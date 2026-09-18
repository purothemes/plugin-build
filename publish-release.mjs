#!/usr/bin/env node
/**
 * Publish a built release ZIP to the update server.
 *
 * Uploads the dist/ artifact named by the config's zipName() to the server's
 * `POST /v1/admin/releases/upload` endpoint (raw ZIP body + metadata in the
 * query string, Bearer ADMIN_TOKEN auth). The server derives the storage path
 * and computes the SHA-256 checksum; this script supplies neither.
 *
 * Every published field is read out of the archive itself: the version and
 * variant from the packaged bootstrap, the compatibility headers and changelog
 * from the packaged readme.txt. The working tree is never consulted, so a ZIP
 * built from an earlier checkout ships the notes it was built with.
 *
 * Everything product-specific comes from build-config.mjs at the consuming
 * plugin root; see load-config.mjs for the contract.
 *
 * Usage:
 *   node publish-release.mjs -v 1.3.0 [--channel <variant>]
 *
 * Environment:
 *   PURO_API_BASE    Base URL of the update server. Default: the config's
 *                    publish.apiBase.
 *   PURO_ADMIN_TOKEN REQUIRED bearer token for /v1/admin/* routes. Never
 *                    hardcoded; the script exits non-zero if it is unset.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { releaseVersionError } from './release-version.mjs';
import { loadBuildConfig, assertZipName } from './load-config.mjs';

const ROOT = join( import.meta.dirname, '..' );

/* ──────────────────────────────────────────────────────────────────────────── */
/*  CLI argument parsing                                                       */
/* ──────────────────────────────────────────────────────────────────────────── */

/**
 * Parse CLI args into { version, channel }.
 *
 * Pure: the channel default comes from the config, applied by main(), so the
 * parser reports only what was actually passed ('' when --channel is absent).
 *
 * @param {string[]} argv - Args after the node script path (process.argv.slice(2)).
 * @return {{ version: string, channel: string }}
 */
export function parseArgs( argv ) {
	let version = '';
	let channel = '';

	for ( let i = 0; i < argv.length; i++ ) {
		if ( argv[ i ] === '-v' && argv[ i + 1 ] ) {
			version = argv[ i + 1 ];
			i++;
		} else if ( argv[ i ] === '--channel' && argv[ i + 1 ] ) {
			channel = argv[ i + 1 ];
			i++;
		}
	}

	return { version, channel };
}

/* ──────────────────────────────────────────────────────────────────────────── */
/*  readme.txt parsing                                                         */
/* ──────────────────────────────────────────────────────────────────────────── */

/**
 * Extract the WordPress compatibility headers from readme.txt content.
 *
 * Pure over whatever readme text it is handed; main() hands it the copy packaged
 * inside the artifact, so published metadata matches the ZIP being shipped.
 * Missing fields are returned as undefined (the server applies its own defaults).
 *
 * @param {string} readmeText - Raw readme.txt contents.
 * @return {{ requires_wp?: string, tested_wp?: string, requires_php?: string }}
 */
export function parseReadmeMeta( readmeText ) {
	const grab = ( label ) => {
		const m = readmeText.match(
			new RegExp( '^' + label + ':\\s*(.+?)\\s*$', 'mi' )
		);
		return m ? m[ 1 ] : undefined;
	};

	return {
		requires_wp: grab( 'Requires at least' ),
		tested_wp: grab( 'Tested up to' ),
		requires_php: grab( 'Requires PHP' ),
	};
}

/**
 * Read one entry out of a ZIP as UTF-8 text.
 *
 * @param {string} zipPath - Path to the archive.
 * @param {string} entry   - In-zip path of the entry.
 * @return {string|null} The entry's text, or null when the archive has no such
 *         entry (unzip status 11). Any other failure, such as a corrupt archive
 *         or a missing unzip binary, is thrown so it is never mistaken for an
 *         absent entry.
 */
function readZipEntry( zipPath, entry ) {
	try {
		return execFileSync( 'unzip', [ '-p', zipPath, entry ], {
			encoding: 'utf8',
			maxBuffer: 4 * 1024 * 1024,
			stdio: [ 'ignore', 'pipe', 'ignore' ]
		} );
	} catch ( err ) {
		if ( 11 === err.status ) {
			return null;
		}
		throw err;
	}
}

/**
 * Read what a built artifact actually is, from the packaged bootstrap header.
 *
 * The filename is a label; this is the plugin the archive installs as.
 *
 * The variant comes from the configured package-variant constant, which the bootstrap
 * declares outright and which gates Pro's licensing and update boot. A header
 * such as `Update URI:` only correlates with Pro; the constant states it.
 *
 * The runtime version is read separately from the header. The build stamps both
 * together, so a ZIP where they disagree was not produced by one. The configured
 * version constant drives update comparisons and asset versions once installed;
 * the header is what the release metadata is taken from.
 *
 * @param {string} zipPath - Path to the release ZIP.
 * @param {object} config  - Loaded build config (publish.inZipProbe, versionConstant,
 *                           publish.packageVariantConstant).
 * @return {{version: string, runtimeVersion: string, variant: string}} Empty
 *         strings when unreadable.
 */
