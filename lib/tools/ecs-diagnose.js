// ============================================================================
// lib/tools/ecs-diagnose.js —— ecs_diagnose: 一键体检(预置只读命令集)
// 通过单条远程 shell(分号串联, 保证各段都执行)一次采集:
//   主机信息 / 负载 / 内存 / 磁盘 / 运行服务与容器 / 内存 TOP 进程 / 监听端口
// v0.4.0: 默认开启只读护栏(read_only=true), 显式下发默认超时(120s), 清洗 ANSI。
// v0.7.0: sections 按需取段 + echo_command 默认不回显命令全文(反馈 §五.1:
//         "7 段命令全文回显占了输出的一大半"); 远端超时按 124 结算(D14)。
// ============================================================================
import {
  runWorkbench, decodeCliOutput, commandLine, guardDestructiveCommand, guardReadOnly,
  omitUndefined, withInstanceLock, cleanOutput, resolveTimeout, remoteResultOf, timeoutAdvice,
} from '../common.js'

// 默认超时(秒): 必须显式下发给 CLI(其 --timeout 默认为 30, 与工具说明不符)。
// 命名带模块前缀: to-body.mjs 会把各模块拼进同一作用域, 顶层 const 不能重名。
const DIAGNOSE_DEFAULT_TIMEOUT = 120

// 体检段落(v0.7.0: 可在 sections 里按名字点选)。
// 用 echo ==== 分隔; 以 ; 串联保证整体执行不会被单段失败中断。
export const DIAGNOSE_SECTIONS = [
  { id: 'host', title: '1/7 主机信息', command: 'hostname; uname -a; cat /etc/os-release 2>/dev/null | head -3' },
  { id: 'load', title: '2/7 负载与运行时长', command: 'uptime' },
  { id: 'mem', title: '3/7 内存', command: 'free -m' },
  { id: 'disk', title: '4/7 磁盘', command: 'df -h' },
  {
    id: 'services', title: '5/7 运行服务与容器',
    command: 'systemctl --no-pager list-units --type=service --state=running 2>/dev/null | head -25; ' +
      'docker ps --format "table {{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}" 2>/dev/null',
  },
  { id: 'processes', title: '6/7 内存 TOP 进程', command: 'ps aux --sort=-%mem 2>/dev/null | head -15' },
  { id: 'ports', title: '7/7 监听端口', command: 'ss -tlnp 2>/dev/null | head -30' },
]

// 合法的 sections 取值(含 extra: 只表示"要跑 extra_command")
export const DIAGNOSE_SECTION_IDS = DIAGNOSE_SECTIONS.map((s) => s.id).concat(['extra'])

// 把 sections 参数归一成段落 id 列表; 缺省/空 = 全部; 非法值抛错并列出合法值。
export function resolveDiagnoseSections(sections) {
  if (sections === undefined || sections === null) return { ids: DIAGNOSE_SECTIONS.map((s) => s.id), extra: true }
  if (!Array.isArray(sections)) {
    throw new Error('ecs_diagnose: sections 必须是数组, 可选值: ' + DIAGNOSE_SECTION_IDS.join(' / '))
  }
  const ids = []
  const unique = new Set()
  for (const raw of sections) {
    const id = String(raw != null ? raw : '').trim().toLowerCase()
    if (id.length === 0) continue
    if (!DIAGNOSE_SECTION_IDS.includes(id)) {
      throw new Error('ecs_diagnose: 未知段落 "' + id + '"; 可选值: ' + DIAGNOSE_SECTION_IDS.join(' / '))
    }
    if (unique.has(id)) continue
    unique.add(id)
    ids.push(id)
  }
  const extra = ids.includes('extra')
  const bodyIds = ids.filter((id) => id !== 'extra')
  if (bodyIds.length === 0 && !extra) {
    throw new Error('ecs_diagnose: sections 不能为空; 可选值: ' + DIAGNOSE_SECTION_IDS.join(' / '))
  }
  return { ids: bodyIds, extra }
}

// 预置只读体检脚本。opts.sections = 段落 id 数组(缺省=全部 7 段);
// opts.includeExtra = 是否附带 extra_command(缺省 true)。
export function buildDiagnoseScript(extra, opts = {}) {
  const selection = Array.isArray(opts.sections)
    ? { ids: opts.sections, extra: opts.includeExtra !== false }
    : resolveDiagnoseSections(opts.sections !== undefined ? opts.sections : undefined)
  const wanted = DIAGNOSE_SECTIONS.filter((s) => selection.ids.includes(s.id))
  const parts = []
  for (const section of wanted) {
    parts.push('echo "==== ' + section.title + ' ===="')
    parts.push('(' + section.command + ') 2>/dev/null')
  }
  if (extra !== undefined && String(extra).trim().length > 0 && selection.extra !== false) {
    parts.push('echo "==== 自定义 ===="')
    parts.push('(' + String(extra).trim() + ') 2>/dev/null')
  }
  return parts.join('; ')
}

