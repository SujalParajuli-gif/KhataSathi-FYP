[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$scriptDirectory = Split-Path -Parent $PSCommandPath
$projectDirectory = Split-Path -Parent (Split-Path -Parent $scriptDirectory)
$environmentExamplePath = Join-Path $projectDirectory "deploy\production.env.example"
$environmentPath = Join-Path $projectDirectory "deploy\production.env"
$secretsDirectory = Join-Path $projectDirectory "deploy\secrets"
$resticPasswordPath = Join-Path $secretsDirectory "restic-password"
$utf8WithoutBom = New-Object System.Text.UTF8Encoding($false)

function New-HexSecret {
    $bytes = New-Object byte[] 32
    $generator = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try {
        $generator.GetBytes($bytes)
    }
    finally {
        $generator.Dispose()
    }

    return ([System.BitConverter]::ToString($bytes) -replace "-", "").ToLowerInvariant()
}

if (-not (Test-Path -LiteralPath $environmentExamplePath -PathType Leaf)) {
    throw "Missing environment template: $environmentExamplePath"
}
if (Test-Path -LiteralPath $environmentPath) {
    throw "Refusing to overwrite the existing ignored environment file: $environmentPath"
}
if (Test-Path -LiteralPath $resticPasswordPath) {
    throw "Refusing to overwrite the existing Restic password file: $resticPasswordPath"
}

$environmentContents = [System.IO.File]::ReadAllText($environmentExamplePath)
$replacementSecrets = @{
    "REPLACE_WITH_64_CHARACTER_HEX_VALUE" = New-HexSecret
    "REPLACE_WITH_A_DIFFERENT_64_CHARACTER_HEX_VALUE" = New-HexSecret
    "REPLACE_WITH_A_THIRD_64_CHARACTER_HEX_VALUE" = New-HexSecret
}

foreach ($placeholder in $replacementSecrets.Keys) {
    if (-not $environmentContents.Contains($placeholder)) {
        throw "The environment template no longer contains the expected placeholder: $placeholder"
    }
    $environmentContents = $environmentContents.Replace(
        $placeholder,
        $replacementSecrets[$placeholder]
    )
}

[System.IO.Directory]::CreateDirectory($secretsDirectory) | Out-Null
[System.IO.File]::WriteAllText($environmentPath, $environmentContents, $utf8WithoutBom)
[System.IO.File]::WriteAllText($resticPasswordPath, (New-HexSecret), $utf8WithoutBom)

Write-Host "Created the ignored local rehearsal configuration."
Write-Host "- deploy/production.env"
Write-Host "- deploy/secrets/restic-password"
Write-Host "Secret values were generated independently and were not printed."