function readArtifactIdentity( zipPath, config ) {
	let php;

	try {
		php = readZipEntry( zipPath, config.publish.inZipProbe );
	} catch {
		php = null;
	}

	if ( null === php ) {
		return { version: '', runtimeVersion: '', variant: '' };
	}

	const version = php.match( /^ \* Version:\s+(.+)$/m );
	const runtime = php.match( new RegExp( `define\\(\\s*'${ config.versionConstant }',\\s*'([^']*)'` ) );
	const variant = php.match( new RegExp( `define\\(\\s*'${ config.publish.packageVariantConstant }',\\s*'([^']*)'` ) );

	return {
		version: version ? version[ 1 ].trim() : '',
		runtimeVersion: runtime ? runtime[ 1 ] : '',
		variant: variant ? variant[ 1 ] : ''
	};
}

/**
 * Extract the changelog entry for a specific version and render it to HTML.
 *
 * Finds the `= <version> =` heading inside the `== Changelog ==` section and
 * captures the lines up to the next `=`/`==` heading. `* item` bullets become a
 * `<ul><li>…</li></ul>`; any non-bullet lines are emitted as `<p>` paragraphs.
 * Returns '' when the section or version entry is absent; publishing treats that
 * as a hard error rather than shipping another version's notes.
 *
 * @param {string} readmeText - Raw readme.txt contents.
 * @param {string} version    - Version to extract (exact match).
 * @return {string} HTML string, or '' when no matching entry exists.
 */
export function parseChangelogHtml( readmeText, version ) {
	// Isolate the Changelog section: the lines after its heading, up to the
	// next `== Section ==` heading or EOF. Done line by line so an empty
	// section stays empty instead of running on into the section after it.
	const allLines = readmeText.split( /\r?\n/ );
	const start = allLines.findIndex( ( line ) => /^==\s*Changelog\s*==\s*$/i.test( line ) );
	if ( -1 === start ) {
		return '';
	}

	let end = allLines.findIndex( ( line, index ) => index > start && /^==\s/.test( line ) );
	if ( -1 === end ) {
		end = allLines.length;
	}

	const lines = allLines.slice( start + 1, end );

	// Escape for use in a RegExp (version may contain dots).
	const escaped = version.replace( /[.*+?^${}()|[\]\\]/g, '\\$&' );
	const headingRe = new RegExp( '^=\\s*' + escaped + '\\s*=\\s*$' );

	let i = 0;
	while ( i < lines.length && ! headingRe.test( lines[ i ] ) ) {
		i++;
	}
	if ( i >= lines.length ) {
		return ''; // Version entry not found.
	}

	// Collect body lines until the next heading (`= … =`) or section divider.
	const body = [];
	for ( let j = i + 1; j < lines.length; j++ ) {
		if ( /^=/.test( lines[ j ].trim() ) ) {
			break;
		}
		body.push( lines[ j ] );
	}

	const bullets = [];
	const paragraphs = [];
	for ( const raw of body ) {
		const line = raw.trim();
		if ( ! line ) {
			continue;
		}
		const bulletMatch = line.match( /^[*-]\s+(.*)$/ );
		if ( bulletMatch ) {
			bullets.push( escapeHtml( bulletMatch[ 1 ].trim() ) );
		} else {
			paragraphs.push( escapeHtml( line ) );
		}
	}

	let html = '';
	for ( const p of paragraphs ) {
		html += `<p>${ p }</p>`;
	}
	if ( bullets.length > 0 ) {
		html += '<ul>' + bullets.map( ( b ) => `<li>${ b }</li>` ).join( '' ) + '</ul>';
	}

	return html;
}

/**
 * Minimal HTML-escape for changelog text nodes.
 *
 * @param {string} s - Raw text.
 * @return {string}
 */
function escapeHtml( s ) {
	return s
		.replace( /&/g, '&amp;' )
		.replace( /</g, '&lt;' )
		.replace( />/g, '&gt;' );
}

/* ──────────────────────────────────────────────────────────────────────────── */
/*  URL building                                                               */
/* ──────────────────────────────────────────────────────────────────────────── */

/**
 * Build the upload URL with all metadata correctly encoded in the query.
 *
 * Required keys (product_slug, version, channel) are always present; optional
 * keys (requires_wp, requires_php, tested_wp, changelog) are appended only when
 * truthy so the server applies its own defaults for anything omitted.
 *
 * @param {string} base - API base URL (no trailing path required).
 * @param {object} meta - { product_slug, version, channel, requires_wp?,
 *                          requires_php?, tested_wp?, changelog? }
 * @return {string} Fully-encoded upload URL.
 */
