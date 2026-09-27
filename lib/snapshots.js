// ============================================================================
// lib/snapshots.js —— 发布快照机制(N1, v0.8.0; 反馈 §四.10)
// ----------------------------------------------------------------------------
// 动机: 一次受控发布的"最后一公里"其实是两件事 —— **动手前的回滚点**与
// **动手后的差异核对**。此前每个 agent 都要自己手写 `docker tag` + `docker cp` +
// 采集 `docker images/ps` 的拼装脚本, 20 多行且每次重写。
//
// 设计边界(与 runbook 同一原则: 插件只给机制, 内容留在项目仓库):
//   - **机制**在这里: 采集脚本的生成与解析、清单结构、差异计算、工作区读写;
//   - **内容**由项目给出: 快照哪些路径 / 采集什么命令, 写在
//     .dsh/workbench-ecs/snapshot-profiles.json 的具名 profile 里;
//   - 默认采集是**通用且只读**的: 主机信息 / 容器清单 / 镜像清单 / 监听端口。
//
// 清单落在**工作区** .dsh/workbench-ecs/snapshots/<name>.json(可 diff、可提交、可 grep),
// 因此 list 是零远程调用的。
// ============================================================================
import { shellQuote, textDigest, firstDifferingLine, ensureLocalDir } from './common.js'

// 相对会话工作区的快照目录与 profile 文件
export const SNAPSHOT_DIR = '.dsh/workbench-ecs/snapshots'
export const SNAPSHOT_PROFILES_FILE = '.dsh/workbench-ecs/snapshot-profiles.json'
// 快照名字白名单(直接拼进文件名, 因此必须挡住 / \ .. 等穿越写法)
export const SNAPSHOT_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

// 采集脚本/输出用的分段标记(与 ecs_log 的标记不同名)
export const SNAPSHOT_MARKERS = {
  command: '__DSH_SNAP_CMD__',
  commandExit: '__DSH_SNAP_RC__',
  path: '__DSH_SNAP_PATH__',
}

// 默认采集器(通用、只读、不绑定任何项目): docker 缺失时会记为 rc!=0 的空输出,
// 不影响其它采集器 —— 快照在没装 docker 的机器上同样可用。
// 刻意**不放易变内容**(如 uptime / df 的精确数值): 快照用于"发布前后对差异",
// 噪声会淹掉真正的变化; 需要这些指标时在项目的 profile 里按需加采集器。
export const DEFAULT_SNAPSHOT_COLLECTORS = [
  { label: 'host', command: 'hostname; uname -sr' },
  { label: 'images', command: "docker images --digests --format '{{.Repository}}:{{.Tag}} {{.ID}} {{.Digest}}' 2>/dev/null | sort" },
  { label: 'containers', command: "docker ps --format '{{.Names}} {{.Image}} {{.Status}} {{.Ports}}' 2>/dev/null | sort" },
  { label: 'ports', command: "ss -tln 2>/dev/null | tail -n +2 | awk '{print $4}' | sort" },
]

export const DEFAULT_SNAPSHOT_COLLECTOR_LABELS = DEFAULT_SNAPSHOT_COLLECTORS.map((c) => c.label)
// 采集输出保留的前若干行(差异提示用; 完整输出不进清单, 只留摘要与行数)
export const SNAPSHOT_HEAD_LINES = 12
// paths 上限: 再多就不该塞进一次快照, 应该拆成多份
export const SNAPSHOT_MAX_PATHS = 50

export function isValidSnapshotName(name) {
  return SNAPSHOT_NAME_RE.test(String(name != null ? name : ''))
}

export function snapshotDirOf(opts = {}) {
  const direct = opts.dir !== undefined && opts.dir !== null ? String(opts.dir).trim() : ''
  if (direct.length > 0) return direct.replace(/[\\/]+$/, '')
  const rootRaw = opts.workspaceRoot !== undefined && opts.workspaceRoot !== null ? String(opts.workspaceRoot) : ''
  const root = rootRaw.replace(/[\\/]+$/, '')
  return (root.length > 0 ? root + '/' : '') + SNAPSHOT_DIR
}

export function snapshotProfilesPathOf(opts = {}) {
  const rootRaw = opts.workspaceRoot !== undefined && opts.workspaceRoot !== null ? String(opts.workspaceRoot) : ''
  const root = rootRaw.replace(/[\\/]+$/, '')
  return (root.length > 0 ? root + '/' : '') + SNAPSHOT_PROFILES_FILE
}

