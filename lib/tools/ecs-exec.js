// ============================================================================
// lib/tools/ecs-exec.js —— ecs_exec: 在指定实例上执行远程命令或脚本
// 对应 CLI: workbench exec --instance-id <id> --command <cmd> --timeout <s> --output json
// 增强: 脚本直送(script, 零转义) / 只读护栏(read_only) / 破坏性命令守卫(approval) /
//       后台任务(jobs) / 批量实例 / 大输出 spill / ANSI 清洗
// ============================================================================
import {
  runWorkbench, spawnWorkbench, decodeCliOutput, commandLine,
  guardDestructiveCommand, guardReadOnly, omitUndefined, withInstanceLock,
  buildScriptDelivery, cleanOutput, resolveTimeout, utf8ByteLength,
} from '../common.js'

const BATCH_LIMIT = 20

// 默认超时(秒): 工具声明的默认值必须显式下发 —— CLI 的 --timeout 默认仅 30 秒。
// 命名带模块前缀: scripts/to-body.mjs 会把各模块拼进同一作用域, 顶层 const 不能重名。
const EXEC_DEFAULT_TIMEOUT = 60

// 单实例前台执行并解析 CLI 的 { output, stderr, exit_code } 成功结构
function execOne(r, instanceId, opts = {}) {
  const data = decodeCliOutput(r, 'ecs_exec')
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('ecs_exec: 意外的输出结构: ' + r.stdout.slice(0, 300))
  }
  const stripAnsi = opts.stripAnsi !== false
  // 远端退出码以 JSON 的 exit_code 为准(CLI 自身退出码通常与之相同, 作为回退)
  const remoteExit = typeof data.exit_code === 'number' ? data.exit_code : undefined
  return {
    instance_id: instanceId,
    exit_code: remoteExit !== undefined ? remoteExit : (r.exitCode != null ? r.exitCode : 0),
    output: cleanOutput(data.output !== undefined ? String(data.output) : '', stripAnsi),
    stderr: cleanOutput(data.stderr !== undefined ? String(data.stderr) : '', stripAnsi),
    request_id: data.request_id !== undefined ? String(data.request_id) : undefined,
    session_id: data.session_id !== undefined ? String(data.session_id) : undefined,
    stdout_truncated: r.stdoutTruncated === true,
    stdout_spill_path: r.stdoutSpillPath,
  }
}

// 脚本正文过长时, 回显字段只保留头部, 避免工具结果被脚本淹没
const SCRIPT_ECHO_LIMIT = 4000
function scriptEcho(script) {
  if (script.length <= SCRIPT_ECHO_LIMIT) return { command: script, script_truncated: false }
  return { command: script.slice(0, SCRIPT_ECHO_LIMIT) + '\n… (脚本共 ' + script.length + ' 字符, 已截断回显)', script_truncated: true }
}

