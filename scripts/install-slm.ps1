param(
  [string]$Model = "qwen2.5:3b"
)

$ErrorActionPreference = "Stop"

function Resolve-OllamaExe {
  $cmd = Get-Command ollama -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  $local = Join-Path $env:LocalAppData "Programs\Ollama\ollama.exe"
  if (Test-Path $local) { return $local }
  return $null
}

$ollamaExe = Resolve-OllamaExe
if (-not $ollamaExe) {
  Write-Output "Ollama not found. Installing with winget..."
  winget install -e --id Ollama.Ollama --silent --disable-interactivity --accept-package-agreements --accept-source-agreements
  if ($LASTEXITCODE -ne 0) {
    throw "winget install failed with exit code $LASTEXITCODE"
  }

  $ollamaExe = Resolve-OllamaExe
  if (-not $ollamaExe) {
    throw "Ollama install completed but executable was not found. Reopen terminal and retry."
  }
}

try {
  $null = Invoke-WebRequest -Uri "http://127.0.0.1:11434/api/tags" -UseBasicParsing -TimeoutSec 3
} catch {
  Start-Process -FilePath $ollamaExe -ArgumentList "serve" -WindowStyle Hidden
  Start-Sleep -Seconds 3
}

& $ollamaExe pull $Model
if ($LASTEXITCODE -ne 0) {
  throw "ollama pull failed with exit code $LASTEXITCODE"
}

Write-Output "SLM install complete. Model: $Model"