// 归一采集器选择: 缺省 = 全部默认采集器; 给了标签数组 = 只取这些
export function resolveCollectors(labels) {
  if (labels === undefined || labels === null) return DEFAULT_SNAPSHOT_COLLECTORS.slice()
  if (!Array.isArray(labels)) {
    throw new Error('ecs_snapshot: collectors 必须是数组, 可选: ' + DEFAULT_SNAPSHOT_COLLECTOR_LABELS.join(' / '))
  }
  const wanted = labels.map((l) => String(l != null ? l : '').trim()).filter((l) => l.length > 0)
  if (wanted.length === 0) return DEFAULT_SNAPSHOT_COLLECTORS.slice()
  const unknown = wanted.filter((l) => !DEFAULT_SNAPSHOT_COLLECTOR_LABELS.includes(l))
  if (unknown.length > 0) {
    throw new Error('ecs_snapshot: 未知的默认采集器 ' + unknown.join(', ') +
      '; 可选: ' + DEFAULT_SNAPSHOT_COLLECTOR_LABELS.join(' / ') + '(自定义采集请用 commands)')
  }
  return DEFAULT_SNAPSHOT_COLLECTORS.filter((c) => wanted.includes(c.label))
}

// 自定义采集器归一: { label: command }
export function resolveCommandCollectors(commands) {
  if (commands === undefined || commands === null) return []
  if (typeof commands !== 'object' || Array.isArray(commands)) {
    throw new Error('ecs_snapshot: commands 必须是对象 { "<标签>": "<只读命令>" }')
  }
  const out = []
  for (const label of Object.keys(commands)) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/.test(label)) {
      throw new Error('ecs_snapshot: commands 的标签 ' + JSON.stringify(label) + ' 非法(只允许字母/数字/._-, 不超过 32 字符)')
    }
    const command = String(commands[label] != null ? commands[label] : '').trim()
    if (command.length === 0) throw new Error('ecs_snapshot: commands.' + label + ' 的命令为空')
    out.push({ label, command })
  }
  return out
}

// 归一 paths: 字符串数组(去重、上限)
export function resolvePaths(paths) {
  if (paths === undefined || paths === null) return []
  if (!Array.isArray(paths)) throw new Error('ecs_snapshot: paths 必须是远端路径字符串数组')
  const list = Array.from(new Set(paths.map((p) => String(p != null ? p : '').trim()).filter((p) => p.length > 0)))
  if (list.length > SNAPSHOT_MAX_PATHS) {
    throw new Error('ecs_snapshot: paths 一次最多 ' + SNAPSHOT_MAX_PATHS + ' 个(收到 ' + list.length + '); 更多请拆成多份快照')
  }
  return list
}

// ----------------------------------------------------------------------------
// 采集脚本: 一次远程调用内完成全部采集(单次实例锁, 一条 CLI 调用)。
// 每个采集器/路径前打标记, 输出由 parseSnapshotOutput 按标记切段。
// 全部命令只读(sha256sum/stat/find/docker images|ps/ss), 经只读护栏预检。
// ----------------------------------------------------------------------------
export function buildSnapshotScript(spec) {
  const collectors = spec !== undefined && Array.isArray(spec.collectors) ? spec.collectors : []
  const paths = spec !== undefined && Array.isArray(spec.paths) ? spec.paths : []
  const lines = []
  for (const collector of collectors) {
    const label = shellQuote(collector.label)
    lines.push('printf "' + SNAPSHOT_MARKERS.command + '%s\\n" ' + label)
    lines.push('(' + collector.command + ') 2>&1')
    lines.push('printf "' + SNAPSHOT_MARKERS.commandExit + '%s %s\\n" ' + label + ' "$?"')
  }
  for (const path of paths) {
    const quoted = shellQuote(path)
    lines.push('printf "' + SNAPSHOT_MARKERS.path + '%s\\n" ' + quoted)
    lines.push('{ if [ -f ' + quoted + ' ]; then printf "file %s %s %s\\n" "$(sha256sum ' + quoted +
      " | cut -d' ' -f1)\" \"$(stat -c %s " + quoted + ' 2>/dev/null)" \"$(stat -c %Y ' + quoted + ' 2>/dev/null)";')
    lines.push('  elif [ -d ' + quoted + ' ]; then printf "dir %s %s %s\\n" "$(find ' + quoted +
      " -type f -printf '%P %s\\n' 2>/dev/null | sort | sha256sum | cut -d' ' -f1)\" \"$(find " + quoted +
      ' -type f 2>/dev/null | wc -l)" \"$(stat -c %Y ' + quoted + ' 2>/dev/null)";')
    lines.push('  else printf "missing\\n"; fi; } 2>/dev/null')
  }
  return lines.join('\n')
}

