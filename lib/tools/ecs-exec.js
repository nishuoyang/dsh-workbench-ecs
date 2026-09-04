// ============================================================================
// lib/tools/ecs-exec.js —— ecs_exec: 在指定实例上执行远程命令
// 对应 CLI: workbench exec --instance-id <id> --command <cmd> [--timeout <s>] --output json
// 增强: 破坏性命令守卫(approval) / 后台任务(jobs) / 批量实例 / 大输出 spill
// ============================================================================
import {
  runWorkbench, spawnWorkbench, decodeCliOutput, commandLine,
  guardDestructiveCommand,
} from '../common.js'

const BATCH_LIMIT = 20

// 单实例前台执行并解析 CLI 的 { output, stderr, exit_code } 成功结构
function execOne(r, instanceId) {
  const data = decodeCliOutput(r, 'ecs_exec')
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('ecs_exec: 意外的输出结构: ' + r.stdout.slice(0, 300))
  }
  return {
    instance_id: instanceId,
    exit_code: r.exitCode !== null ? r.exitCode : 0,
    output: data.output !== undefined ? String(data.output) : '',
    stderr: data.stderr !== undefined ? String(data.stderr) : '',
    stdout_truncated: r.stdoutTruncated,
    stdout_spill_path: r.stdoutSpillPath,
  }
}

