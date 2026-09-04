/**
 * Release-version rules, shared by every script that takes a `-v` value.
 *
 * The version reaches a filesystem path (the artifact name) and the inside of a
 * single-quoted PHP string (the version constant), so both the builder and the
 * publisher validate it before use. They share these rules so the two cannot
 * disagree about what a releasable version is.
 *
 */

/** Release versions are MAJOR.MINOR.PATCH with an optional prerelease suffix. */
const RELEASE_VERSION = /^\d+\.\d+\.\d+(-[0-9A-Za-z]+(\.[0-9A-Za-z]+)*)?$/;

/**
 * Why this version cannot be released, or null when it can.
 *
 * An allowlist, not a list of known-bad inputs: a slash would place an artifact
 * outside dist/, and a quote or newline would emit PHP that fatals on load.
 *
 * @param {string} version - The requested version.
 * @return {string|null} Operator-facing reason, or null when the version is fine.
 */
export function releaseVersionError( version ) {
	if ( ! RELEASE_VERSION.test( version ) ) {
		return `Not a release version: '${ version }'. Expected MAJOR.MINOR.PATCH with an optional prerelease suffix, e.g. 1.0.0 or 1.0.0-rc1.`;
	}

	// `-dev` marks the source placeholder. It satisfies the grammar above, so it
	// needs saying separately: stamped into a build it reaches the plugin header,
	// the version constant, the readme Stable tag and the POT at once, and
	// WordPress.org rejects it. A real prerelease such as 1.0.0-rc1 is fine.
	if ( version.includes( '-dev' ) ) {
		return `Refusing to release '${ version }': -dev marks the source placeholder, not a release version.`;
	}

	return null;
}
