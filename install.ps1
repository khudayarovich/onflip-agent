<#
.SYNOPSIS
    Install OnFlip on Windows.

.DESCRIPTION
    Downloads the latest release from GitHub, installs it globally with npm,
    fetches the browser it drives, and leaves a one-click shortcut on the
    Desktop. Run it straight from the web:

        irm https://raw.githubusercontent.com/khudayarovich/onflip-agent/main/install.ps1 | iex

.PARAMETER Tag
    Release tag to install. Defaults to the latest published release.

.PARAMETER FromSource
    Clone and build instead of using a release. Needed only before the first
    release is published, or to install an unreleased branch.

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
# Checked before anything is installed, so a missing one costs a message
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

# npm 11.17 stopped running a package's install scripts on a global install
# unless the package is named. Older npm has no such flag and warns about one
# it does not know, so it is only passed where it means something.
$npmParts = (& npm -v).Split(".")
$allowScripts = @()
if ([int]$npmParts[0] -gt 11 -or ([int]$npmParts[0] -eq 11 -and [int]$npmParts[1] -ge 17)) {
    $allowScripts = @("--allow-scripts=onflip", "--allow-scripts=better-sqlite3")
}

$temp = Join-Path ([IO.Path]::GetTempPath()) ("onflip-install-" + [Guid]::NewGuid().ToString("N").Substring(0, 8))
New-Item -ItemType Directory -Path $temp | Out-Null
# The package's own postinstall would fetch Chromium mid-install, which npm
# may decline to run at all. It is done explicitly further down instead.
$env:ONFLIP_SKIP_BROWSER_DOWNLOAD = "1"

try {
    if ($FromSource) {
        # ---- build from a checkout ----------------------------------------
        if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
            Die "git is required to install from source. Get it from https://git-scm.com/download/win."
        }
        Step "cloning $Repo ($Branch)"
        & git clone --depth 1 --branch $Branch "https://github.com/$Repo.git" "$temp\src" 2>&1 | Out-Null
        if ($LASTEXITCODE -ne 0) { Die "git could not clone https://github.com/$Repo." }

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
    } else {
        # ---- install the published release --------------------------------
        # The release tarball already carries the built dist, so this needs no
        # git, no compiler and no TypeScript.
        Step "looking up the latest release"
        $url = "https://api.github.com/repos/$Repo/releases/latest"
        if ($Tag) { $url = "https://api.github.com/repos/$Repo/releases/tags/$Tag" }

        $release = $null
        try {
            $release = Invoke-RestMethod -Uri $url -Headers @{ "User-Agent" = "onflip-installer" }
        } catch {
            Die "No published release found for $Repo. Install from a checkout instead - see the README, or re-run this script with -FromSource."
        }

        $asset = $release.assets | Where-Object { $_.name -like "onflip-*.tgz" } | Select-Object -First 1
        if (-not $asset) { Die "Release $($release.tag_name) has no onflip-*.tgz attached to it." }

        $tarball = Join-Path $temp $asset.name
        Step "downloading $($asset.name) ($($release.tag_name))"
        Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $tarball -UseBasicParsing

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
