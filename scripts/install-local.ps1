# ============================================================================
# scripts/install-local.ps1 —— dsh-workbench-ecs 本地开发安装 (junction 实时生效)
# ----------------------------------------------------------------------------
# 用法:  在仓库根目录执行
#   powershell -ExecutionPolicy Bypass -File .\scripts\install-local.ps1        (install)
#   powershell -ExecutionPolicy Bypass -File .\scripts\install-local.ps1 status
#   powershell -ExecutionPolicy Bypass -File .\scripts\install-local.ps1 uninstall
#
# 安装 = ① 在 %DSH_HOME%\node_modules 下创建指向本仓库的 junction (与 DSH 的
#         ESM 解析链一致) ② 把插件行写进 profiles/*/cordis.patch.yml (用户
#         自有补丁层, 支持热重载)。幂等可逆, 仅涉及 %DSH_HOME% 与本仓库。
#
# 完成后: 刷新页面即可看到「设置 → Workbench ECS」标签; 若刷新后无效果,
# 重启 dsh web (Ctrl+C 后重新运行 dsh web)。
# ============================================================================
param([string]$Command = 'install')

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $HOME '.dsh' }
$linkPath = Join-Path $dshHome 'node_modules\dsh-workbench-ecs'
$rowName = 'dsh-workbench-ecs'
$patchBlock = @(
  '- insert:',
  '    # dsh-workbench-ecs (managed-by: install-local.ps1)',
  '    # 设置页 Workbench ECS + 7 个 ECS 工具; 随 dsh web 启动即生效。',
  '    - id: workbench-ecs',
  "      name: $rowName",
)
$templateLines = @(
  '# Your patch layer for this dsh profile, applied after every bundle layer:',
  '# a top-level YAML array of loader patch entries (id-targeted config',
  '# overrides, disables, and insert lists; `!!js` expressions allowed).',
  '[]',
  '',
)

function Get-ProfilePatchPaths {
  $profiles = Join-Path $dshHome 'profiles'
  $paths = @()
  if (Test-Path $profiles) {
    foreach ($d in Get-ChildItem $profiles -Directory -ErrorAction SilentlyContinue) {
      if ($d.Name -eq 'node_modules') { continue }
      $p = Join-Path $d.FullName 'cordis.patch.yml'
      if (Test-Path $p) { $paths += $p }
    }
  }
  return $paths
}

function Get-LinkState {
  if (-not (Test-Path $linkPath)) { return 'absent' }
  $item = Get-Item $linkPath -Force
  if ($item.LinkType -ne $null) { return "link:$($item.Target)" }
  return 'plain-dir'
}

function Invoke-EnsureLink {
  $state = Get-LinkState
  if ($state -eq "link:$repo") { Write-Host "[link] 已存在 junction: $linkPath"; return $true }
  if ($state -ne 'absent') { Write-Error "[link] $linkPath 已被非本插件的其它内容占用 ($state), 请手动处理"; return $false }
  New-Item -ItemType Junction -Path $linkPath -Target $repo -Force | Out-Null
  Write-Host "[link] 已创建 junction: $linkPath -> $repo"
  return $true
}

function Invoke-RemoveLink {
  $state = Get-LinkState
  if ($state -eq 'absent') { Write-Host "[link] 无链接可移除"; return }
  if ($state -eq "link:$repo") {
    Remove-Item $linkPath -Force -Recurse
    Write-Host "[link] 已移除 $linkPath"
  } else {
    Write-Warning "[link] $linkPath 不属于本插件 ($state), 未动它"
  }
}

function Test-RowPresent([string]$text) { return $text -match "name:\s*$rowName" }

function Invoke-WritePatch([string]$path) {
  $content = Get-Content $path -Raw -ErrorAction SilentlyContinue
  if ($null -eq $content) { Write-Error "[patch] 无法读取 $path"; return $false }
  if (Test-RowPresent $content) { Write-Host "[patch] $path 已包含插件行"; return $true }
  $blockText = ($patchBlock -join "`n") + "`n`n"
  if ($content -match '^\[\]\s*$') {
    # 模板态 (仅注释 + 空数组): 替换为插入块
    $next = $content -replace '^\[\]\s*$', $blockText.TrimEnd("`n")
  } else {
    $next = $content.TrimEnd("`n") + "`n" + $blockText
  }
  Set-Content -Path $path -Value $next -Encoding utf8NoBOM
  Write-Host "[patch] 已写入 $path"
  return $true
}

