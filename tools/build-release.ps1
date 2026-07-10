param(
    [string]$OutDir = "",
    [string]$ZipName = "",
    [ValidateSet("chrome", "brave", "edge", "opera", "firefox", "safari")]
    [string]$Target = "",
    [ValidateSet("full", "lite")]
    [string]$Variant = "full",
    [switch]$KeepStaging,
    [switch]$NoUnpack
)

$ErrorActionPreference = "Stop"

$tool_dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repo_dir = Split-Path -Parent $tool_dir
$script_path = [System.IO.Path]::GetFullPath((Join-Path $tool_dir "release.js"))

$argsList = @()

if ($OutDir) {
    $argsList += "--out-dir"
    $argsList += $OutDir
}

if ($ZipName) {
    $argsList += "--zip-name"
    $argsList += $ZipName
}

if ($Target) {
    $argsList += "--target"
    $argsList += $Target
}

if ($Variant -and $Variant -ne "full") {
    $argsList += "--variant"
    $argsList += $Variant
}

if ($KeepStaging) {
    $argsList += "--keep-staging"
}

if (-not $NoUnpack) {
    $argsList += "--unpack"
}

& node -- $script_path @argsList
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