// 解析采集输出: 按标记切段, 逐条给出采集结论
export function parseSnapshotOutput(text, spec) {
  const collectors = spec !== undefined && Array.isArray(spec.collectors) ? spec.collectors : []
  const paths = spec !== undefined && Array.isArray(spec.paths) ? spec.paths : []
  const output = String(text != null ? text : '')

  const commands = {}
  for (const collector of collectors) {
    const start = output.indexOf(SNAPSHOT_MARKERS.command + collector.label + '\n')
    if (start < 0) {
      commands[collector.label] = { exit_code: undefined, missing_marker: true }
      continue
    }
    const bodyStart = start + (SNAPSHOT_MARKERS.command + collector.label + '\n').length
    const exitMarker = SNAPSHOT_MARKERS.commandExit + collector.label + ' '
    const exitAt = output.indexOf(exitMarker, bodyStart)
    const raw = (exitAt < 0 ? output.slice(bodyStart) : output.slice(bodyStart, exitAt)).replace(/\n$/, '')
    let exitCode
    if (exitAt >= 0) {
      const lineEnd = output.indexOf('\n', exitAt)
      const tail = output.slice(exitAt + exitMarker.length, lineEnd < 0 ? undefined : lineEnd)
      const n = Number(tail.trim())
      exitCode = Number.isFinite(n) ? n : undefined
    }
    const lines = raw.length > 0 ? raw.split('\n') : []
    commands[collector.label] = {
      exit_code: exitCode,
      command: collector.command,
      lines: lines.length,
      digest: textDigest(raw),
      head: lines.slice(0, SNAPSHOT_HEAD_LINES),
    }
  }

  const files = {}
  for (const path of paths) {
    const marker = SNAPSHOT_MARKERS.path + path + '\n'
    const start = output.indexOf(marker)
    if (start < 0) {
      files[path] = { status: 'unknown', missing_marker: true }
      continue
    }
    const bodyStart = start + marker.length
    const nextMarker = output.indexOf(SNAPSHOT_MARKERS.path, bodyStart)
    const rcMarker = output.indexOf(SNAPSHOT_MARKERS.commandExit, bodyStart)
    const ends = [nextMarker, rcMarker].filter((n) => n >= 0)
    const end = ends.length > 0 ? Math.min.apply(null, ends) : output.length
    const line = output.slice(bodyStart, end).split('\n')[0].trim()
    const parts = line.split(/\s+/)
    if (parts[0] === 'file') {
      files[path] = { status: 'file', sha256: parts[1], size: Number(parts[2]), mtime: Number(parts[3]) }
    } else if (parts[0] === 'dir') {
      files[path] = { status: 'dir', digest: parts[1], entries: Number(parts[2]), mtime: Number(parts[3]) }
    } else {
      files[path] = { status: 'missing' }
    }
  }
  return { commands, files }
}

// ----------------------------------------------------------------------------
// 差异计算: 逐条对比两次采集结论
//   files:    added / removed / changed(内容或大小变了) / metadata-only(只有 mtime 变了)
//   commands: changed(输出摘要不同) / exit-changed / unchanged, 并给出首个差异行
// ----------------------------------------------------------------------------
function sameNumber(a, b) {
  return (Number.isFinite(a) ? a : undefined) === (Number.isFinite(b) ? b : undefined)
}

