# ============================================================================
# scripts/install-local.ps1 -- dsh-workbench-ecs local dev install (junction)
# ----------------------------------------------------------------------------
# Usage (run from the repo root):
#   powershell -ExecutionPolicy Bypass -File .\scripts\install-local.ps1                     (install, all profiles)
#   powershell -ExecutionPolicy Bypass -File .\scripts\install-local.ps1 -Profile desktop    (desktop app only)
#   powershell -ExecutionPolicy Bypass -File .\scripts\install-local.ps1 -Profile web        (dsh web / browser only)
#   powershell -ExecutionPolicy Bypass -File .\scripts\install-local.ps1 status
#   powershell -ExecutionPolicy Bypass -File .\scripts\install-local.ps1 uninstall
#
# install = (1) create a junction at %DSH_HOME%\node_modules\dsh-workbench-ecs
# pointing at this repo (matches the DSH ESM resolution chain),
#           (2) insert the plugin row into the selected profiles'
# cordis.patch.yml (the user patch layer, hot-reloadable). Idempotent &
# reversible; touches only %DSH_HOME% and this repo.
#
# Two hosts, two profiles (v0.9.0):
#   * browser -> `dsh web`      -> %DSH_HOME%\profiles\web
#   * desktop -> the Electron app -> %DSH_HOME%\profiles\desktop
#     (the desktop host is @deepseek-ai/dsh-desktop-host and loads the
#      `desktop` profile; it is still the web surface, so the same row works.)
# Install into BOTH unless -Profile narrows it. The desktop app must be
# restarted for a newly inserted row to take effect (it boots the profile once).
#
# After install: refresh the settings page (or restart the host) and open
# Settings (gear) -> Workbench ECS.
# NOTE: keep this file ASCII-only (Windows PowerShell 5.1 parses ANSI; use
# install-local.mjs-style scripts for non-ASCII output).
# ============================================================================
param(
  [string]$Command = 'install',
  # install / uninstall target: all (default) | web | desktop | <any profile dir name>
  [string]$Profile = 'all'
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $HOME '.dsh' }
$linkPath = Join-Path $dshHome 'node_modules\dsh-workbench-ecs'
$rowName = 'dsh-workbench-ecs'
$patchBlock = @(
  '- insert:',
  '    # dsh-workbench-ecs (managed-by: install-local.ps1)',
  '    # Settings panel "Workbench ECS" + 11 ECS tools; applies at host start',
  "    # (`dsh web` for the browser profile, the desktop app for the desktop one).",
  '    - id: workbench-ecs',
  "      name: $rowName"
)
$templateLines = @(
  '# Your patch layer for this dsh profile, applied after every bundle layer:',
  '# a top-level YAML array of loader patch entries (id-targeted config',
  '# overrides, disables, and insert lists; `!!js` expressions allowed).',
  '[]',
  ''
)

