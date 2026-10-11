# publish-github-release.ps1 — 把安装包发布到 GitHub Release
#
# 用法（在 E:\dsh\deskpet 下）:
#   $env:GH_TOKEN = '<你的 GitHub PAT，需 repo 权限>'     # 只在当前会话生效，不要写进文件
#   pwsh -File build\publish-github-release.ps1
#
# 可选参数:
#   -Repo  wfknife/dsh-pet-xiaoshen
#   -Tag   v2.0.0-rc.2
#   -DryRun       只检查不发布
#
# 行为:
#   · 创建（或复用）Release，标题含两版说明；正文为中性文字，不含任何个人/开发信息
#   · 上传  deskpet-setup-<v>.exe（COS 发行版）与 deskpet-setup-clean-<v>.exe（GitHub 纯净版）
#   · 幂等：同名资产已存在则跳过
param(
  [string]$Repo = 'wfknife/dsh-pet-xiaoshen',
  [string]$Tag = '',
  [ValidateSet('clean', 'cos', 'both')]
  [string]$Only = 'clean',   # 默认只发纯净版
  [switch]$DryRun
)
$ErrorActionPreference = 'Stop'
Set-Location 'E:\dsh\deskpet'

$version = (Get-Content 'package.json' -Raw -Encoding UTF8 | ConvertFrom-Json).version
if (-not $Tag) { $Tag = 'v' + $version }
$notes = @"
## 桌宠小深 $version

Windows x64 安装包：``deskpet-setup-clean-$version.exe``

- 桌面伙伴「小深」：聊天、日记、记忆、生活状态、相册与成就
- 完整默认人设与提示词
- 首次安装后即可使用（需自备 DeepSeek API 密钥）
"@

$assets = @()
if ($Only -eq 'clean' -or $Only -eq 'both') { $assets += "releases\github-$version\deskpet-setup-clean-$version.exe" }
if ($Only -eq 'cos' -or $Only -eq 'both') { $assets += "releases\cos-$version\deskpet-setup-$version.exe" }
foreach ($a in $assets) {
  if (-not (Test-Path $a)) { throw "缺少待上传文件：$a（先跑 node build\prepare-release-dir.cjs）" }
  $i = Get-Item $a
  Write-Output ("待上传: {0}  {1} B" -f $i.Name, $i.Length)
}
if ($DryRun) { Write-Output 'DryRun：仅检查，未发布'; return }

$token = $env:GH_TOKEN
if (-not $token) { throw '未设置 GH_TOKEN（示例：$env:GH_TOKEN = ''ghp_xxx''；需要 repo 权限）' }
$headers = @{ Authorization = "Bearer $token"; 'User-Agent' = 'deskpet-release'; Accept = 'application/vnd.github+json' }

# 1) 创建或复用 Release
$body = @{ tag_name = $Tag; name = "桌宠小深 $version"; body = $notes; draft = $false; prerelease = ($version -match '-') } | ConvertTo-Json
$rel = $null
try {
  $rel = Invoke-RestMethod -Method Post -Uri "https://api.github.com/repos/$Repo/releases" -Headers $headers -Body $body -ContentType 'application/json; charset=utf-8'
  Write-Output "已创建 Release: $($rel.html_url)"
} catch {
  Write-Output "创建失败（可能已存在同名 tag），尝试复用: $($_.Exception.Message)"
  $rel = Invoke-RestMethod -Method Get -Uri "https://api.github.com/repos/$Repo/releases/tags/$Tag" -Headers $headers
  Write-Output "已复用 Release: $($rel.html_url)"
}

# 2) 上传资产（幂等）
$existing = @($rel.assets | ForEach-Object { $_.name })
foreach ($a in $assets) {
  $name = Split-Path $a -Leaf
  if ($existing -contains $name) { Write-Output "跳过（已存在）: $name"; continue }
  $uploadUrl = ($rel.upload_url -replace '\{.*$', '') + '?name=' + [uri]::EscapeDataString($name)
  Write-Output "上传中: $name ..."
  $r = curl.exe -sS -X POST $uploadUrl -H "Authorization: Bearer $token" -H 'Content-Type: application/octet-stream' -H 'User-Agent: deskpet-release' --data-binary "@$a"
  if ($LASTEXITCODE -ne 0) { throw "上传失败: $name" }
  $state = ($r | ConvertFrom-Json).state
  Write-Output ("  结果: " + $state + "  " + $name)
}

Write-Output ''
Write-Output "完成。发布页: https://github.com/$Repo/releases/tag/$Tag"
