# ============================================================================
# scripts/workbench-setup.ps1 —— 一键配置阿里云 Workbench CLI 凭据 (Windows)
# ----------------------------------------------------------------------------
# 生成 ~/.workbench/config.json(权限 0600)并给出 RAM 最小权限策略与自检命令。
# 用法:
#   # AK 模式(默认)
#   ./workbench-setup.ps1 -AccessKeyId LTAIxxx -AccessKeySecret xxx
#   # StsToken 模式
#   ./workbench-setup.ps1 -Mode StsToken -AccessKeyId LTAIxxx -AccessKeySecret xxx -SecurityToken xxx
#   # RamRoleArn 模式(生产推荐)
#   ./workbench-setup.ps1 -Mode RamRoleArn -AccessKeyId LTAIxxx -AccessKeySecret xxx -RamRoleArn acs:ram::123456789:role/WorkbenchRole
#   # 多 profile: 指定 profile 名并切换
#   ./workbench-setup.ps1 -Profile prod -Mode RamRoleArn -AccessKeyId ... -AccessKeySecret ... -RamRoleArn ... -AutoSwitch
# ============================================================================
param(
  [ValidateSet('AK', 'StsToken', 'RamRoleArn', 'CredentialsCmd', 'CredentialsURI')]
  [string]$Mode = 'AK',
  [string]$AccessKeyId,
  [string]$AccessKeySecret,
  [string]$SecurityToken,
  [string]$RamRoleArn,
  [string]$RoleSessionName = 'workbench-session',
  [string]$CredentialsCmd,
  [string]$CredentialsUri,
  [string]$Profile = 'default',
  [switch]$AutoSwitch
)

$ErrorActionPreference = 'Stop'

# --- 1. 检查要求字段 ---
if ($Mode -in @('AK', 'StsToken', 'RamRoleArn')) {
  if ([string]::IsNullOrWhiteSpace($AccessKeyId) -or [string]::IsNullOrWhiteSpace($AccessKeySecret)) {
    Write-Error "模式 $Mode 需要 -AccessKeyId 与 -AccessKeySecret"
  }
}
if ($Mode -eq 'StsToken' -and [string]::IsNullOrWhiteSpace($SecurityToken)) {
  Write-Error 'StsToken 模式需要 -SecurityToken'
}
if ($Mode -eq 'RamRoleArn' -and [string]::IsNullOrWhiteSpace($RamRoleArn)) {
  Write-Error 'RamRoleArn 模式需要 -RamRoleArn'
}
if ($Mode -eq 'CredentialsCmd' -and [string]::IsNullOrWhiteSpace($CredentialsCmd)) {
  Write-Error 'CredentialsCmd 模式需要 -CredentialsCmd'
}
if ($Mode -eq 'CredentialsURI' -and [string]::IsNullOrWhiteSpace($CredentialsUri)) {
  Write-Error 'CredentialsURI 模式需要 -CredentialsUri'
}

# --- 2. 组织 profile 配置 ---
$profile = @{ mode = $Mode }
if (-not [string]::IsNullOrWhiteSpace($AccessKeyId)) { $profile['access_key_id'] = $AccessKeyId }
if (-not [string]::IsNullOrWhiteSpace($AccessKeySecret)) { $profile['access_key_secret'] = $AccessKeySecret }
if (-not [string]::IsNullOrWhiteSpace($SecurityToken)) { $profile['security_token'] = $SecurityToken }
if (-not [string]::IsNullOrWhiteSpace($RamRoleArn)) {
  $profile['ram_role_arn'] = $RamRoleArn
  $profile['role_session_name'] = $RoleSessionName
}
if (-not [string]::IsNullOrWhiteSpace($CredentialsCmd)) { $profile['credentials_cmd'] = $CredentialsCmd }
if (-not [string]::IsNullOrWhiteSpace($CredentialsUri)) { $profile['credentials_uri'] = $CredentialsUri }

# --- 3. 合并/备份既有配置 ---
$cfgDir = Join-Path $env:USERPROFILE '.workbench'
$cfgPath = Join-Path $cfgDir 'config.json'
New-Item -ItemType Directory -Force -Path $cfgDir | Out-Null
if (Test-Path $cfgPath) {
  $backup = "$cfgPath.bak-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
  Copy-Item $cfgPath $backup
  Write-Host "[backup] 已备份既有配置到 $backup"
  try { $config = Get-Content $cfgPath -Raw | ConvertFrom-Json } catch { $config = $null }
} else {
  $config = $null
}
if ($null -eq $config -or $null -eq $config.profiles) {
  $config = [PSCustomObject]@{ current = $Profile; profiles = [PSCustomObject]@{} }
}
# PowerShell 中向 PSObject 属性的动态字典添加键
$profilesProp = $config.profiles
$profilesProp | Add-Member -NotePropertyName $Profile -NotePropertyValue $profile -Force
if ($AutoSwitch -or $null -eq $config.current) { $config.current = $Profile }

# --- 4. 写入配置(UTF-8 无 BOM), 并尽力设置权限 ---
$json = $config | ConvertTo-Json -Depth 6
[System.IO.File]::WriteAllText($cfgPath, $json, [System.Text.UTF8Encoding]::new($false))
Write-Host "[ok] 已写入 $cfgPath (profile: $Profile, mode: $Mode, current: $($config.current))"

# Windows ACL 提示(仅本用户可读的推荐做法)
try {
  icacls $cfgPath /inheritance:r /grant:r "$env:USERNAME:(R)" | Out-Null
  Write-Host '[ok] 已收紧文件 ACL(仅当前用户可读)'
} catch {
  Write-Host '[warn] 无法收紧 ACL, 请确保其他用户无法读取该文件'
}

# --- 5. 自检与 RAM 策略提示 ---
Write-Host ''
Write-Host '=== 下一步 ==='
Write-Host '1. 自检 CLI:'
Write-Host "   workbench version"
Write-Host "   workbench config get"
Write-Host "   workbench list ecs --region cn-hangzhou --output json"
Write-Host ''
Write-Host '2. RAM 最小权限(给运行 CLI 的账号绑定): ecs-workbench:LoginECSInstance / ChatMessages,'
Write-Host '   ecs:DescribeInstances / DescribeCloudAssistantStatus / StartTerminalSession,'
Write-Host '   ram:CreateServiceLinkedRole(条件 ram:ServiceName = workbench.ecs.aliyuncs.com)'
Write-Host ''
Write-Host '3. 若本机未安装 CLI: irm https://workbench-cli.oss-cn-hangzhou.aliyuncs.com/install.ps1 | iex'
