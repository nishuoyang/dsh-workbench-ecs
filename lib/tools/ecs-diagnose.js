// ============================================================================
// lib/tools/ecs-diagnose.js —— ecs_diagnose: 一键体检(预置只读命令集)
// 通过单条远程 shell(分号串联, 保证各段都执行)一次采集:
//   主机信息 / 负载 / 内存 / 磁盘 / 运行服务与容器 / 内存 TOP 进程 / 监听端口
// ============================================================================
import { runWorkbench, decodeCliOutput, commandLine, guardDestructiveCommand } from '../common.js'

// 预置只读体检段落(用 echo ==== 分隔; 以 ; 串联保证整体执行不会被单段失败中断)
export function buildDiagnoseScript(extra) {
  const sections = [
    ['1/7 主机信息', 'hostname; uname -a; cat /etc/os-release 2>/dev/null | head -3'],
    ['2/7 负载与运行时长', 'uptime'],
    ['3/7 内存', 'free -m'],
    ['4/7 磁盘', 'df -h'],
    ['5/7 运行服务与容器', 'systemctl --no-pager list-units --type=service --state=running 2>/dev/null | head -25; docker ps --format "table {{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}" 2>/dev/null'],
    ['6/7 内存 TOP 进程', 'ps aux --sort=-%mem 2>/dev/null | head -15'],
    ['7/7 监听端口', 'ss -tlnp 2>/dev/null | head -30'],
  ]
  const parts = []
  for (const [title, cmd] of sections) {
    parts.push('echo "==== ' + title + ' ===="')
    parts.push('(' + cmd + ') 2>/dev/null')
  }
  if (extra !== undefined && extra.trim().length > 0) {
    parts.push('echo "==== 自定义 ===="')
    parts.push('(' + extra.trim() + ') 2>/dev/null')
  }
  return parts.join('; ')
}

export function ecsDiagnoseDefinition(ctx) {
  return {
    name: 'ecs_diagnose',
    description: '通过本机阿里云 Workbench CLI 对指定 ECS 实例执行一键只读体检, 一次采集: ' +
      '主机信息/负载/内存/磁盘/运行服务与容器/mem TOP 进程/监听端口, 并支持追加自定义命令。' +
      '适合生产环境快速定位问题(检查 nginx/docker 等服务、日志目录、端口占用等)的起始动作。',
    parameters: {
      instance_id: { type: 'string', required: true, description: '目标 ECS 实例 ID(可由 ecs_list 取得)' },
      region: { type: 'string', description: '地域, 可缺省: CLI 会从实例 ID 自动推断' },
      extra_command: { type: 'string', description: '追加的自定义只读命令(如 tail -n 50 /var/log/nginx/error.log)' },
      timeout: { type: 'integer', description: '命令超时时间(秒), 默认 120' },
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
          exit_code: { type: 'integer' },
          output: { type: 'string' },
          stderr: { type: 'string' },
          stdout_truncated: { type: 'boolean' },
          stdout_spill_path: { type: 'string' },
        },
        additionalProperties: false,
      },
      render: (args, value) => [{
        type: 'text',
        text: '一键体检完成 — 实例: ' + value.instance_id + '\n' +
          '$ ' + value.command + '\n' +
          (value.output.length > 0 ? value.output.replace(/\n$/, '') + '\n' : '(无输出)\n') +
          (value.stderr.length > 0 ? '[stderr]\n' + value.stderr.replace(/\n$/, '') + '\n' : '') +
          '[exit code: ' + value.exit_code + ']' +
          (value.stdout_truncated === true
            ? '\n[输出过长, 已截断' + (value.stdout_spill_path !== undefined && value.stdout_spill_path !== null
                ? '; 完整输出: ' + value.stdout_spill_path : '') + ']'
            : ''),
      }],
      presentationMeta: (args, value) => ({ kind: value.kind, instance_id: value.instance_id, exit_code: value.exit_code }),
    },
    async execute(args, exec) {
      const script = buildDiagnoseScript(args.extra_command)
      // 自定义段可能含危险命令, 同样做守卫
      await guardDestructiveCommand(ctx, exec, script)

      const argv = ['exec', '--instance-id', args.instance_id, '--command', script, '--output', 'json']
      if (args.timeout !== undefined) argv.push('--timeout', String(args.timeout))
      if (args.region !== undefined) argv.push('--region', args.region)

      const r = await runWorkbench(ctx, argv, exec.signal, { stdoutSpillMaxBytes: 64 * 1024 * 1024 })
      if (exec.signal.aborted) throw new Error('工具调用已被取消')

      const data = decodeCliOutput(r, 'ecs_diagnose')
      if (data === null || typeof data !== 'object' || Array.isArray(data)) {
        throw new Error('ecs_diagnose: 意外的输出结构: ' + r.stdout.slice(0, 300))
      }
      return {
        kind: 'diagnose',
        instance_id: args.instance_id,
        command: script,
        command_line: commandLine(argv),
        exit_code: r.exitCode !== null ? r.exitCode : 0,
        output: data.output !== undefined ? String(data.output) : '',
        stderr: data.stderr !== undefined ? String(data.stderr) : '',
        stdout_truncated: r.stdoutTruncated,
        stdout_spill_path: r.stdoutSpillPath,
      }
    },
    presentCall(args) {
      return {
        card: 'terminal',
        title: '一键体检 ' + args.instance_id,
        description: '只读诊断: 主机/负载/内存/磁盘/服务/进程/端口',
      }
    },
    presentResult(args, result) {
      const meta = result.meta
      if (meta === undefined || typeof meta !== 'object') return undefined
      const block = result.content.length === 1 ? result.content[0] : undefined
      if (block === undefined || block.type !== 'text') return undefined
      return { card: 'terminal', title: '一键体检 ' + meta.instance_id, output: block.text, ...(typeof meta.exit_code === 'number' ? { exitCode: meta.exit_code } : {}) }
    },
  }
}
