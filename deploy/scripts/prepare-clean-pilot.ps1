[CmdletBinding()]
param(
    [ValidateSet("Preflight", "Create")]
    [string]$Action = "Preflight",
    [string]$SourceProjectName = "khatasathi",
    [string]$ProjectName = "khatasathi-catalog-pilot",
    [string]$EnvironmentFile = "deploy/production.env",
    [string]$AdminIdentity = "ADMINSujal",
    [string]$ManagerIdentity = "Sujal Manager",
    [string]$CashierIdentity = "Sakshyam Sharma",
    [string[]]$StaffIdentities = @("Sujalstaff", "Maniram Panthee"),
    [string]$Confirmation = ""
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$scriptDirectory = Split-Path -Parent $PSCommandPath
$projectDirectory = Split-Path -Parent (Split-Path -Parent $scriptDirectory)
$composePath = Join-Path $projectDirectory "compose.production.yml"
$reportDirectory = Join-Path $projectDirectory "deploy\backup-output"
$preflightReportPath = Join-Path $reportDirectory "clean-pilot-preflight.json"
$receiptPath = Join-Path $reportDirectory "clean-pilot-import-receipt.json"
$resolvedEnvironmentPath = if ([System.IO.Path]::IsPathRooted($EnvironmentFile)) {
    $EnvironmentFile
} else {
    Join-Path $projectDirectory $EnvironmentFile
}
$utf8WithoutBom = New-Object System.Text.UTF8Encoding($false)

function Assert-LastExitCode([string]$message) {
    if ($LASTEXITCODE -ne 0) { throw $message }
}

function Get-ComposeArguments([string]$projectName) {
    return @(
        "compose",
        "--project-name", $projectName,
        "--project-directory", $projectDirectory,
        "--env-file", $resolvedEnvironmentPath,
        "-f", $composePath
    )
}

if ($ProjectName -notmatch '^[a-z0-9][a-z0-9_-]{2,40}$') {
    throw "ProjectName must contain only lowercase letters, numbers, hyphens, or underscores."
}
if ($SourceProjectName -eq $ProjectName) {
    throw "The clean pilot must use a different Compose project name from the source stack."
}
if ($ProjectName -in @("khatasathi", "production", "default")) {
    throw "Refusing a project name that could overlap the normal stack. Use a dedicated pilot name."
}
if (-not (Test-Path -LiteralPath $composePath -PathType Leaf)) {
    throw "Missing Compose file: $composePath"
}
if (-not (Test-Path -LiteralPath $resolvedEnvironmentPath -PathType Leaf)) {
    throw "Missing ignored environment file: $resolvedEnvironmentPath"
}

& docker version *> $null
Assert-LastExitCode "Docker Desktop is not running or docker is unavailable."

$sourceCompose = Get-ComposeArguments $SourceProjectName
$targetCompose = Get-ComposeArguments $ProjectName
$sourceBackendId = (& docker @sourceCompose ps -q backend).Trim()
if (-not $sourceBackendId) {
    throw "The source backend is not running. Start the normal KhataSathi stack first."
}
& docker exec $sourceBackendId test -f /app/dist/scripts/auditCleanPilot.js
if ($LASTEXITCODE -ne 0) {
    throw "The running source backend does not contain the clean-pilot tools. Rebuild it with: docker compose --env-file deploy/production.env -f compose.production.yml up -d --build backend"
}

$identityArguments = @(
    "--admin", $AdminIdentity,
    "--manager", $ManagerIdentity,
    "--cashier", $CashierIdentity
)
foreach ($staffIdentity in $StaffIdentities) {
    if ([string]::IsNullOrWhiteSpace($staffIdentity)) {
        throw "StaffIdentities cannot contain an empty value."
    }
    $identityArguments += @("--staff", $staffIdentity)
}
if ($StaffIdentities.Count -lt 1) {
    throw "At least one Staff identity is required."
}

Write-Host "Auditing the source database. No data is being changed..."
$preflightLines = @(& docker exec $sourceBackendId node /app/dist/scripts/auditCleanPilot.js @identityArguments)
Assert-LastExitCode "The clean-pilot preflight failed. No target database was created."
$preflightJson = $preflightLines -join [Environment]::NewLine
[System.IO.Directory]::CreateDirectory($reportDirectory) | Out-Null
[System.IO.File]::WriteAllText($preflightReportPath, $preflightJson, $utf8WithoutBom)
Write-Host $preflightJson
Write-Host "Preflight report saved to: $preflightReportPath"

if ($Action -eq "Preflight") {
    Write-Host "No data was changed. Review the report before running the Create action."
    exit 0
}

if ($Confirmation -ne "CREATE-SEPARATE-CLEAN-PILOT") {
    throw "No data was changed. Re-run with -Action Create -Confirmation CREATE-SEPARATE-CLEAN-PILOT after reviewing the preflight report."
}

$existingProjectResources = @(
    @(& docker volume ls --format '{{.Name}}') |
        Where-Object { $_ -like "${ProjectName}_*" }
)
if ($existingProjectResources.Count -gt 0) {
    throw "Refusing to reuse existing pilot volumes: $($existingProjectResources -join ', '). Inspect or remove that isolated pilot explicitly before retrying."
}

Write-Host "Creating a fresh full recovery snapshot of the source before transfer..."
$appCommit = (& git -C $projectDirectory rev-parse HEAD 2>$null).Trim()
if (-not $appCommit) { $appCommit = "unknown" }
& docker @sourceCompose run --rm -e "KHATASATHI_APP_COMMIT=$appCommit" recovery
Assert-LastExitCode "The source backup failed. The clean pilot was not created."

Write-Host "Validating and creating isolated pilot database volumes..."
& docker @targetCompose config --quiet
Assert-LastExitCode "The isolated pilot Compose configuration is invalid."
& docker @targetCompose up -d --build mysql backend
Assert-LastExitCode "The isolated pilot containers could not be started."

$targetBackendId = (& docker @targetCompose ps -q backend).Trim()
if (-not $targetBackendId) {
    throw "The isolated pilot backend container was not created."
}

$deadline = (Get-Date).AddMinutes(4)
do {
    $health = (& docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' $targetBackendId).Trim()
    if ($health -eq "healthy") { break }
    if ($health -eq "unhealthy" -or (Get-Date) -ge $deadline) {
        & docker @targetCompose logs --tail 120 backend mysql
        throw "The clean pilot did not become healthy. Its isolated volumes were retained for diagnosis."
    }
    Start-Sleep -Seconds 3
} while ($true)

Write-Host "Transferring only the approved accounts and verified profile images..."
$exportArguments = @(
    "/app/dist/scripts/exportCleanPilotIdentities.js"
) + $identityArguments + @(
    "--confirmation", "EXPORT-APPROVED-PILOT-ACCOUNTS"
)
$bundleLines = @(& docker exec $sourceBackendId node @exportArguments)
Assert-LastExitCode "The approved-account export failed. The source database was not changed."
$bundleJson = $bundleLines -join [Environment]::NewLine
if (-not $bundleJson) {
    throw "The account export returned an empty bundle."
}

$receiptLines = @($bundleJson | & docker exec -i $targetBackendId node /app/dist/scripts/importCleanPilotIdentities.js --confirmation IMPORT-APPROVED-PILOT-ACCOUNTS)
Assert-LastExitCode "The clean-pilot account import failed. The isolated target was retained for diagnosis."
$receiptJson = $receiptLines -join [Environment]::NewLine
[System.IO.File]::WriteAllText($receiptPath, $receiptJson, $utf8WithoutBom)

Write-Host $receiptJson
Write-Host "Clean pilot database prepared successfully."
Write-Host "- Source records and files were not modified."
Write-Host "- $($StaffIdentities.Count + 3) approved accounts were transferred without their old sessions."
Write-Host "- Catalog Only is active and staff billing requests are off."
Write-Host "- No products, invoices, documents, import batches, or old audit history were copied."
Write-Host "- No supplier catalogue was imported."
Write-Host "- Import receipt: $receiptPath"
Write-Host "Next: inspect the isolated pilot, then prepare one supplier catalogue as a review batch."
