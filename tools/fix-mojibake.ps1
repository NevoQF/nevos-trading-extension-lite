param(
  [string[]]$Targets = @(
    "Roblox Bots/Extension/nevos trading extension/extension"
  )
)

$ErrorActionPreference = "Stop"

function New-Literal([int[]]$Codes) {
  return -join ($Codes | ForEach-Object { [char]$_ })
}

$replacementPairs = @(
  @{ From = (New-Literal @(0x00E2, 0x20AC, 0x201D)); To = "-" },
  @{ From = (New-Literal @(0x00E2, 0x20AC, 0x201C)); To = "-" },
  @{ From = (New-Literal @(0x00E2, 0x20AC, 0x00A6)); To = "..." },
  @{ From = (New-Literal @(0x00C2, 0x00A0)); To = " " },
  @{ From = (New-Literal @(0x00C2)); To = "" }
)

$extensions = @(".js", ".json", ".html", ".css", ".md", ".txt")
$changedFiles = New-Object System.Collections.Generic.List[string]

foreach ($target in $Targets) {
  if (-not (Test-Path -LiteralPath $target)) { continue }

  Get-ChildItem -LiteralPath $target -Recurse -File | Where-Object {
    $extensions -contains $_.Extension.ToLowerInvariant()
  } | ForEach-Object {
    $path = $_.FullName
    $content = [System.IO.File]::ReadAllText($path)
    $updated = $content

    foreach ($pair in $replacementPairs) {
      $updated = $updated.Replace($pair.From, $pair.To)
    }

    if ($updated -ne $content) {
      [System.IO.File]::WriteAllText($path, $updated, [System.Text.UTF8Encoding]::new($false))
      [void]$changedFiles.Add($path)
    }
  }
}

if ($changedFiles.Count -eq 0) {
  Write-Output "No mojibake replacements were needed."
  exit 0
}

Write-Output "Updated files:"
$changedFiles | ForEach-Object { Write-Output $_ }
