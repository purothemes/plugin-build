/**
 * Tests for the WordPress.org SVN publisher, against a throwaway local
 * repository: `svnadmin create` in a temp dir, reached by a file:// URL.
 * Nothing here contacts a remote.
 *
 * Each case runs the CLI the way a consuming plugin does: a copy of the
 * scripts mounted at <fixture>/build, a dist/ ZIP built by `zip`, and listing
 * art in <fixture>/.wordpress-org.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { parseArgs, parseStableTag, stageRelease, summarizeStatus } from '../publish-wporg.mjs';

const SCRIPTS_DIR = join( import.meta.dirname, '..' );

function hasTool( name ) {
	try {
		execFileSync( name, [ '--version' ], { stdio: 'ignore' } );
		return true;
	} catch {
		return false;
	}
}

/* ── pure helpers ──────────────────────────────────────────────────────── */

assert.deepEqual(
	parseArgs( [ '--variant', 'free', '-v', '1.2.3', '--svn', 'wc' ] ),
	{ version: '1.2.3', variant: 'free', svn: 'wc', root: '', commit: false },
	'a dry run is the default'
);
assert.equal( parseArgs( [ '--commit' ] ).commit, true, '--commit opts in' );
assert.throws( () => parseArgs( [ '--comit' ] ), /Unknown argument "--comit"/, 'a misspelt --commit is refused, not read as a dry run' );
assert.throws( () => parseArgs( [ '--svn' ] ), /--svn requires a value/ );

assert.equal( parseStableTag( '=== X ===\nStable tag: 1.4.0 \nLicense: GPL\n' ), '1.4.0' );
assert.equal( parseStableTag( '=== X ===\nLicense: GPL\n' ), '' );

assert.deepEqual(
	summarizeStatus( 'A       trunk/a.php\nD       trunk/b.php\n M      assets/icon.png\nA  +    tags/1.0.0\n', '1.0.0' ),
	[ 'trunk: 1 added, 1 deleted', 'assets: 1 properties set', 'tags/1.0.0: copy of trunk' ]
);

if ( ! hasTool( 'svn' ) || ! hasTool( 'svnadmin' ) || ! hasTool( 'zip' ) ) {
	console.log( 'SKIPPED publish-wporg CLI tests: svn, svnadmin and zip are required.' );
	process.exit( 0 );
}

/* ── fixtures ──────────────────────────────────────────────────────────── */

const TMP = mkdtempSync( join( tmpdir(), 'publish-wporg-test-' ) );

const CONFIG = `export default {
	textDomain: 'fixture',
	versionConstant: 'FIXTURE_VERSION',
	tempSuffix: '.fixture-tmp',
	globalExclude: [],
	excludeBasenames: [ '.DS_Store' ],
	potExclude: [],
	overlayDir: 'overlays',
	variants: {
		lite: { slug: 'fixture', removedPaths: [], overlayPhpFiles: [], postProcess: [] },
		paid: { slug: 'fixture', removedPaths: [], overlayPhpFiles: [], postProcess: [] },
	},
	zipName( variant, version ) { return 'fixture-' + variant + '.' + version + '.zip'; },
	potMeta: { package: 'Fixture', bugReport: 'https://example.com', team: 'Example <x@example.com>' },
	publish: {
		inZipProbe: 'fixture/fixture.php',
		packageVariantConstant: 'FIXTURE_VARIANT',
	},
};
`;

/** A plugin root with the scripts mounted at build/ and some listing art. */
function makeRoot() {
	const root = mkdtempSync( join( TMP, 'root-' ) );

	writeFileSync( join( root, 'build-config.mjs' ), CONFIG );
	mkdirSync( join( root, 'build' ) );

	for ( const entry of readdirSync( SCRIPTS_DIR ) ) {
		if ( entry.endsWith( '.mjs' ) ) {
			cpSync( join( SCRIPTS_DIR, entry ), join( root, 'build', entry ) );
		}
	}

	const art = join( root, '.wordpress-org' );
	mkdirSync( art );
	for ( const name of [ 'icon-128x128.png', 'banner-772x250.jpg', 'icon.svg', 'anim.gif', '.DS_Store' ] ) {
		writeFileSync( join( art, name ), `bytes of ${ name }\n` );
	}

	return root;
}

