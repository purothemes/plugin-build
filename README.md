# plugin-build

Release tooling for WordPress plugins. Builds per-variant release zips with PHP
overlays, syncs vendored runtime assets from pinned npm packages, stamps
versions, generates the translation template, publishes artifacts to the
update server, and stages a release into the plugin's WordPress.org SVN
repository.

Everything product-specific lives in the consuming plugin. This repo carries
only machinery.

## Mounting

In the plugin repo:

```sh
git submodule add git@github.com:purothemes/plugin-build.git build
```

Then point the plugin's npm scripts at the mount:

```json
{
	"scripts": {
		"build": "node build/build-release.mjs all",
		"build:free": "node build/build-release.mjs free",
		"vendor": "node build/sync-vendor-assets.mjs",
		"vendor:check": "node build/sync-vendor-assets.mjs --check",
		"publish:pro": "node build/publish-release.mjs --channel pro",
		"publish:wporg": "node build/publish-wporg.mjs --variant free",
		"test:build-tooling": "npm --prefix build test --silent"
	}
}
```

Builds always take an explicit version: `npm run build -- -v 1.2.3`.

The scripts resolve the plugin root as their mount's parent directory, and read
these root files:

- **`build-config.mjs`** — `export default { ... }` with every key below. Its
  presence is what defines a consuming root; there is no flag and no
  environment variable for it. Required by the build and publish CLIs; the
  sync CLI uses it for the temp suffix when present and falls back to a
  generic default when it is not.
- **`vendor-manifest.json`** — the vendored-asset contract (package, version,
  sources, target, sha256 per asset), read by `sync-vendor-assets.mjs`.
- **`readme.txt`** — packaged by the build CLI. The publish CLI reads the copy
  inside the artifact (`<slug>/readme.txt`), never this one, for the
  compatibility headers and the changelog entry.

Dependencies (`yazl`, `wp-pot`) resolve upward from `build/`, so declaring them
in the plugin's own `package.json` is enough for mounted use. For standalone
work in this repo, `npm ci` installs them here.

## The build-config.mjs contract

| Key | Type | Used by |
|---|---|---|
| `textDomain` | string | build: WP_Pot domain and `languages/<textDomain>.pot` |
| `versionConstant` | string | build: stamped `define()`; publish: identity check |
| `tempSuffix` | string starting `.` | build + sync: in-progress write suffix, skipped by the packager |
| `globalExclude` | string[] | build: paths excluded from every zip (prefix-matched) |
| `potExclude` | string[] | build: extra exclusions for the POT scan |
| `excludeBasenames` | string[] (optional) | build: names skipped anywhere in the tree (e.g. `.DS_Store`) |
| `overlayDir` | string | build: root-relative dir holding `<variant>/<path>` PHP overlays |
| `variants.<name>.slug` | string | build: in-zip root for that variant |
| `variants.<name>.removedPaths` | string[] | build: paths stripped from that variant |
| `variants.<name>.overlayPhpFiles` | string[] | build: files replaced by their overlay copy |
| `variants.<name>.postProcess` | function[] | build: per-file transforms `(relPath, Buffer) => Buffer\|undefined` |
| `zipName` | `(variant, version) => string` | build + publish: artifact basename (validated: plain `*.zip`) |
| `potMeta.package` | string | build: POT package and Project-Id-Version |
| `potMeta.bugReport` | string | build: POT report URL |
| `potMeta.team` | string | build: POT team header |
| `publish.productSlug` | string | publish: upload identity |
| `publish.defaultChannel` | string | publish: `--channel` default; must name a variant |
| `publish.apiBase` | string | publish: server base URL (`PURO_API_BASE` overrides) |
| `publish.inZipProbe` | string | publish + wporg: in-zip PHP file read for identity checks |
| `publish.packageVariantConstant` | string | publish + wporg: `define()` naming the variant inside the artifact |

The loader (`load-config.mjs`) validates presence, type and shape of every key
before anything runs; the `publish.*` subtree is required only by
`publish-release.mjs`, so a build-only consumer omits it. `publish-wporg.mjs`
requires only its two identity keys, `inZipProbe` and `packageVariantConstant`. Validation is a typo
net for first-party configuration, not input hardening: path contents are the
consumer's responsibility, with one exception — `zipName()`'s return value is
checked to be a plain `*.zip` basename, because a bad name there would write
outside `dist/`; the two constant keys must be PHP constant names (they build
regexes), and `textDomain` / `variants.<name>.slug` must be plain path-segment
names (they build zip entry paths).