function Invoke-RemovePatch([string]$path) {
  $lines = Get-Content $path -ErrorAction SilentlyContinue
  if ($null -eq $lines) { return }
  $out = [System.Collections.Generic.List[string]]::new()
  $i = 0
  while ($i -lt $lines.Count) {
    $line = $lines[$i]
    if ($line -match '^- insert:\s*$') {
      $block = [System.Collections.Generic.List[string]]::new()
      $block.Add($line)
      $j = $i + 1
      while ($j -lt $lines.Count -and -not ($lines[$j] -match '^-\s')) {
        $block.Add($lines[$j])
        $j++
      }
      if (($block -join "`n") -match $rowName) {
        $i = $j
        continue   # 跳过整块 (已删除)
      }
      foreach ($b in $block) { $out.Add($b) }
      $i = $j
      continue
    }
    $out.Add($line)
    $i++
  }
  $body = ($out -join "`n").Trim()
  # 只剩注释/空白时恢复模板 [] (DSH 要求补丁层是合法 YAML 数组, 否则启动失败)
  $meaningful = $body -split "`n" | ForEach-Object { $_.Trim() } | Where-Object { $_ -ne '' -and -not $_.StartsWith('#') }
  if ($meaningful.Count -eq 0) {
    Set-Content -Path $path -Value ($templateLines -join "`n") -Encoding utf8NoBOM
    Write-Host "[patch] $path 已恢复为模板 []"
    return
  }
  Set-Content -Path $path -Value ($body + "`n") -Encoding utf8NoBOM
  Write-Host "[patch] 已从 $path 移除插件行"
}

switch ($Command.ToLower()) {
  'install' {
    if (-not (Invoke-EnsureLink)) { exit 1 }
    $paths = Get-ProfilePatchPaths
    if ($paths.Count -eq 0) {
      Write-Error '[patch] 找不到 profiles/*/cordis.patch.yml; 请先运行一次 dsh web 生成 profile, 或手动添加插件行'
      exit 1
    }
    $any = $false
    foreach ($p in $paths) { if (Invoke-WritePatch $p) { $any = $true } }
    if (-not $any) { exit 1 }
    Write-Host ''
    Write-Host '安装完成。接下来:'
    Write-Host '  1. 刷新页面 (热重载) 或在无热重载时重启 dsh web'
    Write-Host '  2. 设置(齿轮) → Workbench ECS 使用面板'
    Write-Host '  3. 当前会话可用工具: ecs_list / ecs_exec / ecs_upload / ecs_download / ecs_diagnose / ecs_deploy / ecs_session'
  }
  'status' {
    Write-Host "DSH_HOME: $dshHome"
    Write-Host "repo:     $repo"
    Write-Host "link:     $linkPath -> $(Get-LinkState)"
    foreach ($p in Get-ProfilePatchPaths) {
      $has = if (Test-RowPresent ((Get-Content $p -Raw))) { '已安装' } else { '未安装' }
      Write-Host "patch:    $p -> $has"
    }
    Write-Host ''
    Write-Host '安装: powershell -ExecutionPolicy Bypass -File .\scripts\install-local.ps1'
    Write-Host '卸载: powershell -ExecutionPolicy Bypass -File .\scripts\install-local.ps1 uninstall'
  }
  'uninstall' {
    foreach ($p in Get-ProfilePatchPaths) { Invoke-RemovePatch $p }
    Invoke-RemoveLink
    Write-Host '若还通过 dsh plugin --profile web add 安装过, 再执行: dsh plugin --profile web remove dsh-workbench-ecs'
  }
  default {
    Write-Error "未知命令: $Command (可用: install / status / uninstall)"
    exit 1
  }
}