/**
 * Build dist/<zipName> holding fixture/ with the given extra files.
 *
 * @param {string} root    - Plugin root.
 * @param {object} opts
 * @param {string} opts.version  - Stamped header and constant version.
 * @param {string} [opts.stable] - Readme Stable tag (default: the version).
 * @param {string} [opts.variant]  - The variant constant and zip name.
 * @param {object} [opts.files]  - Extra relPath → content entries.
 */
function buildZip( root, { version, stable = version, variant = 'lite', files = {} } ) {
	const stage = mkdtempSync( join( TMP, 'zip-' ) );
	const plugin = join( stage, 'fixture' );
	const all = {
		'fixture.php': `<?php\n/*\n * Plugin Name: Fixture\n * Version: ${ version }\n */\ndefine( 'FIXTURE_VERSION', '${ version }' );\ndefine( 'FIXTURE_VARIANT', '${ variant }' );\n`,
		'readme.txt': `=== Fixture ===\nStable tag: ${ stable }\n\n== Changelog ==\n\n= ${ version } =\n* Release.\n`,
		...files,
	};

	for ( const [ rel, content ] of Object.entries( all ) ) {
		mkdirSync( join( plugin, rel, '..' ), { recursive: true } );
		writeFileSync( join( plugin, rel ), content );
	}

	mkdirSync( join( root, 'dist' ), { recursive: true } );
	const zip = join( root, 'dist', `fixture-${ variant }.${ version }.zip` );
	rmSync( zip, { force: true } );
	execFileSync( 'zip', [ '-qr', zip, 'fixture' ], { cwd: stage } );
}

/** A fresh repository with the WordPress.org layout, and a checkout of it. */
function makeRepo() {
	const dir = mkdtempSync( join( TMP, 'svn-' ) );
	const repo = join( dir, 'repo' );
	const url = pathToFileURL( repo ).href;

	execFileSync( 'svnadmin', [ 'create', repo ] );
	execFileSync( 'svn', [ 'mkdir', '-q', '-m', 'Layout', `${ url }/trunk`, `${ url }/tags`, `${ url }/assets` ] );
	execFileSync( 'svn', [ 'checkout', '-q', url, join( dir, 'wc' ) ] );

	return { repo, url, wc: join( dir, 'wc' ) };
}

function publish( root, wc, version, ...extra ) {
	try {
		const stdout = execFileSync( 'node', [ join( root, 'build', 'publish-wporg.mjs' ), '--variant', 'lite', '-v', version, '--svn', wc, ...extra ], {
			cwd: root,
			stdio: 'pipe',
			encoding: 'utf8',
		} );
		return { status: 0, stdout, stderr: '' };
	} catch ( err ) {
		return { status: err.status ?? 1, stdout: String( err.stdout || '' ), stderr: String( err.stderr || '' ) };
	}
}

const out = ( cmd, args, cwd ) => execFileSync( cmd, args, { cwd, encoding: 'utf8' } );
const youngest = ( repo ) => out( 'svnlook', [ 'youngest', repo ] ).trim();
const ls = ( url ) => out( 'svn', [ 'ls', '-R', url ] ).trim().split( '\n' );
const mime = ( url ) => out( 'svn', [ 'propget', 'svn:mime-type', url ] ).trim();