export function diffFacts(before, after) {
  const files = []
  const beforeFiles = before !== undefined && before !== null && typeof before.files === 'object' ? before.files : {}
  const afterFiles = after !== undefined && after !== null && typeof after.files === 'object' ? after.files : {}
  for (const path of Object.keys(beforeFiles).concat(Object.keys(afterFiles))) {
    if (files.some((f) => f.path === path)) continue
    const a = beforeFiles[path]
    const b = afterFiles[path]
    if (a === undefined) {
      files.push({ path, status: 'added', after: b !== undefined ? b.status : undefined })
      continue
    }
    if (b === undefined) {
      files.push({ path, status: 'removed', before: a.status })
      continue
    }
    if (a.status !== b.status) {
      // 文件/目录"从有到无"/"从无到有"按 added / removed 报(基线里没有 = 新增;
      // 现在不存在 = 被删除), 只有 file↔dir 这类真正的类型变化才叫 changed。
      if (b.status === 'missing') {
        files.push({ path, status: 'removed', before: a.status })
      } else if (a.status === 'missing') {
        files.push({ path, status: 'added', after: b.status })
      } else {
        files.push({ path, status: 'changed', detail: '类型变化: ' + a.status + ' → ' + b.status })
      }
      continue
    }
    if (a.status === 'file') {
      const contentSame = String(a.sha256) === String(b.sha256)
      const metaSame = sameNumber(a.size, b.size) && sameNumber(a.mtime, b.mtime)
      if (!contentSame) {
        files.push({ path, status: 'changed', before: a.sha256, after: b.sha256, size_before: a.size, size_after: b.size })
      } else if (!metaSame) {
        files.push({
          path, status: 'metadata-only',
          detail: '内容一致(sha256 相同), 仅 大小/修改时间 变化: ' + a.size + 'B→' + b.size + 'B',
        })
      } else {
        files.push({ path, status: 'unchanged', before: a.sha256, after: b.sha256 })
      }
      continue
    }
    if (a.status === 'dir') {
      const listSame = String(a.digest) === String(b.digest)
      const countSame = sameNumber(a.entries, b.entries)
      if (!listSame || !countSame) {
        files.push({
          path, status: 'changed',
          detail: '目录清单变化: ' + a.entries + ' → ' + b.entries + ' 个文件',
          before: a.digest, after: b.digest,
        })
      } else if (!sameNumber(a.mtime, b.mtime)) {
        files.push({ path, status: 'metadata-only', detail: '文件清单一致, 仅目录修改时间变化' })
      } else {
        files.push({ path, status: 'unchanged', before: a.digest, after: b.digest })
      }
      continue
    }
    files.push({ path, status: 'unchanged', before: a.status, after: b.status })
  }

  const commands = []
  const beforeCommands = before !== undefined && before !== null && typeof before.commands === 'object' ? before.commands : {}
  const afterCommands = after !== undefined && after !== null && typeof after.commands === 'object' ? after.commands : {}
  for (const label of Object.keys(beforeCommands).concat(Object.keys(afterCommands))) {
    if (commands.some((c) => c.label === label)) continue
    const a = beforeCommands[label]
    const b = afterCommands[label]
    if (a === undefined || b === undefined) {
      commands.push({ label, status: 'added', lines_after: b !== undefined ? b.lines : undefined })
      continue
    }
    const digestSame = String(a.digest) === String(b.digest)
    const exitSame = sameNumber(a.exit_code, b.exit_code)
    if (!digestSame) {
      const diff = firstDifferingLine((a.head !== undefined ? a.head : []).join('\n'), (b.head !== undefined ? b.head : []).join('\n'))
      commands.push({
        label, status: 'changed',
        lines_before: a.lines, lines_after: b.lines,
        first_difference: diff,
        before_head: a.head, after_head: b.head,
      })
    } else if (!exitSame) {
      commands.push({ label, status: 'exit-changed', exit_before: a.exit_code, exit_after: b.exit_code })
    } else {
      commands.push({ label, status: 'unchanged', lines_after: b.lines })
    }
  }

  const changed = files.filter((f) => f.status !== 'unchanged').length +
    commands.filter((c) => c.status !== 'unchanged').length
  return {
    files,
    commands,
    changed_count: changed,
    clean: changed === 0,
    files_changed: files.filter((f) => f.status === 'changed' || f.status === 'added' || f.status === 'removed').length,
    commands_changed: commands.filter((c) => c.status === 'changed' || c.status === 'exit-changed' || c.status === 'added').length,
  }
}

