# Optional terminal entry point: canonical Senior review only.
$ksRepoRoot = Split-Path -Parent $PSScriptRoot
if (-not (Test-Path -LiteralPath (Join-Path $ksRepoRoot 'AGENTS.md'))) {
    throw 'KhataSathi repository entry point is missing.'
}
$ksPrompt = 'ks-senior. Follow AGENTS.md and the workflow-router manual Senior role. Independently inspect implementation and evidence, write/update canonical review, and return ACCEPTED or FIX_REQUIRED. Stop after review; do not plan, implement, closeout, commit or begin another task. Reuse the existing Senior role builder via role-instructions ks-senior. Honor current user restrictions.'
& codex --cd $ksRepoRoot $ksPrompt
exit $LASTEXITCODE
