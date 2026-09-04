import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { syncVendorAssets } from '../sync-vendor-assets.mjs';

/**
 * Controls for sync-vendor-assets.mjs — the script that regenerates the
 * grid's bundled runtime assets from the pinned npm package.
 *
 * Everything here runs against a THROWAWAY fixture tree, never the real
 * node_modules or assets/. That matters twice over: assets/js/vendor/ and
 * assets/css/vendor/ are gitignored, so damage there leaves nothing in
 * `git diff` to notice, and the missing-parent-directory case genuinely needs to
 * delete a directory — safe in a temp tree, destructive in the repo.
 */

const CLI = 'sync-vendor-assets.mjs';

const sha256 = ( value ) => createHash( 'sha256' ).update( value ).digest( 'hex' );

const JS_BODY = 'console.log("grid");\n';
const CSS_HEAD = '.ag-root{display:grid}\n';
const CSS_THEME = '.ag-theme-quartz{color:#000}\n';

/**
 * Build a disposable repo-shaped tree with a fake installed package.
 *
 * @param {Object} overrides - Manifest field overrides.
 * @return {Object} Fixture handles.
 */
function createFixture( { version = '1.0.0', assets = null, packageName = 'fake-grid', installedVersion = null, installPackage = true } = {} ) {
	const root = mkdtempSync( join( tmpdir(), 'vendor-sync-' ) );
	const packageRoot = join( root, 'node_modules', packageName );

	if ( installPackage ) {
		mkdirSync( join( packageRoot, 'dist' ), { recursive: true } );
		mkdirSync( join( packageRoot, 'styles' ), { recursive: true } );
		writeFileSync(
			join( packageRoot, 'package.json' ),
			JSON.stringify( { name: packageName, version: installedVersion ?? version } )
		);
		writeFileSync( join( packageRoot, 'dist', 'grid.min.js' ), JS_BODY );
		writeFileSync( join( packageRoot, 'styles', 'base.min.css' ), CSS_HEAD );
		writeFileSync( join( packageRoot, 'styles', 'theme.min.css' ), CSS_THEME );
	}

	const manifest = {
		[ packageName ]: {
			package: packageName,
			version,
			license: 'MIT',
			assets: assets ?? [
				{
					sources: [ 'dist/grid.min.js' ],
					target: 'assets/js/vendor/grid.min.js',
					sha256: sha256( JS_BODY )
				}
			]
		}
	};

	writeFileSync( join( root, 'vendor-manifest.json' ), JSON.stringify( manifest, null, '\t' ) );

	return {
		root,
		manifest,
		jsTarget: join( root, 'assets/js/vendor/grid.min.js' ),
		writeManifest: ( next ) =>
			writeFileSync( join( root, 'vendor-manifest.json' ), JSON.stringify( next, null, '\t' ) ),
		cleanup: () => rmSync( root, { recursive: true, force: true } )
	};
}

/** The two-source asset used by the concatenation and atomicity cases. */
const cssAsset = {
	sources: [ 'styles/base.min.css', 'styles/theme.min.css' ],
	target: 'assets/css/vendor/grid.min.css',
	sha256: sha256( CSS_HEAD + CSS_THEME )
};

/**
 * Assert a call throws with a message matching `pattern`.
 *
 * @param {Function} run     - Callable expected to throw.
 * @param {RegExp}   pattern - Expected message.
 * @param {string}   label   - Assertion description.
 */
function throwsWith( run, pattern, label ) {
	assert.throws( run, ( error ) => pattern.test( error.message ), label );
}

/* Control 1 — a fresh clone has neither target NOR its parent directory, since
   the paths are gitignored and git tracks no empty directories. */
function testWritesTargetsAndCreatesDirectories() {
	const fixture = createFixture();

	try {
		assert.equal(
			existsSync( dirname( fixture.jsTarget ) ),
			false,
			'the fixture starts without the target directory, as a fresh clone does'
		);

		const results = syncVendorAssets( { root: fixture.root } );

		assert.equal( readFileSync( fixture.jsTarget, 'utf8' ), JS_BODY, 'the target is written' );
		assert.deepEqual(
			results.map( ( result ) => result.action ),
			[ 'written' ],
			'write mode reports what it wrote'
		);
	} finally {
		fixture.cleanup();
	}
}

