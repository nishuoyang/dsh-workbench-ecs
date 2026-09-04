// ============================================================================
// lib/tools/ecs-deploy.js —— ecs_deploy: 受控发布(上传 + 重启 + 健康检查)
// 流程: (可选)上传文件 -> 执行重启/生效命令 -> (可选)健康检查;
// 三个阶段结果全部返回, 任一失败不中断后续阶段, 由模型与用户判断处理。
// ============================================================================
import { runWorkbench, decodeLoose, decodeCliOutput, commandLine, guardDestructiveCommand } from '../common.js'

export function ecsDeployDefinition(ctx) {
  // 单阶段执行: 返回 { ok, exit_code, output, error }
  async function runStage(argv, signal, timeoutSec) {
    try {
      const r = await runWorkbench(ctx, argv, signal, { stdoutSpillMaxBytes: 64 * 1024 * 1024 })
      if (signal.aborted) throw new Error('工具调用已被取消')
      const data = decodeCliOutput(r, 'ecs_deploy')
      if (data === null || typeof data !== 'object' || Array.isArray(data)) {
        throw new Error('意外的输出结构: ' + r.stdout.slice(0, 300))
      }
      return {
        ok: (r.exitCode !== null ? r.exitCode : 0) === 0,
        exit_code: r.exitCode !== null ? r.exitCode : 0,
        output: data.output !== undefined ? String(data.output) : '',
        stdout_truncated: r.stdoutTruncated,
        stdout_spill_path: r.stdoutSpillPath,
        error: undefined,
      }
    } catch (err) {
      return {
        ok: false,
        exit_code: 0,
        output: '',
        stdout_truncated: false,
        error: err && err.message !== undefined ? String(err.message) : String(err),
      }
    }
  }

  function renderStages(value) {
    const lines = []
    lines.push('受控发布 — 实例: ' + value.instance_id + ', 阶段 ' + value.done_stage + '/' + value.total_stage + ', 结果: ' + (value.ok === true ? '成功' : '失败'))
    for (const s of value.stages) {
      lines.push('')
      lines.push('[' + s.name + '] ' + (s.ok === true ? 'OK' : 'FAIL'))
      if (s.ok !== true) {
        if (s.error !== undefined && s.error.length > 0) lines.push('  错误: ' + s.error)
      }
      if (s.output !== undefined && s.output.length > 0) {
        for (const line of String(s.output).split('\n')) lines.push('  ' + line)
      }
      if (s.exit_code !== undefined && s.exit_code !== null && s.ok !== true) {
        lines.push('  [exit code: ' + s.exit_code + ']')
      }
    }
    return lines.join('\n')
  }

  return {
    name: 'ecs_deploy',
    description: '受控发布组合工具: (1) 可选上传本地文件; (2) 执行重启/生效命令; (3) 可选健康检查命令。' +
      '三个阶段结果全部返回; 破坏性命令同样需要用户确认。' +
      '适用于"改代码 -> 上传 -> 重启 -> 验证"的完整修复闭环。',
    parameters: {
      instance_id: { type: 'string', required: true, description: '目标 ECS 实例 ID(可由 ecs_list 取得)' },
      command: { type: 'string', required: true, description: '重启/生效命令, 例如 docker compose restart 或 systemctl restart nginx' },
      local_file: { type: 'string', description: '可选: 要上传的本地文件(相对路径基于会话工作区)' },
      remote_path: { type: 'string', description: '可选: 上传目标远端路径(local_file 提供时必填)' },
      health_check: { type: 'string', description: '可选: 健康检查命令, 例如 curl -fsS http://127.0.0.1/health || true' },
      region: { type: 'string', description: '地域, 可缺省: CLI 会从实例 ID 自动推断' },
      force: { type: 'boolean', description: '上传时覆盖远端已存在文件而不需确认(默认 false)' },
      timeout: { type: 'integer', description: '每个阶段命令超时时间(秒), 默认 120' },
    },
    timeoutMs: 600000,
    output: {
      schema: {
        type: 'object',
        properties: {
          instance_id: { type: 'string' },
          ok: { type: 'boolean' },
          done_stage: { type: 'integer' },
          total_stage: { type: 'integer' },
          stages: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                ok: { type: 'boolean' },
                exit_code: { type: 'integer' },
                output: { type: 'string' },
                stdout_truncated: { type: 'boolean' },
                stdout_spill_path: { type: 'string' },
                error: { type: 'string' },
              },
              additionalProperties: false,
            },
          },
          command_line: { type: 'string' },
        },
        additionalProperties: false,
      },
      render: (args, value) => [{ type: 'text', text: renderStages(value) }],
      presentationMeta: (args, value) => ({ ok: value.ok, done_stage: value.done_stage, total_stage: value.total_stage }),
    },
    async execute(args, exec) {
      const uploadNeeded = args.local_file !== undefined && args.local_file.length > 0
      if (uploadNeeded && (args.remote_path === undefined || args.remote_path.length === 0)) {
        throw new Error('ecs_deploy: 提供 local_file 时必须同时提供 remote_path')
      }
      // 破坏性命令守卫: 重启/健康检查命令都可能包含危险模式
      await guardDestructiveCommand(ctx, exec, args.command)
      if (args.health_check !== undefined) {
        await guardDestructiveCommand(ctx, exec, args.health_check)
      }

      const stages = []
      const total = (uploadNeeded ? 1 : 0) + 1 + (args.health_check !== undefined ? 1 : 0)
      let doneStage = 0

      // 阶段 1: 上传(可选)
      if (uploadNeeded) {
        const argv = ['upload', args.local_file, args.remote_path, '--instance-id', args.instance_id, '--output', 'json']
        if (args.region !== undefined) argv.push('--region', args.region)
        if (args.force === true) argv.push('--force')
        if (exec.signal.aborted) throw new Error('工具调用已被取消')
        const stage = await runStage(argv, exec.signal, args.timeout)
        stages.push({ name: '上传 ' + args.local_file, ...stage })
        doneStage += 1
      }

      // 阶段 2: 重启/生效
      {
        const argv = ['exec', '--instance-id', args.instance_id, '--command', args.command, '--output', 'json']
        if (args.timeout !== undefined) argv.push('--timeout', String(args.timeout))
        if (args.region !== undefined) argv.push('--region', args.region)
        if (exec.signal.aborted) throw new Error('工具调用已被取消')
        const stage = await runStage(argv, exec.signal, args.timeout)
        stages.push({ name: '重启/生效', ...stage })
        doneStage += 1
      }

      // 阶段 3: 健康检查(可选)
      if (args.health_check !== undefined) {
        const argv = ['exec', '--instance-id', args.instance_id, '--command', args.health_check, '--output', 'json']
        if (args.region !== undefined) argv.push('--region', args.region)
        if (exec.signal.aborted) throw new Error('工具调用已被取消')
        const stage = await runStage(argv, exec.signal, args.timeout)
        stages.push({ name: '健康检查', ...stage })
        doneStage += 1
      }

      return {
        instance_id: args.instance_id,
        ok: stages.every((s) => s.ok === true),
        done_stage: doneStage,
        total_stage: total,
        stages,
        command_line: commandLine(['deploy', args.instance_id, args.command]),
      }
    },
    presentCall(args) {
      return {
        card: 'generic',
        title: '受控发布 ' + args.instance_id,
        kind: 'execute',
        rawInput: { command: args.command, upload: args.local_file ?? undefined, health_check: args.health_check ?? undefined },
      }
    },
  }
}