export function ecsDiagnoseDefinition(ctx) {
  return {
    name: 'ecs_diagnose',
    description: '通过本机阿里云 Workbench CLI 对指定 ECS 实例执行一键只读体检, 一次采集: ' +
      '主机信息/负载/内存/磁盘/运行服务与容器/mem TOP 进程/监听端口, 并支持追加自定义命令。' +
      '默认采集全部 7 段; sections 可按需点选取子集(减少输出体积), echo_command=true 才回显完整命令。' +
      '默认开启 read_only 只读护栏(命中写操作模式即拒绝, 传 read_only=false 才放行)。' +
      '适合生产环境快速定位问题(检查 nginx/docker 等服务、日志目录、端口占用等)的起始动作。',
    parameters: {
      instance_id: { type: 'string', required: true, description: '目标 ECS 实例 ID(可由 ecs_list 取得), 也可写工作区实例锚点名(instances.json)' },
      region: { type: 'string', description: '地域, 可缺省: CLI 会从实例 ID 自动推断' },
      extra_command: { type: 'string', description: '追加的自定义只读命令(如 tail -n 50 /var/log/nginx/error.log)' },
      sections: {
        type: 'array', items: { type: 'string' },
        description: '按需取段(缺省=全部): ' + DIAGNOSE_SECTION_IDS.join(' / ') +
          '(extra 表示只跑 extra_command); 非法值会报错并列出合法值',
      },
      echo_command: { type: 'boolean', description: '是否回显完整的采集命令(默认 false; 输出里已含各段标题)' },
      read_only: { type: 'boolean', description: '只读护栏, 默认 true; 传 false 才允许 extra_command 中写入' },
      description: { type: 'string', description: '本次体检用途的简述(展示在卡片标题)' },
      strip_ansi: { type: 'boolean', description: '清洗 ANSI 转义与控制字符(默认 true)' },
      timeout: { type: 'integer', description: '命令超时时间(秒), 默认 ' + DIAGNOSE_DEFAULT_TIMEOUT },
    },
    timeoutMs: 300000,
    output: {
      schema: {
        type: 'object',
        properties: {
          kind: { type: 'string' },
          instance_id: { type: 'string' },
          command: { type: 'string' },
          command_line: { type: 'string' },
          description: { type: 'string' },
          read_only: { type: 'boolean' },
          sections: { type: 'array', items: { type: 'string' } },
          extra_command: { type: 'string' },
          echo_command: { type: 'boolean' },
          exit_code: { type: 'integer' },
          timed_out: { type: 'boolean' },
          duration: { type: 'string' },
          timeout_message: { type: 'string' },
          output: { type: 'string' },
          stderr: { type: 'string' },
          request_id: { type: 'string' },
          session_id: { type: 'string' },
          stdout_truncated: { type: 'boolean' },
          stdout_spill_path: { type: 'string' },
        },
        additionalProperties: false,
      },
      render: (args, value) => {
        const lines = []
        lines.push('一键体检完成 — 实例: ' + value.instance_id)
        if (value.description !== undefined) lines.push('用途: ' + value.description)
        if (value.sections !== undefined) lines.push('[采集段落: ' + value.sections.join(', ') + ']')
        if (value.extra_command !== undefined) lines.push('[自定义命令: ' + value.extra_command + ']')
        // echo_command 默认关闭(反馈 §五.1: 7 段命令全文占了输出的一大半)
        if (value.echo_command === true) lines.push('$ ' + value.command)
        if (value.output.length > 0) lines.push(value.output.replace(/\n$/, ''))
        else lines.push('(无输出)')
        if (value.stderr.length > 0) lines.push('[stderr]\n' + value.stderr.replace(/\n$/, ''))
        lines.push('[exit code: ' + value.exit_code + ']')
        if (value.read_only === true) lines.push('[read_only: 已启用只读护栏]')
        if (value.timed_out === true) {
          lines.push('[timeout: 体检命令被 CLI 掐断(exit 124)' +
            (value.duration !== undefined ? ', 实跑 ' + value.duration : '') +
            (value.timeout_message !== undefined ? ' — ' + value.timeout_message : '') + ']')
          lines.push(timeoutAdvice({ timeout: args.timeout !== undefined ? args.timeout : DIAGNOSE_DEFAULT_TIMEOUT, detachSupported: false }))
        }
        if (value.stdout_truncated === true) {
          lines.push('[输出过长, 已截断' + (value.stdout_spill_path !== undefined && value.stdout_spill_path !== null
            ? '; 完整输出: ' + value.stdout_spill_path : '') + ']')
        }
        return [{ type: 'text', text: lines.join('\n') }]
      },
      presentationMeta: (args, value) => omitUndefined({
        kind: value.kind, instance_id: value.instance_id, exit_code: value.exit_code, description: value.description,
        timed_out: value.timed_out,
      }),
    },
    async execute(args, exec) {
      const selection = resolveDiagnoseSections(args.sections)
      const extraCommand = args.extra_command !== undefined && String(args.extra_command).trim().length > 0
        ? String(args.extra_command).trim()
        : undefined
      const script = buildDiagnoseScript(extraCommand, { sections: selection.ids, includeExtra: selection.extra })
      const readOnly = args.read_only !== false // 默认开启
      const stripAnsi = args.strip_ansi !== false
      const echoCommand = args.echo_command === true
      const description = args.description !== undefined && String(args.description).length > 0 ? String(args.description) : undefined

      // 只读护栏(默认开启, 对**实际下发**的拼接脚本生效) + 破坏性命令守卫(审批)
      if (readOnly) guardReadOnly(script, 'ecs_diagnose')
      await guardDestructiveCommand(ctx, exec, script, 'ecs_diagnose')

      const argv = ['exec', '--instance-id', args.instance_id, '--command', script, '--output', 'json']
      argv.push('--timeout', String(resolveTimeout(args.timeout, DIAGNOSE_DEFAULT_TIMEOUT)))
      if (args.region !== undefined) argv.push('--region', args.region)

      const r = await withInstanceLock(args.instance_id, () => runWorkbench(ctx, argv, exec.signal, { stdoutSpillMaxBytes: 64 * 1024 * 1024, exec }))
      if (exec.signal.aborted) throw new Error('工具调用已被取消')

      const data = decodeCliOutput(r, 'ecs_diagnose')
      if (data === null || typeof data !== 'object' || Array.isArray(data)) {
        throw new Error('ecs_diagnose: 意外的输出结构: ' + r.stdout.slice(0, 300))
      }
      const remote = remoteResultOf(data, r)
      return omitUndefined({
        kind: 'diagnose',
        instance_id: args.instance_id,
        command: script,
        command_line: commandLine(argv),
        description,
        read_only: readOnly === true ? true : undefined,
        sections: selection.ids.concat(selection.extra && extraCommand !== undefined ? ['extra'] : []),
        extra_command: extraCommand,
        echo_command: echoCommand === true ? true : undefined,
        exit_code: remote.exit_code,
        timed_out: remote.timed_out === true ? true : undefined,
        duration: remote.duration,
        timeout_message: remote.timeout_message,
        output: cleanOutput(remote.output, stripAnsi),
        stderr: cleanOutput(remote.stderr, stripAnsi),
        request_id: remote.request_id,
        session_id: remote.cli_session_id,
        stdout_truncated: r.stdoutTruncated === true,
        stdout_spill_path: r.stdoutSpillPath,
      })
    },
    presentCall(args) {
      const sectionCount = Array.isArray(args.sections) && args.sections.length > 0 ? args.sections.length : DIAGNOSE_SECTIONS.length
      return {
        card: 'terminal',
        title: args.description !== undefined && String(args.description).length > 0
          ? String(args.description)
          : '一键体检 ' + args.instance_id,
        description: '只读诊断: ' + sectionCount + ' 段' + (args.read_only === false ? ' · read_only=false' : ' · read_only'),
      }
    },
    presentResult(args, result) {
      const meta = result.meta
      if (meta === undefined || typeof meta !== 'object') return undefined
      const block = result.content.length === 1 ? result.content[0] : undefined
      if (block === undefined || block.type !== 'text') return undefined
      return {
        card: 'terminal',
        title: meta.description !== undefined ? meta.description : '一键体检 ' + meta.instance_id,
        output: block.text,
        ...(typeof meta.exit_code === 'number' ? { exitCode: meta.exit_code } : {}),
      }
    },
  }
}