/* Control 2 — check mode must detect tampering and never repair it. */
function testCheckModeDetectsCorruption() {
	const fixture = createFixture();

	try {
		syncVendorAssets( { root: fixture.root } );

		assert.deepEqual(
			syncVendorAssets( { root: fixture.root, check: true } ).map( ( r ) => r.action ),
			[ 'verified' ],
			'check mode passes on a clean tree'
		);

		writeFileSync( fixture.jsTarget, `${ JS_BODY }// tampered\n` );

		throwsWith(
			() => syncVendorAssets( { root: fixture.root, check: true } ),
			/hashes .* expected/,
			'check mode fails on a corrupted target'
		);

		assert.match(
			readFileSync( fixture.jsTarget, 'utf8' ),
			/tampered/,
			'check mode must not repair — that would mask the fault it exists to report'
		);

		syncVendorAssets( { root: fixture.root } );

		assert.equal(
			readFileSync( fixture.jsTarget, 'utf8' ),
			JS_BODY,
			'write mode repairs what check mode reported'
		);
	} finally {
		fixture.cleanup();
	}
}

/* Control 2b — check mode on a target that was never written. */
function testCheckModeFailsOnMissingTarget() {
	const fixture = createFixture();

	try {
		throwsWith(
			() => syncVendorAssets( { root: fixture.root, check: true } ),
			/is missing/,
			'check mode fails when the target does not exist'
		);
	} finally {
		fixture.cleanup();
	}
}

/* Control 3 — the installed package disagreeing with the manifest is the
   supply-chain fault this whole script exists to catch. */
function testVersionMismatchFailsWithoutWriting() {
	const fixture = createFixture( { version: '1.0.0', installedVersion: '1.0.1' } );

	try {
		throwsWith(
			() => syncVendorAssets( { root: fixture.root } ),
			/manifest expects 1\.0\.0, node_modules has 1\.0\.1/,
			'a version mismatch fails'
		);

		assert.equal( existsSync( fixture.jsTarget ), false, 'and writes nothing' );
	} finally {
		fixture.cleanup();
	}
}

/* Control 4 — the recorded hash not matching the assembled bytes. */
function testSourceHashMismatchFails() {
	const fixture = createFixture( {
		assets: [
			{
				sources: [ 'dist/grid.min.js' ],
				target: 'assets/js/vendor/grid.min.js',
				sha256: 'f'.repeat( 64 )
			}
		]
	} );

	try {
		throwsWith(
			() => syncVendorAssets( { root: fixture.root } ),
			/hashes .* manifest expects/,
			'assembled bytes that do not match the manifest fail'
		);

		assert.equal( existsSync( fixture.jsTarget ), false, 'and write nothing' );
	} finally {
		fixture.cleanup();
	}
}

/* Control 5 — the package absent from node_modules entirely. */
function testMissingPackageFails() {
	const fixture = createFixture( { installPackage: false } );

	try {
		throwsWith(
			() => syncVendorAssets( { root: fixture.root } ),
			/is not installed/,
			'a missing package fails with an actionable message'
		);
	} finally {
		fixture.cleanup();
	}
}

/* Control 5b — the package installed, but a declared source file missing. */
function testMissingSourceFileFails() {
	const fixture = createFixture( {
		assets: [
			{
				sources: [ 'dist/not-shipped.js' ],
				target: 'assets/js/vendor/grid.min.js',
				sha256: sha256( JS_BODY )
			}
		]
	} );

	try {
		throwsWith(
			() => syncVendorAssets( { root: fixture.root } ),
			/source file .* is missing/,
			'a missing source file fails'
		);
	} finally {
		fixture.cleanup();
	}
}

/* Control 8 — the real CSS target is two upstream stylesheets concatenated, so
   order is load-bearing: reversing it yields a valid-looking, wrong file. */
function testConcatenationOrderIsLoadBearing() {
	const fixture = createFixture( { assets: [ cssAsset ] } );

	try {
		syncVendorAssets( { root: fixture.root } );

		assert.equal(
			readFileSync( join( fixture.root, cssAsset.target ), 'utf8' ),
			CSS_HEAD + CSS_THEME,
			'sources are concatenated in the order declared'
		);

		const reversed = structuredClone( fixture.manifest );
		reversed[ 'fake-grid' ].assets = [
			{ ...cssAsset, sources: [ 'styles/theme.min.css', 'styles/base.min.css' ] }
		];
		fixture.writeManifest( reversed );

		throwsWith(
			() => syncVendorAssets( { root: fixture.root } ),
			/hashes .* manifest expects/,
			'reversing the source order changes the hash and fails'
		);
	} finally {
		fixture.cleanup();
	}
}

/* Control 9 — path containment. Lexical only, by design: see the note in
   sync-vendor-assets.mjs. These catch typos, not a hostile manifest. */
