$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path $PSScriptRoot -Parent
$manifest = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'Compressed_Data_Manifest.json') -Raw | ConvertFrom-Json
foreach ($entry in $manifest) {
    $archive = Join-Path $repoRoot $entry.archive
    $target = Join-Path $repoRoot $entry.path
    if ($entry.parts -and -not (Test-Path -LiteralPath $target)) {
        $outputStream = [IO.File]::Create($archive)
        try {
            foreach ($part in $entry.parts) {
                $inputStream = [IO.File]::OpenRead((Join-Path $repoRoot $part))
                try { $inputStream.CopyTo($outputStream) } finally { $inputStream.Dispose() }
            }
        } finally { $outputStream.Dispose() }
    }
    if (-not (Test-Path -LiteralPath $target)) {
        Expand-Archive -LiteralPath $archive -DestinationPath (Split-Path $target) -Force
    }
    $actual = (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actual -ne $entry.sha256) { throw "Integrity check failed: $($entry.path)" }
    Write-Output "Verified: $($entry.path)"
}
