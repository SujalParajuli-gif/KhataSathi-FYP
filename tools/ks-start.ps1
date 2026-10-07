# Optional entry point: exactly one task in one interactive Codex session.
$ksRepoRoot = Split-Path -Parent $PSScriptRoot
if (-not (Test-Path -LiteralPath (Join-Path $ksRepoRoot 'AGENTS.md'))) {
    throw 'KhataSathi repository entry point is missing.'
}
# Forward the exact chat token: AGENTS.md dispatches the single router9 definition.
$ksPrompt = 'ks-start'
& codex --cd $ksRepoRoot $ksPrompt
exit $LASTEXITCODE