export function ecsExecDefinition(ctx) {
  // 前台/后台共用的 argv 构造
  function buildArgv(id, remoteCommand, args) {
    const argv = ['exec', '--instance-id', id, '--command', remoteCommand, '--output', 'json']
    argv.push('--timeout', String(resolveTimeout(args.timeout, EXEC_DEFAULT_TIMEOUT)))
    if (args.region !== undefined) argv.push('--region', args.region)
    return argv
  }

  // 单条远程命令(前台)
  async function runRemote(id, remoteCommand, args, exec) {
    const argv = buildArgv(id, remoteCommand, args)
    return withInstanceLock(id, () => runWorkbench(ctx, argv, exec.signal, {
      stdoutSpillMaxBytes: 64 * 1024 * 1024,
    }))
  }

  // 脚本直送: 前置命令(投递/落盘/校验)逐条执行, 末条命令执行脚本并透传退出码。
  // 前置命令在同一个实例锁内串行, 不会被同实例其它调用插进来。
  async function deliverScript(id, script, args, exec) {
    const delivery = buildScriptDelivery(script, { shell: args.shell, keep: args.keep_script === true })
    const prep = delivery.commands.slice(0, -1)
    const finalCommand = delivery.commands[delivery.commands.length - 1]
    for (let i = 0; i < prep.length; i++) {
      const r = await runRemote(id, prep[i], args, exec)
      if (r.exitCode !== 0) {
        throw new Error('ecs_exec: 脚本投递失败(第 ' + (i + 1) + '/' + prep.length + ' 步, exit ' + r.exitCode + '): ' +
          cleanOutput(r.stdout + r.stderr, true).slice(0, 300))
      }
      if (exec.signal.aborted) throw new Error('工具调用已被取消')
    }
    return { delivery, finalCommand }
  }

  // 前台单实例 / 后台 / 批量 三种结果的渲染
  function renderExecValue(value) {
    const lines = []
    if (value.kind === 'background') {
      lines.push('后台任务已启动 — 实例: ' + value.instance_id)
      if (value.description !== undefined) lines.push('用途: ' + value.description)
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
    lines.push('远程' + (value.script_mode === true ? '脚本' : '命令') + '执行结果 — 实例: ' + value.instance_id)
    if (value.description !== undefined) lines.push('用途: ' + value.description)
    if (value.script_mode === true) lines.push('$ (script, ' + value.script_bytes + ' 字节)')
    lines.push('$ ' + value.command)
    if (value.output.length > 0) lines.push(value.output.replace(/\n$/, ''))
    if (value.stderr.length > 0) {
      if (value.output.length > 0) lines.push('')
      lines.push('[stderr]')
      lines.push(value.stderr.replace(/\n$/, ''))
    }
    if (value.output.length === 0 && value.stderr.length === 0) lines.push('(无输出)')
    lines.push('[exit code: ' + value.exit_code + ']')
    if (value.read_only === true) lines.push('[read_only: 已启用只读护栏]')
    if (value.stdout_truncated === true) {
      lines.push('[输出过长, 已截断' +
        (value.stdout_spill_path !== undefined && value.stdout_spill_path !== null
          ? '; 完整输出: ' + value.stdout_spill_path : '') + ']')
    }
    return lines.join('\n')
  }

  const ITEM_SCHEMA = {
    type: 'object',
    properties: {
      instance_id: { type: 'string' },
      is_error: { type: 'boolean' },
      error: { type: 'string' },
      exit_code: { type: 'integer' },
      output: { type: 'string' },
      stderr: { type: 'string' },
      request_id: { type: 'string' },
      session_id: { type: 'string' },
      stdout_truncated: { type: 'boolean' },
      stdout_spill_path: { type: 'string' },
    },
    additionalProperties: false,
  }

  return {
    name: 'ecs_exec',
    description: '通过本机阿里云 Workbench CLI 在指定 ECS 实例上执行远程命令(非交互), ' +
      '返回标准输出/错误输出与退出码; 每次调用是独立 shell 上下文, 状态不跨调用保留。' +
      'command 与 script 二选一: script 会把脚本正文原样投递远端落盘后执行, ' +
      '引号/中文/$/反引号/docker exec 多层引用都不需要转义(推荐用于复杂命令)。' +
      'read_only=true 时拒绝写操作(重定向/rm/docker 变更/systemctl 变更等)。' +
      '支持 instance_ids 批量执行(串行, 上限 ' + BATCH_LIMIT + ' 台)与 run_in_background 后台任务。' +
      '破坏性命令(rm -rf、shutdown、reboot、mkfs、dd 等)会自动请求用户确认, 未批准即拒绝执行。',
    parameters: {
      instance_id: { type: 'string', description: '目标 ECS 实例 ID, 例如 i-bp1xxxxx(可由 ecs_list 取得); 与 instance_ids 二选一' },
      instance_ids: {
        type: 'array', items: { type: 'string' },
        description: '批量目标实例 ID 数组(串行执行, 最多 ' + BATCH_LIMIT + ' 台); 与 instance_id 二选一',
      },
      command: { type: 'string', description: '要执行的远程命令(与 script 二选一); 需要共享上下文时用 && 或 ; 串联, 例如 "cd /var/log && tail -n 50 app.log"' },
      script: { type: 'string', description: '脚本正文(与 command 二选一)。base64 投递远端落盘后执行, 内容不经过 shell 引用层: 引号/中文/$/反引号/多行/heredoc 均无需转义' },
      shell: { type: 'string', enum: ['bash', 'sh'], description: 'script 模式的远端解释器, 默认 bash' },
      keep_script: { type: 'boolean', description: 'script 模式保留远端临时脚本文件(默认 false, 执行后删除)' },
      read_only: { type: 'boolean', description: '只读护栏: true 时命中写操作模式(重定向、rm/mv/cp、chmod、docker 变更、systemctl 变更、nohup 等)直接拒绝执行(默认 false)' },
      description: { type: 'string', description: '本次执行用途的简述(展示在任务列表与卡片标题, 便于回看)' },
      strip_ansi: { type: 'boolean', description: '清洗 ANSI 转义与控制字符(默认 true)' },
      timeout: { type: 'integer', description: '远端命令超时时间(秒), 默认 ' + EXEC_DEFAULT_TIMEOUT },
      region: { type: 'string', description: '地域, 可缺省: CLI 会从实例 ID 自动推断' },
      run_in_background: {
        type: 'boolean',
        description: '后台执行长命令: 立即返回 job_id, 用 job_output 读取增量输出(不适用于批量)',
      },
    },
    timeoutMs: 600000,
    output: {
      schema: {
        type: 'object',
        properties: {
          kind: { type: 'string' },
          instance_id: { type: 'string' },
          job_id: { type: 'string' },
          command: { type: 'string' },
          command_line: { type: 'string' },
          description: { type: 'string' },
          script_mode: { type: 'boolean' },
          script_bytes: { type: 'integer' },
          script_truncated: { type: 'boolean' },
          script_path: { type: 'string' },
          read_only: { type: 'boolean' },
          exit_code: { type: 'integer' },
          output: { type: 'string' },
          stderr: { type: 'string' },
          request_id: { type: 'string' },
          session_id: { type: 'string' },
          stdout_truncated: { type: 'boolean' },
          stdout_spill_path: { type: 'string' },
          count: { type: 'integer' },
          failed_count: { type: 'integer' },
          batch: { type: 'array', items: ITEM_SCHEMA },
        },
        additionalProperties: false,
      },
      render: (args, value) => [{ type: 'text', text: renderExecValue(value) }],
      presentationMeta: (args, value) => omitUndefined({
        kind: value.kind,
        instance_id: value.instance_id,
        job_id: value.job_id,
        exit_code: value.exit_code,
        command: value.command,
        count: value.count,
        description: value.description,
      }),
    },
    async execute(args, exec) {
      // ---- 归一化目标实例: instance_ids 支持批量 ----
      const hasIds = args.instance_ids !== undefined && Array.isArray(args.instance_ids) && args.instance_ids.length > 0
      const targets = hasIds
        ? Array.from(new Set(args.instance_ids.map((id) => String(id)).filter((id) => id.length > 0)))
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

      // ---- command / script 二选一 ----
      const hasCommand = args.command !== undefined && String(args.command).length > 0
      const hasScript = args.script !== undefined && String(args.script).length > 0
      if (hasCommand && hasScript) {
        throw new Error('ecs_exec: command 与 script 只能二选一(script 模式下命令内容不会被 shell 再解释)')
      }
      if (!hasCommand && !hasScript) {
        throw new Error('ecs_exec: 必须提供 command 或 script')
      }
      const scriptMode = hasScript
      const scriptText = scriptMode ? String(args.script) : ''
      const payload = scriptMode ? scriptText : String(args.command)
      const readOnly = args.read_only === true
      const stripAnsi = args.strip_ansi !== false
      const echo = scriptMode ? scriptEcho(payload) : { command: payload, script_truncated: false }
      const description = args.description !== undefined && String(args.description).length > 0 ? String(args.description) : undefined

      // ---- 只读护栏(防呆, 先于审批) + 破坏性命令守卫(审批) ----
      if (readOnly) guardReadOnly(payload, 'ecs_exec')
      await guardDestructiveCommand(ctx, exec, payload)

      const scriptMeta = scriptMode
        ? { script_mode: true, script_bytes: utf8ByteLength(payload), script_truncated: echo.script_truncated }
        : {}
      // script 模式的 command_line 只登记投递形状, 不把整段脚本塞进展示串
      const displayArgv = scriptMode
        ? ['exec', '--instance-id', targets[0], '--command', '<script ' + utf8ByteLength(payload) + ' bytes>',
          '--timeout', String(resolveTimeout(args.timeout, EXEC_DEFAULT_TIMEOUT)),
          ...(args.region !== undefined ? ['--region', String(args.region)] : [])]
        : buildArgv(targets[0], payload, args)

      // ---- 后台任务: 注册到 jobs, 立即返回 job_id ----
      if (args.run_in_background === true) {
        const jobs = ctx.get('jobs')
        if (jobs === undefined) {
          throw new Error('后台任务不可用: 当前环境未挂载 jobs 服务(需 @deepseek-ai/dsh-jobs)')
        }
        if (exec.signal.aborted) throw new Error('工具调用已被取消')
        const id = targets[0]
        // 脚本模式的前置投递先在前台完成(秒级), 后台子进程只承载真正执行的末条命令
        const prepared = scriptMode
          ? await deliverScript(id, payload, args, exec)
          : { delivery: undefined, finalCommand: payload }
        const finalCommand = prepared.finalCommand
        let handle = undefined
        let offsetStdout = 0
        let offsetStderr = 0
        const jobId = jobs.start({
          kind: 'workbench-ecs',
          label: (description !== undefined ? description + ' — ' : '') + 'ecs_exec ' + id + ': ' + (scriptMode ? 'script' : payload.slice(0, 60)),
          outputLimitBytes: 256 * 1024,
          ...(exec.agent !== undefined ? { owner: exec.agent } : {}),
          run: () => {
            // 后台任务同样占用实例锁: 与同实例的其它调用互斥, 避免输出串流。
            // 锁在子进程结束后释放(而不是 start() 返回时), 因此长任务期间
            // 同实例的前台调用会排队等待 —— 这正是隔离所需的语义。
            // (v0.5 的 detach 轮询模型会把持锁时间降到单次轮询, 见 docs/改良计划)
            let cancelled = false
            const done = withInstanceLock(id, async () => {
              if (cancelled) return { status: 'killed', detail: 'cancelled before start' }
              const h = await spawnWorkbench(ctx, buildArgv(id, finalCommand, args), undefined, {
                stdoutMaxBytes: 8 * 1024 * 1024,
                stdoutSpillMaxBytes: 64 * 1024 * 1024,
              })
              handle = h
              const outcome = await h.done
              const collected = h.collected.stdout !== undefined ? h.collected.stdout.readFrom(0) : undefined
              let code = outcome.exitCode != null ? outcome.exitCode : 0
              // JSON 的 exit_code 才是远端退出码(CLI 自身退出码通常相同, 作为回退)
              if (collected !== undefined) {
                try {
                  const parsed = JSON.parse(collected.text)
                  if (parsed !== null && typeof parsed === 'object' && typeof parsed.exit_code === 'number') code = parsed.exit_code
                } catch (err) { /* 非 JSON 输出: 保留 CLI 退出码 */ }
              }
              // dsh-jobs 契约: done 必须解析 { status: 'completed'|'killed'|'failed', detail? }
              // (旧实现返回 {exitCode,signal} 会让 job.status = undefined, 导致
              //  job_output/job_list 结果含 undefined 而报 not lossless JSON)
              return {
                status: cancelled ? 'killed' : (code === 0 ? 'completed' : 'failed'),
                detail: 'exit code: ' + code,
              }
            })
            return {
              cancel: () => { cancelled = true; if (handle !== undefined) handle.terminate() },
              done,
              readOutput: () => {
                if (handle === undefined) return ''
                const parts = []
                const out = handle.collected.stdout
                if (out !== undefined) {
                  const rd = out.readFrom(offsetStdout)
                  offsetStdout = rd.nextOffset
                  parts.push(cleanOutput(rd.text, stripAnsi))
                }
                const err = handle.collected.stderr
                if (err !== undefined) {
                  const rd = err.readFrom(offsetStderr)
                  offsetStderr = rd.nextOffset
                  parts.push(cleanOutput(rd.text, stripAnsi))
                }
                return parts.join('')
              },
            }
          },
        })
        return omitUndefined({
          kind: 'background',
          instance_id: id,
          job_id: jobId,
          command: scriptMode ? prepared.delivery.runner : payload,
          command_line: commandLine(buildArgv(id, scriptMode ? '<script ' + utf8ByteLength(payload) + ' bytes>' : payload, args)),
          description,
          read_only: readOnly === true ? true : undefined,
          ...scriptMeta,
          ...(scriptMode ? { script_path: args.keep_script === true ? prepared.delivery.script_path : undefined } : {}),
        })
      }

      // ---- 单实例前台 ----
      if (targets.length === 1) {
        const id = targets[0]
        let r
        let scriptPath
        if (scriptMode) {
          const prepared = await deliverScript(id, payload, args, exec)
          scriptPath = args.keep_script === true ? prepared.delivery.script_path : undefined
          r = await runRemote(id, prepared.finalCommand, args, exec)
        } else {
          r = await runRemote(id, payload, args, exec)
        }
        if (exec.signal.aborted) throw new Error('工具调用已被取消')
        return omitUndefined({
          kind: 'single',
          command: echo.command,
          command_line: commandLine(displayArgv),
          description,
          read_only: readOnly === true ? true : undefined,
          ...scriptMeta,
          ...(scriptPath !== undefined ? { script_path: scriptPath } : {}),
          ...execOne(r, id, { stripAnsi }),
        })
      }

      // ---- 批量: 串行执行, 单台失败不中断 ----
      const batch = []
      for (const id of targets) {
        try {
          let r
          if (scriptMode) {
            const prepared = await deliverScript(id, payload, args, exec)
            r = await runRemote(id, prepared.finalCommand, args, exec)
          } else {
            r = await runRemote(id, payload, args, exec)
          }
          if (exec.signal.aborted) throw new Error('工具调用已被取消')
          batch.push({ is_error: false, ...execOne(r, id, { stripAnsi }) })
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
      return omitUndefined({
        kind: 'batch',
        command: echo.command,
        command_line: commandLine(displayArgv),
        description,
        read_only: readOnly === true ? true : undefined,
        ...scriptMeta,
        count: batch.length,
        failed_count: batch.filter((b) => b.is_error === true).length,
        batch,
      })
    },
    presentCall(args) {
      const isScript = args.command === undefined && args.script !== undefined
      const title = args.description !== undefined && String(args.description).length > 0
        ? String(args.description)
        : (isScript ? '[script] ' + String(args.script).split('\n')[0] : String(args.command))
      const short = title.length > 120 ? title.slice(0, 120) + '…' : title
      if (args.run_in_background === true) {
        return {
          card: 'generic',
          title: '后台执行: ' + short,
          kind: 'execute',
          rawInput: args.instance_id,
          content: [{ type: 'text', text: 'run_in_background' }],
        }
      }
      const target = args.instance_ids !== undefined && args.instance_ids.length > 1
        ? '批量 ' + args.instance_ids.length + ' 台'
        : '实例 ' + (args.instance_id ?? (args.instance_ids ? String(args.instance_ids[0]) : ''))
      const badges = []
      if (isScript) badges.push('script')
      if (args.read_only === true) badges.push('read_only')
      return {
        card: 'terminal',
        title: short,
        description: badges.length > 0 ? badges.join(' · ') + ' · ' + target : target,
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
        title: meta.description !== undefined ? meta.description : meta.command,
        output: block.text,
        ...(typeof meta.exit_code === 'number' ? { exitCode: meta.exit_code } : {}),
      }
    },
  }
}
