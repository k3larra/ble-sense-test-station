$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$scriptPath = Join-Path $projectRoot "ble_sense_test_station.py"
$existing = Get-NetTCPConnection -LocalPort 8765 -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique
foreach ($processId in $existing) {
    $process = Get-Process -Id $processId -ErrorAction SilentlyContinue
    if ($process -and $process.ProcessName -like "python*") {
        Stop-Process -Id $processId -Force
    }
}
Start-Process powershell.exe -ArgumentList "-NoExit", "-Command", "Set-Location -LiteralPath '$projectRoot'; python '$scriptPath'" | Out-Null
