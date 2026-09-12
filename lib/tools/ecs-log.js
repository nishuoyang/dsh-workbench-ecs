// ============================================================================
// lib/tools/ecs-log.js —— ecs_log: 远端文件按字节游标续读(只读)
// 解决反馈 F2 的"长任务日志不可续读": tail/nohup 轮询时代只能反复整段拉取,
// 日志一大就丢头或重复。这里用 tail -c +N | head -c M 做**字节游标**读取,
// 返回 next_offset 供下一次续读;可选 exit_file 用于等待远端任务写完退出码。
// 全部命令只读(wc -c / tail / head / cat), 路径经 shell 引用, 无注入面。
// ============================================================================
import { runWorkbench, decodeCliOutput, commandLine, omitUndefined, withInstanceLock, buildLogReadCommand, parseLogRead, resolveTimeout, cleanOutput } from '../common.js'

const DEFAULT_MAX_BYTES = 262144
const DEFAULT_TIMEOUT = 60

export function ecsLogDefinition(ctx) {
  return {
    name: 'ecs_log',
    description: '按字节游标读取 ECS 实例上的文件(通常用于长任务日志): 传入 after=上一次返回的 next_offset 即可续读, ' +
      '不会重复也不会丢段; 可选 exit_file 用于等待远端任务写出退出码(存在即返回 exit_code)。' +
      '全程只读(仅 wc -c / tail / head / cat), 适合配合 detach 长任务与发布日志轮询。',
    parameters: {
      instance_id: { type: 'string', required: true, description: '目标 ECS 实例 ID(可由 ecs_list 取得)' },
      path: { type: 'string', required: true, description: '远端文件路径, 例如 /tmp/.dsh-ecs-xxx/out.log 或 /root/app/release-<sha>.log' },
      after: { type: 'integer', description: '起始字节偏移(上次返回的 next_offset; 首次为 0)' },
      max_bytes: { type: 'integer', description: '本次最多读取的字节数, 默认 ' + DEFAULT_MAX_BYTES + '; 返回 truncated=true 时应立刻续读' },
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
          path: { type: 'string' },
          text: { type: 'string' },
          after: { type: 'integer' },
          next_offset: { type: 'integer' },
          bytes: { type: 'integer' },
          total_bytes: { type: 'integer' },
          eof: { type: 'boolean' },
          truncated: { type: 'boolean' },
          exit_code: { type: 'integer' },
          command_line: { type: 'string' },
        },
        additionalProperties: false,
      },
      render: (args, value) => {
        const head = '日志读取 — 实例: ' + value.instance_id + ' ' + value.path +
          ' [bytes ' + value.after + '→' + value.next_offset +
          (value.total_bytes !== undefined ? ' / 共 ' + value.total_bytes : '') +
          (value.eof === true ? ', 已到末尾' : '') +
          (value.exit_code !== undefined ? ', exit code ' + value.exit_code : '') + ']'
        const parts = [head]
        if (value.text.length > 0) parts.push(value.text.replace(/\n$/, ''))
        else parts.push('(本次没有新增内容)')
        if (value.truncated === true) parts.push('[本次已达 max_bytes 上限, 请立即用 after=' + value.next_offset + ' 续读]')
        return [{ type: 'text', text: parts.join('\n') }]
      },
      presentationMeta: (args, value) => omitUndefined({
        instance_id: value.instance_id,
        path: value.path,
        next_offset: value.next_offset,
        exit_code: value.exit_code,
      }),
    },
    async execute(args, exec) {
      const after = Math.max(0, Number.isFinite(Number(args.after)) ? Math.floor(Number(args.after)) : 0)
      const maxBytes = Number.isFinite(Number(args.max_bytes)) && Number(args.max_bytes) > 0
        ? Math.min(Math.floor(Number(args.max_bytes)), 4 * 1024 * 1024)
        : DEFAULT_MAX_BYTES

      const remoteCommand = buildLogReadCommand({
        logPath: args.path,
        exitPath: args.exit_file,
        after,
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
      const parsed = parseLogRead(data.output !== undefined ? String(data.output) : '', after, maxBytes)
      const total = parsed.total_bytes
      return omitUndefined({
        instance_id: args.instance_id,
        path: args.path,
        text: cleanOutput(parsed.text, true),
        after,
        next_offset: parsed.next_offset,
        bytes: parsed.bytes,
        total_bytes: total,
        eof: total !== undefined ? parsed.next_offset >= total : undefined,
        truncated: parsed.truncated === true ? true : undefined,
        exit_code: parsed.exit_code,
        command_line: commandLine(argv),
      })
    },
    presentCall(args) {
      return {
        card: 'generic',
        title: '读取日志 ' + (String(args.path).length > 60 ? String(args.path).slice(0, 60) + '…' : String(args.path)),
        kind: 'read',
        rawInput: omitUndefined({ instance: args.instance_id, after: args.after, exit_file: args.exit_file }),
      }
    },
  }
}
