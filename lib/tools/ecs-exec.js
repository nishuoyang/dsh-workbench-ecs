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
  buildDetachLaunch, buildLogReadCommand, parseLogRead, parseDetachPid, hasLocalTimer, delay, shellQuote,
  runWithConcurrency,
} from '../common.js'

const BATCH_LIMIT = 20

// 批量默认并发: 只读命令(read_only)天然可并发, 默认 4; 写命令保持串行, 避免集群级惊群
const BATCH_READONLY_CONCURRENCY = 4

// 默认超时(秒): 工具声明的默认值必须显式下发 —— CLI 的 --timeout 默认仅 30 秒。
// 命名带模块前缀: scripts/to-body.mjs 会把各模块拼进同一作用域, 顶层 const 不能重名。
const EXEC_DEFAULT_TIMEOUT = 60

// detach 轮询参数
const DETACH_POLL_SECONDS = 2
const DETACH_POLL_MAX_BYTES = 256 * 1024
const DETACH_MAX_DURATION_SECONDS = 3600
const DETACH_BUFFER_BYTES = 4 * 1024 * 1024
// 每 poll 的远端命令超时(detach 轮询自身必须快, 不占用实例名额太久)
const DETACH_POLL_TIMEOUT = 30

// ----------------------------------------------------------------------------
// 伪会话(S3): CLI 的 exec 每次都是独立 shell(且只有 session list/close, 没有
// 可用的会话创建语义), 因此 cwd/环境变量由插件侧持有: 每次把 payload 包进
// "cd <上次 cwd>; export ...; <payload>; 打印 __DSH_ECS_CWD__<pwd>" 的脚本投递,
// 从输出里回收新的 cwd 并剥离标记行。状态随插件 fiber 生命周期, 空闲过期后
// 显式提示(而不是静默从默认目录开始)。
// ----------------------------------------------------------------------------
const SESSION_STATE = new Map()
const SESSION_IDLE_MS = 30 * 60 * 1000
const SESSION_CWD_MARKER = '__DSH_ECS_CWD__'

export function buildSessionScript(payload, state, envPairs) {  const lines = []
  if (state !== undefined && state.cwd !== undefined && state.cwd.length > 0) {
    lines.push('cd ' + shellQuote(state.cwd) + ' 2>/dev/null || { echo "dsh-ecs: 会话工作目录不可用: ' + state.cwd + '" >&2; }')
  }
  const env = Object.assign({}, state !== undefined ? state.env : undefined)
  for (const pair of envPairs !== undefined ? envPairs : []) {
    const s = String(pair)
    const i = s.indexOf('=')
    if (i > 0) env[s.slice(0, i)] = s.slice(i + 1)
  }
  for (const key of Object.keys(env)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue
    lines.push('export ' + key + '=' + shellQuote(String(env[key])))
  }
  lines.push(payload)
  lines.push('rc=$?')
  lines.push('printf "\\n' + SESSION_CWD_MARKER + '%s\\n" "$PWD"')
  lines.push('exit $rc')
  return { script: lines.join('\n'), env }
}

