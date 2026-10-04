#!/usr/bin/env node
/**
 * Stage a built release ZIP into a WordPress.org SVN working copy, and commit
 * it only when asked.
 *
 * One release is three changes to the plugin's SVN repository, staged together
 * so they land in one commit:
 *
 *   - trunk/ becomes exactly the ZIP's contents: new files are svn-added,
 *     files the ZIP no longer carries are svn-removed;
 *   - trunk/ is copied to tags/<version>/, which must not exist yet;
 *   - assets/ becomes exactly the plugin's .wordpress-org/ directory, with
 *     svn:mime-type set on every image so WordPress.org serves it inline.
 *
 * The default is a dry run: the changes are staged in a scratch copy of the
 * working copy, its `svn status` is printed, and the scratch copy is deleted.
 * The working copy itself is untouched. `--commit` stages them in the working
 * copy and commits.
 *
 * Before anything is staged, the artifact is read back the way publish-release
 * reads it: its version and variant must agree with the request, and its
 * readme's Stable tag (which becomes trunk/readme.txt) must equal the version,
 * because WordPress.org serves whichever tag the Stable tag names.
 *
 * Everything product-specific comes from build-config.mjs at the consuming
 * plugin root; see load-config.mjs for the contract.
 *
 * Usage:
 *   node publish-wporg.mjs --variant <name> -v <version> --svn <working copy>
 *                          [--root <plugin root>] [--commit]
 *
 * The working copy is a checkout of the repository root (trunk/, tags/,
 * assets/ beneath it). It must have no local changes.
 */