function testPathContainmentRejectsEscapes() {
	for ( const [ label, mutate, pattern ] of [
		[
			'a target escaping the root',
			( m ) => { m[ 'fake-grid' ].assets[ 0 ].target = '../outside.js'; },
			/must be a relative path without/
		],
		[
			'an absolute target',
			( m ) => { m[ 'fake-grid' ].assets[ 0 ].target = '/tmp/outside.js'; },
			/must be a relative path without/
		],
		[
			'a source escaping the package',
			( m ) => { m[ 'fake-grid' ].assets[ 0 ].sources = [ '../../escape.js' ]; },
			/must be a relative path without/
		],
		[
			'a package name containing a path separator',
			( m ) => {
				m[ 'evil/../../escape' ] = { ...m[ 'fake-grid' ], package: 'evil/../../escape' };
				delete m[ 'fake-grid' ];
			},
			/invalid package name/
		]
	] ) {
		const fixture = createFixture();

		try {
			const manifest = structuredClone( fixture.manifest );
			mutate( manifest );
			fixture.writeManifest( manifest );

			throwsWith( () => syncVendorAssets( { root: fixture.root } ), pattern, `rejects ${ label }` );
			assert.equal( existsSync( fixture.jsTarget ), false, `writes nothing for ${ label }` );
		} finally {
			fixture.cleanup();
		}
	}
}

/* Manifest shape errors must fail loudly rather than drift. */
function testManifestValidation() {
	for ( const [ label, mutate, pattern ] of [
		[
			'a key disagreeing with its package field',
			( m ) => { m[ 'mislabelled' ] = m[ 'fake-grid' ]; delete m[ 'fake-grid' ]; },
			/disagrees with its package/
		],
		[
			'two assets claiming the same target',
			( m ) => { m[ 'fake-grid' ].assets.push( { ...m[ 'fake-grid' ].assets[ 0 ] } ); },
			/duplicate target/
		],
		[
			'an empty sources array',
			( m ) => { m[ 'fake-grid' ].assets[ 0 ].sources = []; },
			/non-empty sources array/
		],
		[
			'an empty assets array',
			( m ) => { m[ 'fake-grid' ].assets = []; },
			/non-empty assets array/
		],
		[
			'a malformed sha256',
			( m ) => { m[ 'fake-grid' ].assets[ 0 ].sha256 = 'not-a-hash'; },
			/lowercase hex sha256/
		]
	] ) {
		const fixture = createFixture();

		try {
			const manifest = structuredClone( fixture.manifest );
			mutate( manifest );
			fixture.writeManifest( manifest );

			throwsWith( () => syncVendorAssets( { root: fixture.root } ), pattern, `rejects ${ label }` );
		} finally {
			fixture.cleanup();
		}
	}
}

/* Atomicity — needs TWO assets. A single-asset fixture cannot distinguish
   "validated everything first" from "wrote as it went", because there is no
   earlier target to leave behind. */
function testValidationCompletesBeforeAnyWrite() {
	const fixture = createFixture( {
		assets: [
			{
				sources: [ 'dist/grid.min.js' ],
				target: 'assets/js/vendor/grid.min.js',
				sha256: sha256( JS_BODY )
			},
			{ ...cssAsset, sha256: 'a'.repeat( 64 ) }
		]
	} );

	try {
		throwsWith(
			() => syncVendorAssets( { root: fixture.root } ),
			/hashes .* manifest expects/,
			'the second asset fails validation'
		);

		assert.equal(
			existsSync( fixture.jsTarget ),
			false,
			'the FIRST target must not exist: a later failure has to leave the tree untouched'
		);
	} finally {
		fixture.cleanup();
	}
}

/**
 * List any surviving temp files under a fixture root.
 *
 * @param {string} root - Fixture root.
 * @return {string} Newline-joined paths, empty when clean.
 */
function findTempFiles( root ) {
	// Match any in-progress-write name, whatever suffix is in force, so this
	// scan can never go quiet because a default changed under it.
	return execFileSync( 'find', [ root, '-name', '.*-tmp' ], { encoding: 'utf8' } ).trim();
}

/* No temp file may survive — and the interesting case is the FAILING one. On a
   successful run the rename consumes the temp file whether or not anything
   cleans up, so a success-only assertion would pass even with the `finally`
   deleted. The cleanup only earns its keep when the write throws midway. */
function testNoTempFileSurvivesAFailedWrite() {
	// Second asset targets a directory path, so writeFileSync throws EISDIR
	// after the first asset has already been renamed into place.
	const fixture = createFixture( {
		assets: [
			{
				sources: [ 'dist/grid.min.js' ],
				target: 'assets/js/vendor/grid.min.js',
				sha256: sha256( JS_BODY )
			},
			{
				sources: [ 'styles/base.min.css' ],
				target: 'assets/css/vendor',
				sha256: sha256( CSS_HEAD )
			}
		]
	} );

	try {
		mkdirSync( join( fixture.root, 'assets/css/vendor' ), { recursive: true } );

		assert.throws(
			() => syncVendorAssets( { root: fixture.root } ),
			'a write to a directory path fails'
		);

		assert.equal(
			findTempFiles( fixture.root ),
			'',
			'a FAILED write must clean up its temp file — otherwise a later build packages it'
		);
	} finally {
		fixture.cleanup();
	}
}

