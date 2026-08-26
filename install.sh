#!/usr/bin/env bash
#
# Install OnFlip on macOS or Linux.
#
#   curl -fsSL https://raw.githubusercontent.com/khudayarovich/onflip-agent/main/install.sh | bash
#
# Environment:
#   ONFLIP_REPO    owner/repo to install from  (default khudayarovich/onflip-agent)
#   ONFLIP_TAG     release tag                 (default: the latest release)
#   ONFLIP_BRANCH  branch for --from-source    (default main)
#
# Flags:
#   --from-source   clone and build instead of using a release
#   --skip-browser  skip Playwright's Chromium download (~150 MB)
set -euo pipefail

REPO="${ONFLIP_REPO:-khudayarovich/onflip-agent}"
TAG="${ONFLIP_TAG:-}"
BRANCH="${ONFLIP_BRANCH:-main}"
FROM_SOURCE=0
SKIP_BROWSER=0

for arg in "$@"; do
  case "$arg" in
    --from-source) FROM_SOURCE=1 ;;
    --skip-browser) SKIP_BROWSER=1 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

if [ -t 1 ]; then
  CYAN=$'\033[36m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; RED=$'\033[31m'
  MAGENTA=$'\033[35m'; DIM=$'\033[90m'; OFF=$'\033[0m'
else
  CYAN=""; GREEN=""; YELLOW=""; RED=""; MAGENTA=""; DIM=""; OFF=""
fi

step() { printf '  %s%s%s\n' "$CYAN" "$1" "$OFF"; }
good() { printf '  %s%s%s\n' "$GREEN" "$1" "$OFF"; }
warn() { printf '  %s%s%s\n' "$YELLOW" "$1" "$OFF"; }
die()  { printf '\n  %s%s%s\n\n' "$RED" "$1" "$OFF" >&2; exit 1; }

printf '\n  %sOnFlip%s\n' "$MAGENTA" "$OFF"
printf '  %sa coding agent driven by your ChatGPT web session%s\n\n' "$DIM" "$OFF"

# -- prerequisites ----------------------------------------------------------
# Checked up front so a missing one costs a message rather than half an install.
command -v node >/dev/null 2>&1 ||
  die "Node.js is required. Install the LTS build from https://nodejs.org, then run this again."

NODE_VERSION="$(node -v | sed 's/^v//')"
if [ "${NODE_VERSION%%.*}" -lt 20 ]; then
  die "Node.js 20 or newer is required; this machine has $NODE_VERSION."
fi
good "Node.js $NODE_VERSION"

command -v npm >/dev/null 2>&1 ||
  die "npm is required and normally ships with Node.js."

# npm 11.17 stopped running a package's install scripts on a global install
# unless the package is named. Older npm warns about a flag it does not know,
# so it is only passed where it means something.
NPM_VERSION="$(npm -v)"
NPM_MAJOR="${NPM_VERSION%%.*}"
NPM_MINOR="$(printf '%s' "$NPM_VERSION" | cut -d. -f2)"
ALLOW=()
if [ "$NPM_MAJOR" -gt 11 ] || { [ "$NPM_MAJOR" -eq 11 ] && [ "$NPM_MINOR" -ge 17 ]; }; then
  ALLOW=(--allow-scripts=onflip --allow-scripts=better-sqlite3)
fi

TMP="$(mktemp -d "${TMPDIR:-/tmp}/onflip-install.XXXXXX")"
cleanup() { rm -rf "$TMP"; }
trap cleanup EXIT

# The package's own postinstall would fetch Chromium mid-install, which npm may
# decline to run at all. It is done explicitly further down instead.
export ONFLIP_SKIP_BROWSER_DOWNLOAD=1

npm_global() {
  # A global prefix owned by root is the single most common install failure on
  # Linux, and "try sudo" is more useful advice after the fact than before it.
  if npm install -g "$@" --no-audit --no-fund; then
    return 0
  fi
  die "npm could not install OnFlip. If that was a permissions error, either point npm somewhere writable (npm config set prefix ~/.npm-global) or re-run this with sudo."
}

if [ "$FROM_SOURCE" -eq 1 ]; then
  # ---- build from a checkout ----------------------------------------------
  command -v git >/dev/null 2>&1 || die "git is required to install from source."
  step "cloning $REPO ($BRANCH)"
  git clone --depth 1 --branch "$BRANCH" "https://github.com/$REPO.git" "$TMP/src" >/dev/null 2>&1 ||
    die "git could not clone https://github.com/$REPO."
  (
    cd "$TMP/src"
    step "installing dependencies"
    npm install --no-audit --no-fund
    step "building"
    npm run build
  ) || die "the build failed in the checkout."
  step "installing onflip globally"
  npm_global "$TMP/src" "${ALLOW[@]+"${ALLOW[@]}"}"
else
  # ---- install the published release ---------------------------------------
  # The release tarball already carries the built dist, so this needs no git,
  # no compiler and no TypeScript.
  step "looking up the latest release"
  API="https://api.github.com/repos/$REPO/releases/latest"
  [ -z "$TAG" ] || API="https://api.github.com/repos/$REPO/releases/tags/$TAG"

  ASSET_URL="$(curl -fsSL "$API" 2>/dev/null |
    sed -n 's/.*"browser_download_url": *"\([^"]*onflip-[^"]*\.tgz\)".*/\1/p' | head -1 || true)"

  if [ -z "$ASSET_URL" ]; then
    die "No published release with an onflip-*.tgz was found for $REPO. Install from a checkout instead: curl -fsSL https://raw.githubusercontent.com/$REPO/main/install.sh | bash -s -- --from-source"
  fi

  TARBALL="$TMP/$(basename "$ASSET_URL")"
  step "downloading $(basename "$ASSET_URL")"
  curl -fsSL "$ASSET_URL" -o "$TARBALL" || die "could not download $ASSET_URL"

  step "installing it globally"
  npm_global "$TARBALL" "${ALLOW[@]+"${ALLOW[@]}"}"
fi

unset ONFLIP_SKIP_BROWSER_DOWNLOAD

# -- the browser it drives --------------------------------------------------
# Explicit rather than left to the package's postinstall, which npm may skip:
# a first turn that fails on a missing browser is a much worse first impression
# than a progress bar during setup.
if [ "$SKIP_BROWSER" -eq 0 ]; then
  step "fetching Chromium for Playwright (one time, ~150 MB)"
  if ! npx --yes playwright install chromium; then
    warn "That download did not finish. OnFlip still works if Chrome is installed;"
    warn "otherwise run: npx playwright install chromium"
  fi
fi

if command -v onflip >/dev/null 2>&1; then
  good "onflip $(onflip --version)"
else
  warn "Installed, but 'onflip' is not on PATH. Add this to your shell profile:"
  warn "  export PATH=\"\$(npm prefix -g)/bin:\$PATH\""
fi

printf '\n  %sNext%s\n' "$MAGENTA" "$OFF"
printf '    1. Sign in to ChatGPT in Firefox, Chrome or Edge.\n'
printf '    2. onflip login        pick that session up\n'
printf '    3. cd your-project\n'
printf '    4. onflip              start working\n'
printf '\n  %sonflip --help for everything else.%s\n\n' "$DIM" "$OFF"
