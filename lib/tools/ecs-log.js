// ============================================================================
// lib/tools/ecs-log.js —— ecs_log: 远端文件按字节游标续读(只读)
// 解决反馈 F2 的"长任务日志不可续读": tail/nohup 轮询时代只能反复整段拉取,
// 日志一大就丢头或重复。这里用 tail -c +N | head -c M 做**字节游标**读取,
// 返回 next_offset 供下一次续读;可选 exit_file 用于等待远端任务写完退出码。
// 全部命令只读(wc -c / tail / head / cat), 路径经 shell 引用, 无注入面。
// v0.7.0(L1, 反馈 §六.10): 支持 paths 一次读多个文件(app.log + access.log)——
//   单次远程调用内按文件分段, 每段复用同一套 buildLogReadCommand/parseLogRead,
//   字节游标语义逐字不变; 每个文件各自维护 after/next_offset。
// ============================================================================
import {
  runWorkbench, decodeCliOutput, commandLine, omitUndefined, withInstanceLock,
  buildLogReadCommand, parseLogRead, resolveTimeout, cleanOutput, remoteResultOf, timeoutAdvice,
} from '../common.js'

const DEFAULT_MAX_BYTES = 262144
const DEFAULT_TIMEOUT = 60
// 一次最多读几个文件: 再多就不如分几次调用(单次输出体积与超时都要可控)
const MULTI_PATH_LIMIT = 8
// 分段标记(与 buildLogReadCommand 的 __DSH_ECS_META__/__DSH_ECS_EXIT__ 不冲突)
const LOG_FILE_MARKER = '__DSH_ECS_FILE__'

// 多文件读取命令: 每个文件前打一条"文件开始"标记, 后续复用单文件读命令
export function buildMultiLogReadCommand(entries, opts = {}) {
  const parts = []
  for (const entry of entries) {
    parts.push('printf "' + LOG_FILE_MARKER + '%s\\n" ' + quoteForPrintf(entry.path))
    parts.push(buildLogReadCommand({
      logPath: entry.path,
      exitPath: opts.exitPath,
      after: entry.after,
      maxBytes: entry.maxBytes,
      sleep: opts.sleep,
    }))
  }
  return parts.join('; ')
}

// printf 的 %s 参数需要用 shell 引用(路径可能含空格/特殊字符)
function quoteForPrintf(path) {
  return "'" + String(path != null ? path : '').replace(/'/g, "'\\''") + "'"
}

// 把多文件输出切成"每文件一段": 段内文本仍交给 parseLogRead 解析(标记语义完全复用)
export function splitLogSegments(output, paths) {
  const text = String(output != null ? output : '')
  const segments = []
  const re = new RegExp(LOG_FILE_MARKER + '([^\\n]*)\\n?', 'g')
  let match = re.exec(text)
  let current = null
  while (match !== null) {
    if (current !== null) {
      current.raw = text.slice(current.start, match.index)
      segments.push(current)
    }
    current = { path: match[1].trim(), start: re.lastIndex }
    match = re.exec(text)
  }
  if (current !== null) {
    current.raw = text.slice(current.start)
    segments.push(current)
  }
  // 标记丢失(远端意外输出)时按输入顺序兜底, 保证每个请求的文件都有结果
  if (segments.length === 0) {
    return paths.map((path, index) => ({ path, raw: index === 0 && paths.length === 1 ? text : '' }))
  }
  const byPath = new Map(segments.map((seg) => [seg.path, seg]))
  return paths.map((path) => {
    const found = byPath.get(path)
    return { path, raw: found !== undefined ? found.raw : '' }
  })
}

// 归一 after 参数: 数字(所有文件同一游标)或对象({ "<path>": offset })
export function resolveAfter(args, path) {
  const raw = args !== undefined && args !== null ? args.after : undefined
  if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
    const value = raw[path]
    const n = Number(value)
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0
  }
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0
}

// 归一目标文件列表: path 与 paths 二选一
export function resolveLogPaths(args) {
  const single = args !== undefined && args !== null && args.path !== undefined && args.path !== null
    ? String(args.path).trim() : ''
  const many = args !== undefined && args !== null && Array.isArray(args.paths)
    ? args.paths.map((p) => String(p != null ? p : '').trim()).filter((p) => p.length > 0)
    : []
  if (single.length > 0 && many.length > 0) {
    throw new Error('ecs_log: path 与 paths 只能二选一(读多个文件用 paths)')
  }
  if (single.length > 0) return { mode: 'single', paths: [single] }
  if (many.length > 0) {
    const unique = Array.from(new Set(many))
    if (unique.length > MULTI_PATH_LIMIT) {
      throw new Error('ecs_log: paths 一次最多 ' + MULTI_PATH_LIMIT + ' 个文件(收到 ' + unique.length + '); 更多请分次调用')
    }
    return { mode: 'multi', paths: unique }
  }
  throw new Error('ecs_log: 必须提供 path(单个文件)或 paths(多个文件)')
}

