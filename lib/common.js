// ============================================================================
// lib/common.js —— dsh-workbench-ecs 共享层
// ----------------------------------------------------------------------------
// 提供: workbench 可执行文件解析、子进程执行(含大输出 spill 与取消)、
//       CLI JSON 输出解析、破坏性命令守卫(接入 Harness approval)、渲染辅助。
// 说明: 本文件会被 scripts/to-body.mjs 捆绑进动态挂载 body, 因此
//       只允许 import @deepseek-ai/dsh-tools 之外的普通顶层声明。
// ============================================================================

// 插件版本号 (单源): /health 响应与发布包版本保持一致; 测试会校验
// test/ui-rpc.mjs 中 package.json.version === PLUGIN_VERSION。
export const PLUGIN_VERSION = '0.3.5'

// ----------------------------------------------------------------------------
// 破坏性命令模式: 命中即需要用户确认(ecs_exec / ecs_deploy 执行前守卫)。
// ----------------------------------------------------------------------------
export const DANGEROUS_PATTERNS = [
  { source: 'rm -rf / -fr', test: /(^|[;&|]\s*)rm\s+-[a-zA-Z]*(?:r[a-zA-Z]*f|f[a-zA-Z]*r)/ },
  { source: 'shutdown', test: /(^|[;&|]\s*|\b)(shutdown|poweroff|reboot|halt)\b/ },
  { source: 'mkfs', test: /\bmkfs(\.[a-z0-9]+)?\s/ },
  { source: 'dd', test: /\bdd\b\s+if=|\bdd\b\s+of=\/dev\// },
  { source: 'init 0/6', test: /\binit\s+[06]\b/ },
  { source: 'systemctl stop/disable/mask', test: /\bsystemctl\s+(stop|disable|mask)\b/ },
  { source: 'service stop', test: /\bservice\s+[a-z0-9_.-]+\s+stop\b/ },
  { source: 'iptables -F/-X', test: /\biptables\s+-[FX]\b/ },
  { source: 'userdel/groupdel', test: /\b(userdel|groupdel)\b/ },
]

// workbench 可执行文件的常见安装位置(Windows; Linux/macOS 一般都在 PATH 内)
export const WORKBENCH_CANDIDATES = [
  'C:\\Program Files\\workbench\\workbench.exe',
  'C:\\Program Files (x86)\\workbench\\workbench.exe',
]

// ----------------------------------------------------------------------------
// 解析 workbench 可执行文件路径: 先按 PATH, 失败回退常见安装位置;
// 全部失败时抛出带安装指引的提示。
// ----------------------------------------------------------------------------
export async function resolveWorkbenchCli(subprocess) {
  if (subprocess === undefined) {
    throw new Error('subprocess 服务不可用, 无法在本机执行 workbench 命令')
  }
  let exe
  try {
    exe = await subprocess.resolveExecutable('workbench')
  } catch (err) {
    exe = undefined
  }
  if (exe === undefined) {
    for (const candidate of WORKBENCH_CANDIDATES) {
      try {
        exe = await subprocess.resolveExecutable(candidate)
        break
      } catch (err2) {
        exe = undefined
      }
    }
  }
  if (exe === undefined) {
    throw new Error('workbench CLI 不可用: 已按 PATH 与常见安装位置 (' +
      WORKBENCH_CANDIDATES.join(', ') + ') 查找均未命中。' +
      '请确认已安装: irm https://workbench-cli.oss-cn-hangzhou.aliyuncs.com/install.ps1 | iex; ' +
      '若已安装, 请重启 Harness 会话使新增的 PATH 生效, 或把安装目录加入 PATH 后重试')
  }
  return exe
}

// ----------------------------------------------------------------------------
// 启动一条 workbench 子命令, 返回进程句柄(供前台等待与后台任务共用)。
// opts: { stdoutMaxBytes, stdoutSpillMaxBytes, stderrMaxBytes }
// ----------------------------------------------------------------------------
export function spawnWorkbench(ctx, argv, signal, opts = {}) {
  const subprocess = ctx.get('subprocess')
  const stdoutMaxBytes = opts.stdoutMaxBytes ?? 2 * 1024 * 1024
  const stdoutSpillMaxBytes = opts.stdoutSpillMaxBytes ?? 32 * 1024 * 1024
  const stderrMaxBytes = opts.stderrMaxBytes ?? 512 * 1024

  return new Promise((resolveSpawn, rejectSpawn) => {
    resolveWorkbenchCli(subprocess).then((exe) => {
      // 工作目录: 优先会话工作区根目录, 兜底进程当前目录
      const sandboxPolicy = ctx.get('sandboxPolicy')
      const cwd = (sandboxPolicy !== undefined && sandboxPolicy.workspaceRoot !== undefined && sandboxPolicy.workspaceRoot !== null)
        ? String(sandboxPolicy.workspaceRoot) : '.'

      // 显式 stdio: stdout 内存尾部 + 溢出落盘; stderr 仅内存尾部
      const handle = subprocess.spawn({
        argv: [exe, ...argv],
        cwd,
        stdio: {
          stdin: 'ignore',
          stdout: {
            maxBytes: stdoutMaxBytes,
            spill: { maxBytes: stdoutSpillMaxBytes },
          },
          stderr: { maxBytes: stderrMaxBytes },
        },
        graceMs: 5000,
        signal,
      })
      resolveSpawn(handle)
    }, rejectSpawn)
  })
}

// ----------------------------------------------------------------------------
// 前台执行一条 workbench 子命令, 等待退出并收集输出。
// 等价于 Node.js child_process.exec: 命令 + stdout/stderr + 退出码 + 取消。
// ----------------------------------------------------------------------------
export async function runWorkbench(ctx, argv, signal, opts = {}) {
  const handle = await spawnWorkbench(ctx, argv, signal, opts)
  const outcome = await handle.done
  const out = handle.collected.stdout !== undefined ? handle.collected.stdout.readFrom(0) : undefined
  const err = handle.collected.stderr !== undefined ? handle.collected.stderr.readFrom(0) : undefined
  return {
    exitCode: outcome.exitCode,
    signalName: outcome.signal,
    stdout: out !== undefined ? out.text : '',
    stdoutTruncated: out !== undefined ? out.lossy : false,
    stdoutSpillPath: out !== undefined ? out.spillPath : undefined,
    stderr: err !== undefined ? err.text : '',
    stderrTruncated: err !== undefined ? err.lossy : false,
  }
}

// 展示用的命令行
export function commandLine(argv) {
  return 'workbench ' + argv.join(' ')
}

// ----------------------------------------------------------------------------
// 解析 stdout JSON; 若命中 CLI 错误对象 { code, message } 则抛出可读错误。
// ----------------------------------------------------------------------------
export function parseJsonOrThrow(text, label) {
  let data
  try {
    data = JSON.parse(text)
  } catch (err) {
    throw new Error(label + ': 未能把 workbench 输出解析为 JSON: ' + text.slice(0, 500))
  }
  const cliError = asCliError(data)
  if (cliError !== undefined) {
    throw new Error(label + ': workbench CLI 错误 (code ' + cliError.code + '): ' + cliError.message)
  }
  return data
}

// 识别 { code: number, message: string } 结构的 CLI 错误对象
export function asCliError(data) {
  if (data !== null && typeof data === 'object' && !Array.isArray(data) &&
      typeof data.code === 'number' && typeof data.message === 'string') {
    return data
  }
  return undefined
}

// ----------------------------------------------------------------------------
// 统一解码一次 CLI 运行结果:
//   - stdout 有内容   -> 解析 JSON(命中 {code,message} 即抛出)
//   - stdout 为空     -> 回退解析 stderr 上的 CLI 错误 JSON, 再回落"无输出"错误
// ----------------------------------------------------------------------------
export function decodeCliOutput(r, label) {
  const outText = r.stdout.trim()
  const errText = r.stderr.trim()
  if (outText.length > 0) {
    return parseJsonOrThrow(outText, label)
  }
  const errData = asCliError(parseCliErrorJson(errText))
  if (errData !== undefined) {
    throw new Error(label + ': workbench CLI 错误 (code ' + errData.code + '): ' + errData.message)
  }
  throw new Error(label + ': workbench 无输出 (exit ' + r.exitCode + '): ' + errText.slice(0, 300))
}

// 尝试从一段文本解析 CLI 错误对象; 非 JSON 或结构不符返回 undefined
export function parseCliErrorJson(text) {
  if (text === undefined || text === null) return undefined
  const trimmed = String(text).trim()
  if (trimmed.length === 0) return undefined
  try {
    return JSON.parse(trimmed)
  } catch (err) {
    return undefined
  }
}

// ----------------------------------------------------------------------------
// 破坏性命令守卫: 命中 DANGEROUS_PATTERNS 时接入 Harness approval 服务,
// 未获 'allowed-once' (或无审批服务/agent/callId) 一律拒绝执行 (fail closed)。
// ----------------------------------------------------------------------------
export async function guardDestructiveCommand(ctx, exec, command) {
  // DANGEROUS_PATTERNS 的 test 字段是正则对象, 这里调用其 .test 方法
  const hit = DANGEROUS_PATTERNS.find((p) => p.test.test(command))
  if (hit === undefined) return
  const excerpt = command.slice(0, 300)
  const approval = ctx.get('approval')
  if (approval === undefined) {
    throw new Error('检测到破坏性命令模式 (' + hit.source + '), 且当前环境无审批服务, 已拒绝执行: ' + excerpt)
  }
  if (exec.agent === undefined || exec.callId === undefined) {
    throw new Error('检测到破坏性命令模式 (' + hit.source + '), 缺少审批上下文(agent/callId), 已拒绝执行: ' + excerpt)
  }
  let outcome
  try {
    outcome = await approval.request({
      agent: exec.agent,
      toolName: exec.name,
      callId: exec.callId,
      reason: '检测到破坏性命令模式 (' + hit.source + '); 命令: ' + excerpt + '; 请确认是否放行',
      signal: exec.signal,
    })
  } catch (err) {
    throw new Error('破坏性命令审批失败 (' + (err && err.message ? err.message : String(err)) + '), 已拒绝执行: ' + excerpt)
  }
  if (outcome !== 'allowed-once') {
    throw new Error('破坏性命令未获批准 (' + outcome + '), 已拒绝执行: ' + excerpt)
  }
}

// ----------------------------------------------------------------------------
// 宽容解码: 用于 upload/download/session 等可能输出文本而非 JSON 的命令。
// 返回 { json, text }: json 为解析成功的 CLI JSON(命中 {code,message} 即抛出),
// text 为原始文本输出。stdout 为空时回退 stderr。
// ----------------------------------------------------------------------------
export function decodeLoose(r, label) {
  const outText = r.stdout.trim()
  const errText = r.stderr.trim()
  if (outText.length > 0) {
    let parsed
    try {
      parsed = JSON.parse(outText)
    } catch (err) {
      parsed = undefined
    }
    if (parsed !== undefined) {
      const errData = asCliError(parsed)
      if (errData !== undefined) {
        throw new Error(label + ': workbench CLI 错误 (code ' + errData.code + '): ' + errData.message)
      }
      return { json: parsed, text: '' }
    }
    return { json: undefined, text: outText }
  }
  const errData = asCliError(parseCliErrorJson(errText))
  if (errData !== undefined) {
    throw new Error(label + ': workbench CLI 错误 (code ' + errData.code + '): ' + errData.message)
  }
  if (errText.length > 0) return { json: undefined, text: errText }
  return { json: undefined, text: '' }
}

// ----------------------------------------------------------------------------
// 渲染辅助: 把 stdout/stderr/退出码拼成模型可见文本
// ----------------------------------------------------------------------------
export function renderRunText(r, { title = '', spillLabel = '输出过长' } = {}) {
  const parts = []
  if (title.length > 0) parts.push(title)
  if (r.output !== undefined && r.output.length > 0) parts.push(r.output.replace(/\n$/, ''))
  if (r.stderr !== undefined && r.stderr.length > 0) {
    if ((r.output !== undefined && r.output.length > 0)) parts.push('')
    parts.push('[stderr]')
    parts.push(String(r.stderr).replace(/\n$/, ''))
  }
  if ((r.output === undefined || r.output.length === 0) && (r.stderr === undefined || r.stderr.length === 0)) {
    parts.push('(无输出)')
  }
  if (r.exit_code !== undefined) parts.push('[exit code: ' + r.exit_code + ']')
  if (r.stdout_truncated === true) {
    parts.push('[' + spillLabel + ', 已截断' + (r.stdout_spill_path ? '; 完整输出: ' + r.stdout_spill_path : '') + ']')
  }
  return parts.join('\n')
}