# Which profile directories this invocation targets. `all` = every profile that
# already has a cordis.patch.yml (profiles are created on first host start); a
# name selects exactly that one (and must already exist).
function Get-ProfilePatchPaths {
  $profiles = Join-Path $dshHome 'profiles'
  $paths = @()
  if (-not (Test-Path $profiles)) { return $paths }
  foreach ($d in Get-ChildItem $profiles -Directory -ErrorAction SilentlyContinue) {
    if ($d.Name -eq 'node_modules') { continue }
    if ($Profile -ne 'all' -and $d.Name -ne $Profile) { continue }
    $p = Join-Path $d.FullName 'cordis.patch.yml'
    if (Test-Path $p) { $paths += $p }
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
  if ($state -eq "link:$repo") { Write-Host "[link] junction already present: $linkPath"; return $true }
  if ($state -ne 'absent') { Write-Error "[link] $linkPath is occupied by foreign content ($state); fix manually"; return $false }
  New-Item -ItemType Junction -Path $linkPath -Target $repo -Force | Out-Null
  Write-Host "[link] created junction: $linkPath -> $repo"
  return $true
}

function Invoke-RemoveLink {
  $state = Get-LinkState
  if ($state -eq 'absent') { Write-Host "[link] nothing to remove"; return }
  if ($state -eq "link:$repo") {
    $item = Get-Item $linkPath -Force
    if ($item.LinkType -eq 'Junction') {
      # Delete junctions without recursion. On Windows PowerShell 5.1,
      # Remove-Item -Recurse on a reparse point can delete the *target's*
      # contents; Directory.Delete(recurse=$false) removes the link itself.
      [System.IO.Directory]::Delete($linkPath, $false)
    } else {
      Remove-Item -LiteralPath $linkPath -Force
    }
    if (Test-Path $linkPath) {
      Write-Warning "[link] $linkPath still exists after removal; remove it manually"
    } else {
      Write-Host "[link] removed $linkPath"
    }
  } else {
    Write-Warning "[link] $linkPath does not belong to this plugin ($state); left untouched"
  }
}

function Test-RowPresent([string]$text) { return $text -match "name:\s*$rowName" }

function Write-TextFile([string]$path, [string]$text) {
  # UTF-8 without BOM (compatible with Windows PowerShell 5.1)
  $enc = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($path, $text, $enc)
}

function Invoke-WritePatch([string]$path) {
  $content = Get-Content $path -Raw -ErrorAction SilentlyContinue
  if ($null -eq $content) { Write-Error "[patch] cannot read $path"; return $false }
  if (Test-RowPresent $content) { Write-Host "[patch] $path already contains the row"; return $true }
  $blockText = ($patchBlock -join "`n") + "`n`n"
  if ($content -match '(?m)^\[\]\s*$') {
    # template state (comments + empty array): replace the empty array line
    # with the insert block (must NOT leave a bare [] next to the block —
    # that combination is invalid YAML and would break the profile boot)
    $next = $content -replace '(?m)^\[\]\s*$', $blockText.TrimEnd("`n")
  } else {
    $next = $content.TrimEnd("`n") + "`n" + $blockText
  }
  Write-TextFile $path $next
  Write-Host "[patch] wrote $path"
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
        continue   # skip whole block (removed)
      }
      foreach ($b in $block) { $out.Add($b) }
      $i = $j
      continue
    }
    $out.Add($line)
    $i++
  }
  $body = ($out -join "`n").Trim()
  # Only comments/whitespace left: restore the template [] (DSH requires a
  # valid YAML array here, otherwise the profile fails to boot).
  $meaningful = $body -split "`n" | ForEach-Object { $_.Trim() } | Where-Object { $_ -ne '' -and -not $_.StartsWith('#') }
  if ($meaningful.Count -eq 0) {
    Write-TextFile $path ($templateLines -join "`n")
    Write-Host "[patch] $path restored to template []"
    return
  }
  Write-TextFile $path ($body + "`n")
  Write-Host "[patch] removed the row from $path"
}

function Show-Targets {
  Write-Host "target:   -Profile $Profile"
  foreach ($p in Get-ProfilePatchPaths) {
    $name = Split-Path -Parent $p | Split-Path -Leaf
    $has = if (Test-RowPresent ((Get-Content $p -Raw))) { 'installed' } else { 'absent' }
    Write-Host "profile:  $name -> $has"
  }
}

switch ($Command.ToLower()) {
  'install' {
    if (-not (Invoke-EnsureLink)) { exit 1 }
    $paths = Get-ProfilePatchPaths
    if ($paths.Count -eq 0) {
      if ($Profile -eq 'all') {
        Write-Error '[patch] no profiles/*/cordis.patch.yml found; start `dsh web` (or the desktop app) once to generate the profile, or add the row manually'
      } else {
        Write-Error "[patch] profile '$Profile' has no cordis.patch.yml; start that host once (the desktop app for 'desktop', ``dsh web`` for 'web') or add the row manually"
      }
      exit 1
    }
    $any = $false
    foreach ($p in $paths) { if (Invoke-WritePatch $p) { $any = $true } }
    if (-not $any) { exit 1 }
    Write-Host ''
    Show-Targets
    Write-Host ''
    Write-Host 'Install done. Next:'
    Write-Host '  1. Browser (`dsh web`): refresh the page, or restart `dsh web`'
    Write-Host '  2. Desktop app: quit and reopen DeepSeek Harness (the profile boots once)'
    Write-Host '  3. Open Settings(gear) -> Workbench ECS'
    Write-Host '  4. Session tools: ecs_find / ecs_list / ecs_exec / ecs_log / ecs_upload /'
    Write-Host '     ecs_download / ecs_diagnose / ecs_deploy / ecs_runbook / ecs_snapshot / ecs_session'
  }
  'status' {
    Write-Host "DSH_HOME: $dshHome"
    Write-Host "repo:     $repo"
    Write-Host "link:     $linkPath -> $(Get-LinkState)"
    Show-Targets
    Write-Host ''
    Write-Host 'Install:   powershell -ExecutionPolicy Bypass -File .\scripts\install-local.ps1 [-Profile all|web|desktop]'
    Write-Host 'Uninstall: powershell -ExecutionPolicy Bypass -File .\scripts\install-local.ps1 uninstall [-Profile ...]'
  }
  'uninstall' {
    foreach ($p in Get-ProfilePatchPaths) { Invoke-RemovePatch $p }
    Invoke-RemoveLink
    Write-Host 'If it was also installed via `dsh plugin --profile <name> add`, run: dsh plugin --profile <name> remove dsh-workbench-ecs'
  }
  default {
    Write-Error "unknown command: $Command (available: install / status / uninstall)"
    exit 1
  }
}
