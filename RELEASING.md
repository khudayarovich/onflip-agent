# Releasing

One command cuts a release; GitHub Actions does the rest.

```bash
npm version patch      # or minor / major
git push --follow-tags
```

`npm version` bumps `package.json`, runs `scripts/sync-version.js` so the
`VERSION` constant in `src/repl.ts` agrees with it, commits both, and tags the
commit `vX.Y.Z`. Pushing the tag starts `.github/workflows/release.yml`, which

1. refuses to continue if the tag and `package.json` disagree,
2. typechecks, builds, and runs `onflip --version` against the build,
3. `npm pack`s the tarball,
4. creates the GitHub Release with install instructions and attaches
   `onflip-<version>.tgz`, `install.ps1` and `install.sh`,
5. publishes to npm — but only if an `NPM_TOKEN` secret exists.

Re-running the workflow by hand (Actions → Release → Run workflow) against an
existing tag updates that release rather than creating a second one.

## What people actually download

The tarball is the release. It carries `dist/` already built, so installing it
needs no compiler, no TypeScript and no git — which matters more than it
sounds:

- **`npm install -g github:owner/repo` cannot be relied on.** npm runs the
  package's `prepare` script in a temporary clone *without installing its
  devDependencies*, so `tsc` is not on PATH and the build fails. Measured on
  npm 11.17. The installers download the release tarball instead.
- **npm 11.17 does not run a package's install scripts on a global install**
  unless the package is named: `--allow-scripts=onflip`, repeated per package —
  the comma-separated form is ignored. Both installers pass it when the npm in
  front of them is new enough, and fetch the browser themselves afterwards
  rather than trusting `postinstall` to have run.
- **`better-sqlite3` is native.** v12 ships prebuilt binaries for Node 20–26,
  which is why `engines.node` is `>=20`: on Node 18 there is no prebuild, and
  the install then needs a C++ toolchain that most people do not have.

## Before tagging

```bash
npm run typecheck
npm run build
npm run check-version
npm pack --dry-run          # dist/, LICENSE and scripts/postinstall.js must be in it
```

CI runs the same on every push, across Node 20 and 22 on Linux, Windows and
macOS.

## Publishing to npm

Optional and off by default. Create an automation token on npmjs.com, add it as
the repository secret `NPM_TOKEN`, and the next release publishes. Until then
the GitHub Release is the whole distribution.
