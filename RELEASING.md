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

## Who can install it

The repository is private, and stays that way: access is granted per person
rather than by publishing. **Settings → Collaborators and teams → Add people**,
with **Read** permission — that is enough to clone, to download release assets
and to fetch the installers.

Everything a collaborator installs with is authenticated, which rules out the
usual public tricks:

- **`raw.githubusercontent.com` URLs return 404** for a private repo, so
  `irm ... | iex` and `curl ... | bash` against raw cannot work. The installers
  are fetched through the API instead, which does accept a credential:
  `gh api repos/OWNER/REPO/contents/install.sh -H "Accept: application/vnd.github.raw"`.
- **Release assets need a token too**, and the `browser_download_url` redirects
  to storage that rejects a request still carrying an `Authorization` header.
  `gh release download` handles that; the token path in the installers uses the
  API asset URL with `Accept: application/octet-stream` and `curl`, which drops
  the header across hosts by default.
- **Dynamic badges break.** GitHub proxies README images anonymously, so an
  Actions or release badge for a private repo renders as broken for everyone.
  Only the static licence badge is left in the README.

Collaborators need either GitHub CLI signed in (`gh auth login`) or a token with
read access in `GITHUB_TOKEN`. The installers accept both and say so plainly
when neither is present.

If this ever outgrows collaborator-by-collaborator access, the next step is
GitHub Packages: publish the tarball to `npm.pkg.github.com` under a scope, and
people install it with a token in their `.npmrc`. That is more setup for them,
not less, which is why it is not the default here.

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

Off by default, and it should stay off while the project is private — the
public registry is exactly the thing being avoided. The workflow only publishes
if an `NPM_TOKEN` secret exists, so nothing leaks by accident; the GitHub
Release is the whole distribution.