try {
	const root = makeRoot();
	const { repo, url, wc } = makeRepo();

	/* ── first release: dry run, then commit ──────────────────────────── */

	buildZip( root, { version: '1.0.0', files: { 'src/old.php': '<?php // old\n', 'src/keep.php': '<?php // v1\n' } } );

	{
		const before = youngest( repo );
		const dry = publish( root, wc, '1.0.0' );

		assert.equal( dry.status, 0, `first dry run succeeds: ${ dry.stderr }` );
		for ( const line of [ 'A       trunk/fixture.php', 'A       trunk/src/old.php', 'A       assets/icon-128x128.png', 'A  +    tags/1.0.0' ] ) {
			assert.ok( dry.stdout.includes( line ), `dry run lists "${ line }"` );
		}
		assert.match( dry.stdout, /Dry run: .* is unchanged/, 'and says it changed nothing' );
		assert.equal( dry.stdout.includes( '.DS_Store' ), false, 'excluded basenames never reach assets/' );
		assert.equal( youngest( repo ), before, 'a dry run commits nothing' );
		assert.equal( out( 'svn', [ 'status' ], wc ), '', 'and leaves the working copy clean' );
	}

	{
		const committed = publish( root, wc, '1.0.0', '--commit' );

		assert.equal( committed.status, 0, `first commit succeeds: ${ committed.stderr }` );
		assert.equal( youngest( repo ), '2', '--commit makes one commit' );
		assert.deepEqual( ls( `${ url }/trunk` ), [ 'fixture.php', 'readme.txt', 'src/', 'src/keep.php', 'src/old.php' ] );
		assert.deepEqual( ls( `${ url }/tags/1.0.0` ), ls( `${ url }/trunk` ), 'the tag is a copy of trunk' );
		assert.equal( parseStableTag( out( 'svn', [ 'cat', `${ url }/trunk/readme.txt` ] ) ), '1.0.0', 'trunk Stable tag names the new tag' );
		assert.equal( mime( `${ url }/assets/icon-128x128.png` ), 'image/png' );
		assert.equal( mime( `${ url }/assets/banner-772x250.jpg` ), 'image/jpeg' );
		assert.equal( mime( `${ url }/assets/anim.gif` ), 'image/gif' );
		assert.equal( mime( `${ url }/assets/icon.svg` ), 'image/svg+xml' );
		assert.match( committed.stdout, /both say Stable tag 1\.0\.0/, 'the committed result is read back from the repository' );
	}

	/* ── second release: adds, removes, modifies ──────────────────────── */

	execFileSync( 'svn', [ 'update', '-q' ], { cwd: wc } );
	buildZip( root, { version: '1.1.0', files: { 'src/keep.php': '<?php // v2\n', 'src/new.php': '<?php // new\n' } } );
	rmSync( join( root, '.wordpress-org', 'anim.gif' ) );
	writeFileSync( join( root, '.wordpress-org', 'icon-256x256.png' ), 'bigger icon\n' );

	{
		const dry = publish( root, wc, '1.1.0' );

		assert.equal( dry.status, 0, `second dry run succeeds: ${ dry.stderr }` );
		for ( const line of [
			'A       trunk/src/new.php',
			'D       trunk/src/old.php',
			'M       trunk/src/keep.php',
			'M       trunk/fixture.php',
			'D       assets/anim.gif',
			'A       assets/icon-256x256.png',
		] ) {
			assert.ok( dry.stdout.includes( line ), `dry run lists "${ line }"` );
		}
		assert.equal( / M {6}assets\/icon-128x128\.png/.test( dry.stdout ), false, 'an image whose type is already right shows no property change' );
		assert.match( dry.stdout, /trunk: 1 added, 1 deleted, 3 modified/ );
	}

	{
		const committed = publish( root, wc, '1.1.0', '--commit' );

		assert.equal( committed.status, 0, `second commit succeeds: ${ committed.stderr }` );
		assert.deepEqual( ls( `${ url }/trunk` ), [ 'fixture.php', 'readme.txt', 'src/', 'src/keep.php', 'src/new.php' ], 'trunk holds exactly the new ZIP' );
		assert.deepEqual( ls( `${ url }/tags/1.1.0` ), ls( `${ url }/trunk` ) );
		assert.ok( ls( `${ url }/tags/1.0.0` ).includes( 'src/old.php' ), 'the earlier tag is untouched' );
		assert.equal( out( 'svn', [ 'cat', `${ url }/tags/1.1.0/src/keep.php` ] ), '<?php // v2\n' );
		assert.equal( mime( `${ url }/assets/icon-256x256.png` ), 'image/png' );
		assert.equal( ls( `${ url }/assets` ).includes( 'anim.gif' ), false );
	}

	/* ── refusals ─────────────────────────────────────────────────────── */

	execFileSync( 'svn', [ 'update', '-q' ], { cwd: wc } );

	{
		buildZip( root, { version: '1.2.0', stable: '1.1.0' } );
		const before = youngest( repo );
		const refused = publish( root, wc, '1.2.0', '--commit' );

		assert.notEqual( refused.status, 0, 'a Stable tag that is not the version is refused' );
		assert.match( refused.stderr, /Stable tag '1\.1\.0', not 1\.2\.0/ );
		assert.equal( youngest( repo ), before );
		assert.equal( out( 'svn', [ 'status' ], wc ), '', 'before anything is staged' );
	}

	{
		buildZip( root, { version: '1.1.0' } );
		const refused = publish( root, wc, '1.1.0', '--commit' );

		assert.notEqual( refused.status, 0, 'an existing tag is refused' );
		assert.match( refused.stderr, /tags\/1\.1\.0 already exists/ );

		// A sparse checkout without tags/ children: the repository is asked.
		const sparse = join( TMP, 'sparse' );
		execFileSync( 'svn', [ 'checkout', '-q', '--depth', 'immediates', url, sparse ] );
		execFileSync( 'svn', [ 'update', '-q', '--set-depth', 'empty', join( sparse, 'tags' ) ] );
		const remote = publish( root, sparse, '1.1.0' );

		assert.notEqual( remote.status, 0, 'a tag missing from the working copy but present in the repository is refused' );
		assert.match( remote.stderr, /tags\/1\.1\.0 already exists in file:/ );

		// The CLI asks the repository first, so this guard is for stageRelease()
		// alone: svn cp onto an existing directory copies INTO it, and would
		// commit tags/1.1.0/trunk/ without complaint.
		assert.throws(
			() => stageRelease( { wc, pluginDir: wc, assetsDir: '', version: '1.1.0', skip: [] } ),
			/tags\/1\.1\.0 already exists in the working copy/
		);
		assert.equal( out( 'svn', [ 'status' ], wc ), '', 'refused before anything is staged' );
	}

	{
		buildZip( root, { version: '1.2.0', variant: 'paid' } );
		const wrongVariant = join( root, 'dist', 'fixture-paid.1.2.0.zip' );
		cpSync( wrongVariant, join( root, 'dist', 'fixture-lite.1.2.0.zip' ) );
		const refused = publish( root, wc, '1.2.0' );

		assert.notEqual( refused.status, 0, 'another variant under this variant\'s name is refused' );
		assert.match( refused.stderr, /is the paid build, not lite/ );
	}

	{
		buildZip( root, { version: '1.2.0' } );
		writeFileSync( join( wc, 'trunk', 'readme.txt' ), 'edited\n' );
		const refused = publish( root, wc, '1.2.0' );

		assert.notEqual( refused.status, 0, 'a working copy with local changes is refused' );
		assert.match( refused.stderr, /has local changes/ );
		execFileSync( 'svn', [ 'revert', '-q', join( wc, 'trunk', 'readme.txt' ) ] );

		const trunkOnly = publish( root, join( wc, 'trunk' ), '1.2.0' );
		assert.notEqual( trunkOnly.status, 0, 'a checkout of trunk alone is refused' );
		assert.match( trunkOnly.stderr, /not of the repository root/ );
	}

	console.log( 'publish-wporg tests passed.' );
} finally {
	rmSync( TMP, { recursive: true, force: true } );
}