/* And a successful run leaves nothing either. */
function testNoTempFileSurvivesSuccess() {
	const fixture = createFixture();

	try {
		syncVendorAssets( { root: fixture.root } );

		assert.equal( findTempFiles( fixture.root ), '', 'a successful run leaves no temp file behind' );
	} finally {
		fixture.cleanup();
	}
}

/* The cleanup must not itself break a successful run: after renameSync the temp
   path is gone, so a bare unlinkSync would throw ENOENT and turn a good sync
   into a failure. */
function testCleanupSurvivesAConsumedTempFile() {
	const fixture = createFixture();

	try {
		assert.deepEqual(
			syncVendorAssets( { root: fixture.root } ).map( ( r ) => r.action ),
			[ 'written' ],
			'the rename consumes the temp path, and cleanup must tolerate its absence'
		);
	} finally {
		fixture.cleanup();
	}
}

/* ──────────────────────────────────────────────────────────────────────────── */
/*  CLI wrapper                                                                */
/* ──────────────────────────────────────────────────────────────────────────── */

// Every control above would still pass with a completely broken CLI wrapper, so
// the wrapper is spawned for itself: flag parsing, exit codes, and the guard
// that keeps `import` from running CLI code.

/**
 * Run the CLI, returning its exit status and stderr.
 *
 * @param {Array<string>} argv - CLI arguments.
 * @return {Object} `{ status, stderr }`.
 */
function runCli( argv ) {
	try {
		execFileSync( 'node', [ CLI, ...argv ], { encoding: 'utf8', stdio: 'pipe' } );
		return { status: 0, stderr: '' };
	} catch ( error ) {
		return { status: error.status, stderr: String( error.stderr ) };
	}
}

function testCliWritesAndChecks() {
	const fixture = createFixture();

	try {
		assert.equal( runCli( [ '--root', fixture.root ] ).status, 0, 'write mode exits 0' );
		assert.equal( readFileSync( fixture.jsTarget, 'utf8' ), JS_BODY, 'and writes the target' );

		assert.equal(
			runCli( [ '--root', fixture.root, '--check' ] ).status,
			0,
			'check mode exits 0 on a clean tree'
		);

		writeFileSync( fixture.jsTarget, 'tampered' );

		const failed = runCli( [ '--root', fixture.root, '--check' ] );

		assert.equal( failed.status, 1, 'check mode exits 1 on a corrupted target' );
		assert.match( failed.stderr, /sync-vendor-assets:/, 'and reports the reason on stderr' );
	} finally {
		fixture.cleanup();
	}
}

function testCliRejectsUnknownFlags() {
	const fixture = createFixture();

	try {
		const result = runCli( [ '--root', fixture.root, '--verify' ] );

		assert.equal( result.status, 1, 'an unrecognised flag exits 1 rather than being ignored' );
		assert.match( result.stderr, /Unknown argument "--verify"/, 'and names the offending flag' );

		assert.equal( runCli( [ '--root' ] ).status, 1, '--root with no value exits 1' );
	} finally {
		fixture.cleanup();
	}
}

/* Importing must run no CLI code: build-release.mjs imports this module, and a
   stray process.exit() there would kill the build out from under it. Reaching
   the next line at all is the proof — a leaky guard would exit this process. */
function testImportRunsNoCliCode() {
	const probe = execFileSync(
		'node',
		[ '-e', "import('./sync-vendor-assets.mjs').then(() => console.log('alive'))" ],
		{ encoding: 'utf8' }
	).trim();

	assert.equal( probe, 'alive', 'importing the module neither builds nor exits' );
}

testWritesTargetsAndCreatesDirectories();
testCheckModeDetectsCorruption();
testCheckModeFailsOnMissingTarget();
testVersionMismatchFailsWithoutWriting();
testSourceHashMismatchFails();
testMissingPackageFails();
testMissingSourceFileFails();
testConcatenationOrderIsLoadBearing();
testPathContainmentRejectsEscapes();
testManifestValidation();
testValidationCompletesBeforeAnyWrite();
testNoTempFileSurvivesAFailedWrite();
testNoTempFileSurvivesSuccess();
testCleanupSurvivesAConsumedTempFile();
testCliWritesAndChecks();
testCliRejectsUnknownFlags();
testImportRunsNoCliCode();

console.log( 'Vendor sync tests passed.' );