// 从输出中剥离并取出 cwd 标记(标记独占一行; 只额外吃掉它自带的换行)
export function extractSessionCwd(text) {
  const re = new RegExp(SESSION_CWD_MARKER + '([^\\n]*)\\n?')
  const m = re.exec(text)
  if (m === null) return { text, cwd: undefined }
  const cleaned = (text.slice(0, m.index) + text.slice(m.index + m[0].length)).replace(/\n$/, '')
  return { text: cleaned, cwd: m[1].trim() }
}

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
    // CLI 侧的共享会话 id(用于核对同实例并发是否复用同一输出流);
    // 与插件侧的伪会话(session_id)不是一回事, 故显式命名为 cli_session_id
    cli_session_id: data.session_id !== undefined ? String(data.session_id) : undefined,
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
    return withInstanceLock(id, () => runWorkbench(ctx, argv, exec.signal, { exec,
      stdoutSpillMaxBytes: 64 * 1024 * 1024,
    }))
  }

  // 脚本直送: 前置命令(投递/落盘/校验)逐条执行, 末条命令执行脚本并透传退出码。
  // 前置命令在同一个实例锁内串行, 不会被同实例其它调用插进来。
  async function deliverScript(id, script, args, exec) {
    const delivery = buildScriptDelivery(script, { shell: args.shell, keep: args.keep_script === true })
    const prep = delivery.commands.slice(0, -1)
    const finalCommand = delivery.commands[delivery.commands.length - 1]
    await runPrep(id, prep, args, exec)
    return { delivery, finalCommand }
  }

  // 顺序执行投递前置命令, 任一步非零即报错
  async function runPrep(id, prep, args, exec) {
    for (let i = 0; i < prep.length; i++) {
      const r = await runRemote(id, prep[i], args, exec)
      if (r.exitCode !== 0) {
        throw new Error('ecs_exec: 脚本投递失败(第 ' + (i + 1) + '/' + prep.length + ' 步, exit ' + r.exitCode + '): ' +
          cleanOutput(r.stdout + r.stderr, true).slice(0, 300))
      }
      if (exec.signal.aborted) throw new Error('工具调用已被取消')
    }
  }

  // detach: 远端 nohup 启动 + 日志/退出码文件; 插件侧注册成流式 job,
  // 轮询只搬运增量(远端日志文件是唯一事实源), 且每次轮询只短暂占用实例锁。
  async function startDetached(id, script, args, exec) {
    const jobs = ctx.get('jobs')
    if (jobs === undefined) {
      throw new Error('detach 不可用: 当前环境未挂载 jobs 服务(需 @deepseek-ai/dsh-jobs)')
    }
    const launch = buildDetachLaunch(script, { shell: args.shell })
    await runPrep(id, launch.prepare_commands, args, exec)

    const launched = await runRemote(id, launch.launch_command, args, exec)
    const pid = parseDetachPid(launched.stdout)
    if (launched.exitCode !== 0 || pid === undefined) {
      throw new Error('ecs_exec: detach 启动失败 (exit ' + launched.exitCode + '): ' +
        cleanOutput(launched.stdout + launched.stderr, true).slice(0, 300))
    }

    const intervalSec = Number.isFinite(Number(args.poll_interval)) && Number(args.poll_interval) > 0
      ? Math.min(Math.floor(Number(args.poll_interval)), 60)
      : DETACH_POLL_SECONDS
    const maxDurationSec = Number.isFinite(Number(args.max_duration)) && Number(args.max_duration) > 0
      ? Math.floor(Number(args.max_duration))
      : DETACH_MAX_DURATION_SECONDS
    const localTimer = hasLocalTimer(ctx)

    const jobId = jobs.start({
      kind: 'workbench-ecs',
      label: (args.description !== undefined && String(args.description).length > 0 ? String(args.description) + ' — ' : '') +
        'ecs_exec detach ' + id + ': ' + (args.script !== undefined ? 'script' : String(args.command).slice(0, 60)),
      outputLimitBytes: 256 * 1024,
      ...(exec.agent !== undefined ? { owner: exec.agent } : {}),
      run: () => {
        let cancelled = false
        const pending = []
        let buffered = 0
        let dropped = false
        let cursor = 0
        let polls = 0
        let failures = 0
        const deadline = Date.now() + maxDurationSec * 1000

        const push = (text) => {
          if (text.length === 0) return
          pending.push(text)
          buffered += utf8ByteLength(text)
          while (buffered > DETACH_BUFFER_BYTES && pending.length > 1) {
            buffered -= utf8ByteLength(pending.shift())
            dropped = true
          }
        }

        const pollCommand = () => buildLogReadCommand({
          logPath: launch.log_path,
          exitPath: launch.exit_path,
          after: cursor,
          maxBytes: DETACH_POLL_MAX_BYTES,
          sleep: localTimer ? 0 : intervalSec,
        })

        const done = (async () => {
          while (!cancelled) {
            if (localTimer) await delay(ctx, intervalSec * 1000)
            if (cancelled) break
            let r
            try {
              const argv = ['exec', '--instance-id', id, '--command', pollCommand(),
                '--timeout', String(DETACH_POLL_TIMEOUT), '--output', 'json']
              if (args.region !== undefined) argv.push('--region', String(args.region))
              r = await withInstanceLock(id, () => runWorkbench(ctx, argv, undefined, { stdoutSpillMaxBytes: 8 * 1024 * 1024, exec }))
            } catch (err) {
              failures += 1
              if (failures > 5) {
                return { status: 'failed', detail: '轮询失败 ' + failures + ' 次: ' + (err && err.message ? err.message : String(err)) }
              }
              continue
            }
            polls += 1
            let parsed
            try {
              const data = decodeCliOutput(r, 'ecs_exec detach')
              parsed = parseLogRead(data.output !== undefined ? String(data.output) : '', cursor, DETACH_POLL_MAX_BYTES)
            } catch (err) {
              failures += 1
              if (failures > 5) {
                return { status: 'failed', detail: '轮询输出解析失败: ' + (err && err.message ? err.message : String(err)) }
              }
              continue
            }
            failures = 0
            push(cleanOutput(parsed.text, args.strip_ansi !== false))
            cursor = parsed.next_offset
            if (parsed.exit_code !== undefined) {
              const code = parsed.exit_code
              return { status: code === 0 ? 'completed' : 'failed', detail: 'exit code: ' + code }
            }
            if (Date.now() > deadline) {
              return { status: 'failed', detail: 'detach 任务超过 max_duration(' + maxDurationSec + 's), 已停止跟踪; 日志仍在 ' + launch.log_path }
            }
          }
          return { status: 'killed', detail: 'cancelled' }
        })()

        return {
          cancel: () => {
            cancelled = true
            // 尽力终止远端进程(失败不影响本地结算)
            const argv = ['exec', '--instance-id', id, '--command', 'kill ' + String(pid) + ' 2>/dev/null || true',
              '--timeout', '15', '--output', 'json']
            withInstanceLock(id, () => runWorkbench(ctx, argv, undefined, { stdoutMaxBytes: 64 * 1024, exec })).catch(() => {})
          },
          done,
          readOutput: () => {
            const parts = []
            if (dropped && pending.length > 0) parts.push('[提示: 本地缓冲曾超限, 更早的内容请用 ecs_log 读 ' + launch.log_path + ']\n')
            parts.push(pending.join(''))
            pending.length = 0
            buffered = 0
            return parts.join('')
          },
        }
      },
    })

    return omitUndefined({
      kind: 'detached',
      instance_id: id,
      job_id: jobId,
      pid,
      log_path: launch.log_path,
      exit_path: launch.exit_path,
      command: args.script !== undefined && String(args.script).length > 0 ? launch.runner : String(args.command),
      command_line: commandLine(['exec', '--instance-id', id, '--command', '<detach ' + launch.expected_bytes + ' bytes>']),
      description: args.description !== undefined && String(args.description).length > 0 ? String(args.description) : undefined,
      script_mode: args.script !== undefined ? true : undefined,
      script_bytes: args.script !== undefined ? utf8ByteLength(String(args.script)) : undefined,
      poll_interval: intervalSec,
    })
  }

  // 批量并发度: 取显式值 > (只读默认 4) > 串行 1; 上限 20 台
  function resolveConcurrency(args, targetCount) {
    const explicit = Number(args.concurrency)
    const cap = Math.max(1, Math.min(BATCH_LIMIT, targetCount))
    if (Number.isFinite(explicit) && explicit > 0) return Math.min(Math.floor(explicit), cap)
    if (args.read_only === true) return Math.min(BATCH_READONLY_CONCURRENCY, cap)
    return 1
  }

  // 后台单实例任务: 注册到 dsh-jobs 并立即返回 job_id(批量时每台实例各起一个)
  function startBackgroundJob(id, payload, args, exec, prepared, opts) {
    const jobs = ctx.get('jobs')
    if (jobs === undefined) {
      throw new Error('后台任务不可用: 当前环境未挂载 jobs 服务(需 @deepseek-ai/dsh-jobs)')
    }
    if (exec.signal.aborted) throw new Error('工具调用已被取消')
    const scriptMode = opts.scriptMode === true
    const description = opts.description
    const stripAnsi = opts.stripAnsi !== false
    const finalCommand = prepared.finalCommand
    let handle = undefined
    let offsetStdout = 0
    let offsetStderr = 0
    return jobs.start({
      kind: 'workbench-ecs',
      label: (description !== undefined ? description + ' — ' : '') + 'ecs_exec ' + id + ': ' + (scriptMode ? 'script' : payload.slice(0, 60)),
      outputLimitBytes: 256 * 1024,
      ...(exec.agent !== undefined ? { owner: exec.agent } : {}),
      run: () => {
        // 后台任务同样占用实例锁: 与同实例的其它调用互斥, 避免输出串流。
        // 锁在子进程结束后释放(而不是 start() 返回时), 因此长任务期间
        // 同实例的前台调用会排队等待 —— 这正是隔离所需的语义。
        // 需要"不长期占锁"的长任务请用 detach(detach 只在每次轮询期间短暂持锁)。
        let cancelled = false
        const done = withInstanceLock(id, async () => {
          if (cancelled) return { status: 'killed', detail: 'cancelled before start' }
          const h = await spawnWorkbench(ctx, buildArgv(id, finalCommand, args), undefined, { exec,
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
  }

  // 前台单实例 / 后台 / detach / 批量 四种结果的渲染
  function renderExecValue(value) {
    const lines = []
    if (value.kind === 'detached') {
      lines.push('远端长任务已 detach 启动 — 实例: ' + value.instance_id)
      if (value.description !== undefined) lines.push('用途: ' + value.description)
      lines.push('$ ' + value.command)
      lines.push('[job_id: ' + value.job_id + '] [远端 pid: ' + value.pid + '] [轮询间隔: ' + value.poll_interval + 's]')
      lines.push('日志: ' + value.log_path)
      lines.push('退出码文件: ' + value.exit_path)
      lines.push('用 job_output 增量读取; 需要从头/按字节续读时用 ecs_log ' +
        '{ instance_id: "' + value.instance_id + '", path: "' + value.log_path + '" }')
      return lines.join('\n')
    }
    if (value.kind === 'background') {
      lines.push('后台任务已启动 — 实例: ' + value.instance_id)
      if (value.description !== undefined) lines.push('用途: ' + value.description)
      lines.push('$ ' + value.command)
      lines.push('[job_id: ' + value.job_id + ']')
      lines.push('用 job_output 读取增量输出, job_kill 终止任务')
      return lines.join('\n')
    }
    if (value.kind === 'batch') {
      lines.push('批量执行完成 — ' + value.count + ' 台实例, 失败 ' + value.failed_count + ' 台' +
        (value.concurrency !== undefined && value.concurrency > 1 ? ' (并发 ' + value.concurrency + ')' : ''))
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
    if (value.kind === 'batch_background') {
      lines.push('批量后台任务已启动 — ' + value.count + ' 台实例, 失败 ' + value.failed_count + ' 台' +
        (value.concurrency !== undefined ? ' (并发 ' + value.concurrency + ')' : ''))
      lines.push('$ ' + value.command)
      for (const item of value.batch) {
        if (item.is_error === true) {
          lines.push('[' + item.instance_id + '] 启动失败: ' + (item.error !== undefined ? item.error : '未知错误'))
        } else {
          lines.push('[' + item.instance_id + '] job_id: ' + item.job_id)
        }
      }
      if (value.job_ids !== undefined && value.job_ids.length > 0) {
        lines.push('')
        lines.push('用 job_output 逐个读取增量输出(job_ids: ' + value.job_ids.join(', ') + '), job_kill 终止')
      }
      return lines.join('\n')
    }
    // kind === 'single'
    lines.push('远程' + (value.script_mode === true ? '脚本' : '命令') + '执行结果 — 实例: ' + value.instance_id)
    if (value.description !== undefined) lines.push('用途: ' + value.description)
    if (value.session_id !== undefined) {
      lines.push('[会话: ' + value.session_id + ', 工作目录: ' + (value.session_cwd !== undefined ? value.session_cwd : '(默认)') + ']')
      if (value.session_expired === true) lines.push('[提示: 该会话空闲超过 30 分钟, 已重置(cwd/环境变量不再继承)]')
    }
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
      job_id: { type: 'string' },
      exit_code: { type: 'integer' },
      output: { type: 'string' },
      stderr: { type: 'string' },
      request_id: { type: 'string' },
      cli_session_id: { type: 'string' },
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
      '支持 instance_ids 批量执行(可选 concurrency 并发, 上限 ' + BATCH_LIMIT + ' 台)、' +
      'run_in_background 后台任务(批量时每台一个 job, 返回 job_ids), ' +
      '以及 detach=true 的远端长任务(远端 nohup + 日志文件 + 轮询增量, 不长期占用实例, 日志可用 ecs_log 按字节游标续读)。' +
      'output_json=true 时直接返回稳定 JSON 文本(便于下游自动化接线)。' +
      '破坏性命令(rm -rf、shutdown、reboot、mkfs、dd 等)会自动请求用户确认, 未批准即拒绝执行。',
    parameters: {
      instance_id: { type: 'string', description: '目标 ECS 实例 ID, 例如 i-bp1xxxxx(可由 ecs_list 取得); 与 instance_ids 二选一' },
      instance_ids: {
        type: 'array', items: { type: 'string' },
        description: '批量目标实例 ID 数组(最多 ' + BATCH_LIMIT + ' 台, 可选 concurrency 并发); 与 instance_id 二选一',
      },
      concurrency: {
        type: 'integer',
        description: '批量并发度(默认: read_only=true 时 ' + BATCH_READONLY_CONCURRENCY + ', 否则 1 串行); ' +
          '同一实例的调用始终由实例锁串行, 跨实例才真正并行',
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
        description: '后台执行长命令: 立即返回 job_id, 用 job_output 读取增量输出; ' +
          '与 instance_ids 同用时每台实例各起一个 job, 返回 job_ids 数组',
      },
      output_json: {
        type: 'boolean',
        description: '以稳定 JSON 文本返回结果(与结构化 value 一致), 便于下游自动化解析; 默认 false 返回可读文本',
      },
      detach: {
        type: 'boolean',
        description: '远端 detach 长任务(推荐用于发布/构建等分钟~小时级操作): 远端 nohup 启动并写日志文件, ' +
          '立即返回 job_id + log_path + exit_path; 插件按 poll_interval 轮询增量, 期间不长期占用实例, ' +
          '同实例其它调用可正常插空执行。日志可按字节游标用 ecs_log 从头续读',
      },
      poll_interval: { type: 'integer', description: 'detach 轮询间隔(秒), 默认 ' + DETACH_POLL_SECONDS },
      max_duration: { type: 'integer', description: 'detach 最长跟踪时长(秒), 默认 ' + DETACH_MAX_DURATION_SECONDS + '; 超时停止跟踪(远端任务不受影响)' },
      session_id: {
        type: 'string',
        description: '可选:: 伪会话 —— 同一 session_id 下保留工作目录与环境变量(cd/export 会被继承), 不同 session_id 互不影响。' +
          '仅适用于单实例前台执行(批量/detach/后台不支持); 状态由插件持有并随进程结束失效',
      },
      session_reset: { type: 'boolean', description: '配合 session_id: 先清空该会话的 cwd/环境变量再执行' },
      env: {
        type: 'array', items: { type: 'string' },
        description: '配合 session_id: 会话内持久的环境变量, 每项 "K=V"; 与已有会话变量合并',
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
          pid: { type: 'integer' },
          log_path: { type: 'string' },
          exit_path: { type: 'string' },
          poll_interval: { type: 'integer' },
          read_only: { type: 'boolean' },
          exit_code: { type: 'integer' },
          output: { type: 'string' },
          stderr: { type: 'string' },
          request_id: { type: 'string' },
          cli_session_id: { type: 'string' },
          session_id: { type: 'string' },
          session_cwd: { type: 'string' },
          session_expired: { type: 'boolean' },
          env_keys: { type: 'array', items: { type: 'string' } },
          stdout_truncated: { type: 'boolean' },
          stdout_spill_path: { type: 'string' },
          count: { type: 'integer' },
          failed_count: { type: 'integer' },
          concurrency: { type: 'integer' },
          job_ids: { type: 'array', items: { type: 'string' } },
          batch: { type: 'array', items: ITEM_SCHEMA },
        },
        additionalProperties: false,
      },
      render: (args, value) => [{
        type: 'text',
        text: args.output_json === true ? JSON.stringify(value, null, 2) : renderExecValue(value),
      }],
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
      if (args.detach === true && targets.length > 1) {
        throw new Error('ecs_exec: 批量执行(instance_ids)与 detach 不能同时使用(每台实例请单独 detach)')
      }
      if (args.detach === true && args.run_in_background === true) {
        throw new Error('ecs_exec: detach 与 run_in_background 只能二选一(detach 用于远端长任务, run_in_background 用于本地 CLI 进程)')
      }
      // 伪会话需要回收 cwd 标记, 只支持单实例前台执行
      const sessionMode = args.session_id !== undefined && String(args.session_id).length > 0
      if (sessionMode && (targets.length > 1 || args.detach === true || args.run_in_background === true)) {
        throw new Error('ecs_exec: session_id(伪会话)仅支持单实例前台执行, 不能与批量/detach/run_in_background 同用')
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

      // ---- detach 远端长任务: 远端 nohup + 日志文件 + 插件侧轮询增量 ----
      if (args.detach === true) {
        return await startDetached(targets[0], payload, args, exec)
      }

      // ---- 后台任务: 注册到 jobs, 立即返回 job_id ----
      if (args.run_in_background === true && targets.length === 1) {
        const id = targets[0]
        // 脚本模式的前置投递先在前台完成(秒级), 后台子进程只承载真正执行的末条命令
        const prepared = scriptMode
          ? await deliverScript(id, payload, args, exec)
          : { delivery: undefined, finalCommand: payload }
        const jobId = startBackgroundJob(id, payload, args, exec, prepared, { description, stripAnsi, scriptMode })
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
        let sessionInfo
        if (sessionMode) {
          // 伪会话: 包一层 cd/export + cwd 回传标记, 走脚本直送(零转义)
          const key = String(args.session_id)
          let state = args.session_reset === true ? undefined : SESSION_STATE.get(key)
          let expired = false
          if (state !== undefined && Date.now() - state.at > SESSION_IDLE_MS) {
            state = undefined
            expired = true
          }
          const built = buildSessionScript(payload, state, Array.isArray(args.env) ? args.env : undefined)
          const prepared = await deliverScript(id, built.script, args, exec)
          scriptPath = prepared.delivery.script_path
          r = await runRemote(id, prepared.finalCommand, args, exec)
          const one = execOne(r, id, { stripAnsi })
          const extracted = extractSessionCwd(one.output)
          const envKeys = Object.keys(built.env)
          SESSION_STATE.set(key, { cwd: extracted.cwd !== undefined && extracted.cwd.length > 0 ? extracted.cwd : (state !== undefined ? state.cwd : undefined), env: built.env, at: Date.now() })
          sessionInfo = {
            session_id: key,
            session_cwd: extracted.cwd !== undefined ? extracted.cwd : (state !== undefined ? state.cwd : undefined),
            session_expired: expired === true ? true : undefined,
            env_keys: envKeys.length > 0 ? envKeys : undefined,
            output: extracted.text,
          }
        } else if (scriptMode) {
          const prepared = await deliverScript(id, payload, args, exec)
          scriptPath = args.keep_script === true ? prepared.delivery.script_path : undefined
          r = await runRemote(id, prepared.finalCommand, args, exec)
        } else {
          r = await runRemote(id, payload, args, exec)
        }
        if (exec.signal.aborted) throw new Error('工具调用已被取消')
        const single = sessionInfo !== undefined
          ? Object.assign(execOne(r, id, { stripAnsi }), { output: sessionInfo.output })
          : execOne(r, id, { stripAnsi })
        return omitUndefined({
          kind: 'single',
          command: echo.command,
          command_line: commandLine(displayArgv),
          description,
          read_only: readOnly === true ? true : undefined,
          ...scriptMeta,
          ...(sessionInfo !== undefined
            ? { session_id: sessionInfo.session_id, session_cwd: sessionInfo.session_cwd, session_expired: sessionInfo.session_expired, env_keys: sessionInfo.env_keys }
            : {}),
          ...(scriptPath !== undefined && args.keep_script === true ? { script_path: scriptPath } : {}),
          ...single,
        })
      }

      // ---- 批量后台: 每台实例一个 job, 返回 job_id 数组 ----
      const concurrency = resolveConcurrency(args, targets.length)
      if (args.run_in_background === true) {
        // 脚本投递(秒级, 需要实例锁)先在前台按并发完成, 再各自注册后台 job
        const preparedList = await runWithConcurrency(targets, concurrency, async (id) => {
          try {
            return scriptMode
              ? await deliverScript(id, payload, args, exec)
              : { delivery: undefined, finalCommand: payload }
          } catch (err) {
            return { error: err && err.message !== undefined ? String(err.message) : String(err) }
          }
        })
        const items = []
        for (let i = 0; i < targets.length; i++) {
          const id = targets[i]
          const prepared = preparedList[i]
          if (prepared.error !== undefined) {
            items.push({ instance_id: id, is_error: true, error: prepared.error })
            continue
          }
          try {
            const jobId = startBackgroundJob(id, payload, args, exec, prepared, { description, stripAnsi, scriptMode })
            items.push({ instance_id: id, job_id: jobId, is_error: false })
          } catch (err) {
            items.push({
              instance_id: id,
              is_error: true,
              error: err && err.message !== undefined ? String(err.message) : String(err),
            })
          }
        }
        const jobIds = items.filter((it) => it.is_error !== true && it.job_id !== undefined).map((it) => it.job_id)
        return omitUndefined({
          kind: 'batch_background',
          command: echo.command,
          command_line: commandLine(displayArgv),
          description,
          read_only: readOnly === true ? true : undefined,
          ...scriptMeta,
          count: items.length,
          failed_count: items.filter((it) => it.is_error === true).length,
          concurrency,
          job_ids: jobIds,
          batch: items,
        })
      }

      // ---- 批量前台: 按并发度执行, 单台失败不中断(同实例仍由实例锁串行) ----
      const batch = await runWithConcurrency(targets, concurrency, async (id) => {
        try {
          let r
          if (scriptMode) {
            const prepared = await deliverScript(id, payload, args, exec)
            r = await runRemote(id, prepared.finalCommand, args, exec)
          } else {
            r = await runRemote(id, payload, args, exec)
          }
          if (exec.signal.aborted) throw new Error('工具调用已被取消')
          return { is_error: false, ...execOne(r, id, { stripAnsi }) }
        } catch (err) {
          return {
            is_error: true,
            instance_id: id,
            error: err && err.message !== undefined ? String(err.message) : String(err),
            exit_code: 0,
            output: '',
            stderr: '',
            stdout_truncated: false,
          }
        }
      })
      return omitUndefined({
        kind: 'batch',
        command: echo.command,
        command_line: commandLine(displayArgv),
        description,
        read_only: readOnly === true ? true : undefined,
        ...scriptMeta,
        count: batch.length,
        failed_count: batch.filter((b) => b.is_error === true).length,
        concurrency,
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
        const many = args.instance_ids !== undefined && args.instance_ids.length > 1
        return {
          card: 'generic',
          title: (many ? '批量后台执行(' + args.instance_ids.length + ' 台): ' : '后台执行: ') + short,
          kind: 'execute',
          rawInput: args.instance_id !== undefined ? args.instance_id : args.instance_ids,
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
      if (meta.kind === 'batch' || meta.kind === 'batch_background') return undefined
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
