/**
 * Tests for the publish CLI's token and route choice: the release-only token
 * goes to the release route, the admin token to the admin route, and the
 * release token wins when both are set.
 */

import assert from 'node:assert/strict';

import {
	resolvePublishAuth,
	buildUploadUrl,
	uploadRelease,
	RELEASE_UPLOAD_PATH,
	ADMIN_UPLOAD_PATH,
} from '../publish-release.mjs';

const META = { product_slug: 'fixture', version: '1.2.3', channel: 'pro' };

// The release token picks the release route, and wins over the admin token.
assert.deepEqual(
	resolvePublishAuth( { PURO_RELEASE_TOKEN: ' rel ', PURO_ADMIN_TOKEN: 'adm' } ),
	{ token: 'rel', path: RELEASE_UPLOAD_PATH, name: 'PURO_RELEASE_TOKEN' }
);

// The admin token alone picks the admin route; a blank release token is unset.
assert.deepEqual(
	resolvePublishAuth( { PURO_RELEASE_TOKEN: '  ', PURO_ADMIN_TOKEN: 'adm' } ),
	{ token: 'adm', path: ADMIN_UPLOAD_PATH, name: 'PURO_ADMIN_TOKEN' }
);

// Neither, or only blanks: null, so the CLI refuses to run.
assert.equal( resolvePublishAuth( {} ), null );
assert.equal( resolvePublishAuth( { PURO_RELEASE_TOKEN: '', PURO_ADMIN_TOKEN: ' ' } ), null );

// The URL takes the chosen route and keeps the admin route as its default.
assert.equal( new URL( buildUploadUrl( 'https://x.test', META, RELEASE_UPLOAD_PATH ) ).pathname, '/v1/releases/upload' );
assert.equal( new URL( buildUploadUrl( 'https://x.test', META ) ).pathname, '/v1/admin/releases/upload' );
assert.equal( new URL( buildUploadUrl( 'https://x.test', META, RELEASE_UPLOAD_PATH ) ).searchParams.get( 'version' ), '1.2.3' );

// A 409 from the release route (a version already released with other bytes)
// fails the upload with the server's message.
await assert.rejects(
	uploadRelease( {
		url: 'https://x.test/v1/releases/upload',
		token: 'rel',
		bytes: new Uint8Array( [ 1 ] ),
		fetchImpl: async () => new Response( JSON.stringify( { error: 'Version already released with different content' } ), { status: 409 } ),
	} ),
	/Version already released with different content/
);

// The bearer header carries the token it was given.
let seenAuth = '';
await uploadRelease( {
	url: 'https://x.test/v1/releases/upload',
	token: 'rel',
	bytes: new Uint8Array( [ 1 ] ),
	fetchImpl: async ( _url, init ) => {
		seenAuth = init.headers.Authorization;
		return new Response( JSON.stringify( { success: true, created: true } ), { status: 200 } );
	},
} );
assert.equal( seenAuth, 'Bearer rel' );

console.log( 'publish-release: token and route choice OK' );
