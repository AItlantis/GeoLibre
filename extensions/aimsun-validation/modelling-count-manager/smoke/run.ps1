$ErrorActionPreference = 'Stop'

if (-not $env:AIMSUN_DATA_DIR) {
  Write-Output 'SKIP: AIMSUN_DATA_DIR is not set (data root holding <RUN>/detectors_*.parquet)'
  exit 0
}

$chromeExe = if ($env:CHROME) { $env:CHROME } else { Join-Path $env:ProgramFiles 'Google/Chrome/Application/chrome.exe' }
if (-not (Test-Path -LiteralPath $chromeExe)) { throw "Chrome executable not found: $chromeExe" }
$listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
$listener.Start()
$port = $listener.LocalEndpoint.Port
$listener.Stop()
$profile = Join-Path ([System.IO.Path]::GetTempPath()) ("mcm-smoke-" + [guid]::NewGuid().ToString('N'))
$chrome = $null
try {
  $args = @('--headless=new', '--disable-gpu', '--no-first-run', "--remote-debugging-port=$port", "--user-data-dir=`"$profile`"", 'about:blank')
  $chrome = Start-Process -FilePath $chromeExe -ArgumentList $args -WindowStyle Hidden -PassThru
  $env:CHROME_REMOTE_PORT = [string]$port
  node smoke/run.mjs
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
} finally {
  if ($chrome) {
    # Chrome owns helper processes. Collect only descendants of the PID this script started.
    $all = @(Get-CimInstance Win32_Process)
    $owned = [System.Collections.Generic.HashSet[int]]::new()
    [void]$owned.Add([int]$chrome.Id)
    $changed = $true
    while ($changed) {
      $changed = $false
      foreach ($proc in $all) {
        if ($owned.Contains([int]$proc.ParentProcessId) -and $owned.Add([int]$proc.ProcessId)) { $changed = $true }
      }
    }
    foreach ($pidToStop in @($owned | Sort-Object -Descending)) {
      Stop-Process -Id $pidToStop -Force -ErrorAction SilentlyContinue
    }
  }
  if (Test-Path -LiteralPath $profile) { Remove-Item -LiteralPath $profile -Recurse -Force -ErrorAction SilentlyContinue }
}
