/**
 * Generic tests for the build tooling: config loading and validation, the
 * sync CLI's config-resolution order, and the packager's config-driven
 * guards. Nothing here belongs to any one consuming plugin — every case
 * runs against a throwaway fixture root.
 *
 * CLI cases copy the scripts into a real `build/` directory inside the
 * fixture (never a symlink: Node resolves modules through realpath, so a
 * symlinked mount would point ROOT back at this checkout). Fixture roots
 * live inside this checkout so bare imports (yazl, wp-pot) resolve against
 * its node_modules — or, when mounted as a submodule, the consumer's.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { loadBuildConfig, assertZipName } from '../load-config.mjs';

const SCRIPTS_DIR = join( import.meta.dirname, '..' );
const TMP_BASE = join( import.meta.dirname, '.test-tmp' );

mkdirSync( TMP_BASE, { recursive: true } );

/** A minimal, valid config body (as source text for fixture files). */
const VALID_CONFIG = `export default {
	textDomain: 'fixture',
	versionConstant: 'FIXTURE_VERSION',
	tempSuffix: '.fixture-tmp',
	globalExclude: [ 'build', 'build-config.mjs', 'dist', 'node_modules' ],
	potExclude: [],
	overlayDir: 'overlays',
	variants: {
		lite: { slug: 'fixture', removedPaths: [], overlayPhpFiles: [], postProcess: [] },
	},
	zipName( variant, version ) { return 'fixture.' + version + '.zip'; },
	potMeta: { package: 'Fixture', bugReport: 'https://example.com', team: 'Example <x@example.com>' },
	publish: {
		productSlug: 'fixture',
		defaultChannel: 'lite',
		apiBase: 'https://example.com',
		inZipProbe: 'fixture/fixture.php',
		packageVariantConstant: 'FIXTURE_VARIANT',
	},
};
`;

function makeRoot( configSource ) {
	const root = mkdtempSync( join( TMP_BASE, 'root-' ) );

	if ( null !== configSource ) {
		writeFileSync( join( root, 'build-config.mjs' ), configSource );
	}

	return root;
}

/**
 * Give a fixture root the one vendored package the sync step insists on:
 * a fake npm package plus the manifest entry that verifies it.
 */
function installFakeVendor( root ) {
	const body = '/* fake vendor bundle */\n';
	const packageRoot = join( root, 'node_modules', 'fake-grid' );

	mkdirSync( join( packageRoot, 'dist' ), { recursive: true } );
	writeFileSync( join( packageRoot, 'package.json' ), JSON.stringify( { name: 'fake-grid', version: '1.0.0' } ) );
	writeFileSync( join( packageRoot, 'dist', 'grid.min.js' ), body );
	writeFileSync( join( root, 'vendor-manifest.json' ), JSON.stringify( {
		'fake-grid': {
			package: 'fake-grid',
			version: '1.0.0',
			license: 'MIT',
			assets: [ {
				sources: [ 'dist/grid.min.js' ],
				target: 'assets/js/vendor/grid.min.js',
				sha256: createHash( 'sha256' ).update( body ).digest( 'hex' ),
			} ],
		},
	}, null, '\t' ) );
}

/** Mount a copy of the scripts at <root>/build, the consuming layout. */
function mountBuild( root ) {
	const buildDir = join( root, 'build' );
	mkdirSync( buildDir );

	for ( const entry of readdirSync( SCRIPTS_DIR ) ) {
		if ( entry.endsWith( '.mjs' ) ) {
			cpSync( join( SCRIPTS_DIR, entry ), join( buildDir, entry ) );
		}
	}

	return buildDir;
}

function runCli( cwd, script, args ) {
	try {
		const stdout = execFileSync( 'node', [ script, ...args ], { cwd, stdio: 'pipe', encoding: 'utf8' } );
		return { status: 0, stdout, stderr: '' };
	} catch ( err ) {
		return { status: err.status ?? 1, stdout: String( err.stdout || '' ), stderr: String( err.stderr || '' ) };
	}
}

