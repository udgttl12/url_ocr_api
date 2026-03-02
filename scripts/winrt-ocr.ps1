param(
  [Parameter(Mandatory = $true)]
  [string]$ImagePath
)

$ErrorActionPreference = "Stop"

Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
$null = [Windows.Graphics.Imaging.SoftwareBitmap, Windows.Graphics.Imaging, ContentType = WindowsRuntime]
$null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Globalization.Language, Windows.Globalization, ContentType = WindowsRuntime]

function Wait-AsyncResult {
  param([Parameter(Mandatory = $true)]$AsyncOp)

  if ($AsyncOp -is [Windows.Foundation.IAsyncAction]) {
    $task = [System.WindowsRuntimeSystemExtensions]::AsTask([Windows.Foundation.IAsyncAction]$AsyncOp)
    $task.Wait()
    return $null
  }

  $iface = $AsyncOp.GetType().GetInterfaces() | Where-Object {
    $_.IsGenericType -and $_.GetGenericTypeDefinition().FullName -eq "Windows.Foundation.IAsyncOperation`1"
  } | Select-Object -First 1

  if ($null -eq $iface) {
    throw "Unsupported async operation type: $($AsyncOp.GetType().FullName)"
  }

  $resultType = $iface.GetGenericArguments()[0]
  $asTaskMethod = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq "AsTask" -and
    $_.IsGenericMethodDefinition -and
    $_.GetParameters().Count -eq 1 -and
    $_.GetParameters()[0].ParameterType.IsGenericType -and
    $_.GetParameters()[0].ParameterType.GetGenericTypeDefinition().FullName -eq "Windows.Foundation.IAsyncOperation`1"
  } | Select-Object -First 1

  $genericAsTask = $asTaskMethod.MakeGenericMethod($resultType)
  $task = $genericAsTask.Invoke($null, @($AsyncOp))
  $task.Wait()
  return $task.Result
}

$file = Wait-AsyncResult ([Windows.Storage.StorageFile]::GetFileFromPathAsync($ImagePath))
$stream = Wait-AsyncResult ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read))
$decoder = Wait-AsyncResult ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream))
$bitmap = Wait-AsyncResult ($decoder.GetSoftwareBitmapAsync())

$lang = New-Object Windows.Globalization.Language("ko-KR")
$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($lang)
if ($null -eq $engine) {
  $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
}
if ($null -eq $engine) {
  throw "WinRT OCR engine unavailable"
}

$result = Wait-AsyncResult ($engine.RecognizeAsync($bitmap))
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
Write-Output $result.Text