export function ecsLogDefinition(ctx) {
  function normalizeMaxBytes(value) {
    return Number.isFinite(Number(value)) && Number(value) > 0
      ? Math.min(Math.floor(Number(value)), 4 * 1024 * 1024)
      : DEFAULT_MAX_BYTES
  }

  return {
    name: 'ecs_log',
    description: '按字节游标读取 ECS 实例上的文件(通常用于长任务日志): 传入 after=上一次返回的 next_offset 即可续读, ' +
      '不会重复也不会丢段; 可选 exit_file 用于等待远端任务写出退出码(存在即返回 exit_code)。' +
      'paths 可一次读多个文件(app.log + access.log 等): 单次远程调用内按文件分段, 每个文件各自维护 after/next_offset' +
      '(after 传对象即可逐文件指定起点)。全程只读(仅 wc -c / tail / head / cat), 适合配合 detach 长任务与发布日志轮询。',
    parameters: {
      instance_id: { type: 'string', required: true, description: '目标 ECS 实例 ID(可由 ecs_list 取得), 也可写工作区实例锚点名(instances.json)' },
      path: { type: 'string', description: '单个远端文件路径, 例如 /tmp/.dsh-ecs-xxx/out.log 或 /root/app/release-<sha>.log; 与 paths 二选一' },
      paths: {
        type: 'array', items: { type: 'string' },
        description: '多个远端文件路径(最多 ' + MULTI_PATH_LIMIT + ' 个), 一次调用读完; 与 path 二选一',
      },
      after: {
        type: 'json',
        description: '起始字节偏移: 数字(所有文件同一游标)或对象 { "<path>": offset }(逐文件); 首次为 0',
      },
      max_bytes: { type: 'integer', description: '每个文件本次最多读取的字节数, 默认 ' + DEFAULT_MAX_BYTES + '; 返回 truncated=true 时应立刻续读' },
      exit_file: { type: 'string', description: '可选: 远端退出码文件路径, 存在时在返回值中给出 exit_code' },
      region: { type: 'string', description: '地域, 可缺省: CLI 会从实例 ID 自动推断' },
      timeout: { type: 'integer', description: '命令超时时间(秒), 默认 ' + DEFAULT_TIMEOUT },
    },
    timeoutMs: 120000,
    output: {
      schema: {
        type: 'object',
        properties: {
          instance_id: { type: 'string' },
          mode: { type: 'string' },
          path: { type: 'string' },
          text: { type: 'string' },
          after: { type: 'integer' },
          next_offset: { type: 'integer' },
          bytes: { type: 'integer' },
          total_bytes: { type: 'integer' },
          eof: { type: 'boolean' },
          truncated: { type: 'boolean' },
          exit_code: { type: 'integer' },
          timed_out: { type: 'boolean' },
          duration: { type: 'string' },
          files: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                path: { type: 'string' },
                text: { type: 'string' },
                after: { type: 'integer' },
                next_offset: { type: 'integer' },
                bytes: { type: 'integer' },
                total_bytes: { type: 'integer' },
                eof: { type: 'boolean' },
                truncated: { type: 'boolean' },
                exit_code: { type: 'integer' },
              },
              additionalProperties: false,
            },
          },
          command_line: { type: 'string' },
        },
        additionalProperties: false,
      },
      render: (args, value) => {
        const parts = []
        if (value.mode === 'multi') {
          parts.push('多文件日志读取 — 实例: ' + value.instance_id + ' (共 ' + value.files.length + ' 个文件)')
          for (const file of value.files) {
            parts.push('')
            parts.push('── ' + file.path + ' [bytes ' + file.after + '→' + file.next_offset +
              (file.total_bytes !== undefined ? ' / 共 ' + file.total_bytes : '') +
              (file.eof === true ? ', 已到末尾' : '') +
              (file.exit_code !== undefined ? ', exit code ' + file.exit_code : '') + ']')
            parts.push(file.text.length > 0 ? file.text.replace(/\n$/, '') : '(本次没有新增内容)')
            if (file.truncated === true) parts.push('[本次已达 max_bytes 上限, 请立即用 after=' + file.next_offset + ' 续读]')
          }
          if (value.timed_out === true) {
            parts.push('')
            parts.push('[timeout: 读取命令被 CLI 掐断' + (value.duration !== undefined ? ', 实跑 ' + value.duration : '') +
              ' —— 游标未推进, 直接用相同 after 重试即可]')
          }
          return [{ type: 'text', text: parts.join('\n') }]
        }
        parts.push('日志读取 — 实例: ' + value.instance_id + ' ' + value.path +
          ' [bytes ' + value.after + '→' + value.next_offset +
          (value.total_bytes !== undefined ? ' / 共 ' + value.total_bytes : '') +
          (value.eof === true ? ', 已到末尾' : '') +
          (value.exit_code !== undefined ? ', exit code ' + value.exit_code : '') + ']')
        parts.push(value.text.length > 0 ? value.text.replace(/\n$/, '') : '(本次没有新增内容)')
        if (value.truncated === true) parts.push('[本次已达 max_bytes 上限, 请立即用 after=' + value.next_offset + ' 续读]')
        if (value.timed_out === true) {
          parts.push('[timeout: 读取命令被 CLI 掐断' + (value.duration !== undefined ? ', 实跑 ' + value.duration : '') +
            ' —— 游标未推进, 直接用相同 after 重试即可]')
          parts.push(timeoutAdvice({ timeout: args.timeout !== undefined ? args.timeout : DEFAULT_TIMEOUT, detachSupported: false }))
        }
        return [{ type: 'text', text: parts.join('\n') }]
      },
      presentationMeta: (args, value) => omitUndefined({
        instance_id: value.instance_id,
        path: value.path,
        mode: value.mode,
        files: value.files !== undefined ? value.files.length : undefined,
        next_offset: value.next_offset,
        exit_code: value.exit_code,
      }),
    },
    async execute(args, exec) {
      const target = resolveLogPaths(args)
      const maxBytes = normalizeMaxBytes(args.max_bytes)
      const entries = target.paths.map((path) => ({ path, after: resolveAfter(args, path), maxBytes }))

      const remoteCommand = target.mode === 'multi'
        ? buildMultiLogReadCommand(entries, { exitPath: args.exit_file })
        : buildLogReadCommand({
          logPath: entries[0].path,
          exitPath: args.exit_file,
          after: entries[0].after,
          maxBytes,
        })
      const argv = ['exec', '--instance-id', args.instance_id, '--command', remoteCommand,
        '--timeout', String(resolveTimeout(args.timeout, DEFAULT_TIMEOUT)), '--output', 'json']
      if (args.region !== undefined) argv.push('--region', args.region)

      const r = await withInstanceLock(args.instance_id, () => runWorkbench(ctx, argv, exec.signal, { stdoutSpillMaxBytes: 64 * 1024 * 1024, exec }))
      if (exec.signal.aborted) throw new Error('工具调用已被取消')

      const data = decodeCliOutput(r, 'ecs_log')
      if (data === null || typeof data !== 'object' || Array.isArray(data)) {
        throw new Error('ecs_log: 意外的输出结构: ' + r.stdout.slice(0, 300))
      }
      const remote = remoteResultOf(data, r)
      // 超时: 游标不推进, 原样回报(重试同一 after 即可), 不能假装读到了内容
      const timedOut = remote.timed_out === true
      const raw = timedOut ? '' : remote.output
      const segments = target.mode === 'multi' ? splitLogSegments(raw, target.paths) : [{ path: target.paths[0], raw }]

      const files = segments.map((segment, index) => {
        const entry = entries[index]
        const parsed = parseLogRead(segment.raw, entry.after, maxBytes)
        const total = parsed.total_bytes
        return omitUndefined({
          path: segment.path,
          text: cleanOutput(parsed.text, true),
          after: entry.after,
          next_offset: parsed.next_offset,
          bytes: parsed.bytes,
          total_bytes: total,
          eof: total !== undefined ? parsed.next_offset >= total : undefined,
          truncated: parsed.truncated === true ? true : undefined,
          exit_code: parsed.exit_code,
        })
      })

      const base = omitUndefined({
        instance_id: args.instance_id,
        mode: target.mode,
        timed_out: timedOut === true ? true : undefined,
        duration: remote.duration,
        command_line: commandLine(argv),
      })
      if (target.mode === 'multi') {
        return Object.assign(base, { files })
      }
      const one = files[0]
      // 显式列出字段会带上 undefined 值属性(DSH 管线会报 "not lossless JSON"),
      // 因此这里同样过一遍 omitUndefined —— 与注册边界的口径一致。
      return omitUndefined(Object.assign(base, {
        path: one.path,
        text: one.text,
        after: one.after,
        next_offset: one.next_offset,
        bytes: one.bytes,
        total_bytes: one.total_bytes,
        eof: one.eof,
        truncated: one.truncated,
        exit_code: one.exit_code,
      }))
    },
    presentCall(args) {
      const many = Array.isArray(args.paths) ? args.paths : undefined
      const label = many !== undefined && many.length > 0
        ? many.map((p) => String(p)).join(', ')
        : String(args.path)
      return {
        card: 'generic',
        title: '读取日志 ' + (label.length > 60 ? label.slice(0, 60) + '…' : label),
        kind: 'read',
        rawInput: omitUndefined({ instance: args.instance_id, after: args.after, exit_file: args.exit_file }),
      }
    },
  }
}
