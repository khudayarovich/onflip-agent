<#
.SYNOPSIS
  Launch a packaged OnFlip in isolation for about half a minute and say
  whether it came up healthy. Windows only.

.DESCRIPTION
  Three things to launch, in order of how much they prove:

    -Release 0.10.56   the published installer: downloaded from the GitHub
                       release, checked against SHA256SUMS-windows.txt, and
                       extracted (never installed). This is what people get.
    -Installer <exe>   an installer already on disk, extracted the same way.
    (default)          desktop/release/win-unpacked, the local build.

  The local build is the weakest of the three, and the reason this script
  takes the others: its sqlite binding is compiled for this machine's Node,
  so it loads under that Node where the published one — built on Node 22 in
  CI — would not. The runtime probe that sends the engine to Electron-as-Node
  on a machine with Node 24 is only ever exercised by a published build.

  Isolation: a temporary --user-data-dir (window state, Telegram token and
  schedules stay untouched), a temporary ONFLIP_CONFIG_DIR, and DeepSeek as
  the provider, whose fresh profile is signed out, so no account is touched.
  A packaged launch registers itself for onflip:// links, so that
  registration is exported first and put back afterwards. It refuses to run
  beside the installed OnFlip.

  Healthy means: the window loaded and photographed itself, the engine
  started and checked the session, and the usage store opened (no "usage
  database could not be opened" warning — the symptom of a sqlite binding
  that does not fit the runtime). Exits 1 otherwise.

.EXAMPLE
  powershell -File desktop/scripts/smoke.ps1 -Release 0.10.56
#>
param(
  [string]$Release = "",
  [string]$Installer = "",
  [string]$Build = "",
  [int]$Seconds = 45
)

$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$work = Join-Path ([System.IO.Path]::GetTempPath()) ("onflip-smoke-" + (Get-Date -Format "yyyyMMdd-HHmmss"))
New-Item -ItemType Directory -Force $work | Out-Null
"work folder: $work"

function Invoke-Quietly([scriptblock]$Body) {
  # reg.exe and 7z write progress to stderr, which Windows PowerShell 5.1
  # turns into a terminating error under "Stop".
  $saved = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try { & $Body 2>&1 | Out-Null } finally { $ErrorActionPreference = $saved }
}

function Expand-Installer([string]$exe) {
  $sevenZip = "C:\Program Files\7-Zip\7z.exe"
  if (-not (Test-Path $sevenZip)) { throw "7-Zip is needed to open the installer without running it: $sevenZip" }
  $payload = Join-Path $work "payload"
  $app = Join-Path $work "app"
  Invoke-Quietly { & $sevenZip e $exe '$PLUGINSDIR\app-64.7z' "-o$payload" -y }
  $archive = Join-Path $payload "app-64.7z"
  if (-not (Test-Path $archive)) { throw "no app-64.7z inside $exe" }
  Invoke-Quietly { & $sevenZip x $archive "-o$app" -y }
  if (-not (Test-Path (Join-Path $app "OnFlip.exe"))) { throw "the installer's payload holds no OnFlip.exe" }
  return $app
}

if ($Release) {
  $base = "https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v$Release"
  $exe = Join-Path $work "OnFlip-Setup-$Release.exe"
  "downloading $base/OnFlip-Setup-$Release.exe"
  $ProgressPreference = "SilentlyContinue"
  Invoke-WebRequest -UseBasicParsing -Uri "$base/OnFlip-Setup-$Release.exe" -OutFile $exe
  # Saved, not read from .Content: GitHub serves assets as octet-stream,
  # which Windows PowerShell hands back as bytes rather than text.
  $sumsFile = Join-Path $work "SHA256SUMS-windows.txt"
  Invoke-WebRequest -UseBasicParsing -Uri "$base/SHA256SUMS-windows.txt" -OutFile $sumsFile
  $want = (Get-Content $sumsFile | Where-Object { $_ -match "OnFlip-Setup-$([regex]::Escape($Release))\.exe" } | ForEach-Object { ($_.Trim() -split "\s+")[0] }) | Select-Object -First 1
  $got = (Get-FileHash -Algorithm SHA256 $exe).Hash.ToLower()
  if (-not $want -or $want.ToLower() -ne $got) { throw "checksum mismatch: SHA256SUMS says $want, the download is $got" }
  "checksum matches SHA256SUMS-windows.txt"
  $Installer = $exe
}
if ($Installer) {
  $appDir = Expand-Installer (Resolve-Path $Installer).Path
} elseif ($Build) {
  $appDir = (Resolve-Path $Build).Path
} else {
  $appDir = Join-Path $repo "desktop\release\win-unpacked"
}
$exePath = Join-Path $appDir "OnFlip.exe"
if (-not (Test-Path $exePath)) { throw "no OnFlip.exe in $appDir" }
$expected = (Get-Content (Join-Path $appDir "resources\app\package.json") -Raw | ConvertFrom-Json).version
"launching $exePath (version $expected)"

