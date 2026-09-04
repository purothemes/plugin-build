#!/usr/bin/env node
/**
 * Regenerate the bundled third-party runtime assets from installed npm packages.
 *
 * The grid's runtime bundle is a build output, not source: it is produced here
 * from the exact package version pinned in package.json, verified against the
 * sha256 recorded in vendor-manifest.json, and written into assets/*\/vendor/
 * (which is gitignored). The release script calls this before collecting files,
 * so a zip can never carry a stale or tampered copy.
 *
 * Usage:
 *   node sync-vendor-assets.mjs                 # write mode
 *   node sync-vendor-assets.mjs --check         # verify only, no writes
 *   node sync-vendor-assets.mjs --root <path>   # operate on another tree
 */

import { readFileSync, writeFileSync, mkdirSync, renameSync, rmSync, existsSync } from 'node:fs';
import { join, dirname, basename, resolve, isAbsolute, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT_DEFAULT = join( import.meta.dirname, '..' );

/**
 * Default suffix for in-progress writes when no config supplies one.
 * Reserved: `collectFiles()` in build-release.mjs skips any basename ending
 * in the configured suffix, so a hard kill that skips the `finally` below
 * still cannot leak a partial file into a release.
 */
const DEFAULT_TEMP_SUFFIX = '.plugin-build-tmp';

/** npm package names: optionally scoped, lowercase, no path separators. */
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;

/**
 * Hash a buffer.
 *
 * @param {Buffer} buffer - Bytes to digest.
 * @return {string} Lowercase hex sha256.
 */
function sha256( buffer ) {
	return createHash( 'sha256' ).update( buffer ).digest( 'hex' );
}

/**
 * Reject a relative path that could escape the tree it is resolved against.
 *
 * NOTE: this is a LEXICAL check, not a sandbox. A symlink inside the tree whose
 * own target lies outside it would satisfy every test here, because resolve()
 * never touches the filesystem. That is deliberate: vendor-manifest.json is
 * trusted repo content reviewed like any other tracked file (anyone who can edit
 * it can edit this script too), and npm trees legitimately contain symlinks that
 * a realpath rule would reject. The purpose is to turn a typo or a malformed
 * edit into a loud failure — do not mistake it for a security boundary.
 *
 * @param {string} relPath - Path from the manifest.
 * @param {string} base    - Directory it must stay inside.
 * @param {string} label   - Field name, for the error message.
 * @return {string} The resolved absolute path.
 */
function resolveContained( relPath, base, label ) {
	if ( 'string' !== typeof relPath || '' === relPath ) {
		throw new Error( `vendor-manifest: ${ label } must be a non-empty string.` );
	}

	if ( isAbsolute( relPath ) || relPath.split( /[\\/]/ ).includes( '..' ) ) {
		throw new Error(
			`vendor-manifest: ${ label } must be a relative path without "..", got "${ relPath }".`
		);
	}

	const absolutePath = resolve( base, relPath );

	if ( absolutePath !== base && ! absolutePath.startsWith( base + sep ) ) {
		throw new Error(
			`vendor-manifest: ${ label } "${ relPath }" resolves outside ${ base }.`
		);
	}

	return absolutePath;
}

/**
 * Parse and fully validate the manifest. Reads nothing from node_modules.
 *
 * @param {string} root - Repository root.
 * @return {Array<Object>} Validated package entries.
 */
function readManifest( root ) {
	const manifestPath = join( root, 'vendor-manifest.json' );

	if ( ! existsSync( manifestPath ) ) {
		throw new Error( `vendor-manifest.json not found at ${ manifestPath }.` );
	}

	let manifest;

	try {
		manifest = JSON.parse( readFileSync( manifestPath, 'utf8' ) );
	} catch ( error ) {
		throw new Error( `vendor-manifest.json is not valid JSON: ${ error.message }` );
	}

	if ( null === manifest || 'object' !== typeof manifest || Array.isArray( manifest ) ) {
		throw new Error( 'vendor-manifest.json must be an object keyed by package label.' );
	}

	const entries = [];
	const seenTargets = new Set();

	for ( const [ label, entry ] of Object.entries( manifest ) ) {
		if ( null === entry || 'object' !== typeof entry || Array.isArray( entry ) ) {
			throw new Error( `vendor-manifest: entry "${ label }" must be an object.` );
		}

		const { package: packageName, version, assets } = entry;

		// The nested `package` field is authoritative; the key is a label. They
		// are validated against each other so the duplication cannot drift.
		if ( 'string' !== typeof packageName || ! PACKAGE_NAME.test( packageName ) ) {
			throw new Error(
				`vendor-manifest: entry "${ label }" has an invalid package name "${ packageName }".`
			);
		}

		if ( packageName !== label ) {
			throw new Error(
				`vendor-manifest: key "${ label }" disagrees with its package "${ packageName }".`
			);
		}

		if ( 'string' !== typeof version || '' === version ) {
			throw new Error( `vendor-manifest: entry "${ label }" needs a version string.` );
		}

		if ( ! Array.isArray( assets ) || 0 === assets.length ) {
			throw new Error( `vendor-manifest: entry "${ label }" needs a non-empty assets array.` );
		}

		for ( const asset of assets ) {
			if ( null === asset || 'object' !== typeof asset || Array.isArray( asset ) ) {
				throw new Error( `vendor-manifest: "${ label }" has a non-object asset.` );
			}

			if ( ! Array.isArray( asset.sources ) || 0 === asset.sources.length ) {
				throw new Error(
					`vendor-manifest: asset "${ asset.target }" needs a non-empty sources array.`
				);
			}

			if ( 'string' !== typeof asset.sha256 || ! /^[0-9a-f]{64}$/.test( asset.sha256 ) ) {
				throw new Error(
					`vendor-manifest: asset "${ asset.target }" needs a lowercase hex sha256.`
				);
			}

			if ( seenTargets.has( asset.target ) ) {
				throw new Error( `vendor-manifest: duplicate target "${ asset.target }".` );
			}

			seenTargets.add( asset.target );
		}

		entries.push( { label, packageName, version, assets } );
	}

	if ( 0 === entries.length ) {
		throw new Error( 'vendor-manifest.json declares no packages.' );
	}

	return entries;
}

/**
 * Regenerate (or verify) every vendored asset declared in the manifest.
 *
 * Two-phase and deliberately so. Phase 1 validates the whole manifest, asserts
 * every installed version, reads every source and computes every hash WITHOUT
 * writing anything — so any supply-chain fault (missing package, wrong version,
 * tampered bytes, bad path) leaves the tree completely untouched. Phase 2 only
 * begins once every entry has passed.
 *
 * Phase 2 is atomic per target via same-directory temp + rename, but not across
 * targets: if the disk fills between two writes, the first is already replaced.
 * That residue is individually complete and correct, and a re-run repairs it.
 *
 * @param {Object}  options            - Options.
 * @param {string}  options.root       - Repository root.
 * @param {boolean} options.check      - Verify only; write nothing.
 * @param {string}  options.tempSuffix - Suffix for in-progress writes.
 * @return {Array<Object>} One `{ target, sha256, action }` per asset.
 */
export function syncVendorAssets( { root = ROOT_DEFAULT, check = false, tempSuffix = DEFAULT_TEMP_SUFFIX } = {} ) {
	const rootPath = resolve( root );
	const modulesPath = resolve( rootPath, 'node_modules' );
	const entries = readManifest( rootPath );

	/* Phase 1 — validate and assemble. No writes. */
	const planned = [];

	for ( const { packageName, version, assets } of entries ) {
		// Containment on `sources` would be meaningless if the package name had
		// already escaped, so the package root is checked before it is read.
		const packagePath = resolveContained( packageName, modulesPath, 'package' );
		const packageJsonPath = join( packagePath, 'package.json' );

		if ( ! existsSync( packageJsonPath ) ) {
			throw new Error(
				`${ packageName } is not installed at ${ packagePath }. Run \`npm ci\` first.`
			);
		}

		const installed = JSON.parse( readFileSync( packageJsonPath, 'utf8' ) ).version;

		if ( installed !== version ) {
			throw new Error(
				`${ packageName }: manifest expects ${ version }, node_modules has ${ installed }. ` +
					'Run `npm ci`, or update vendor-manifest.json if the bump is intended.'
			);
		}

		for ( const asset of assets ) {
			const chunks = asset.sources.map( ( source, index ) => {
				const sourcePath = resolveContained(
					source,
					packagePath,
					`${ packageName } sources[${ index }]`
				);

				if ( ! existsSync( sourcePath ) ) {
					throw new Error( `${ packageName }: source file "${ source }" is missing.` );
				}

				return readFileSync( sourcePath );
			} );

			// Order is load-bearing: the CSS target is a concatenation, and
			// reversing it produces a valid-looking but wrong stylesheet.
			const contents = Buffer.concat( chunks );
			const actual = sha256( contents );

			if ( actual !== asset.sha256 ) {
				throw new Error(
					`${ packageName }: assembled "${ asset.target }" hashes ${ actual }, ` +
						`manifest expects ${ asset.sha256 }. The installed package may be tampered ` +
						'with, or the manifest is stale.'
				);
			}

			planned.push( {
				targetPath: resolveContained( asset.target, rootPath, 'target' ),
				target: asset.target,
				contents,
				sha256: actual
			} );
		}
	}

	/* Phase 2 — commit. Every entry above has already passed. */
	const results = [];

	for ( const { targetPath, target, contents, sha256: expected } of planned ) {
		if ( check ) {
			if ( ! existsSync( targetPath ) ) {
				throw new Error( `${ target } is missing. Run \`npm run vendor\` to regenerate it.` );
			}

			const onDisk = sha256( readFileSync( targetPath ) );

			if ( onDisk !== expected ) {
				throw new Error(
					`${ target } hashes ${ onDisk }, expected ${ expected }. ` +
						'Run `npm run vendor` to regenerate it.'
				);
			}

			results.push( { target, sha256: expected, action: 'verified' } );
			continue;
		}

		// A fresh clone has neither directory: they are gitignored, and git
		// tracks no empty directories.
		mkdirSync( dirname( targetPath ), { recursive: true } );

		const tempPath = join( dirname( targetPath ), `.${ basename( targetPath ) }${ tempSuffix }` );

		try {
			writeFileSync( tempPath, contents );

			// Hash BEFORE the rename: a truncated write must be caught while the
			// real target is still intact.
			const written = sha256( readFileSync( tempPath ) );

			if ( written !== expected ) {
				throw new Error(
					`${ target }: wrote ${ written }, expected ${ expected }. Disk write failed.`
				);
			}

			renameSync( tempPath, targetPath );
		} finally {
			// force: after a successful rename the temp path is gone, and a bare
			// unlink would throw ENOENT and fail an otherwise successful sync.
			rmSync( tempPath, { force: true } );
		}

		const settled = sha256( readFileSync( targetPath ) );

		if ( settled !== expected ) {
			throw new Error( `${ target }: hashes ${ settled } after rename, expected ${ expected }.` );
		}

		results.push( { target, sha256: expected, action: 'written' } );
	}

	return results;
}

/* ──────────────────────────────────────────────────────────────────────────── */
/*  CLI                                                                        */
/* ──────────────────────────────────────────────────────────────────────────── */

/**
 * Parse argv. An unrecognised flag is an error, never silently ignored.
 *
 * @param {Array<string>} argv - Arguments after the script name.
 * @return {Object} Parsed options.
 */
function parseArgs( argv ) {
	const options = { check: false };

	for ( let index = 0; index < argv.length; index++ ) {
		const arg = argv[ index ];

		if ( '--check' === arg ) {
			options.check = true;
		} else if ( '--root' === arg ) {
			const value = argv[ ++index ];

			if ( ! value ) {
				throw new Error( '--root requires a path.' );
			}

			options.root = value;
		} else {
			throw new Error( `Unknown argument "${ arg }".` );
		}
	}

	return options;
}

// Entry-point guard: importing this module from build-release.mjs must never
// run CLI code, and must never call process.exit() on the caller's behalf.
const invokedPath = process.argv[ 1 ] ? realpathSync( process.argv[ 1 ] ) : '';

if ( invokedPath && invokedPath === realpathSync( fileURLToPath( import.meta.url ) ) ) {
	try {
		const options = parseArgs( process.argv.slice( 2 ) );

		// Same resolution order in check and write mode: an explicit --root
		// (default: this mount's parent), then that root's build-config.mjs
		// for the temp suffix when one exists, else the generic default.
		const cliRoot = resolve( options.root || ROOT_DEFAULT );

		if ( existsSync( join( cliRoot, 'build-config.mjs' ) ) ) {
			const { loadBuildConfig } = await import( './load-config.mjs' );
			options.tempSuffix = ( await loadBuildConfig( cliRoot ) ).tempSuffix;
		}

		const results = syncVendorAssets( options );

		for ( const { target, action } of results ) {
			console.log( `${ 'verified' === action ? 'ok  ' : 'wrote' } ${ target }` );
		}
	} catch ( error ) {
		console.error( `sync-vendor-assets: ${ error.message }` );
		process.exit( 1 );
	}
}
