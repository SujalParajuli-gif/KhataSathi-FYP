# Optional entry point: exactly one task in one interactive Codex session.
$ksRepoRoot = Split-Path -Parent $PSScriptRoot
if (-not (Test-Path -LiteralPath (Join-Path $ksRepoRoot 'AGENTS.md'))) {
    throw 'KhataSathi repository entry point is missing.'
}
$ksPrompt = 'ks-start. Read AGENTS.md and .agents/skills/khatasathi-workflow-router/SKILL.md section 9. Orchestrate exactly ONE task in this session using existing ks-plan/ks-impl/ks-senior/ks-next role builders and deterministic toolbox mission binding. Continue active partial work. After acceptance, closeout and authorized hygiene-gated commit, re-anchor once, report the next safe task without activating it, and STOP at the task boundary. Honor current user restrictions and genuine human gates. No nested Codex or legacy Python run loop.'
& codex --cd $ksRepoRoot $ksPrompt
exit $LASTEXITCODE