import { execFileSync } from 'node:child_process';
import { cpSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { releaseVersionError } from './release-version.mjs';
import { loadBuildConfig, assertZipName } from './load-config.mjs';
import { readZipEntry, readArtifactIdentity } from './publish-release.mjs';

const ROOT_DEFAULT = join( import.meta.dirname, '..' );

/** The source directory, under the plugin root, of the SVN assets/ directory. */
const ASSETS_SOURCE = '.wordpress-org';

/**
 * svn:mime-type for listing art. Without it SVN serves images as
 * application/octet-stream and the plugin page downloads them, not shows them.
 */
export const MIME_TYPES = {
	'.png': 'image/png',
	'.jpg': 'image/jpeg',
	'.jpeg': 'image/jpeg',
	'.gif': 'image/gif',
	'.svg': 'image/svg+xml',
};

/* ──────────────────────────────────────────────────────────────────────────── */
/*  CLI argument parsing                                                       */
/* ──────────────────────────────────────────────────────────────────────────── */

/**
 * Parse argv. An unrecognised flag is an error, never silently ignored: a typo
 * of --commit must not quietly become a dry run, nor the other way round.
 *
 * @param {string[]} argv - Args after the node script path.
 * @return {{ version: string, variant: string, svn: string, root: string, commit: boolean }}
 */
export function parseArgs( argv ) {
	const options = { version: '', variant: '', svn: '', root: '', commit: false };
	const valued = { '-v': 'version', '--variant': 'variant', '--svn': 'svn', '--root': 'root' };

	for ( let i = 0; i < argv.length; i++ ) {
		const arg = argv[ i ];

		if ( '--commit' === arg ) {
			options.commit = true;
		} else if ( valued[ arg ] ) {
			const value = argv[ ++i ];

			if ( ! value ) {
				throw new Error( `${ arg } requires a value.` );
			}

			options[ valued[ arg ] ] = value;
		} else {
			throw new Error( `Unknown argument "${ arg }".` );
		}
	}

	return options;
}

/* ──────────────────────────────────────────────────────────────────────────── */
/*  readme.txt                                                                 */
/* ──────────────────────────────────────────────────────────────────────────── */

/**
 * The Stable tag header of a readme.txt, or '' when it has none or it is blank.
 *
 * The value is read from the header's own line only. A blank header must stay
 * blank: read across the line break, it would take the next line as its value.
 *
 * @param {string} readmeText - Raw readme.txt contents.
 * @return {string}
 */
export function parseStableTag( readmeText ) {
	const match = readmeText.match( /^Stable tag:[ \t]*([^\r\n]*)/mi );

	return match ? match[ 1 ].trim() : '';
}

/* ──────────────────────────────────────────────────────────────────────────── */
/*  svn                                                                        */
/* ──────────────────────────────────────────────────────────────────────────── */

/**
 * Run a non-interactive svn command and return its stdout.
 *
 * @param {string[]} args  - svn arguments.
 * @param {string}   [cwd] - Working directory.
 * @return {string}
 */
function svn( args, cwd ) {
	return execFileSync( 'svn', [ '--non-interactive', ...args ], {
		cwd,
		encoding: 'utf8',
		maxBuffer: 64 * 1024 * 1024,
		stdio: [ 'ignore', 'pipe', 'pipe' ],
	} );
}

/**
 * A working-copy path as an svn argument. svn reads the last @ in a path as a
 * peg revision, so `icon@2x.png` names `icon` at revision `2x.png`; a trailing
 * @ is an empty peg and leaves the path as written. Every working-copy path
 * passed to svn goes through here, not only the ones known to hold an @.
 *
 * @param {string} path - Working-copy path.
 * @return {string}
 */
export function wcArg( path ) {
	return `${ path }@`;
}

/**
 * Whether a repository URL exists. A missing path is the only failure read as
 * "no"; anything else (a network error, a bad URL) is thrown, so an
 * unreachable server can never pass for an absent tag.
 *
 * @param {string} url - Repository URL.
 * @return {boolean}
 */
function svnUrlExists( url ) {
	try {
		svn( [ 'info', url ] );
		return true;
	} catch ( err ) {
		if ( /W170000|E170000/.test( String( err.stderr ) ) ) {
			return false;
		}
		throw new Error( `svn info ${ url } failed: ${ String( err.stderr || err.message ).trim() }` );
	}
}

/**
 * Every file and directory under a directory, as relative path → kind.
 * Sorted, so a parent always comes before its children.
 *
 * @param {string}   dir     - Directory to walk.
 * @param {string[]} skip    - Basenames skipped anywhere (with their subtrees).
 * @param {string}   [base]  - Path prefix, for recursion.
 * @return {Map<string, 'file'|'dir'>}
 */
function listTree( dir, skip, base = '' ) {
	const tree = new Map();

	for ( const entry of readdirSync( dir, { withFileTypes: true } ).sort( ( a, b ) => a.name.localeCompare( b.name ) ) ) {
		if ( skip.includes( entry.name ) ) {
			continue;
		}

		const rel = base ? `${ base }/${ entry.name }` : entry.name;

		if ( entry.isDirectory() ) {
			tree.set( rel, 'dir' );
			for ( const [ childPath, kind ] of listTree( join( dir, entry.name ), skip, rel ) ) {
				tree.set( childPath, kind );
			}
		} else {
			tree.set( rel, 'file' );
		}
	}

	return tree;
}

/**
 * Make a versioned directory hold exactly what a source directory holds.
 *
 * Whatever the source lacks, or holds as the other kind (a file that became a
 * directory), is svn-removed. Then every source entry is copied in and the
 * tree is svn-added; --no-ignore so svn's global ignores never drop a file the
 * source ships.
 *
 * @param {string}   source - Directory to mirror.
 * @param {string}   target - Versioned directory in the working copy.
 * @param {string[]} skip   - Basenames never taken from the source.
 */
export function mirrorIntoSvn( source, target, skip ) {
	const wanted = listTree( source, skip );
	const removed = [];

	for ( const [ rel, kind ] of listTree( target, [ '.svn' ] ) ) {
		if ( removed.some( ( parent ) => rel.startsWith( `${ parent }/` ) ) ) {
			continue;
		}

		if ( wanted.get( rel ) !== kind ) {
			svn( [ 'rm', '--force', '--quiet', wcArg( join( target, rel ) ) ] );
			removed.push( rel );
		}
	}

	for ( const [ rel, kind ] of wanted ) {
		if ( 'dir' === kind ) {
			mkdirSync( join( target, rel ), { recursive: true } );
		} else {
			copyFileSync( join( source, rel ), join( target, rel ) );
		}
	}

	svn( [ 'add', '--force', '--no-ignore', '--quiet', wcArg( target ) ] );
}

/**
 * Set svn:mime-type on every image under a directory whose type is missing or
 * wrong. Files already right are left alone, so a release that changes no art
 * shows no property changes.
 *
 * @param {string} dir - Versioned directory in the working copy.
 */
export function setImageMimeTypes( dir ) {
	for ( const [ rel, kind ] of listTree( dir, [ '.svn' ] ) ) {
		const mime = MIME_TYPES[ extname( rel ).toLowerCase() ];

		if ( 'file' !== kind || ! mime ) {
			continue;
		}

		const path = join( dir, rel );
		let current = '';

		try {
			current = svn( [ 'propget', 'svn:mime-type', wcArg( path ) ] ).trim();
		} catch ( err ) {
			// W200017: the property is not set. Older svn prints nothing instead.
			if ( ! /W200017/.test( String( err.stderr ) ) ) {
				throw err;
			}
		}

		if ( current !== mime ) {
			svn( [ 'propset', '--quiet', 'svn:mime-type', mime, wcArg( path ) ] );
		}
	}
}

/**
 * Stage one release in a working copy: trunk, assets, then the tag.
 *
 * @param {object}   args
 * @param {string}   args.wc          - Working copy root.
 * @param {string}   args.pluginDir   - Extracted plugin directory (the ZIP's root).
 * @param {string}   args.assetsDir   - Listing art source, or '' to leave assets/ alone.
 * @param {string}   args.version     - Release version.
 * @param {string[]} args.skip        - Basenames never taken from a source.
 */
export function stageRelease( { wc, pluginDir, assetsDir, version, skip } ) {
	for ( const dir of [ 'trunk', 'tags', 'assets' ] ) {
		if ( ! existsSync( join( wc, dir ) ) ) {
			svn( [ 'mkdir', '--quiet', wcArg( join( wc, dir ) ) ] );
		}
	}

	const tag = join( wc, 'tags', version );

	if ( existsSync( tag ) ) {
		throw new Error( `tags/${ version } already exists in the working copy. A released tag is never rewritten; release a new version.` );
	}

	mirrorIntoSvn( pluginDir, join( wc, 'trunk' ), skip );

	// The ZIP's readme was checked before staging. Re-read the staged copy: it
	// is the file WordPress.org reads, and the check must hold for it.
	const stable = parseStableTag( readFileSync( join( wc, 'trunk', 'readme.txt' ), 'utf8' ) );

	if ( stable !== version ) {
		throw new Error( `trunk/readme.txt Stable tag is '${ stable }', not ${ version }.` );
	}

	if ( assetsDir ) {
		mirrorIntoSvn( assetsDir, join( wc, 'assets' ), skip );
		setImageMimeTypes( join( wc, 'assets' ) );
	}

	svn( [ 'cp', '--quiet', wcArg( join( wc, 'trunk' ) ), wcArg( tag ) ] );
}

/**
 * Count status lines per area: trunk, assets, and the tag.
 *
 * @param {string} status  - `svn status` output, paths relative to the WC root.
 * @param {string} version - Release version.
 * @return {string[]} One summary line per area with changes.
 */
export function summarizeStatus( status, version ) {
	const areas = new Map();
	const words = { A: 'added', D: 'deleted', M: 'modified', R: 'replaced' };

	for ( const line of status.split( '\n' ) ) {
		if ( line.length < 9 ) {
			continue;
		}

		const path = line.slice( 8 );
		const area = path.startsWith( `tags/${ version }` ) ? `tags/${ version }` : path.split( '/' )[ 0 ];
		const counts = areas.get( area ) || {};
		const word = words[ line[ 0 ] ] || ( 'M' === line[ 1 ] ? 'properties set' : 'other' );

		counts[ word ] = ( counts[ word ] || 0 ) + 1;
		areas.set( area, counts );
	}

	// The tag's lines repeat trunk's, relative to the last commit, so they are
	// named for what they are rather than counted again.
	return [ ...areas ].map( ( [ area, counts ] ) => `tags/${ version }` === area
		? `${ area }: copy of trunk`
		: `${ area }: ` + Object.values( words ).concat( 'properties set', 'other' )
			.filter( ( word ) => counts[ word ] )
			.map( ( word ) => `${ counts[ word ] } ${ word }` )
			.join( ', ' )
	);
}

/* ──────────────────────────────────────────────────────────────────────────── */
/*  main                                                                       */
/* ──────────────────────────────────────────────────────────────────────────── */

function fail( message ) {
	console.error( message );
	process.exit( 1 );
}

/**
 * Entry point.
 *
 * @return {Promise<void>}
 */
async function main() {
	let options;

	try {
		options = parseArgs( process.argv.slice( 2 ) );
	} catch ( err ) {
		fail( err.message );
	}

	const { version, variant } = options;

	if ( ! version || ! variant || ! options.svn ) {
		fail( 'Usage: node publish-wporg.mjs --variant <name> -v <version> --svn <working copy> [--root <plugin root>] [--commit]' );
	}

	const versionError = releaseVersionError( version );

	if ( versionError ) {
		fail( versionError );
	}

	const root = resolve( options.root || ROOT_DEFAULT );
	let config;

	try {
		config = await loadBuildConfig( root, { requireIdentity: true } );
	} catch ( err ) {
		fail( err.message );
	}

	if ( ! config.variants[ variant ] ) {
		fail( `Unknown --variant '${ variant }': must be one of ${ Object.keys( config.variants ).join( ', ' ) }.` );
	}

	const zipName = assertZipName( config.zipName( variant, version ) );
	const zipPath = join( root, 'dist', zipName );
	const rebuild = `Rebuild it:\n  npm run build:${ variant } -- -v ${ version }`;

	if ( ! existsSync( zipPath ) ) {
		fail( `Release artifact not found: dist/${ zipName }\n${ rebuild }` );
	}

	// One private copy of the bytes: every check and the extraction run against
	// it, never against a dist/ that a build may be rewriting.
	const scratch = mkdtempSync( join( tmpdir(), 'publish-wporg-' ) );

	process.on( 'exit', () => rmSync( scratch, { recursive: true, force: true } ) );
	process.on( 'SIGINT', () => process.exit( 130 ) );
	process.on( 'SIGTERM', () => process.exit( 143 ) );

	const snapshot = join( scratch, zipName );
	copyFileSync( zipPath, snapshot );

	// What the archive is, not what its name says: the Pro build under the Free
	// name would put paid code on WordPress.org.
	let artifact;

	try {
		artifact = readArtifactIdentity( snapshot, config );
	} catch ( err ) {
		fail( `Could not read ${ config.publish.inZipProbe } from dist/${ zipName }: ${ err.message }` );
	}

	if ( artifact.version !== version || artifact.runtimeVersion !== version ) {
		fail( `dist/${ zipName } is version ${ artifact.version } (${ config.versionConstant } ${ artifact.runtimeVersion }), not ${ version }.\n${ rebuild }` );
	}

	if ( artifact.variant !== variant ) {
		fail( `dist/${ zipName } is the ${ artifact.variant } build, not ${ variant }.\n${ rebuild }` );
	}

	const slug = config.variants[ variant ].slug;
	const readmeText = readZipEntry( snapshot, `${ slug }/readme.txt` );

	if ( null === readmeText ) {
		fail( `dist/${ zipName } has no ${ slug }/readme.txt.\n${ rebuild }` );
	}

	const stable = parseStableTag( readmeText );

	if ( stable !== version ) {
		fail( `Refusing: ${ slug }/readme.txt in dist/${ zipName } has Stable tag '${ stable }', not ${ version }. It becomes trunk/readme.txt, and WordPress.org serves the tag it names.` );
	}

	const extracted = join( scratch, 'zip' );
	execFileSync( 'unzip', [ '-q', snapshot, '-d', extracted ] );

	const roots = readdirSync( extracted );

	if ( 1 !== roots.length || roots[ 0 ] !== slug || ! statSync( join( extracted, slug ) ).isDirectory() ) {
		fail( `dist/${ zipName } must hold one top-level ${ slug }/ directory; found: ${ roots.join( ', ' ) }.` );
	}

	// The working copy: the repository root, with nothing pending, so the
	// status printed below is this release and nothing else.
	const wc = resolve( options.svn );
	let repoRoot;

	try {
		const relative = svn( [ 'info', '--show-item', 'relative-url', wcArg( wc ) ] ).trim();

		if ( '^/' !== relative ) {
			fail( `${ wc } is a checkout of ${ relative }, not of the repository root. Check out the root: trunk/, tags/ and assets/ are all staged.` );
		}

		repoRoot = svn( [ 'info', '--show-item', 'repos-root-url', wcArg( wc ) ] ).trim();
	} catch ( err ) {
		fail( `${ wc } is not an svn working copy: ${ String( err.stderr || err.message ).trim() }` );
	}

	const pending = svn( [ 'status', '--no-ignore' ], wc ).trimEnd();

	if ( pending ) {
		fail( `${ wc } has local changes. Revert or commit them first:\n${ pending }` );
	}

	// A sparse checkout may not hold every tag, so the repository is asked too.
	let tagExists;

	try {
		tagExists = svnUrlExists( `${ repoRoot }/tags/${ version }` );
	} catch ( err ) {
		fail( err.message );
	}

	if ( tagExists ) {
		fail( `tags/${ version } already exists in ${ repoRoot }. A released tag is never rewritten; release a new version.` );
	}

	const assetsDir = join( root, ASSETS_SOURCE );
	let target = wc;

	if ( ! options.commit ) {
		target = join( scratch, 'wc' );
		cpSync( wc, target, { recursive: true } );
	}

	try {
		stageRelease( {
			wc: target,
			pluginDir: join( extracted, slug ),
			assetsDir: existsSync( assetsDir ) ? assetsDir : '',
			version,
			skip: config.excludeBasenames || [],
		} );
	} catch ( err ) {
		fail( `${ err.message.trim() }${ options.commit ? `\n${ wc } may hold staged changes; svn revert -R it before retrying.` : '' }` );
	}

	if ( ! existsSync( assetsDir ) ) {
		console.log( `No ${ ASSETS_SOURCE }/ at ${ root }: assets/ left as it is.` );
	}

	const status = svn( [ 'status' ], target ).trimEnd();

	console.log( `svn status for ${ version } (dist/${ zipName } → ${ repoRoot }):\n` );
	console.log( status );
	console.log( '' );
	for ( const line of summarizeStatus( status, version ) ) {
		console.log( line );
	}
	console.log( `trunk/readme.txt Stable tag: ${ version }` );

	if ( ! options.commit ) {
		console.log( `\nDry run: staged in a scratch copy; ${ wc } is unchanged. Re-run with --commit to commit.` );
		return;
	}

	// Interactive, so svn can ask for the WordPress.org password.
	execFileSync( 'svn', [ 'commit', '-m', `Release ${ version }`, wcArg( wc ) ], { stdio: 'inherit' } );

	// Read the result back from the repository, not the working copy.
	for ( const path of [ 'trunk/readme.txt', `tags/${ version }/readme.txt` ] ) {
		const committed = parseStableTag( svn( [ 'cat', `${ repoRoot }/${ path }` ] ) );

		if ( committed !== version ) {
			fail( `Committed ${ path } has Stable tag '${ committed }', not ${ version }.` );
		}
	}

	console.log( `\nCommitted. ${ repoRoot }: trunk/readme.txt and tags/${ version }/readme.txt both say Stable tag ${ version }.` );
}

// Only run when invoked directly (not when imported by tests).
const invokedPath = process.argv[ 1 ] ? realpathSync( process.argv[ 1 ] ) : '';

if ( invokedPath && invokedPath === realpathSync( fileURLToPath( import.meta.url ) ) ) {
	await main();
}

export { main };
