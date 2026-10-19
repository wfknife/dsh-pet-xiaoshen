# build-release-both.ps1 — 一键重建双渠道发行包
#
# 用法（在 E:\dsh\deskpet 下）:  pwsh -File build\build-release-both.ps1
#
# 产出：
#   dist\release\deskpet-setup-<version>.exe         ← A: COS 发行版（保留更新检测，更新源见图标默认）
#   dist-clean\deskpet-setup-clean-<version>.exe     ← B: GitHub 纯净版（无更新模块/无更新 UI/无更新依赖）
#
# 注意：
#   · 纯净版构建会**临时改写源码**（main.js/preload.js/pet.js/index.html），脚本自身保证恢复；
#     因此构建期间不要运行桌宠，也不要同时跑别的构建。
#   · 两版都不含 dsh/node 运行时、不含私人数据（userData 与包体分离）。
#   · 构建完成后务必跑一次校验：node build\verify-dual-release.cjs
$ErrorActionPreference = 'Stop'
Set-Location (Split-Path -Parent $PSScriptRoot)
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue

$version = (Get-Content 'package.json' -Raw -Encoding UTF8 | ConvertFrom-Json).version
Write-Output "[1/3] 版本 $version — 校验 JSON 清单"
foreach ($f in 'package.json', 'build\electron-builder-release.json') {
  try { $null = Get-Content $f -Raw -Encoding UTF8 | ConvertFrom-Json } catch { throw "$f 不是合法 JSON：$($_.Exception.Message)" }
}

Write-Output "[2/3] 构建 COS 发行版（NSIS）"
& node node_modules/electron-builder/out/cli/cli.js --win nsis --config build/electron-builder-release.json -p never "-c.npmRebuild=false"
if ($LASTEXITCODE -ne 0) { throw "COS 版构建失败（exit $LASTEXITCODE）" }

Write-Output "[3/3] 构建 GitHub 纯净版（NSIS，临时改写源码后自动恢复）"
& node build/build-clean.mjs
if ($LASTEXITCODE -ne 0) { throw "纯净版构建失败（exit $LASTEXITCODE）" }

Write-Output ''
Write-Output '=== 产物与 SHA256 ==='
foreach ($p in "dist\release\deskpet-setup-$version.exe", "dist-clean\deskpet-setup-clean-$version.exe") {
  if (Test-Path $p) {
    $i = Get-Item $p
    Write-Output ("{0}`n  {1} B`n  {2}" -f $i.FullName, $i.Length, (Get-FileHash $p -Algorithm SHA256).Hash)
  } else { Write-Output "缺失: $p" }
}
Write-Output ''
Write-Output '下一步：node build\verify-dual-release.cjs  （包内容/更新栈差异校验）'
