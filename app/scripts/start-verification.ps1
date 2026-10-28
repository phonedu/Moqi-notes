# 起一台「验收用」桌面实例（docs/07-V3-验收记录.md「零、怎么开始跑」的执行版）。
# 用法：
#   powershell -ExecutionPolicy Bypass -File .\scripts\start-verification.ps1            # 桌面构建
#   powershell -ExecutionPolicy Bypass -File .\scripts\start-verification.ps1 -Browser   # 浏览器通道
#   powershell -ExecutionPolicy Bypass -File .\scripts\start-verification.ps1 -Fresh     # 重拷干净副本
#
# 它做三件事：拷实验库**副本**（真库永不做实验台，docs/06 §7.0）→ 给独立 WebView 用户目录
# （不干扰日常实例）→ 设好两个环境变量再起应用。两实例跑法（先删 device_id）见 docs 同一节。

$Browser = $false
$Fresh = $false
foreach ($Name in $args) {
  if ($Name -eq '-Browser') { $Browser = $true }
  if ($Name -eq '-Fresh') { $Fresh = $true }
}

$App = Split-Path -Parent $PSScriptRoot
$Work = Join-Path $env:TEMP 'moqi-verify-run'
$Webview = Join-Path $env:TEMP 'moqi-verify-webview'
$Marker = Join-Path $Work 'project-b.sqlite3'

if ($Fresh -and (Test-Path $Work)) { Remove-Item -Recurse -Force $Work }
if (-not (Test-Path $Marker)) {
  New-Item -ItemType Directory -Force $Work | Out-Null
  Copy-Item (Join-Path $App 'fixtures\library\project-b.sqlite3') $Marker
  Write-Host "[准备] 实验库副本 -> $Work"
} else {
  Write-Host "[准备] 复用已有副本 $Work（要重拷加 -Fresh）"
}
New-Item -ItemType Directory -Force $Webview | Out-Null

$env:MOQI_DATA_DIR = $Work
$env:WEBVIEW2_USER_DATA_FOLDER = $Webview
Write-Host "[环境] MOQI_DATA_DIR = $Work"
Write-Host "[环境] WEBVIEW2_USER_DATA_FOLDER = $Webview"

Set-Location $App
if ($Browser) {
  Write-Host '[起] 浏览器通道（pnpm dev）：文件导出会如实禁用、快照存 localStorage'
  pnpm dev
} else {
  Write-Host '[起] 桌面构建（pnpm tauri dev）：快照 / 导出 / 恢复 / 另存副本的原生路径只有这条走得到'
  pnpm tauri dev
}
