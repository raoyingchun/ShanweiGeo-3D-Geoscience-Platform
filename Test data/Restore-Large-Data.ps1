$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path $PSScriptRoot -Parent
$manifest = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'Compressed_Data_Manifest.json') -Raw | ConvertFrom-Json

function Resolve-RepoPath {
    param([string]$RelativePath)
    $parts = $RelativePath -split '[\\/]'
    $joined = $repoRoot
    foreach ($part in $parts) {
        if ($part) { $joined = Join-Path $joined $part }
    }
    return $joined
}

foreach ($entry in $manifest) {
    $archive = Resolve-RepoPath $entry.archive
    $target = Resolve-RepoPath $entry.path
    if ($entry.parts -and -not (Test-Path -LiteralPath $target)) {
        $outputStream = [IO.File]::Create($archive)
        try {
            foreach ($part in $entry.parts) {
                $partPath = Resolve-RepoPath $part
                if (-not (Test-Path -LiteralPath $partPath)) {
                    throw "Missing archive part: $part"
                }
                $inputStream = [IO.File]::OpenRead($partPath)
                try { $inputStream.CopyTo($outputStream) } finally { $inputStream.Dispose() }
            }
        } finally { $outputStream.Dispose() }
    }
    if (-not (Test-Path -LiteralPath $target)) {
        if (-not (Test-Path -LiteralPath $archive)) {
            throw "Missing archive: $($entry.archive)"
        }
        Expand-Archive -LiteralPath $archive -DestinationPath (Split-Path $target) -Force
    }
    $actual = (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actual -ne $entry.sha256) { throw "Integrity check failed: $($entry.path)" }
    Write-Output "Verified: $($entry.path)"
}