// ----------------------------------------------------------------------------
// 工作区读写(清单 = 纯 JSON)
// ----------------------------------------------------------------------------
async function fsOf(ctx) {
  const fs = ctx !== undefined && typeof ctx.get === 'function' ? ctx.get('fs') : undefined
  if (fs === undefined || fs === null) {
    throw new Error('ecs_snapshot: 当前环境未挂载 fs 服务, 无法读写工作区快照清单')
  }
  return fs
}

// 读取具名 profile(内容留在项目仓库): { paths?, commands?, collectors? }
export async function loadSnapshotProfile(ctx, name, opts = {}) {
  const fs = await fsOf(ctx)
  const path = snapshotProfilesPathOf(opts)
  let text
  try {
    const target = await fs.resolve(path, opts.signal !== undefined ? { signal: opts.signal } : undefined)
    text = await fs.readText(target, opts.signal)
  } catch (err) {
    throw new Error('ecs_snapshot: 读取 profile 失败(' + path + '): ' +
      (err && err.message ? err.message : String(err)) +
      '; profile 文件格式: { "<名字>": { "paths": [...], "commands": {...}, "collectors": [...] } }')
  }
  let data
  try {
    data = JSON.parse(text)
  } catch (err) {
    throw new Error('ecs_snapshot: profile 文件不是合法 JSON(' + path + '): ' + (err && err.message ? err.message : String(err)))
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('ecs_snapshot: profile 文件顶层必须是对象 { "<名字>": {...} }')
  }
  const entry = data[name]
  if (entry === undefined || entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new Error('ecs_snapshot: profile "' + name + '" 不存在(' + path + '); 可用 profile: ' +
      (Object.keys(data).length > 0 ? Object.keys(data).join(', ') : '(文件里还没有任何 profile)'))
  }
  return { profile: entry, path }
}

export async function listSnapshotNames(ctx, opts = {}) {
  const fs = await fsOf(ctx)
  const dir = snapshotDirOf(opts)
  try {
    const target = await fs.resolve(dir, opts.signal !== undefined ? { signal: opts.signal } : undefined)
    const entries = await fs.listDir(target, opts.signal)
    return entries
      .map((e) => (typeof e === 'string' ? e : (e !== null && typeof e === 'object' && typeof e.name === 'string' ? e.name : '')))
      .filter((name) => name.endsWith('.json'))
      .map((name) => name.slice(0, -'.json'.length))
      .sort()
  } catch (err) {
    return []
  }
}

export async function loadSnapshot(ctx, name, opts = {}) {
  if (!isValidSnapshotName(name)) {
    throw new Error('ecs_snapshot: 快照名字非法(只允许字母/数字/._-, 且不以 . 开头): ' + String(name))
  }
  const fs = await fsOf(ctx)
  const path = snapshotDirOf(opts) + '/' + name + '.json'
  const target = await fs.resolve(path, opts.signal !== undefined ? { signal: opts.signal } : undefined)
  let text
  try {
    text = await fs.readText(target, opts.signal)
  } catch (err) {
    const available = await listSnapshotNames(ctx, opts)
    throw new Error('ecs_snapshot: 读取快照失败(' + path + '): ' + (err && err.message ? err.message : String(err)) +
      (available.length > 0 ? '; 可用快照: ' + available.join(', ') : '; 该目录下还没有快照(先 create)'))
  }
  let manifest
  try {
    manifest = JSON.parse(text)
  } catch (err) {
    throw new Error('ecs_snapshot: 快照清单不是合法 JSON(' + path + '): ' + (err && err.message ? err.message : String(err)))
  }
  return { manifest, path, text }
}

export async function saveSnapshot(ctx, name, manifest, opts = {}) {
  // 目录创建: fs 服务没有 mkdir, 因此经 subprocess 调平台工具(与归档上传同源)
  let dirStatus = 'failed'
  try {
    dirStatus = await ensureLocalDir(ctx, snapshotDirOf(opts), opts.signal, { exec: opts.exec, cwd: opts.cwd })
  } catch (err) {
    dirStatus = 'failed'
  }
  const fs = await fsOf(ctx)
  const path = snapshotDirOf(opts) + '/' + name + '.json'
  const target = await fs.resolve(path, opts.signal !== undefined ? { signal: opts.signal } : undefined)
  const text = JSON.stringify(manifest, null, 2) + '\n'
  const outcome = await fs.writeText(target, text, undefined, opts.signal)
  return { path, dir_status: dirStatus, bytes: text.length, outcome }
}
