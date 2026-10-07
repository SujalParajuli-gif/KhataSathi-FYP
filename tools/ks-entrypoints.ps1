# Optional session-local shortcut; does not alter the user's profile or PATH.
function ks-senior {
    & (Join-Path $PSScriptRoot 'ks-senior.ps1')
}

function ks-start {
    & (Join-Path $PSScriptRoot 'ks-start.ps1')
}
