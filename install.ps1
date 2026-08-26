<#
.SYNOPSIS
    Install OnFlip on Windows.

.DESCRIPTION
    OnFlip lives in a private repository, so this needs a GitHub identity that
    has been given access to it. Either works:

      * GitHub CLI  - install it, run `gh auth login` once, and you are done.
      * A token     - set GITHUB_TOKEN (or GH_TOKEN) to a personal access
                      token with read access to the repository.

    With GitHub CLI signed in, the whole install is one line:

        gh api repos/khudayarovich/onflip-agent/contents/install.ps1 -H "Accept: application/vnd.github.raw" | iex

.PARAMETER Tag
    Release tag to install. Defaults to the latest release.

.PARAMETER FromSource
    Clone and build instead of using a release. Needed before the first
    release exists, or to install an unreleased branch.

.PARAMETER NoShortcut
    Skip the Desktop shortcut.

.PARAMETER SkipBrowser
    Skip Playwright's Chromium download (~150 MB). OnFlip drives your installed
    Chrome when there is one, so this is reasonable on a metered connection.
#>
[CmdletBinding()]
param(
    [string]$Repo = "khudayarovich/onflip-agent",
    [string]$Tag = "",
    [string]$Branch = "main",
    [switch]$FromSource,
    [switch]$NoShortcut,
    [switch]$SkipBrowser
)

$ErrorActionPreference = "Stop"

function Step($m) { Write-Host "  $m" -ForegroundColor Cyan }
function Good($m) { Write-Host "  $m" -ForegroundColor Green }
function Warn($m) { Write-Host "  $m" -ForegroundColor Yellow }
function Die($m) { Write-Host ""; Write-Host "  $m" -ForegroundColor Red; Write-Host ""; exit 1 }

Write-Host ""
Write-Host "  OnFlip" -ForegroundColor Magenta
Write-Host "  a coding agent driven by your ChatGPT web session" -ForegroundColor DarkGray
Write-Host ""

# -- prerequisites ----------------------------------------------------------
# All checked before anything is installed, so a missing one costs a message
# rather than a half-finished install.
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Die "Node.js is required. Install the LTS build from https://nodejs.org, then run this again."
}
$nodeVersion = (& node -v).TrimStart("v")
if ([int]($nodeVersion.Split(".")[0]) -lt 20) {
    Die "Node.js 20 or newer is required; this machine has $nodeVersion. Update it from https://nodejs.org."
}
Good "Node.js $nodeVersion"

if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
    Die "npm is required and normally ships with Node.js. Reinstall Node from https://nodejs.org."
}

# -- who are you --------------------------------------------------------------
# The repository is private, so every download below is authenticated. GitHub
# CLI is preferred because it already knows how to hold a credential; a token
# in the environment is the escape hatch for machines without it.
$gh = Get-Command gh -ErrorAction SilentlyContinue
$token = $env:GITHUB_TOKEN
if (-not $token) { $token = $env:GH_TOKEN }
$ghReady = $false

if ($gh) {
    & gh auth status *> $null
    if ($LASTEXITCODE -eq 0) { $ghReady = $true }
}