try {
	/* ── loadBuildConfig: presence ─────────────────────────────────────── */

	{
		const root = makeRoot( null );
		await assert.rejects(
			loadBuildConfig( root ),
			/No build-config\.mjs found/,
			'a root without a config fails with the clear message'
		);
	}

	{
		const root = makeRoot( VALID_CONFIG );
		const config = loadBuildConfig( root );
		assert.equal( ( await config ).textDomain, 'fixture', 'a valid config loads' );
	}

	{
		const root = makeRoot( 'export const notDefault = 1;\n' );
		await assert.rejects(
			loadBuildConfig( root ),
			/export default/,
			'a config without a default export is refused'
		);
	}

	/* ── loadBuildConfig: one missing key, one wrong type per class ────── */

	{
		const root = makeRoot( VALID_CONFIG.replace( "\ttextDomain: 'fixture',\n", '' ) );
		await assert.rejects(
			loadBuildConfig( root ),
			/"textDomain" must be a plain name/,
			'a missing required string fails naming the key'
		);
	}

	{
		const root = makeRoot( VALID_CONFIG.replace( "globalExclude: [ 'build', 'build-config.mjs', 'dist', 'node_modules' ],", 'globalExclude: 7,' ) );
		await assert.rejects(
			loadBuildConfig( root ),
			/"globalExclude" must be an array of strings/,
			'a wrong-typed array field fails naming the key'
		);
	}

	{
		const root = makeRoot( VALID_CONFIG.replace( "zipName( variant, version ) { return 'fixture.' + version + '.zip'; },", "zipName: 'fixture.zip'," ) );
		await assert.rejects(
			loadBuildConfig( root ),
			/"zipName" must be a function/,
			'a wrong-typed function field fails naming the key'
		);
	}

	{
		const root = makeRoot( VALID_CONFIG.replace( "versionConstant: 'FIXTURE_VERSION',", "versionConstant: 'FIXTURE(VERSION',", ) );
		await assert.rejects(
			loadBuildConfig( root ),
			/"versionConstant" must be a PHP constant name/,
			'a regex metacharacter in a constant name is refused before it can build a pattern'
		);
	}

	{
		const root = makeRoot( VALID_CONFIG.replace( "lite: { slug: 'fixture',", "lite: { slug: '../fixture'," ) );
		await assert.rejects(
			loadBuildConfig( root ),
			/"variants\.lite\.slug" must be a plain name/,
			'a traversal-shaped slug is refused before it can become a zip entry root'
		);
	}

	{
		const root = makeRoot( VALID_CONFIG.replace( 'removedPaths: [], overlayPhpFiles: []', 'removedPaths: [], overlayPhpFiles: {}' ) );
		await assert.rejects(
			loadBuildConfig( root ),
			/"variants\.lite\.overlayPhpFiles" must be an array of strings/,
			'a variant field failure names the variant'
		);
	}

	/* ── the publish subtree is checked only on request ─────────────────── */

	{
		const root = makeRoot( VALID_CONFIG.replace( "\t\tproductSlug: 'fixture',\n", '' ) );
		await loadBuildConfig( root );
		await assert.rejects(
			loadBuildConfig( root, { requirePublish: true } ),
			/"publish\.productSlug" must be a non-empty string/,
			'publish keys bind only when requirePublish is set'
		);
	}

	{
		const root = makeRoot( VALID_CONFIG.replace( "defaultChannel: 'lite',", "defaultChannel: 'pro'," ) );
		await assert.rejects(
			loadBuildConfig( root, { requirePublish: true } ),
			/"publish\.defaultChannel" \("pro"\) must name a variant/,
			'the default channel must exist among the variants'
		);
	}

	/* ── excludeBasenames reaches nested files ──────────────────────────── */

	{
		const { collectFiles } = await import( '../build-release.mjs' );
		const root = makeRoot( null );
		mkdirSync( join( root, 'assets' ) );
		writeFileSync( join( root, 'assets', '.DS_Store' ), 'junk' );
		writeFileSync( join( root, 'assets', 'real.css' ), 'body{}' );

		const shared = { tempSuffix: '.x-tmp', globalExclude: [ 'build-config.mjs' ], excludeBasenames: [ '.DS_Store' ] };
		const collected = collectFiles( root, { removedPaths: [] }, shared );

		assert.ok( collected.includes( join( 'assets', 'real.css' ) ), 'real files are collected' );
		assert.equal( collected.includes( join( 'assets', '.DS_Store' ) ), false, 'a nested excluded basename never ships' );

		const without = collectFiles( root, { removedPaths: [] }, { ...shared, excludeBasenames: undefined } );
		assert.ok( without.includes( join( 'assets', '.DS_Store' ) ), 'and the key is genuinely optional (absent means no basename filter)' );
	}

	/* ── assertZipName ──────────────────────────────────────────────────── */

	assert.equal( assertZipName( 'a.zip' ), 'a.zip' );
	for ( const bad of [ '', 'a.tar', '../a.zip', 'a/b.zip', 'a\\b.zip', 7 ] ) {
		assert.throws( () => assertZipName( bad ), /plain \*\.zip basename/, `zipName result ${ JSON.stringify( bad ) } is refused` );
	}

	/* ── build CLI in a mounted fixture root ────────────────────────────── */

	{
		// No config at the mounted root: the build must fail with the loader's
		// message, before touching anything.
		const root = makeRoot( null );
		mountBuild( root );
		const result = runCli( root, join( root, 'build', 'build-release.mjs' ), [ 'lite', '-v', '1.0.0' ] );
		assert.notEqual( result.status, 0, 'no config, no build' );
		assert.match( result.stderr, /No build-config\.mjs found/, 'and the loader message reaches the CLI user' );
	}

	{
		// A typo'd overlay entry names a file that is never collected: the
		// preflight must refuse before writing a zip.
		const config = VALID_CONFIG.replace(
			'overlayPhpFiles: []',
			"overlayPhpFiles: [ 'no-such-file.php' ]"
		);
		const root = makeRoot( config );
		mountBuild( root );
		// A minimal buildable tree: one collected file, plus the vendored
		// package the sync step (which runs first) insists on having.
		writeFileSync( join( root, 'fixture.php' ), "<?php\n/*\n * Version: 0.0.0\n */\n" );
		installFakeVendor( root );
		const result = runCli( root, join( root, 'build', 'build-release.mjs' ), [ 'lite', '-v', '1.0.0' ] );
		assert.notEqual( result.status, 0, 'a typo overlay entry fails the build' );
		assert.match( result.stderr, /Overlay target not in the collected source set/, 'refused on the collected-set branch' );

		// The other preflight branch: the source file IS collected, but the
		// overlay copy is absent from overlayDir. An implementation that only
		// checked the collected set would pass the case above and ship the
		// un-overlaid file here.
		writeFileSync( join( root, 'build-config.mjs' ), VALID_CONFIG.replace(
			'overlayPhpFiles: []',
			"overlayPhpFiles: [ 'fixture.php' ]"
		) );
		const missingCopy = runCli( root, join( root, 'build', 'build-release.mjs' ), [ 'lite', '-v', '1.0.0' ] );
		assert.notEqual( missingCopy.status, 0, 'a collected target with no overlay copy fails too' );
		assert.match( missingCopy.stderr, /Missing overlay file: overlays\/lite\/fixture\.php/, 'naming the expected overlay path' );
		assert.match( result.stderr, /Overlay target not in the collected source set: no-such-file\.php/, 'naming the entry' );
	}

	/* ── sync CLI config-resolution order ───────────────────────────────── */

	{
		// With a config at --root: the configured suffix is in force. The probe
		// is --check against a root with no manifest, which reports cleanly in
		// both cases; the suffix resolution is what this asserts, via a config
		// whose tempSuffix is deliberately invalid, which must fail validation.
		const root = makeRoot( VALID_CONFIG.replace( "tempSuffix: '.fixture-tmp',", "tempSuffix: 'no-leading-dot'," ) );
		mountBuild( root );
		const result = runCli( root, join( root, 'build', 'sync-vendor-assets.mjs' ), [ '--check', '--root', root ] );
		assert.notEqual( result.status, 0, 'the sync CLI loads and validates the config at --root' );
		assert.match( result.stderr, /"tempSuffix" must be a string starting with "\."/, 'and surfaces its validation' );
	}

	{
		// Without a config: the generic default applies and the CLI still runs.
		const root = makeRoot( null );
		mountBuild( root );
		installFakeVendor( root );
		const result = runCli( root, join( root, 'build', 'sync-vendor-assets.mjs' ), [ '--root', root ] );
		assert.equal( result.status, 0, 'no config falls back to the generic default and still runs' );
		assert.match( result.stdout, /wrote assets\/js\/vendor\/grid\.min\.js/, 'and the sync really happened' );
	}

	console.log( 'Generic build-tooling tests passed.' );
} finally {
	rmSync( TMP_BASE, { recursive: true, force: true } );
}