export function buildUploadUrl( base, meta ) {
	const url = new URL( '/v1/admin/releases/upload', base );
	const params = url.searchParams;

	params.set( 'product_slug', meta.product_slug );
	params.set( 'version', meta.version );
	params.set( 'channel', meta.channel );

	for ( const key of [ 'requires_wp', 'requires_php', 'tested_wp', 'changelog' ] ) {
		if ( meta[ key ] ) {
			params.set( key, meta[ key ] );
		}
	}

	return url.toString();
}

/* ──────────────────────────────────────────────────────────────────────────── */
/*  Upload                                                                     */
/* ──────────────────────────────────────────────────────────────────────────── */

/**
 * Lowercase hex SHA-256 of a Buffer/Uint8Array — matches the server's checksum.
 *
 * @param {Buffer|Uint8Array} bytes - Bytes to hash.
 * @return {string} Lowercase hex digest.
 */
export function sha256Hex( bytes ) {
	return createHash( 'sha256' ).update( bytes ).digest( 'hex' );
}

/**
 * POST the raw ZIP bytes to the update server's upload endpoint.
 *
 * Matches the endpoint's Option-1 contract: raw body + query metadata, Bearer
 * auth, application/zip. Returns the parsed server response on 2xx; throws an
 * Error carrying the server's {error} (or status text) on non-2xx.
 *
 * @param {object} args
 * @param {string} args.url        - Fully-built upload URL (see buildUploadUrl).
 * @param {string} args.token      - PURO_ADMIN_TOKEN bearer value.
 * @param {Buffer|Uint8Array} args.bytes - Raw ZIP bytes.
 * @param {typeof fetch} [args.fetchImpl] - Injectable fetch (for tests).
 * @return {Promise<object>} Parsed JSON: { success, release_id, r2_path, checksum, bytes }.
 */