Variant names are the keys of `config.variants`: the build CLI's targets and
the publish channel are both validated against them.

## Guard rails

- A missing or malformed config fails before any packaging or upload, naming
  the offending key.
- Every configured overlay entry is preflighted: it must name a collected
  source file AND have its overlay copy on disk, or the build refuses. An
  overlaid file can never be shipped un-overlaid in silence.
- Vendored assets are regenerated from the pinned package and hash-verified
  before the file list is taken; a partial write can never enter a zip.
- The published artifact's version and variant are read back out of the zip
  and must agree with the request before an upload starts. Its readme is read
  the same way: the headers and changelog sent to the server describe the bytes
  being uploaded, not the current checkout, and a zip whose readme has no entry
  for the version is refused.

## WordPress.org release runbook

`publish-wporg.mjs` stages one release of a variant (normally the free build)
into a working copy of the plugin's WordPress.org SVN repository:

- `trunk/` becomes exactly the zip's contents: new files are added, files the
  zip no longer carries are removed;
- `trunk/` is copied to `tags/<version>/`;
- `assets/` becomes exactly the plugin's `.wordpress-org/` directory, with
  `svn:mime-type` set on every `.png`, `.jpg`, `.jpeg`, `.gif` and `.svg`
  (`excludeBasenames` applies, so `.DS_Store` never ships). A plugin with no
  `.wordpress-org/` leaves `assets/` as it is.

It refuses, before staging anything, when:

- the zip's version or variant (read from `publish.inZipProbe`) is not the one
  requested;
- the zip's `readme.txt` Stable tag, which becomes `trunk/readme.txt`, is not
  the version;
- `tags/<version>` already exists, in the working copy or in the repository;
- the working copy has local changes, or is not a checkout of the repository
  root.

The default is a dry run. It stages the release in a scratch copy of the
working copy, prints the exact `svn status` (adds `A`, deletes `D`,
modifications `M`, property changes in column two) with a per-area count, and
deletes the copy. The working copy is never changed. `--commit` stages into
the working copy, commits it as `Release <version>`, then reads
`trunk/readme.txt` and `tags/<version>/readme.txt` back from the repository and
fails unless both carry Stable tag `<version>`.

Steps for a release:

1. Once, add the npm script to the plugin's `package.json`, naming the variant
   that ships on WordPress.org:
   ```json
   "publish:wporg": "node build/publish-wporg.mjs --variant free"
   ```
   Without it, call the script directly wherever the steps below say
   `npm run publish:wporg --`:
   `node build/publish-wporg.mjs --variant free -v 1.2.0 --svn ~/svn/<slug>`
2. Build and check the free zip:
   `npm run build:free -- -v 1.2.0`. Its readme needs `Stable tag` stamped to
   the version (the build does this) and a changelog entry.
3. Once, check out the SVN repository root. Skip the tags' contents, which
   grow with every release:
   ```sh
   svn checkout --depth immediates https://plugins.svn.wordpress.org/<slug> ~/svn/<slug>
   svn update --set-depth infinity ~/svn/<slug>/trunk ~/svn/<slug>/assets
   ```
   Before each later release: `svn update ~/svn/<slug>`.
4. Dry run, and read the status it prints:
   `npm run publish:wporg -- -v 1.2.0 --svn ~/svn/<slug>`
5. Commit: the same command with `--commit`. svn asks for the WordPress.org
   password (it is the SVN password from the profile, not the login one).
6. Tag the release in git with the same version, so the git tag and the SVN
   tag name the same code: `git tag 1.2.0 <commit> && git push origin 1.2.0`.
7. Check the plugin page: the version, the banner, the icon and the
   screenshots. The directory can take some minutes to rebuild it.

`--root <path>` points the script at another plugin root (default: the mount's
parent), as `sync-vendor-assets.mjs` does. The tests run against a local
`svnadmin create` repository over `file://`; nothing in them contacts a remote.

## Updating

The consuming plugin pins this repo at an exact commit (the submodule gitlink).
To take changes: commit here, then in the plugin
`git -C build pull && git add build` in a normal source commit, with the
plugin's own suites green before the bump lands. `npm test` here must be green
before every push.

Tests in this repo are generic fixtures only; a consuming plugin keeps its own
product-specific suites (zip contents, overlay fidelity, publish flow) beside
its config.
