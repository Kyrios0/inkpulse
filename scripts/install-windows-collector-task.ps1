$ErrorActionPreference = "Stop"

$taskName = "InkPulse Codex Collector"
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$agentPath = Join-Path $projectRoot "dist\apps\pc-agent\src\index.js"
$environmentPath = Join-Path $projectRoot ".env.local"
$nodePath = (Get-Command node.exe -ErrorAction Stop).Source

if (-not (Test-Path -LiteralPath $agentPath -PathType Leaf)) {
  throw "Collector build is missing. Run npm run build first."
}
if (-not (Test-Path -LiteralPath $environmentPath -PathType Leaf)) {
  throw ".env.local is missing. Configure the collector before installing the task."
}

$arguments = "--env-file-if-exists=`"$environmentPath`" `"$agentPath`" --watch"
$action = New-ScheduledTaskAction `
  -Execute $nodePath `
  -Argument $arguments `
  -WorkingDirectory $projectRoot
$trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
$principal = New-ScheduledTaskPrincipal `
  -UserId "$env:USERDOMAIN\$env:USERNAME" `
  -LogonType Interactive `
  -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -MultipleInstances IgnoreNew `
  -RestartCount 3 `
  -RestartInterval (New-TimeSpan -Minutes 1) `
  -StartWhenAvailable

Register-ScheduledTask `
  -TaskName $taskName `
  -Action $action `
  -Trigger $trigger `
  -Principal $principal `
  -Settings $settings `
  -Description "Publishes Codex and optionally Claude Desktop usage to InkPulse every minute while signed in." `
  -Force | Out-Null
Start-ScheduledTask -TaskName $taskName
Write-Output "Installed and started scheduled task: $taskName"