export async function uploadRelease( { url, token, bytes, fetchImpl = fetch } ) {
	const res = await fetchImpl( url, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${ token }`,
			'Content-Type': 'application/zip',
		},
		body: bytes,
	} );

	let payload;
	try {
		payload = await res.json();
	} catch {
		payload = null;
	}

	if ( ! res.ok ) {
		const message =
			( payload && payload.error ) ||
			`Upload failed with HTTP ${ res.status }`;
		throw new Error( message );
	}

	return payload;
}

/* ──────────────────────────────────────────────────────────────────────────── */
/*  main                                                                       */
/* ──────────────────────────────────────────────────────────────────────────── */

/**
 * Entry point. Resolves env + the dist ZIP, then uploads it.
 *
 * @return {Promise<void>}
 */
async function main() {
	const parsed = parseArgs( process.argv.slice( 2 ) );
	const version = parsed.version;

	if ( ! version ) {
		console.error( 'Usage: node publish-release.mjs -v <version> [--channel <variant>]' );
		process.exit( 1 );
	}

	let config;

	try {
		config = await loadBuildConfig( ROOT, { requirePublish: true } );
	} catch ( err ) {
		console.error( err.message );
		process.exit( 1 );
	}

	const channel = parsed.channel || config.publish.defaultChannel;
	const channels = Object.keys( config.variants );

	if ( ! channels.includes( channel ) ) {
		console.error( `Invalid --channel '${ channel }': must be one of ${ channels.join( ', ' ) }.` );
		process.exit( 1 );
	}

	// The version becomes part of the artifact path and of the metadata sent to
	// the update server, so it is validated here too rather than trusted from the
	// build: a ZIP may have been produced elsewhere, or by hand.
	const versionError = releaseVersionError( version );

	if ( versionError ) {
		console.error( versionError );
		process.exit( 1 );
	}

	// Fail fast on a missing admin token — never fall back to a hardcoded value.
	const adminToken = process.env.PURO_ADMIN_TOKEN;
	if ( ! adminToken ) {
		console.error(
			'PURO_ADMIN_TOKEN is required but unset. Export the Puro admin token, e.g.\n' +
			'  PURO_ADMIN_TOKEN=… npm run publish:pro -- -v ' + version
		);
		process.exit( 1 );
	}

	const apiBase = process.env.PURO_API_BASE || config.publish.apiBase;

	// dist ZIP naming comes from the same config function the build used, so
	// the two can never disagree about an artifact's name.
	const zipName = assertZipName( config.zipName( channel, version ) );
	const zipPath = join( ROOT, 'dist', zipName );

	if ( ! existsSync( zipPath ) ) {
		console.error(
			`Release artifact not found: dist/${ zipName }\n` +
			`Build it first, e.g.\n  npm run build:${ channel } -- -v ${ version }`
		);
		process.exit( 1 );
	}

	// The artifact is whatever is sitting at that path, which is not necessarily
	// what a build just produced: a ZIP keeps whatever filename it is given, and
	// the name is the only thing tying it to this release. Publish the wrong bytes
	// and every site on the channel updates to them. So both the version and the
	// variant are read back out of the archive and must agree with the request.
	//
	// The variant matters as much as the version: a Free ZIP renamed to the Pro
	// filename carries the same version and the same in-zip paths, and sending it
	// to the Pro channel would hand paying sites the Free plugin. It is read from
	// the configured package-variant constant, which the bootstrap declares
	// outright.
	const artifact = readArtifactIdentity( zipPath, config );

	const rebuild = `Rebuild it:\n  npm run build:${ channel } -- -v ${ version }`;

	if ( artifact.version !== version ) {
		console.error( `dist/${ zipName } contains version ${ artifact.version }, not ${ version }.\n${ rebuild }` );
		process.exit( 1 );
	}

	// The version constant is what the installed plugin reports to update checks
	// and hangs on its asset URLs. The build stamps it with the header, so the
	// two disagreeing means this archive did not come from one.
	if ( artifact.runtimeVersion !== version ) {
		console.error( `dist/${ zipName } declares ${ config.versionConstant } ${ artifact.runtimeVersion }, not ${ version }.\n${ rebuild }` );
		process.exit( 1 );
	}

	if ( artifact.variant !== channel ) {
		console.error( `dist/${ zipName } is the ${ artifact.variant } build, not ${ channel }.\n${ rebuild }` );
		process.exit( 1 );
	}

	// Compatibility headers + changelog come from the readme packaged inside the
	// artifact, not from the working tree: the tree may have moved on since this
	// ZIP was built, and the notes that ship must be the ones it was built with.
	// The build writes the readme at <slug>/readme.txt, the same root it gives
	// every entry.
	const readmeEntry = `${ config.variants[ channel ].slug }/readme.txt`;
	let readmeText;

	try {
		readmeText = readZipEntry( zipPath, readmeEntry );
	} catch ( err ) {
		console.error( `Could not read ${ readmeEntry } from dist/${ zipName }: ${ err.message }` );
		process.exit( 1 );
	}

	if ( null === readmeText ) {
		console.error( `dist/${ zipName } has no ${ readmeEntry }.\n${ rebuild }` );
		process.exit( 1 );
	}

	const readmeMeta = parseReadmeMeta( readmeText );
	const changelog = parseChangelogHtml( readmeText, version );

	// The changelog is the one release field the build does not stamp, so it is
	// the one that can silently disagree with the version being shipped. Puro
	// substitutes its own default for an empty changelog, which would publish a
	// release whose notes belong to a different version, or to nothing at all.
	if ( '' === changelog ) {
		console.error(
			`No changelog entry for ${ version } in dist/${ zipName } (${ readmeEntry }).\n` +
			`Add a '= ${ version } =' section under '== Changelog ==' in readme.txt and rebuild.`
		);
		process.exit( 1 );
	}

	const uploadUrl = buildUploadUrl( apiBase, {
		product_slug: config.publish.productSlug,
		version,
		channel,
		requires_wp: readmeMeta.requires_wp,
		requires_php: readmeMeta.requires_php,
		tested_wp: readmeMeta.tested_wp,
		changelog: changelog || undefined,
	} );

	const bytes = readFileSync( zipPath );
	const localChecksum = sha256Hex( bytes );

	console.log( `Uploading dist/${ zipName } (${ bytes.length } bytes) → ${ apiBase } …` );

	let result;
	try {
		result = await uploadRelease( {
			url: uploadUrl,
			token: adminToken,
			bytes,
		} );
	} catch ( err ) {
		console.error( `Publish failed: ${ err.message }` );
		process.exit( 1 );
	}

	console.log( 'Published release:' );
	console.log( `  release_id: ${ result.release_id }` );
	console.log( `  r2_path:    ${ result.r2_path }` );
	console.log( `  checksum:   ${ result.checksum }` );
	console.log( `  bytes:      ${ result.bytes }` );

	// Cross-check the server checksum against a locally computed one. Non-fatal:
	// it catches a truncated/corrupted upload without making the server's
	// authoritative-checksum design redundant.
	if ( result.checksum && result.checksum !== localChecksum ) {
		console.warn(
			`⚠️  Checksum mismatch — server ${ result.checksum } ` +
			`!= local ${ localChecksum }. The uploaded bytes may be corrupted.`
		);
	}
}

// Only run when invoked directly (not when imported by tests).
if ( process.argv[ 1 ] && import.meta.url === `file://${ process.argv[ 1 ] }` ) {
	main();
}

export { main };