if (Get-Process OnFlip -ErrorAction SilentlyContinue | Where-Object { $_.Path -notlike "$appDir\*" }) {
  throw "The installed OnFlip is running; not launching a second copy beside it."
}

$registry = Join-Path $work "onflip-protocol-before.reg"
Invoke-Quietly { & reg.exe export "HKCU\Software\Classes\onflip" $registry /y }

$env:ONFLIP_CONFIG_DIR = Join-Path $work "dot-onflip"
$env:ONFLIP_PROVIDER = "deepseek"
$env:ONFLIP_DESKTOP_SHOT = Join-Path $work "shot.png"
$env:ONFLIP_DESKTOP_DEBUG = "1"

$failures = @()
$started = Get-Date
$p = Start-Process -FilePath $exePath -ArgumentList "--user-data-dir=`"$work\userdata`"" `
  -RedirectStandardOutput "$work\stdout.log" -RedirectStandardError "$work\stderr.log" -PassThru
try {
  $deadline = (Get-Date).AddSeconds($Seconds)
  while (-not (Test-Path $env:ONFLIP_DESKTOP_SHOT) -and (Get-Date) -lt $deadline -and -not $p.HasExited) {
    Start-Sleep -Milliseconds 500
  }
  # Let the engine report on the session after the photo.
  Start-Sleep -Seconds 10
  if ($p.HasExited) { $failures += "the app exited on its own (code $($p.ExitCode))" }
  if (-not (Test-Path $env:ONFLIP_DESKTOP_SHOT)) { $failures += "no screenshot within $Seconds s" }
} finally {
  # Everything this launch started, and nothing else: the Claude app and the
  # installed OnFlip are Electron too.
  Get-CimInstance Win32_Process | Where-Object {
    $_.ExecutablePath -like "$appDir\*" -or
      ($_.CommandLine -and ($_.CommandLine -like "*$work*" -or $_.CommandLine -like "*$appDir*"))
  } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Seconds 2
  if (Test-Path $registry) { Invoke-Quietly { & reg.exe import $registry } }
}

$stdout = Get-Content "$work\stdout.log" -ErrorAction SilentlyContinue
$runtime = ($stdout | Select-String -Pattern "engine runtime: (\w+)" | Select-Object -First 1)
$log = Get-ChildItem (Join-Path $env:ONFLIP_CONFIG_DIR "logs") -Filter *.jsonl -ErrorAction SilentlyContinue | ForEach-Object { Get-Content $_.FullName }
$startedLine = $log | Select-String -Pattern '"desktop engine started"' | Select-Object -First 1
$usageWarnings = @($log | Select-String -Pattern "usage database could not be opened").Count
$checked = @($log | Select-String -Pattern '"checked the session"').Count

if (-not ($stdout | Select-String -Pattern "\[window\] loaded")) { $failures += "the window never reported loaded" }
if (-not $startedLine) { $failures += "the engine never started" }
elseif ($startedLine.Line -notmatch [regex]::Escape("`"version`":`"$expected`"")) { $failures += "the engine reported another version than $expected" }
if ($usageWarnings -gt 0) { $failures += "the usage store could not open ($usageWarnings warnings): the sqlite binding does not fit the engine's runtime" }
if ($checked -eq 0) { $failures += "the engine never checked the session" }

""
"version:        $expected"
"engine runtime: $(if ($runtime) { $runtime.Matches[0].Groups[1].Value } else { 'unknown' })"
"window:         $(if (Test-Path $env:ONFLIP_DESKTOP_SHOT) { 'photographed after ' + [int]((Get-Item $env:ONFLIP_DESKTOP_SHOT).LastWriteTime - $started).TotalSeconds + ' s' } else { 'no photo' })"
"session check:  $checked"
"usage store:    $(if ($usageWarnings) { "$usageWarnings warnings" } else { 'opened' })"
"onflip:// now:  " + ((& reg.exe query "HKCU\Software\Classes\onflip\shell\open\command" /ve 2>$null | Select-String "REG_SZ") -replace '^\s+', '')
""
# The logs and the photo stay for a look afterwards; the installer and the
# app extracted from it are a few hundred MB and go.
if ($Installer) {
  Remove-Item -Recurse -Force (Join-Path $work "payload"), (Join-Path $work "app") -ErrorAction SilentlyContinue
  if ($Release) { Remove-Item -Force $Installer -ErrorAction SilentlyContinue }
}
if ($failures.Count) {
  "UNHEALTHY:"
  $failures | ForEach-Object { "  - $_" }
  exit 1
}
"HEALTHY"