export function ecsExecDefinition(ctx) {
  // 前台单实例 / 后台 / 批量 三种结果的渲染
  function renderExecValue(value) {
    const lines = []
    if (value.kind === 'background') {
      lines.push('后台任务已启动 — 实例: ' + value.instance_id)
      lines.push('$ ' + value.command)
      lines.push('[job_id: ' + value.job_id + ']')
      lines.push('用 job_output 读取增量输出, job_kill 终止任务')
      return lines.join('\n')
    }
    if (value.kind === 'batch') {
      lines.push('批量执行完成 — ' + value.count + ' 台实例, 失败 ' + value.failed_count + ' 台')
      lines.push('$ ' + value.command)
      for (const item of value.batch) {
        lines.push('')
        if (item.is_error === true) {
          lines.push('[' + item.instance_id + '] 失败: ' + (item.error !== undefined ? item.error : '未知错误'))
        } else {
          lines.push('[' + item.instance_id + ']')
          if (item.output.length > 0) lines.push(item.output.replace(/\n$/, ''))
          if (item.stderr !== undefined && item.stderr.length > 0) {
            lines.push('[stderr] ' + String(item.stderr).replace(/\n$/, ''))
          }
          lines.push('[exit code: ' + item.exit_code + ']')
        }
      }
      if (value.failed_count > 0) {
        lines.push('')
        lines.push('提示: 部分实例执行失败, 可逐个用 ecs_exec 重试排查')
      }
      return lines.join('\n')
    }
    // kind === 'single'
    lines.push('远程命令执行结果 — 实例: ' + value.instance_id)
    lines.push('$ ' + value.command)
    if (value.output.length > 0) lines.push(value.output.replace(/\n$/, ''))
    if (value.stderr.length > 0) {
      if (value.output.length > 0) lines.push('')
      lines.push('[stderr]')
      lines.push(value.stderr.replace(/\n$/, ''))
    }
    if (value.output.length === 0 && value.stderr.length === 0) lines.push('(无输出)')
    lines.push('[exit code: ' + value.exit_code + ']')
    if (value.stdout_truncated === true) {
      lines.push('[输出过长, 已截断' +
        (value.stdout_spill_path !== undefined && value.stdout_spill_path !== null
          ? '; 完整输出: ' + value.stdout_spill_path : '') + ']')
    }
    return lines.join('\n')
  }

  return {
    name: 'ecs_exec',
    description: '通过本机阿里云 Workbench CLI 在指定 ECS 实例上执行一条远程命令(非交互), ' +
      '返回标准输出/错误输出与退出码; 每次调用是独立 shell 上下文, 状态不跨调用保留。' +
      '支持 instance_ids 批量执行(串行, 上限 ' + BATCH_LIMIT + ' 台)与 run_in_background 后台任务。' +
      '破坏性命令(rm -rf、shutdown、reboot、mkfs、dd 等)会自动请求用户确认, 未批准即拒绝执行。',
    parameters: {
      instance_id: { type: 'string', description: '目标 ECS 实例 ID, 例如 i-bp1xxxxx(可由 ecs_list 取得); 与 instance_ids 二选一' },
      instance_ids: {
        type: 'array', items: { type: 'string' },
        description: '批量目标实例 ID 数组(串行执行, 最多 ' + BATCH_LIMIT + ' 台); 与 instance_id 二选一',
      },
      command: { type: 'string', required: true, description: '要执行的远程命令; 需要共享上下文时用 && 或 ; 串联, 例如 "cd /var/log && tail -n 50 app.log"' },
      timeout: { type: 'integer', description: '命令超时时间(秒), 默认 30' },
      region: { type: 'string', description: '地域, 可缺省: CLI 会从实例 ID 自动推断' },
      run_in_background: {
        type: 'boolean',
        description: '后台执行长命令: 立即返回 job_id, 用 job_output 读取增量输出(不适用于批量)',
      },
    },
    timeoutMs: 180000,
    output: {
      schema: {
        type: 'object',
        properties: {
          kind: { type: 'string' },
          instance_id: { type: 'string' },
          job_id: { type: 'string' },
          command: { type: 'string' },
          command_line: { type: 'string' },
          exit_code: { type: 'integer' },
          output: { type: 'string' },
          stderr: { type: 'string' },
          stdout_truncated: { type: 'boolean' },
          stdout_spill_path: { type: 'string' },
          count: { type: 'integer' },
          failed_count: { type: 'integer' },
          batch: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                instance_id: { type: 'string' },
                is_error: { type: 'boolean' },
                error: { type: 'string' },
                exit_code: { type: 'integer' },
                output: { type: 'string' },
                stderr: { type: 'string' },
                stdout_truncated: { type: 'boolean' },
                stdout_spill_path: { type: 'string' },
              },
              additionalProperties: false,
            },
          },
        },
        additionalProperties: false,
      },
      render: (args, value) => [{ type: 'text', text: renderExecValue(value) }],
      presentationMeta: (args, value) => ({
        kind: value.kind,
        instance_id: value.instance_id,
        job_id: value.job_id,
        exit_code: value.exit_code,
        command: value.command,
        count: value.count,
      }),
    },
    async execute(args, exec) {
      // 归一化目标实例: instance_ids 支持批量
      const hasIds = args.instance_ids !== undefined && Array.isArray(args.instance_ids) && args.instance_ids.length > 0
      const targets = hasIds
        ? args.instance_ids.map((id) => String(id)).filter((id) => id.length > 0)
        : (args.instance_id !== undefined && args.instance_id.length > 0 ? [args.instance_id] : [])
      if (targets.length === 0) {
        throw new Error('ecs_exec: 必须提供 instance_id 或 instance_ids')
      }
      if (targets.length > BATCH_LIMIT) {
        throw new Error('ecs_exec: 批量执行上限为 ' + BATCH_LIMIT + ' 台 (收到 ' + targets.length + ')')
      }
      if (args.run_in_background === true && targets.length > 1) {
        throw new Error('ecs_exec: 批量执行(instance_ids)与 run_in_background 不能同时使用')
      }

      // 破坏性命令守卫: 命中即需要 approval, 失败关闭
      await guardDestructiveCommand(ctx, exec, args.command)

      const buildArgv = (id) => {
        const argv = ['exec', '--instance-id', id, '--command', args.command, '--output', 'json']
        if (args.timeout !== undefined) argv.push('--timeout', String(args.timeout))
        if (args.region !== undefined) argv.push('--region', args.region)
        return argv
      }

      // ---- 后台任务: 注册到 jobs, 立即返回 job_id ----
      if (args.run_in_background === true) {
        const jobs = ctx.get('jobs')
        if (jobs === undefined) {
          throw new Error('后台任务不可用: 当前环境未挂载 jobs 服务(需 @deepseek-ai/dsh-jobs)')
        }
        if (exec.signal.aborted) throw new Error('工具调用已被取消')
        let handle = undefined
        let offsetStdout = 0
        let offsetStderr = 0
        const jobId = jobs.start({
          kind: 'workbench-ecs',
          label: 'ecs_exec ' + targets[0] + ': ' + args.command.slice(0, 60),
          ...(exec.agent !== undefined ? { owner: exec.agent } : {}),
          run: () => {
            const handlePromise = spawnWorkbench(ctx, buildArgv(targets[0]), undefined)
            return {
              cancel: () => { if (handle !== undefined) handle.terminate() },
              done: handlePromise.then(async (h) => {
                handle = h
                const outcome = await h.done
                return { exitCode: outcome.exitCode, signal: outcome.signal }
              }),
              readOutput: () => {
                if (handle === undefined) return ''
                const parts = []
                const out = handle.collected.stdout
                if (out !== undefined) {
                  const rd = out.readFrom(offsetStdout)
                  offsetStdout = rd.nextOffset
                  parts.push(rd.text)
                }
                const err = handle.collected.stderr
                if (err !== undefined) {
                  const rd = err.readFrom(offsetStderr)
                  offsetStderr = rd.nextOffset
                  parts.push(rd.text)
                }
                return parts.join('')
              },
            }
          },
        })
        return {
          kind: 'background',
          instance_id: targets[0],
          job_id: jobId,
          command: args.command,
          command_line: commandLine(buildArgv(targets[0])),
        }
      }

      // ---- 单实例前台 ----
      if (targets.length === 1) {
        const r = await runWorkbench(ctx, buildArgv(targets[0]), exec.signal, {
          stdoutSpillMaxBytes: 64 * 1024 * 1024,
        })
        if (exec.signal.aborted) throw new Error('工具调用已被取消')
        return { kind: 'single', command: args.command, command_line: commandLine(buildArgv(targets[0])), ...execOne(r, targets[0]) }
      }

      // ---- 批量: 串行执行, 单台失败不中断 ----
      const batch = []
      for (const id of targets) {
        try {
          const r = await runWorkbench(ctx, buildArgv(id), exec.signal, {
            stdoutSpillMaxBytes: 64 * 1024 * 1024,
          })
          if (exec.signal.aborted) throw new Error('工具调用已被取消')
          batch.push({ is_error: false, ...execOne(r, id) })
        } catch (err) {
          batch.push({
            is_error: true,
            instance_id: id,
            error: err && err.message !== undefined ? String(err.message) : String(err),
            exit_code: 0,
            output: '',
            stderr: '',
            stdout_truncated: false,
          })
        }
      }
      return {
        kind: 'batch',
        command: args.command,
        command_line: commandLine(buildArgv(targets[0])),
        count: batch.length,
        failed_count: batch.filter((b) => b.is_error === true).length,
        batch,
      }
    },
    presentCall(args) {
      if (args.run_in_background === true) {
        return {
          card: 'generic',
          title: '后台执行: ' + args.command.slice(0, 80),
          kind: 'execute',
          rawInput: args.instance_id,
          content: [{ type: 'text', text: 'run_in_background' }],
        }
      }
      const target = args.instance_ids !== undefined && args.instance_ids.length > 1
        ? '批量 ' + args.instance_ids.length + ' 台'
        : '实例 ' + (args.instance_id ?? (args.instance_ids ? String(args.instance_ids[0]) : ''))
      return {
        card: 'terminal',
        title: args.command.length > 120 ? args.command.slice(0, 120) + '…' : args.command,
        description: target,
      }
    },
    presentResult(args, result) {
      const meta = result.meta
      if (meta === undefined || typeof meta !== 'object') return undefined
      if (meta.kind === 'background') {
        return { card: 'generic', title: '后台任务', content: [{ type: 'text', text: 'job_id: ' + meta.job_id }] }
      }
      if (meta.kind === 'batch') return undefined
      const block = result.content.length === 1 ? result.content[0] : undefined
      if (block === undefined || block.type !== 'text') return undefined
      return {
        card: 'terminal',
        title: meta.command,
        output: block.text,
        ...(typeof meta.exit_code === 'number' ? { exitCode: meta.exit_code } : {}),
      }
    },
  }
}