if (-not $ghReady -and -not $token) {
    Die @"
This repository is private, so the install needs a GitHub identity with access to it.

  Easiest - GitHub CLI:
      winget install --id GitHub.cli
      gh auth login
    then run this installer again.

  Or a token:
      Create one at https://github.com/settings/tokens with read access to
      $Repo, then:
      `$env:GITHUB_TOKEN = "ghp_yourtoken"
"@
}

if ($ghReady) { Good "GitHub CLI is signed in" } else { Good "using GITHUB_TOKEN" }

# npm 11.17 stopped running a package's install scripts on a global install
# unless the package is named. Older npm warns about a flag it does not know,
# so it is only passed where it means something.
$npmParts = (& npm -v).Split(".")
$allowScripts = @()
if ([int]$npmParts[0] -gt 11 -or ([int]$npmParts[0] -eq 11 -and [int]$npmParts[1] -ge 17)) {
    $allowScripts = @("--allow-scripts=onflip", "--allow-scripts=better-sqlite3")
}

$temp = Join-Path ([IO.Path]::GetTempPath()) ("onflip-install-" + [Guid]::NewGuid().ToString("N").Substring(0, 8))
New-Item -ItemType Directory -Path $temp | Out-Null
# The package's own postinstall would fetch Chromium mid-install, which npm may
# decline to run at all. It is done explicitly further down instead.
$env:ONFLIP_SKIP_BROWSER_DOWNLOAD = "1"

try {
    if ($FromSource) {
        # ---- build from a checkout ----------------------------------------
        Step "cloning $Repo ($Branch)"
        if ($ghReady) {
            & gh repo clone $Repo "$temp\src" -- --depth 1 --branch $Branch 2>&1 | Out-Null
        } else {
            if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
                Die "git is required to install from source. Get it from https://git-scm.com/download/win."
            }
            & git clone --depth 1 --branch $Branch "https://github.com/$Repo.git" "$temp\src" 2>&1 | Out-Null
        }
        if ($LASTEXITCODE -ne 0) {
            Die "Could not clone $Repo. Check that your GitHub account has access to it."
        }

        Push-Location "$temp\src"
        try {
            Step "installing dependencies"
            & npm install --no-audit --no-fund
            if ($LASTEXITCODE -ne 0) { Die "npm install failed in the checkout." }
            Step "building"
            & npm run build
            if ($LASTEXITCODE -ne 0) { Die "the TypeScript build failed." }
            Step "installing onflip globally"
            & npm install -g . @allowScripts --no-audit --no-fund
            if ($LASTEXITCODE -ne 0) { Die "npm could not install OnFlip globally." }
        } finally {
            Pop-Location
        }
    } elseif ($ghReady) {
        # ---- release, via GitHub CLI --------------------------------------
        # `gh release download` handles the private-asset redirect dance on its
        # own, which is the main reason it is the preferred path.
        Step "downloading the latest release"
        $which = if ($Tag) { @($Tag) } else { @() }
        & gh release download @which --repo $Repo --pattern "onflip-*.tgz" --dir $temp
        if ($LASTEXITCODE -ne 0) {
            Die "No release with an onflip-*.tgz was found in $Repo. Install from a checkout instead: re-run with -FromSource."
        }
        $tarball = (Get-ChildItem -Path $temp -Filter "onflip-*.tgz" | Select-Object -First 1).FullName
        Step "installing it globally"
        & npm install -g $tarball @allowScripts --no-audit --no-fund
        if ($LASTEXITCODE -ne 0) {
            Die "npm could not install OnFlip. The output above says why - a permissions problem on the global prefix is the usual culprit."
        }
    } else {
        # ---- release, via the API and a token ------------------------------
        Step "looking up the latest release"
        $api = "https://api.github.com/repos/$Repo/releases/latest"
        if ($Tag) { $api = "https://api.github.com/repos/$Repo/releases/tags/$Tag" }
        $headers = @{
            Authorization = "Bearer $token"
            Accept        = "application/vnd.github+json"
            "User-Agent"  = "onflip-installer"
        }

        $release = $null
        try {
            $release = Invoke-RestMethod -Uri $api -Headers $headers
        } catch {
            Die "Could not read the releases of $Repo. The token may lack access, or there is no release yet - re-run with -FromSource to build from a checkout."
        }
        $asset = $release.assets | Where-Object { $_.name -like "onflip-*.tgz" } | Select-Object -First 1
        if (-not $asset) { Die "Release $($release.tag_name) has no onflip-*.tgz attached to it." }

        $tarball = Join-Path $temp $asset.name
        Step "downloading $($asset.name) ($($release.tag_name))"
        # curl.exe, not Invoke-WebRequest: a private asset URL redirects to
        # storage that rejects the request if the Authorization header comes
        # along, and curl drops that header across hosts by default.
        & curl.exe -fsSL -H "Authorization: Bearer $token" -H "Accept: application/octet-stream" -o $tarball $asset.url
        if ($LASTEXITCODE -ne 0 -or -not (Test-Path $tarball)) { Die "Could not download $($asset.name)." }

        Step "installing it globally"
        & npm install -g $tarball @allowScripts --no-audit --no-fund
        if ($LASTEXITCODE -ne 0) {
            Die "npm could not install OnFlip. The output above says why - a permissions problem on the global prefix is the usual culprit."
        }
    }

    # -- the browser it drives ---------------------------------------------
    # Explicit rather than left to the package's postinstall, which npm may
    # skip: a first turn that fails on a missing browser is a much worse first
    # impression than a progress bar during setup.
    if (-not $SkipBrowser) {
        Step "fetching Chromium for Playwright (one time, ~150 MB)"
        & npx --yes playwright install chromium
        if ($LASTEXITCODE -ne 0) {
            Warn "That download did not finish. OnFlip still works if Chrome is installed;"
            Warn "otherwise run: npx playwright install chromium"
        }
    }
} finally {
    Remove-Item Env:\ONFLIP_SKIP_BROWSER_DOWNLOAD -ErrorAction SilentlyContinue
    Remove-Item -Recurse -Force $temp -ErrorAction SilentlyContinue
}

# -- prove it is really there ----------------------------------------------
if (Get-Command onflip -ErrorAction SilentlyContinue) {
    Good "onflip $(& onflip --version)"
} else {
    Warn "Installed, but 'onflip' is not on PATH in this window."
    Warn "Open a new terminal, or add this to PATH: $(& npm prefix -g)"
}

# -- one-click launcher -----------------------------------------------------
if (-not $NoShortcut) {
    try {
        $link = Join-Path ([Environment]::GetFolderPath("Desktop")) "OnFlip.lnk"
        $shell = New-Object -ComObject WScript.Shell
        $shortcut = $shell.CreateShortcut($link)
        # cmd /k keeps the window open after the session ends, so a startup
        # error is readable instead of flashing past.
        $shortcut.TargetPath = "$env:ComSpec"
        $shortcut.Arguments = "/k onflip"
        $shortcut.WorkingDirectory = $env:USERPROFILE
        $shortcut.IconLocation = "$env:ComSpec,0"
        $shortcut.Description = "OnFlip - a coding agent in your terminal"
        $shortcut.Save()
        Good "Desktop shortcut: OnFlip"
    } catch {
        Warn "Could not create the Desktop shortcut: $($_.Exception.Message)"
    }
}

Write-Host ""
Write-Host "  Next" -ForegroundColor Magenta
Write-Host "    1. Sign in to ChatGPT in Firefox, Chrome or Edge." -ForegroundColor Gray
Write-Host "    2. onflip login        pick that session up" -ForegroundColor Gray
Write-Host "    3. cd your-project" -ForegroundColor Gray
Write-Host "    4. onflip              start working" -ForegroundColor Gray
Write-Host ""
Write-Host "  onflip --help for everything else." -ForegroundColor DarkGray
Write-Host ""
