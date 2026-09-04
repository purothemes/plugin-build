#!/usr/bin/env node
/**
 * Build release zips for a WordPress plugin's variants.
 *
 * Everything plugin-specific comes from build-config.mjs at the consuming
 * plugin root; see load-config.mjs for the contract.
 *
 * Usage:
 *   node build-release.mjs <variant|all> -v <version>
 */

import { createWriteStream, readFileSync, readdirSync, statSync, existsSync, mkdirSync, realpathSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import yazl from 'yazl';
import { WP_Pot } from 'wp-pot';
import { syncVendorAssets } from './sync-vendor-assets.mjs';
import { releaseVersionError } from './release-version.mjs';
import { loadBuildConfig, assertZipName } from './load-config.mjs';

const ROOT = join( import.meta.dirname, '..' );
const distDir = join( ROOT, 'dist' );

/* ──────────────────────────────────────────────────────────────────────────── */
/*  CLI                                                                        */
/* ──────────────────────────────────────────────────────────────────────────── */

// Entry-point guard: tests import collectFiles() to exercise the exclusion
// rules directly, and importing this module must not kick off a build (or exit
// the importing process for want of a -v argument).
const invokedPath = process.argv[ 1 ] ? realpathSync( process.argv[ 1 ] ) : '';

if ( invokedPath && invokedPath === realpathSync( fileURLToPath( import.meta.url ) ) ) {
	const args = process.argv.slice( 2 );
	const target = args[ 0 ] || 'all';
	let version = '';

	for ( let i = 0; i < args.length; i++ ) {
		if ( args[ i ] === '-v' && args[ i + 1 ] ) {
			version = args[ i + 1 ];
			i++;
		}
	}

	if ( ! version ) {
		console.error( 'Usage: node build-release.mjs <variant|all> -v <version>' );
		process.exit( 1 );
	}

	// Validate before the value reaches the zip name or any stamped file.
	const versionError = releaseVersionError( version );

	if ( versionError ) {
		console.error( versionError );
		process.exit( 1 );
	}

	let config;

	try {
		config = await loadBuildConfig( ROOT );
	} catch ( err ) {
		console.error( err.message );
		process.exit( 1 );
	}

	const variantNames = Object.keys( config.variants );
	const targets = target === 'all' ? variantNames : [ target ];

	for ( const t of targets ) {
		if ( ! config.variants[ t ] ) {
			console.error( `Unknown target: ${ t } (configured variants: ${ variantNames.join( ', ' ) })` );
			process.exit( 1 );
		}
	}

	if ( ! existsSync( distDir ) ) {
		mkdirSync( distDir, { recursive: true } );
	}

	for ( const t of targets ) {
		await buildVariant( config, t, version );
	}
}

/**
 * Build a single variant zip.
 *
 * @param {object} config      - Validated build config.
 * @param {string} variantName - A key of config.variants.
 * @param {string} ver         - Semver version string.
 */
async function buildVariant( config, variantName, ver ) {
	const variant = config.variants[ variantName ];

	// Independent versioning: stamp exactly the version passed for this build.
	// No forced bump — variants are iterated separately.
	const variantVer = ver;

	const zipName = assertZipName( config.zipName( variantName, variantVer ) );
	const zipPath = join( distDir, zipName );

	console.log( `\nBuilding ${ variantName } → dist/${ zipName }` );

	const zipfile = new yazl.ZipFile();

	// Regenerate the bundled vendor assets BEFORE the file list is taken, so the
	// zip is built from hash-verified output rather than whatever happens to sit
	// in the working tree. A missing file is repaired here; a file that cannot be
	// correctly regenerated (wrong version, tampered bytes) throws and no zip is
	// produced.
	for ( const { target, action } of syncVendorAssets( { root: ROOT, tempSuffix: config.tempSuffix } ) ) {
		console.log( `  ${ 'verified' === action ? 'verified' : 'regenerated' } ${ target }` );
	}

	const files = collectFiles( ROOT, variant, config );

	// Overlay preflight: every configured overlay must both name a collected
	// source file and have its overlay copy on disk. A typo'd entry, a source
	// file that stopped being collected, or a deleted overlay would otherwise
	// ship an un-overlaid file in silence.
	for ( const relPath of variant.overlayPhpFiles ) {
		if ( ! files.includes( relPath ) ) {
			console.error( `Overlay target not in the collected source set: ${ relPath }` );
			process.exit( 1 );
		}

		const overlayPath = join( ROOT, config.overlayDir, variantName, relPath );

		if ( ! existsSync( overlayPath ) ) {
			console.error( `Missing overlay file: ${ relative( ROOT, overlayPath ) }` );
			process.exit( 1 );
		}
	}

	// Stamp regex for the version constant, built from config so the constant
	// name is the consumer's business.
	const constantPattern = new RegExp( `(define\\(\\s*'${ config.versionConstant }',\\s*').+?('\\s*\\))` );

	for ( const relPath of files ) {
		let content = readFileSync( join( ROOT, relPath ) );

		// Apply the PHP overlay (preflighted above).
		if ( variant.overlayPhpFiles.includes( relPath ) ) {
			content = readFileSync( join( ROOT, config.overlayDir, variantName, relPath ) );
			console.log( `  overlay: ${ relPath }` );
		}

		// Stamp version in PHP headers and constant definitions.
		if ( relPath.endsWith( '.php' ) ) {
			let text = content.toString( 'utf8' );
			text = stampVersion( text, variantVer, constantPattern );
			content = Buffer.from( text, 'utf8' );
		} else if ( 'readme.txt' === relPath ) {
			// WordPress.org resolves the download from Stable tag, so it is
			// release metadata and belongs to the build like the PHP header.
			let text = content.toString( 'utf8' );
			text = stampReadmeVersion( text, variantVer );
			content = Buffer.from( text, 'utf8' );
		}

		// Apply post-processing transforms.
		for ( const fn of variant.postProcess ) {
			if ( typeof fn === 'function' ) {
				const result = fn( relPath, content );
				if ( result !== undefined ) {
					content = result;
				}
			}
		}

		const entryPath = `${ variant.slug }/${ relPath }`;
		zipfile.addBuffer( content, entryPath );
	}

	// Generate the translation template from THIS variant's collected PHP files
	// (post-removedPaths), so a stripped-down variant's POT omits the strings it
	// no longer ships. Scanning the on-disk source is accurate here: the only
	// build-time PHP transforms are version stamping and the bootstrap overlay,
	// neither of which adds or removes translatable strings. Fail the build
	// loudly rather than ship a stale/empty POT.
	const phpFiles = files
		.filter( ( relPath ) => relPath.endsWith( '.php' ) && ! isExcluded( relPath, config.potExclude ) )
		.map( ( relPath ) => join( ROOT, relPath ) );

	let potContent;

	try {
		const pot = new WP_Pot( {
			pot: {
				package: config.potMeta.package,
				domain: config.textDomain,
				bugReport: config.potMeta.bugReport,
				team: config.potMeta.team,
			},
		} );
		pot.parse( phpFiles );
		potContent = pot.generatePot();
	} catch ( err ) {
		console.error( `POT generation failed for ${ variantName }: ${ err.message }` );
		process.exit( 1 );
	}

	// Stamp the build version into the Project-Id-Version header.
	potContent = potContent.replace(
		/Project-Id-Version:.*\\n/,
		`Project-Id-Version: ${ config.potMeta.package } ${ variantVer }\\n`
	);

	const potEntry = `languages/${ config.textDomain }.pot`;

	zipfile.addBuffer(
		Buffer.from( potContent, 'utf8' ),
		`${ variant.slug }/${ potEntry }`
	);
	console.log( `  pot: ${ potEntry } (${ phpFiles.length } PHP files scanned)` );

	zipfile.end();

	await new Promise( ( resolve, reject ) => {
		const out = createWriteStream( zipPath );
		zipfile.outputStream.pipe( out );
		out.on( 'close', resolve );
		out.on( 'error', reject );
	} );

	console.log( `  ✓ ${ zipName } (${ files.length } files)` );
}

/* ──────────────────────────────────────────────────────────────────────────── */
/*  File collection                                                            */
/* ──────────────────────────────────────────────────────────────────────────── */

/**
 * Recursively collect files, skipping excluded paths.
 *
 * @param {string} root    - Absolute root directory.
 * @param {object} variant - Variant config (removedPaths).
 * @param {object} shared  - Build config (globalExclude, tempSuffix).
 * @return {string[]}      - Sorted list of relative paths.
 */
export function collectFiles( root, variant, shared ) {
	const results = [];

	function walk( dir ) {
		const entries = readdirSync( dir );

		for ( const entry of entries ) {
			const abs = join( dir, entry );
			const rel = relative( root, abs );

			// In-progress writes from sync-vendor-assets. A basename test, not a
			// globalExclude entry: isExcluded matches whole ROOT-relative paths or
			// path prefixes, so it can never match a nested temp file.
			if ( entry.endsWith( shared.tempSuffix ) ) {
				continue;
			}

			// Names excluded wherever they appear. A root-relative prefix list
			// cannot catch a nested .DS_Store, and one shipped that way once.
			if ( ( shared.excludeBasenames || [] ).includes( entry ) ) {
				continue;
			}

			// Global exclusions.
			if ( isExcluded( rel, shared.globalExclude ) ) {
				continue;
			}

			// Variant-specific removals.
			if ( isExcluded( rel, variant.removedPaths ) ) {
				continue;
			}

			const stat = statSync( abs );

			if ( stat.isDirectory() ) {
				walk( abs );
			} else if ( stat.isFile() ) {
				results.push( rel );
			}
		}
	}

	walk( root );
	results.sort();
	return results;
}

/**
 * Check if a relative path matches any exclusion prefix.
 *
 * @param {string}   rel       - Relative path.
 * @param {string[]} exclusions - Exclusion prefixes.
 * @return {boolean}
 */
function isExcluded( rel, exclusions ) {
	for ( const ex of exclusions ) {
		if ( rel === ex || rel.startsWith( ex + '/' ) ) {
			return true;
		}
	}

	return false;
}

/* ──────────────────────────────────────────────────────────────────────────── */
/*  Version stamping                                                           */
/* ──────────────────────────────────────────────────────────────────────────── */

/**
 * Replace version placeholders and dev versions in PHP content.
 *
 * @param {string} text            - PHP file content.
 * @param {string} ver             - Version to stamp.
 * @param {RegExp} constantPattern - Matcher for the configured version constant.
 * @return {string}
 */
function stampVersion( text, ver, constantPattern ) {
	// Plugin header: " * Version:     X.Y.Z"
	text = text.replace(
		/^(\s*\*\s*Version:\s+).+$/m,
		`$1${ ver }`
	);

	// The configured version constant.
	text = text.replace( constantPattern, `$1${ ver }$2` );

	return text;
}

/**
 * Replace the Stable tag in readme.txt content.
 *
 * Kept separate from stampVersion(): the plugin-header pattern requires a
 * leading `*`, which no readme line carries, and the anchored Stable tag
 * pattern would be dead weight on every PHP file in the tree.
 *
 * @param {string} text - readme.txt content.
 * @param {string} ver  - Version to stamp.
 * @return {string}
 */
function stampReadmeVersion( text, ver ) {
	// Anchored to column 0: readme bullets start with "* ", so the field header
	// is the only line that can match.
	const pattern = /^(Stable tag:).*$/gm;
	const found = text.match( pattern );

	// WordPress.org resolves the download from this field, so a readme without
	// one, or with two, must stop the build rather than produce an artifact that
	// looks built and is unreleasable. A plain replace would no-op in silence.
	if ( ! found || 1 !== found.length ) {
		console.error(
			`readme.txt must contain exactly one 'Stable tag:' line, found ${ found ? found.length : 0 }.`
		);
		process.exit( 1 );
	}

	return text.replace(
		/^(Stable tag:).*$/m,
		`$1 ${ ver }`
	);
}
