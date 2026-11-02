param([switch]$SoftwareRendering)
$taskRoot = Split-Path -Parent $PSScriptRoot
$taskExe = Join-Path $taskRoot 'node_modules\electron\dist\electron.exe'
if (!(Test-Path -LiteralPath $taskExe)) { throw 'Electron runtime is missing.' }
$taskLogDir = Join-Path $taskRoot 'logs'
New-Item -ItemType Directory -Path $taskLogDir -Force | Out-Null
$taskStamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
$taskArgs = @('"' + $taskRoot + '"')
if ($SoftwareRendering) { $taskArgs += '--sw' }
Start-Process -FilePath $taskExe -ArgumentList $taskArgs -WorkingDirectory $taskRoot -WindowStyle Normal -RedirectStandardOutput (Join-Path $taskLogDir ($taskStamp + '.stdout.log')) -RedirectStandardError (Join-Path $taskLogDir ($taskStamp + '.stderr.log'))
