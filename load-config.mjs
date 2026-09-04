/**
 * Load and validate a consuming plugin's build-config.mjs.
 *
 * The config file's presence defines a consuming root: no CLI flag, no
 * environment variable. It must `export default { ... }`.
 *
 * Validation is a typo net for first-party configuration, not input
 * hardening: it checks presence, type and shape of every contracted key and
 * fails naming the offending key path. The one stronger check is on
 * zipName()'s return value, applied where it is called, because a bad name
 * there would write outside dist/.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * Required keys outside the publish subtree: [key path, predicate, expected].
 */
const BUILD_RULES = [
	[ 'textDomain', isPathSegment, 'a plain name (letters, digits, ., _, -)' ],
	[ 'versionConstant', isConstantName, 'a PHP constant name' ],
	[ 'tempSuffix', ( v ) => isNonEmptyString( v ) && v.startsWith( '.' ), 'a string starting with "."' ],
	[ 'globalExclude', isStringArray, 'an array of strings' ],
	// Optional: basenames skipped anywhere in the tree (finder junk and the
	// like), unlike globalExclude's root-relative prefixes.
	[ 'excludeBasenames', ( v ) => undefined === v || isStringArray( v ), 'an array of strings when present' ],
	[ 'potExclude', isStringArray, 'an array of strings' ],
	[ 'overlayDir', isNonEmptyString, 'a non-empty string' ],
	[ 'zipName', ( v ) => 'function' === typeof v, 'a function (variant, version) => string' ],
	[ 'potMeta.package', isNonEmptyString, 'a non-empty string' ],
	[ 'potMeta.bugReport', isNonEmptyString, 'a non-empty string' ],
	[ 'potMeta.team', isNonEmptyString, 'a non-empty string' ],
];

/**
 * Required per-variant keys, checked for every entry of config.variants.
 */
const VARIANT_RULES = [
	[ 'slug', isPathSegment, 'a plain name (letters, digits, ., _, -)' ],
	[ 'removedPaths', isStringArray, 'an array of strings' ],
	[ 'overlayPhpFiles', isStringArray, 'an array of strings' ],
	[ 'postProcess', ( v ) => Array.isArray( v ) && v.every( ( f ) => 'function' === typeof f ), 'an array of functions' ],
];

/**
 * Required publish keys, checked only when requirePublish is set.
 */
const PUBLISH_RULES = [
	[ 'publish.productSlug', isNonEmptyString, 'a non-empty string' ],
	[ 'publish.apiBase', isNonEmptyString, 'a non-empty string' ],
	[ 'publish.inZipProbe', isNonEmptyString, 'a non-empty string' ],
	[ 'publish.packageVariantConstant', isConstantName, 'a PHP constant name' ],
];

function isNonEmptyString( value ) {
	return 'string' === typeof value && '' !== value;
}

/**
 * A PHP constant name. These values are interpolated into regexes, so an
 * arbitrary string could crash the build or stamp the wrong constant.
 */
function isConstantName( value ) {
	return 'string' === typeof value && /^[A-Za-z_][A-Za-z0-9_]*$/.test( value );
}

/**
 * A plain name safe as a zip path segment (in-zip roots, the POT filename).
 */
function isPathSegment( value ) {
	return 'string' === typeof value && /^[a-z0-9][a-z0-9._-]*$/i.test( value );
}

function isStringArray( value ) {
	return Array.isArray( value ) && value.every( ( item ) => 'string' === typeof item );
}

function getPath( object, path ) {
	return path.split( '.' ).reduce( ( acc, key ) => ( acc ? acc[ key ] : undefined ), object );
}

/**
 * Load <root>/build-config.mjs, validate it, and return the config object.
 *
 * @param {string}  root                     Consuming plugin root.
 * @param {object}  [options]
 * @param {boolean} [options.requirePublish] Also validate the publish subtree.
 * @return {Promise<object>} The validated config (the module's default export).
 */
export async function loadBuildConfig( root, { requirePublish = false } = {} ) {
	const configPath = join( root, 'build-config.mjs' );

	if ( ! existsSync( configPath ) ) {
		throw new Error(
			`No build-config.mjs found at ${ configPath }. ` +
			'The build tooling reads its configuration from the consuming plugin root.'
		);
	}

	const module = await import( pathToFileURL( configPath ).href );
	const config = module.default;

	if ( ! config || 'object' !== typeof config ) {
		throw new Error( 'build-config.mjs must `export default` a configuration object.' );
	}

	const rules = [ ...BUILD_RULES ];

	if ( requirePublish ) {
		rules.push( [ 'publish.defaultChannel', isNonEmptyString, 'a non-empty string' ], ...PUBLISH_RULES );
	}

	for ( const [ path, predicate, expected ] of rules ) {
		if ( ! predicate( getPath( config, path ) ) ) {
			throw new Error( `build-config.mjs: "${ path }" must be ${ expected }.` );
		}
	}

	if ( ! config.variants || 'object' !== typeof config.variants || 0 === Object.keys( config.variants ).length ) {
		throw new Error( 'build-config.mjs: "variants" must be an object with at least one variant.' );
	}

	for ( const [ name, variant ] of Object.entries( config.variants ) ) {
		for ( const [ path, predicate, expected ] of VARIANT_RULES ) {
			if ( ! predicate( getPath( variant, path ) ) ) {
				throw new Error( `build-config.mjs: "variants.${ name }.${ path }" must be ${ expected }.` );
			}
		}
	}

	if ( requirePublish && ! Object.keys( config.variants ).includes( config.publish.defaultChannel ) ) {
		throw new Error(
			`build-config.mjs: "publish.defaultChannel" ("${ config.publish.defaultChannel }") must name a variant.`
		);
	}

	return config;
}

/**
 * Check a zipName() return value where it is used: a plain basename ending in
 * .zip, so a config typo can never write outside the dist directory.
 *
 * @param {*} name Candidate zip name.
 * @return {string} The validated name.
 */
export function assertZipName( name ) {
	if ( ! isNonEmptyString( name ) || name.includes( '/' ) || name.includes( '\\' ) || ! name.endsWith( '.zip' ) ) {
		throw new Error( `build-config.mjs: zipName() must return a plain *.zip basename, got ${ JSON.stringify( name ) }.` );
	}

	return name;
}
