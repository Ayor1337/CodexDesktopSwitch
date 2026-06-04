$ErrorActionPreference = "Stop"

$root = Join-Path $env:USERPROFILE ".codex"
$cfg = Join-Path $root "config.toml"
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"

if (-not (Test-Path -LiteralPath $cfg)) {
  throw "config.toml not found: $cfg"
}

$currentProcessId = $PID
$targetProcessNames = @(
  "Codex",
  "codex",
  "extension-host",
  "node_repl"
)

$targetProcesses = Get-Process -ErrorAction SilentlyContinue |
  Where-Object {
    $targetProcessNames -contains $_.ProcessName -and
    $_.Id -ne $currentProcessId -and
    (
      ($_.ProcessName -eq "extension-host" -and $_.Path -like "*\.codex\plugins\cache\openai-bundled\*") -or
      ($_.Path -like "*\OpenAI\Codex\*" -or $_.Path -like "*\WindowsApps\OpenAI.Codex_*")
    )
  }

if ($targetProcesses) {
  Write-Host "Stopping Codex-related processes:"
  $targetProcesses | Select-Object ProcessName, Id, Path | Format-Table -AutoSize
  $targetProcesses | Stop-Process -Force -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 2
}

Copy-Item -LiteralPath $cfg -Destination "$cfg.bak-computer-use-$stamp" -Force

$text = Get-Content -LiteralPath $cfg -Raw
$text = [regex]::Replace($text, '(?ms)^\[marketplaces\.openai-bundled\]\r?\n.*?(?=^\[|\z)', '')
$text = $text -replace '(?m)^js_repl\s*=\s*false\s*$', 'js_repl = true'
$text = $text -replace '(?m)^sandbox\s*=\s*"elevated"\s*$', 'sandbox = "unelevated"'

if ($text -notmatch '(?m)^\[plugins\."chrome@openai-bundled"\]') {
  $computerUseBlock = '(?ms)(^\[plugins\."computer-use@openai-bundled"\]\r?\nenabled\s*=\s*true\r?\n)'
  $text = [regex]::Replace(
    $text,
    $computerUseBlock,
    "`$1`r`n[plugins.`"chrome@openai-bundled`"]`r`nenabled = true`r`n",
    1
  )
}

Set-Content -LiteralPath $cfg -Value $text -Encoding utf8

$paths = @(
  (Join-Path $root "plugins\cache\openai-bundled"),
  (Join-Path $root ".tmp\bundled-marketplaces\openai-bundled")
)

foreach ($path in $paths) {
  if (Test-Path -LiteralPath $path) {
    $resolvedRoot = (Resolve-Path -LiteralPath $root).Path
    $resolvedPath = (Resolve-Path -LiteralPath $path).Path
    if (-not $resolvedPath.StartsWith($resolvedRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
      throw "Refusing to rename path outside CODEX_HOME: $resolvedPath"
    }
    Rename-Item -LiteralPath $resolvedPath -NewName "$((Split-Path $resolvedPath -Leaf)).bak-$stamp" -Force
  }
}

Select-String -Path $cfg -Pattern 'marketplaces\.openai-bundled|plugins\."(browser|chrome|computer-use)@openai-bundled"|js_repl|sandbox\s*='
