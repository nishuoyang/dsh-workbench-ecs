// ============================================================================
// lib/common.js —— dsh-workbench-ecs 共享层
// ----------------------------------------------------------------------------
// 提供: workbench 可执行文件解析、子进程执行(含大输出 spill 与取消)、
//       CLI JSON 输出解析、破坏性命令守卫(接入 Harness approval)、只读护栏、
//       base64/ANSI/sha256 等与执行通道无关的工具函数、按实例串行化。
// 说明: 本文件会被 scripts/to-body.mjs 捆绑进动态挂载 body, 因此
//       只允许 import @deepseek-ai/dsh-tools 之外的普通顶层声明
//       (该脚本会剥掉所有 import 语句) —— 故此处不依赖 node:crypto /
//       node:fs, 也不使用 Buffer: base64 与 sha256 相关能力都自带实现或
//       经由 subprocess 调用平台工具。
// ============================================================================

// 插件版本号 (单源): /health 响应与发布包版本保持一致; 测试会校验
// test/ui-rpc.mjs 中 package.json.version === PLUGIN_VERSION。
export const PLUGIN_VERSION = '0.9.0'

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

// ----------------------------------------------------------------------------
// 写操作模式: read_only 护栏用(防呆 —— 不是权限边界, 动态拼接仍可绕过;
// 真正的强约束仍走 DestructiveCommand 审批)。
// 设计取舍:
//   - `2>/dev/null` 与 `2>&1` 是只读诊断的常见写法, 必须放行
//     (诊断预置脚本里大量出现, 否则 ecs_diagnose 会自我误杀);
//   - 命令词用 (?<![.\w\/-]) 定位"命令位置", 使 `sudo rm -rf`(/bin/rm 除外)
//     这类前缀写法同样命中;
//   - 宁可少量误杀(调用方显式 read_only:false 即可), 也不放过写入。
// ----------------------------------------------------------------------------
export const WRITE_PATTERNS = [
  // 输出重定向到文件/管道目标(排除 2>/dev/null 与 fd 复制)
  { source: '输出重定向(非 /dev/null)', test: /(^|[^0-9&>])>>?\s*(?!&)(?!\/dev\/null(\s|$|;|\)|\||&))/ },
  { source: '文件增删改(rm/mv/cp/mkdir/rmdir/touch/ln/install/truncate)', test: /(?<![.\w\/-])(rm|mv|cp|mkdir|rmdir|touch|ln|install|truncate)\b/ },
  { source: '权限/属主变更(chmod/chown/chgrp/chattr)', test: /(?<![.\w\/-])(chmod|chown|chgrp|chattr)\b/ },
  { source: 'tee', test: /(?<![.\w\/-])tee\b/ },
  { source: 'sed 就地修改(-i/--in-place)', test: /\bsed\b[^;&|]*(-[a-zA-Z]*i[a-zA-Z]*\b|--in-place)/ },
  { source: '磁盘写(dd/mkfs/mkswap/mount/umount/swapoff)', test: /(?<![.\w\/-])(dd|mkswap|mount|umount|swapoff)\b|\bmkfs(\.[a-z0-9]+)?\s/ },
  { source: '服务状态变更(systemctl/service)', test: /\b(systemctl|service)\s+[^;&|]*\b(start|stop|restart|reload|enable|disable|mask|unmask|daemon-reload)\b/ },
  { source: '容器/镜像变更(docker)', test: /\bdocker\s+(run|create|start|stop|restart|kill|rm|rmi|build|push|pull|exec|cp|commit|tag|load|import|prune|pause|unpause|update)\b/ },
  { source: 'docker compose 变更', test: /\bdocker\s+compose\s+(up|down|restart|build|rm|kill|pull|push|create|start|stop)\b/ },
  { source: '包管理安装/卸载', test: /(?<![.\w\/-])(apt|apt-get|yum|dnf|apk|zypper)\s+[^;&|]*\b(install|remove|purge|upgrade|update|dist-upgrade)\b/ },
  { source: '语言包管理器写操作', test: /(?<![.\w\/-])(npm|pnpm|yarn|pip|pip3|gem|go|cargo)\s+[^;&|]*\b(install|add|ci|uninstall|remove|upgrade|update)\b/ },
  { source: 'git 写操作', test: /\bgit\s+[^;&|]*\b(pull|push|fetch|checkout|reset|clean|commit|merge|rebase|stash|apply|init|clone|tag\s+-d|branch\s+-D|remote\s+(add|set-url))\b/ },
  { source: '进程信号(kill/pkill/killall)', test: /(?<![.\w\/-])(kill|pkill|killall)\b/ },
  { source: '下载落盘(curl -o / wget -O)', test: /\b(curl|wget)\b[^;&|]*(\s-o\s|\s--output\s|\s-O\b|\s--output-document\s)/ },
  { source: '后台启动(nohup / & 后台任务)', test: /(?<![.\w\/-])nohup\b|(^|[;&|]\s*)[^;&|]*&\s*$/ },
  { source: '计划任务/用户/内核参数(crontab/useradd/usermod/passwd/sysctl -w)', test: /(?<![.\w\/-])(crontab|useradd|usermod|groupadd|passwd)\b|\bsysctl\s+-w\b/ },
  { source: 'find 写动作(-delete/-exec)', test: /\bfind\b[^;&|]*\s(-delete|-exec|-execdir|-ok)\b/ },
]

// ----------------------------------------------------------------------------
// 只读护栏的"下一步怎么办"提示(G1, v0.7.0): 反馈里最有用的一句不是规则本身,
// 而是"命中之后该怎么改写"。护栏是防呆不是权限边界, 所以给出可执行的替代写法。
// ----------------------------------------------------------------------------
export const READ_ONLY_ADVICE = [
  '不需要落盘的: 直接把结果写到 stdout(echo/printf, 不要 > 文件), 护栏放行;',
  '确实需要写入: 显式传 read_only=false(写操作必须显式声明, 不会静默放行);',
  '长任务/大输出: 用 detach=true 在远端 nohup 启动 + ecs_log 按字节游标读日志(不占本地缓冲);',
  '若是误伤(命令本身只读): 同样用 read_only=false, 并把该写法反馈给插件维护者以收紧规则。',
]

// 单条命中截断长度: 护栏信息要能一眼看完, 不能把整条命令糊上去
const WRITE_HIT_TEXT_LIMIT = 80
// 同一规则最多列出几处命中(再多的价值递减, 还会把信息淹掉)
const WRITE_HIT_PER_RULE_LIMIT = 3

// 把一条模式在文本里的**所有**命中收集出来(规则内的正则无 g 标志, 这里补上)
function collectRuleMatches(pattern, cmd) {
  const source = pattern.test.source
  const flags = pattern.test.flags.includes('g') ? pattern.test.flags : pattern.test.flags + 'g'
  let re
  try {
    re = new RegExp(source, flags)
  } catch (err) {
    re = pattern.test
  }
  const matches = []
  let match = re.exec(cmd)
  let guard = 0
  while (match !== null && guard < 64) {
    matches.push(match)
    guard += 1
    if (match[0].length === 0) re.lastIndex += 1
    match = re.exec(cmd)
  }
  return matches
}

// 把一次 RegExp 命中整理成结构化描述(前导分隔符不计入命中文本, 位置随之右移)
function describeMatch(rule, cmd, match, occurrences) {
  const raw = match[0]
  const trimmed = raw.trim()
  const offset = match.index + (raw.length - raw.replace(/^[\s;&|]+/, '').length)
  const shown = trimmed.length > WRITE_HIT_TEXT_LIMIT ? trimmed.slice(0, WRITE_HIT_TEXT_LIMIT) + '…' : trimmed
  return {
    rule,
    matched_text: shown.length > 0 ? shown : raw,
    span: { start: offset, end: match.index + raw.length },
    occurrences: occurrences !== undefined ? occurrences : 1,
  }
}

// ----------------------------------------------------------------------------
// 写操作全量扫描(G1, v0.7.0): 此前只报"第一条命中的规则", 于是反馈里一个脚本
// 同时含 mkdir / > / cp / curl -o 时只能看到其中一条, 排障全靠猜。
// 现在**逐规则**给出命中: {rule, matched_text, span, occurrences}, 同一规则最多列
// WRITE_HIT_PER_RULE_LIMIT 处(其余用 occurrences 计数表达)。
// 注意: 模式对象自带 source(标签) 与 test(正则)。
// ----------------------------------------------------------------------------
export function scanWriteCommands(text) {
  const cmd = text != null ? String(text) : ''
  const hits = []
  for (const pattern of WRITE_PATTERNS) {
    const matches = collectRuleMatches(pattern, cmd)
    for (let i = 0; i < Math.min(matches.length, WRITE_HIT_PER_RULE_LIMIT); i++) {
      hits.push(describeMatch(pattern.source, cmd, matches[i], matches.length))
    }
  }
  return hits
}

// 破坏性命令全量扫描(与 scanWriteCommands 同形): 拒绝信息里同样要能看见命中文本
export function scanDangerousCommands(text) {
  const cmd = text != null ? String(text) : ''
  const hits = []
  for (const pattern of DANGEROUS_PATTERNS) {
    const matches = collectRuleMatches(pattern, cmd)
    for (let i = 0; i < Math.min(matches.length, WRITE_HIT_PER_RULE_LIMIT); i++) {
      hits.push(describeMatch(pattern.source, cmd, matches[i], matches.length))
    }
  }
  return hits
}

// 逐条渲染命中(用于拒绝信息): 规则名 + 命中文本 + 位置(+ 同一规则的其它命中处数)
export function renderCommandHits(hits, indent = '  ') {
  return hits.map((hit, index) => indent + '[' + (index + 1) + '] ' + hit.rule +
    ' → 命中 ' + JSON.stringify(hit.matched_text) + ' (位置 ' + hit.span.start + ')' +
    (hit.occurrences !== undefined && hit.occurrences > 1 ? '(该规则共 ' + hit.occurrences + ' 处)' : '')).join('\n')
}

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
// 会话工作区(D11, v0.6.4): 工具调用期间"当前工作目录"的**唯一正确来源**是会话
// 自身的 cwd —— 与 DSH 内置工具同源:
//   dsh-tool-bash:  exec.agent?.session.header.cwd
//   dsh-tool-fs:    sessionResolveOptions() → fs.resolve(path, { cwd })
//   sandboxPolicy:  resolve({ session }).workspaceRoot === session.header.cwd(回落部署兜底)
// 此前插件读的是 `sandboxPolicy.workspaceRoot` 这个**部署兜底值**(默认 process.cwd()),
// 于是 runbook 会去 $HOME/.dsh/... 找、CLI 子进程也在 $HOME 下启动 —— 相对路径
// (如 ecs_upload 的 local_file)与 runbook 目录都会指错地方。
// ----------------------------------------------------------------------------
export function sessionOf(exec) {
  if (exec === undefined || exec === null) return undefined
  const agent = exec.agent
  if (agent === undefined || agent === null) return undefined
  const session = agent.session
  return session === undefined || session === null ? undefined : session
}

// 按"会话 cwd → 部署兜底"的顺序解析工作区根目录;都拿不到时返回 undefined。
export function resolveWorkspaceRoot(ctx, exec) {
  const session = sessionOf(exec)
  const policy = ctx !== undefined && typeof ctx.get === 'function' ? ctx.get('sandboxPolicy') : undefined
  if (policy !== undefined && policy !== null && typeof policy.resolve === 'function') {
    try {
      const resolved = policy.resolve(session !== undefined ? { session } : {})
      if (resolved !== null && typeof resolved === 'object' &&
          typeof resolved.workspaceRoot === 'string' && resolved.workspaceRoot.length > 0) {
        return resolved.workspaceRoot
      }
    } catch (err) {
      /* resolve 不可用时回落下面的来源 */
    }
  }
  if (session !== undefined && session.header !== undefined &&
      typeof session.header.cwd === 'string' && session.header.cwd.length > 0) {
    return session.header.cwd
  }
  if (policy !== undefined && policy !== null &&
      policy.workspaceRoot !== undefined && policy.workspaceRoot !== null) {
    return String(policy.workspaceRoot)
  }
  return undefined
}

// ----------------------------------------------------------------------------
// 启动一条本机子进程(显式 stdio: stdout 内存尾部 + 溢出落盘; stderr 仅内存尾部)。
// argv[0] 即程序本身, 不做 shell 解释, 不套本地 shell。
// opts: { stdoutMaxBytes, stdoutSpillMaxBytes, stderrMaxBytes, stdin, cwd, exec }
//   cwd  显式工作目录(最高优先);
//   exec 工具执行上下文 —— 未给 cwd 时由其会话推导(D11), 再回落部署兜底/'.'
// ----------------------------------------------------------------------------
export function spawnProcess(ctx, argv, signal, opts = {}) {
  const subprocess = ctx.get('subprocess')
  if (subprocess === undefined) {
    return Promise.reject(new Error('subprocess 服务不可用, 无法在本机执行命令'))
  }
  const stdoutMaxBytes = opts.stdoutMaxBytes ?? 2 * 1024 * 1024
  const stdoutSpillMaxBytes = opts.stdoutSpillMaxBytes ?? 32 * 1024 * 1024
  const stderrMaxBytes = opts.stderrMaxBytes ?? 512 * 1024

  // 工作目录: 调用方显式指定 > 会话工作区(与 DSH 内置工具同源) > 部署兜底 > 进程当前目录
  const derived = opts.cwd !== undefined && opts.cwd !== null && String(opts.cwd).length > 0
    ? String(opts.cwd) : resolveWorkspaceRoot(ctx, opts.exec)
  const cwd = derived !== undefined ? derived : '.'

  try {
    return Promise.resolve(subprocess.spawn({
      argv: argv.map((a) => String(a)),
      cwd,
      stdio: {
        stdin: opts.stdin !== undefined ? opts.stdin : 'ignore',
        stdout: {
          maxBytes: stdoutMaxBytes,
          spill: { maxBytes: stdoutSpillMaxBytes },
        },
        stderr: { maxBytes: stderrMaxBytes },
      },
      graceMs: 5000,
      signal,
    }))
  } catch (err) {
    return Promise.reject(err)
  }
}

// ----------------------------------------------------------------------------
// 启动一条 workbench 子命令, 返回进程句柄(供前台等待与后台任务共用)。
// ----------------------------------------------------------------------------
export function spawnWorkbench(ctx, argv, signal, opts = {}) {
  return new Promise((resolveSpawn, rejectSpawn) => {
    resolveWorkbenchCli(ctx.get('subprocess')).then(
      (exe) => resolveSpawn(spawnProcess(ctx, [exe, ...argv], signal, opts)),
      rejectSpawn,
    )
  })
}

// ----------------------------------------------------------------------------
// 收集一条已完成子进程的输出(offset 0 = 本次运行的全部保留输出)。
// ----------------------------------------------------------------------------
function collectRun(handle, outcome) {
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

// ----------------------------------------------------------------------------
// 前台执行一条本机程序, 等待退出并收集输出。
// ----------------------------------------------------------------------------
export async function runProcess(ctx, argv, signal, opts = {}) {
  const handle = await spawnProcess(ctx, argv, signal, opts)
  const outcome = await handle.done
  return collectRun(handle, outcome)
}

// ----------------------------------------------------------------------------
// 前台执行一条 workbench 子命令, 等待退出并收集输出。
// 等价于 Node.js child_process.exec: 命令 + stdout/stderr + 退出码 + 取消。
// ----------------------------------------------------------------------------
export async function runWorkbench(ctx, argv, signal, opts = {}) {
  const exe = await resolveWorkbenchCli(ctx.get('subprocess'))
  return runProcess(ctx, [exe, ...argv], signal, opts)
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

// ----------------------------------------------------------------------------
// 宽容解码 + 失败识别: 专供 workbench upload/download 这类"CLI 输出人类可读文本"
// 的命令。两个坑(实测):
//   1. 成功时 stdout 是 "Upload complete: ...", 进度帧(spinner/百分比)在 stderr;
//   2. **失败时 stdout 仍会有 "Upload complete" 行**(先打印后校验), 真正的错误是
//      stderr 上的 {"code":1,"message":"remote file \"/tmp/x\" already exists ..."} ——
//      只看 stdout 会把失败读成成功(exit_code 1 但 message 写着"完成")。
// 因此这里同时看退出码与 stderr 的 CLI 错误对象, 并把两者合成一段 failure_text
// 供重试判定与报错使用。
// ----------------------------------------------------------------------------
export function looseOutcomeOf(r, label) {
  const exitCode = r !== undefined && r !== null && r.exitCode !== undefined && r.exitCode !== null ? r.exitCode : 0
  const stderrText = r !== undefined && r !== null && r.stderr !== undefined && r.stderr !== null ? String(r.stderr) : ''
  const stdoutText = r !== undefined && r !== null && r.stdout !== undefined && r.stdout !== null ? String(r.stdout) : ''
  const cliError = asCliError(parseCliErrorJson(stderrText))
  let message = ''
  try {
    const decoded = decodeLoose(r, label !== undefined ? label : 'workbench')
    message = decoded.text.length > 0 ? decoded.text : (decoded.json !== undefined ? JSON.stringify(decoded.json) : '')
  } catch (err) {
    // stdout 为空且 stderr 是 CLI 错误时 decodeLoose 会抛 —— 这里不抛, 统一走下面的合成
    message = err && err.message !== undefined ? String(err.message) : ''
  }
  const cleaned = cleanOutput(message, true)
  const failureText = [
    cliError !== undefined ? cliError.message : '',
    cleanOutput(stderrText, true),
    cleaned,
  ].filter((part) => String(part).trim().length > 0).join('\n')
  return {
    exit_code: exitCode,
    ok: exitCode === 0 && cliError === undefined,
    message: cleaned,
    error_message: cliError !== undefined ? cliError.message : undefined,
    failure_text: failureText,
    stdout_truncated: r !== undefined && r !== null && r.stdoutTruncated === true,
    stdout_spill_path: r !== undefined && r !== null ? r.stdoutSpillPath : undefined,
    stdout: cleanOutput(stdoutText, true),
  }
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
// 远端结果归一(D14, v0.7.0) —— 本轮核对发现的真缺陷:
// CLI 在远端命令超时时的 JSON 是 { exit_code: 0, timed_out: true, duration: "3.002s" },
// 而 CLI 进程自身的退出码是 124, 真正的失败原因只出现在 stderr 的
// {"code":124,"message":"command timed out after 3s"} 里。
// 插件此前一律"以 JSON 的 exit_code 为准", 于是**被掐断的命令在编排里显示为成功 + 无输出**。
// 这里把"远端结果"的读取收敛成唯一入口: timed_out 优先, 其余字段按 JSON → 进程退出码回退。
// ----------------------------------------------------------------------------
export const REMOTE_TIMEOUT_EXIT_CODE = 124

export function remoteResultOf(data, run) {
  const obj = data !== null && typeof data === 'object' && !Array.isArray(data) ? data : {}
  const r = run !== undefined && run !== null ? run : {}
  const processExit = r.exitCode !== undefined && r.exitCode !== null ? r.exitCode : undefined
  const jsonExit = typeof obj.exit_code === 'number' ? obj.exit_code : undefined
  // 超时判定: JSON 显式 timed_out, 或"CLI 进程 124 但 JSON 说 0"(CLI 自己在本地掐断)
  const timedOut = obj.timed_out === true || (processExit === REMOTE_TIMEOUT_EXIT_CODE && jsonExit === 0)
  let exitCode
  if (timedOut) exitCode = REMOTE_TIMEOUT_EXIT_CODE
  else if (jsonExit !== undefined) exitCode = jsonExit
  else if (processExit !== undefined) exitCode = processExit
  else exitCode = 0
  const stderrText = r.stderr !== undefined && r.stderr !== null ? String(r.stderr) : ''
  const cliError = asCliError(parseCliErrorJson(stderrText))
  const jsonStderr = obj.stderr !== undefined && obj.stderr !== null ? String(obj.stderr) : ''
  return {
    exit_code: exitCode,
    timed_out: timedOut === true ? true : undefined,
    duration: obj.duration !== undefined && obj.duration !== null ? String(obj.duration) : undefined,
    output: obj.output !== undefined && obj.output !== null
      ? String(obj.output)
      : (obj.stdout !== undefined && obj.stdout !== null ? String(obj.stdout) : ''),
    stderr: jsonStderr.length > 0 ? jsonStderr : stderrText,
    request_id: obj.request_id !== undefined && obj.request_id !== null ? String(obj.request_id) : undefined,
    cli_session_id: obj.session_id !== undefined && obj.session_id !== null ? String(obj.session_id) : undefined,
    timeout_message: timedOut === true && cliError !== undefined ? cliError.message : undefined,
  }
}

// 超时后的"下一步"提示(反馈 §四.13): 只说"超时了"没有用, 要给出可执行的替代路径。
// detachSupported=false 的场景(steps 引擎的 upload/解包等固定命令)指向 ecs_exec detach。
export function timeoutAdvice(opts = {}) {
  const seconds = opts.timeout !== undefined && opts.timeout !== null ? String(opts.timeout) : undefined
  const label = (opts.label !== undefined && opts.label !== null && String(opts.label).length > 0)
    ? String(opts.label) + ': ' : ''
  const lines = []
  lines.push(label + '远端命令被 CLI 在超时' + (seconds !== undefined ? '(' + seconds + 's)' : '') + '处掐断' +
    (opts.duration !== undefined ? '(实跑 ' + opts.duration + ')' : '') + ' —— 不是命令写错, 而是它比 timeout 更久。')
  if (opts.detachSupported !== false) {
    lines.push('  下一步: (a) 改用 detach=true: 远端 nohup 启动 + 写日志文件, 立即返回 job_id, ' +
      '再用 ecs_log 按字节游标读 <log_path>(远端任务不受本地超时影响);')
    lines.push('          (b) 或把 timeout 显式调大(远端单步上限 3600s)。')
  } else {
    lines.push('  下一步: (a) 把该动作拆成一次 ecs_exec { detach: true } 在远端后台执行, 再用 ecs_log 续读;')
    lines.push('          (b) 或把 timeout 显式调大(远端单步上限 3600s)。')
  }
  return lines.join('\n')
}

// ----------------------------------------------------------------------------
// 上传重试(R1, v0.7.0; 反馈 §四.11 真实踩到): 一次 OSS 中继的瞬时抖动
// (dial tcp ... i/o timeout)会把整条发布跑书废掉。这里只对**瞬时网络类**失败重试:
// 语义类失败(远端已存在 / 无权限 / 参数错)立刻失败, 否则会把重试次数白白烧在必然失败的路径上。
// ----------------------------------------------------------------------------
export const UPLOAD_RETRY_DEFAULTS = { retries: 2, baseDelayMs: 1000, maxDelayMs: 8000 }

// 瞬时网络特征(命中即值得重试)
const TRANSIENT_FAILURE_PATTERNS = [
  /i\/o timeout/i,
  /\bdial tcp\b/i,
  /\bconnection (reset|refused|closed|aborted)\b/i,
  /\bTLS handshake\b/i,
  /operation error/i,
  /context deadline exceeded/i,
  /\bEOF\b/,
  /network is unreachable/i,
  /temporary failure in name resolution/i,
  /broken pipe/i,
  /\btimed? ?out\b/i,
]

// 明确的语义类失败(命中即不重试, 即使同时含瞬时特征)
const NON_RETRYABLE_PATTERNS = [
  /already exists/i,
  /use --force to overwrite/i,
  /permission denied/i,
  /no such file or directory/i,
  /not a directory/i,
  /invalid (region|instance|argument|parameter)/i,
  /does not exist or is not recognized/i,
  /unsupported/i,
]

// 判定一段失败文本是否值得重试
export function classifyTransientFailure(text) {
  const t = String(text != null ? text : '')
  if (t.length === 0) return false
  if (NON_RETRYABLE_PATTERNS.some((re) => re.test(t))) return false
  return TRANSIENT_FAILURE_PATTERNS.some((re) => re.test(t))
}

// 失败归属提示(反馈 §四.11): upload/download 固定走 OSS 中继, 网络类失败发生在
// "本机 → OSS"这一段, 与目标实例无关 —— 不说清楚的话排查方向会先跑到 ECS 上去。
export function uploadFailureAdvice(text, attempts) {
  const lines = []
  if (attempts !== undefined && attempts > 1) lines.push('  已尝试 ' + attempts + ' 次仍失败。')
  const transient = classifyTransientFailure(text)
  if (transient) {
    lines.push('  归属: 这是**本机 → 阿里云 OSS 中继**这一段的网络问题(upload/download 必走 OSS 中转),' +
      '不是目标 ECS 实例的问题; 实例本身可能完全正常。')
    lines.push('  下一步: 稍后重跑同一条命令/跑书即可(upload 是幂等的); 或先确认本机网络与 OSS 域名的连通性。')
  }
  return lines.length > 0 ? lines.join('\n') : undefined
}

// 解析重试参数: retries = 首次之外的重试次数(默认 2 → 最多 3 次尝试), retry_delay 单位秒。
export function resolveRetryOptions(args, defaults = UPLOAD_RETRY_DEFAULTS) {
  const rawSource = args !== undefined && args !== null ? args : {}
  const retriesRaw = Number(rawSource.retries)
  const retries = Number.isFinite(retriesRaw) && retriesRaw >= 0
    ? Math.min(Math.floor(retriesRaw), 8)
    : defaults.retries
  const delayRaw = Number(rawSource.retry_delay)
  const baseDelayMs = Number.isFinite(delayRaw) && delayRaw >= 0
    ? Math.min(Math.floor(delayRaw * 1000), 60000)
    : defaults.baseDelayMs
  return { retries, attempts: retries + 1, baseDelayMs, maxDelayMs: defaults.maxDelayMs }
}

// 带重试地执行 attempt(attemptIndex): 返回
//   { ok: true, value }   -> 成功
//   { ok: false, failureText } -> 失败(由 classifyTransientFailure 判定是否重试)
// 结果: { ok, value, attempts, failures: [{attempt, transient, message}] }
// 取消(exec.signal.aborted)优先于重试: 立即停止, 不再等退避。
export async function withRetry(ctx, opts, attempt) {
  const attempts = Math.max(1, Number(opts.attempts) || 1)
  const baseDelayMs = Number.isFinite(Number(opts.baseDelayMs)) ? Math.max(0, Number(opts.baseDelayMs)) : 0
  const maxDelayMs = Number.isFinite(Number(opts.maxDelayMs)) ? Math.max(0, Number(opts.maxDelayMs)) : baseDelayMs
  const signal = opts.signal
  const failures = []
  let last
  for (let index = 1; index <= attempts; index++) {
    if (signal !== undefined && signal !== null && signal.aborted === true) throw new Error('工具调用已被取消')
    last = await attempt(index)
    if (last !== null && typeof last === 'object' && last.ok === true) {
      return { ok: true, value: last.value, attempts: index, failures }
    }
    const failureText = last !== null && typeof last === 'object' && last.failureText !== undefined
      ? String(last.failureText) : ''
    const transient = classifyTransientFailure(failureText)
    failures.push({
      attempt: index,
      transient: transient === true,
      message: failureText.replace(/\s+/g, ' ').trim().slice(0, 240),
    })
    if (transient !== true || index >= attempts) {
      return { ok: false, value: last !== undefined ? last.value : undefined, attempts: index, failures }
    }
    if (baseDelayMs > 0) await delay(ctx, Math.min(baseDelayMs * Math.pow(2, index - 1), maxDelayMs))
  }
  return { ok: false, value: last !== undefined ? last.value : undefined, attempts, failures }
}

// ----------------------------------------------------------------------------
// 破坏性命令守卫: 命中 DANGEROUS_PATTERNS 时接入 Harness approval 服务,
// 未获 'allowed-once' (或无审批服务/agent/callId) 一律拒绝执行 (fail closed)。
// v0.7.0(G2, 反馈 §三.5): 四种"没获批"的情形必须分开说清楚 —— 尤其
// "审批策略为 never(本会话已禁用审批)"与"用户点了拒绝"此前撞成同一句话,
// 模型会误判为"命令写错了"而反复重试, 白烧几轮。
//   - 审批策略 never: 直接拒绝, 不发起请求(请求必然被服务端判为 rejected);
//   - 无审批服务 / 无 agent·callId 上下文: fail closed;
//   - 用户拒绝 / 请求被取消 / 无应答者(unavailable): 各自的下一步不同。
// ----------------------------------------------------------------------------
const DESTRUCTIVE_ADVICE = '这不是命令语法错误, 重试同一条命令不会有不同结果。'

function approvalPolicyOf(approval, exec) {
  if (approval === undefined || approval === null) return undefined
  if (typeof approval.effectivePolicy !== 'function') return undefined
  const agent = exec !== undefined && exec !== null ? exec.agent : undefined
  const session = agent !== undefined && agent !== null ? agent.session : undefined
  if (session === undefined) return undefined
  try {
    const policy = approval.effectivePolicy(session)
    return policy !== undefined && policy !== null ? String(policy) : undefined
  } catch (err) {
    return undefined
  }
}

export async function guardDestructiveCommand(ctx, exec, command, label) {
  const hits = scanDangerousCommands(command)
  if (hits.length === 0) return
  const prefix = (label !== undefined && label !== null && String(label).length > 0 ? String(label) + ': ' : '')
  const hitLines = renderCommandHits(hits)
  const excerpt = command.slice(0, 300)
  const detail = prefix + '检测到破坏性命令模式, 已拒绝执行\n' + hitLines + '\n  命令: ' + excerpt
  const approval = ctx.get('approval')
  if (approval === undefined) {
    throw new Error(detail + '\n  原因: 当前环境未挂载审批服务(approval), 破坏性命令一律拒绝。' + DESTRUCTIVE_ADVICE)
  }
  if (exec.agent === undefined || exec.callId === undefined) {
    throw new Error(detail + '\n  原因: 缺少审批上下文(agent/callId), 无法请求用户确认, 破坏性命令一律拒绝。' +
      DESTRUCTIVE_ADVICE + '(该上下文常见于设置面板等无会话入口)')
  }
  const policy = approvalPolicyOf(approval, exec)
  if (policy === 'never') {
    throw new Error(detail + '\n  原因: 本会话审批策略为 never(审批已禁用) —— 破坏性命令一律直接拒绝, ' +
      '未发起任何审批请求。' + DESTRUCTIVE_ADVICE +
      '\n  下一步: (a) 请用户把审批策略切回 ask 后重试; 或 (b) 改写成不需要审批的等价做法' +
      '(例如先备份并只删除具体路径, 而不是 rm -rf 整个目录)。')
  }
  let outcome
  try {
    outcome = await approval.request({
      agent: exec.agent,
      toolName: exec.name,
      callId: exec.callId,
      reason: '检测到破坏性命令模式 (' + hits.map((h) => h.rule).join('; ') + '); 命令: ' + excerpt + '; 请确认是否放行',
      signal: exec.signal,
    })
  } catch (err) {
    throw new Error(detail + '\n  原因: 审批请求本身失败 (' + (err && err.message ? err.message : String(err)) +
      '), 按 fail-closed 拒绝执行。' + DESTRUCTIVE_ADVICE)
  }
  if (outcome === 'allowed-once') return
  if (outcome === 'rejected') {
    throw new Error(detail + '\n  原因: 用户在审批中拒绝了该命令' +
      (policy !== undefined ? '(审批策略: ' + policy + ')' : '') + '。' + DESTRUCTIVE_ADVICE +
      '\n  下一步: 不要原样重试 —— 改成用户能接受的更小动作, 或让用户重新审批。')
  }
  if (outcome === 'cancelled') {
    throw new Error(detail + '\n  原因: 审批请求被取消(工具调用已取消或用户撤回)。' + DESTRUCTIVE_ADVICE)
  }
  throw new Error(detail + '\n  原因: 无审批应答者(approval 服务判定 ' + String(outcome) +
    ', 例如无人应答的执行环境), 按 fail-closed 拒绝执行。' + DESTRUCTIVE_ADVICE +
    '\n  下一步: 在可交互会话里执行, 或改写成不需要审批的等价做法。')
}

// ----------------------------------------------------------------------------
// 只读护栏: 命中 WRITE_PATTERNS 的写操作返回来源说明(供测试/面板复用)。
// 兼容壳: 只返回**第一条**命中的规则名; 需要全部命中请用 scanWriteCommands。
// ----------------------------------------------------------------------------
export function checkWriteCommand(text) {
  const hits = scanWriteCommands(text)
  return hits.length > 0 ? hits[0].rule : undefined
}

// 只读护栏(防呆): read_only=true 时拒绝写操作; 直接拒绝, 不走审批。
// v0.7.0(G1, 反馈 §三.4/§三.6): 逐条列出命中的规则/文本/位置, 并给出只读等价写法 ——
// 把护栏从"碰运气"变成"可调试"。
export function guardReadOnly(text, label) {
  const hits = scanWriteCommands(text)
  if (hits.length === 0) return
  const source = text != null ? String(text) : ''
  const excerpt = source.length > 300 ? source.slice(0, 300) + '…' : source
  throw new Error((label !== undefined ? label + ': ' : '') +
    'read_only=true 下检测到 ' + hits.length + ' 条写操作模式, 已拒绝执行:\n' +
    renderCommandHits(hits) + '\n  命令: ' + excerpt + '\n' +
    '  只读等价写法建议:\n' + READ_ONLY_ADVICE.map((line) => '    - ' + line).join('\n'))
}

// 结构化形式的护栏判定(供面板/单测按需渲染, 不抛错)
export function inspectReadOnly(text) {
  const hits = scanWriteCommands(text)
  return { ok: hits.length === 0, hits, advice: hits.length > 0 ? READ_ONLY_ADVICE.slice() : [] }
}

// ----------------------------------------------------------------------------
// 超时解析: 工具声明的默认值必须显式下发给 CLI —— CLI 的 --timeout 默认为
// 30 秒, 仅在用户传参时才下发会让"默认 120/180"的说明与实际行为不一致。
// ----------------------------------------------------------------------------
export function resolveTimeout(explicit, fallback) {
  if (typeof explicit === 'number' && Number.isFinite(explicit) && explicit > 0) return Math.floor(explicit)
  return fallback
}

// ----------------------------------------------------------------------------
// 输出清洗:
//   - 统一换行(CRLF -> LF);
//   - strip_ansi=true 时去掉 ANSI 转义与除 \n \t 以外的控制字符;
//   - 额外删除 CLI 的进度帧(spinner / 百分比条): workbench upload 会把
//     "⠋ Preparing... [###---] 50% Uploading to OSS..." 这类回车重绘写进 stderr,
//     原样返回会把真正的结论淹掉。
// ----------------------------------------------------------------------------
const ANSI_RE = /\u001b\[[0-9;?]*[ -\/]*[@-~]|\u001b\][^\u0007]*(\u0007|\u001b\\)|\u001b[()][A-Za-z0-9]|\u001b[@-Z\\-_]/g
const CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g
const PROGRESS_FRAME_RE = /^\s*(?:[\u2800-\u28ff]|\[[#=.\- ]{3,}\]\s*\d{1,3}%|\d{1,3}%\s*[|\[▏▎▍▌▋▊▉█])/u

export function cleanOutput(text, stripAnsiFlag = true) {
  const raw = String(text != null ? text : '').replace(/\r\n/g, '\n')
  // strip_ansi=false 表示原样保留(仅统一换行): 控制字符与 ANSI 都不动
  if (stripAnsiFlag !== true) return raw
  const noAnsi = raw.replace(ANSI_RE, '').replace(CONTROL_RE, '')
  const out = []
  for (const line of noAnsi.split('\n')) {
    if (line.indexOf('\r') < 0) {
      out.push(line)
      continue
    }
    // 回车重绘行: 丢掉进度帧与空段, 其余按出现顺序各占一行
    for (const seg of line.split('\r')) {
      if (seg.trim().length === 0) continue
      if (PROGRESS_FRAME_RE.test(seg)) continue
      out.push(seg)
    }
  }
  return out.join('\n')
}

// ----------------------------------------------------------------------------
// 纯 JS base64 编码(动态挂载 body 没有 Buffer, 且 to-body.mjs 会剥掉 import,
// 所以这里必须自带实现)。
// ----------------------------------------------------------------------------
const B64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

// UTF-8 字节序列(number[]); 供 base64 编码与字节长度校验共用
export function utf8Bytes(text) {
  const s = String(text != null ? text : '')
  const out = []
  for (let i = 0; i < s.length; i++) {
    let code = s.charCodeAt(i)
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < s.length) {
      const next = s.charCodeAt(i + 1)
      if (next >= 0xdc00 && next <= 0xdfff) {
        code = 0x10000 + ((code - 0xd800) << 10) + (next - 0xdc00)
        i += 1
      }
    }
    if (code < 0x80) {
      out.push(code)
    } else if (code < 0x800) {
      out.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f))
    } else if (code < 0x10000) {
      out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f))
    } else {
      out.push(0xf0 | (code >> 18), 0x80 | ((code >> 12) & 0x3f), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f))
    }
  }
  return out
}

export function utf8ByteLength(text) {
  return utf8Bytes(text).length
}

export function base64Encode(text) {
  const bytes = utf8Bytes(text)
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i]
    const b1 = i + 1 < bytes.length ? bytes[i + 1] : undefined
    const b2 = i + 2 < bytes.length ? bytes[i + 2] : undefined
    out += B64_ALPHABET[b0 >> 2]
    out += B64_ALPHABET[((b0 & 0x03) << 4) | (b1 === undefined ? 0 : b1 >> 4)]
    out += b1 === undefined ? '=' : B64_ALPHABET[((b1 & 0x0f) << 2) | (b2 === undefined ? 0 : b2 >> 6)]
    out += b2 === undefined ? '=' : B64_ALPHABET[b2 & 0x3f]
  }
  return out
}

// ----------------------------------------------------------------------------
// shell 引用与路径工具
// ----------------------------------------------------------------------------
export function shellQuote(text) {
  return "'" + String(text != null ? text : '').replace(/'/g, "'\\''") + "'"
}

export function baseName(p) {
  const s = String(p != null ? p : '').replace(/[\\/]+$/, '')
  const i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'))
  return i >= 0 ? s.slice(i + 1) : s
}

// 上传目标路径拼接: 远端以分隔符结尾时视为目录(与 CLI 文档示例一致)
export function remoteJoin(remotePath, localFile) {
  const rp = String(remotePath != null ? remotePath : '')
  return /[\\/]$/.test(rp) ? rp + baseName(localFile) : rp
}

// 本地路径拆成 (父目录, 名字): 目录归档需要 tar -C <父> <名字>,
// 这样归档内的条目都以 <名字>/ 开头, 解包后目录结构可预期。
export function splitLocalPath(p) {
  const s = String(p != null ? p : '').replace(/\\/g, '/').replace(/\/+$/, '')
  const i = s.lastIndexOf('/')
  if (i < 0) return { parent: '.', base: s }
  const parent = s.slice(0, i)
  return { parent: parent.length === 0 ? '/' : parent, base: s.slice(i + 1) }
}

// ----------------------------------------------------------------------------
// 纯 JS 文本摘要(N1, v0.8.0): 快照里用它对"采集到的文本输出"做变更检测。
// 为什么不用 sha256: 动态挂载 body 通道没有 node:crypto, 且这里只需要"变没变"
// (不是安全边界)。因此用两个不同种子的 32 位 FNV-1a 拼成 16 位十六进制摘要。
// 远端文件的完整性仍然用**远端 sha256sum** 的真实摘要(见 buildSnapshotScript)。
// ----------------------------------------------------------------------------
export function textDigest(text) {
  const s = String(text != null ? text : '')
  let h1 = 0x811c9dc5
  let h2 = 0x01000193
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0
    h2 = Math.imul(h2 ^ c, 0x85ebca6b) >>> 0
  }
  return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0')
}

// 文本的首个差异行(用于"哪里变了"的提示); 无差异返回 undefined
export function firstDifferingLine(before, after) {
  const a = String(before != null ? before : '').split('\n')
  const b = String(after != null ? after : '').split('\n')
  const max = Math.max(a.length, b.length)
  for (let i = 0; i < max; i++) {
    if (a[i] !== b[i]) return { line: i + 1, before: a[i] !== undefined ? a[i] : '(无)', after: b[i] !== undefined ? b[i] : '(无)' }
  }
  return undefined
}

// 本地建目录(S5b 归档/快照清单都要在工作区落文件, 而 fs 服务没有 mkdir):
// 与 removeLocalFile 同一套"平台工具逐个尝试"的做法 —— mkdir -p / cmd mkdir。
// 注意 cmd 的分支必须把 `/` 换回 `\`: cmd 的内建命令会把正斜杠当开关, 混用分隔符
// 的路径(如 `C:\ws/.dsh/...`)在 cmd 下直接失败(实测)。
const LOCAL_MKDIR_TOOLS = [
  { exe: 'mkdir', args: (dir) => ['-p', dir] },
  { exe: 'cmd', args: (dir) => ['/c', 'mkdir', String(dir).replace(/\//g, '\\')] },
]

export async function ensureLocalDir(ctx, dirPath, signal, opts = {}) {
  const fs = ctx !== undefined && typeof ctx.get === 'function' ? ctx.get('fs') : undefined
  const exists = async () => {
    if (fs === undefined || fs === null || typeof fs.stat !== 'function') return false
    try {
      const target = await fs.resolve(dirPath)
      const info = await fs.stat(target)
      return info !== undefined && info !== null
    } catch (err) {
      return false
    }
  }
  if (await exists()) return 'exists'
  const subprocess = ctx !== undefined && typeof ctx.get === 'function' ? ctx.get('subprocess') : undefined
  if (subprocess === undefined) return 'no-subprocess'
  for (const tool of LOCAL_MKDIR_TOOLS) {
    let exe
    try {
      exe = await subprocess.resolveExecutable(tool.exe)
    } catch (err) {
      exe = undefined
    }
    if (exe === undefined) continue
    try {
      const r = await runProcess(ctx, [exe, ...tool.args(dirPath)], signal,
        { stdoutMaxBytes: 16 * 1024, cwd: opts.cwd, exec: opts.exec })
      if (r.exitCode === 0) return 'created'
      // cmd 在"目录已存在"时返回非零 → 按其输出识别为"已存在"(无 fs 时也能判对)
      if (/already exists|已存在|子目录或文件/.test(String(r.stdout) + String(r.stderr))) return 'exists'
    } catch (err2) {
      /* 换下一个工具 */
    }
  }
  // cmd 在"目录已存在"时返回非零 → 再确认一次
  return (await exists()) ? 'exists' : 'failed'
}

export async function runWithConcurrency(items, limit, worker) {
  const list = Array.from(items)
  if (list.length === 0) return []
  const lanes = Math.max(1, Math.min(Math.floor(Number(limit) || 1), list.length))
  const results = new Array(list.length)
  let cursor = 0
  const runners = []
  for (let i = 0; i < lanes; i++) {
    runners.push((async () => {
      for (;;) {
        const idx = cursor
        cursor += 1
        if (idx >= list.length) return
        results[idx] = await worker(list[idx], idx)
      }
    })())
  }
  await Promise.all(runners)
  return results
}

// 随机标识(不依赖 node:crypto): 仅用于远端临时文件名
export function shortId() {
  let s = ''
  for (let i = 0; i < 10; i++) s += B64_ALPHABET[Math.floor(Math.random() * 64)].replace(/[+/]/g, 'x').toLowerCase()
  return s.replace(/=/g, '')
}

// ----------------------------------------------------------------------------
// 本地文件 sha256: 经 subprocess 调用平台哈希工具(sha256sum / shasum / certutil),
// 从而不依赖 node:crypto —— 动态挂载 body 与 npm 包两条通道行为一致。
// 全部工具都不可用时返回 undefined(调用方降级为"跳过校验")。
// ----------------------------------------------------------------------------
const HASH_TOOLS = [
  { exe: 'sha256sum', args: (f) => [f], pick: (text) => firstToken(text) },
  { exe: 'shasum', args: (f) => ['-a', '256', f], pick: (text) => firstToken(text) },
  { exe: 'certutil', args: (f) => ['-hashfile', f, 'SHA256'], pick: (text) => hex64(text) },
]

function firstToken(text) {
  const m = /^\s*([0-9a-fA-F]{64})\b/m.exec(String(text))
  return m === null ? undefined : m[1].toLowerCase()
}

function hex64(text) {
  const m = /[0-9a-fA-F]{64}/.exec(String(text).replace(/\s+/g, ''))
  return m === null ? undefined : m[0].toLowerCase()
}

// opts.exec / opts.cwd: 相对路径要按会话工作区解析(D11, v0.6.4)
export async function localSha256(ctx, filePath, signal, opts = {}) {
  const subprocess = ctx.get('subprocess')
  if (subprocess === undefined) return undefined
  for (const tool of HASH_TOOLS) {
    let exe
    try {
      exe = await subprocess.resolveExecutable(tool.exe)
    } catch (err) {
      exe = undefined
    }
    if (exe === undefined) continue
    let r
    try {
      r = await runProcess(ctx, [exe, ...tool.args(filePath)], signal,
        { stdoutMaxBytes: 64 * 1024, cwd: opts.cwd, exec: opts.exec })
    } catch (err2) {
      continue
    }
    if (r.exitCode !== 0) continue
    const digest = tool.pick(r.stdout + '\n' + r.stderr)
    if (digest !== undefined) return digest
  }
  return undefined
}

// 远端文件 sha256(单次 workbench exec)。
// opts.locked=true 表示调用方已经持有该实例的锁(如 ecs_deploy 的整段发布),
// 此时不再重复取锁 —— withInstanceLock 不是可重入锁, 嵌套取锁会自我死锁。
export async function remoteSha256(ctx, instanceId, remotePath, opts = {}) {
  const quoted = shellQuote(remotePath)
  const command = 'sha256sum ' + quoted + ' 2>/dev/null || shasum -a 256 ' + quoted
  const argv = ['exec', '--instance-id', instanceId, '--command', command,
    '--timeout', String(resolveTimeout(opts.timeout, 60)), '--output', 'json']
  if (opts.region !== undefined && opts.region !== null && String(opts.region).length > 0) argv.push('--region', String(opts.region))
  const runOnce = () => runWorkbench(ctx, argv, opts.signal, { cwd: opts.cwd, exec: opts.exec })
  const r = opts.locked === true ? await runOnce() : await withInstanceLock(instanceId, runOnce)
  let data
  try {
    data = decodeCliOutput(r, 'sha256 校验')
  } catch (err) {
    return undefined
  }
  const text = data !== null && typeof data === 'object' && data.output !== undefined ? String(data.output) : ''
  const m = /[0-9a-fA-F]{64}/.exec(text)
  return m === null ? undefined : m[0].toLowerCase()
}

// ----------------------------------------------------------------------------
// 目录递归上传(S5b): CLI 只能上传单个文件, 所以目录必须先在本机归档,
// 再上传归档, 最后在远端解包 —— 顺序保证"校验后解包", 坏包不会落地。
//   - 归档/删除都经 subprocess 调用平台自带工具(tar / rm / cmd), 不依赖任何
//     Node 模块, 两条投递通道(npm 包与动态 body)行为一致;
//   - 不假设 Windows/POSIX: 删除优先 rm, 不可用时回落 cmd /c del。
// ----------------------------------------------------------------------------
export async function resolveLocalTool(ctx, names) {
  const subprocess = ctx.get('subprocess')
  if (subprocess === undefined) return undefined
  for (const name of names) {
    let exe
    try {
      exe = await subprocess.resolveExecutable(name)
    } catch (err) {
      exe = undefined
    }
    if (exe !== undefined && exe !== null && String(exe).length > 0) return String(exe)
  }
  return undefined
}

const LOCAL_REMOVE_TOOLS = [
  { exe: 'rm', args: (f) => ['-f', f] },
  { exe: 'cmd', args: (f) => ['/c', 'del', '/f', '/q', f] },
]

// 尽力删除本地临时文件, 返回 'removed' | 'failed' | 'no-subprocess'(不影响主流程)
// opts.exec / opts.cwd: 相对路径按会话工作区解析(D11, v0.6.4)
export async function removeLocalFile(ctx, filePath, signal, opts = {}) {
  const subprocess = ctx.get('subprocess')
  if (subprocess === undefined) return 'no-subprocess'
  for (const tool of LOCAL_REMOVE_TOOLS) {
    let exe
    try {
      exe = await subprocess.resolveExecutable(tool.exe)
    } catch (err) {
      exe = undefined
    }
    if (exe === undefined) continue
    try {
      const r = await runProcess(ctx, [exe, ...tool.args(filePath)], signal,
        { stdoutMaxBytes: 16 * 1024, cwd: opts.cwd, exec: opts.exec })
      if (r.exitCode === 0) return 'removed'
    } catch (err2) {
      /* 换下一个工具 */
    }
  }
  return 'failed'
}

// 本地归档 argv: tar -czf <archive> -C <parent> <base>
export function buildTarCreateArgv(tarExe, archivePath, sourcePath) {
  const parts = splitLocalPath(sourcePath)
  return [tarExe, '-czf', archivePath, '-C', parts.parent, parts.base]
}

// 远端解包命令(单条 --command, 所有路径经 shell 引用, 无自由文本进入引用层):
//   建目录 → 数条目 → 解包 → 报条目数 → 清理归档 → 透传退出码
// keep_root_dir=false 时用 --strip-components=1 把归档顶层的目录名剥掉,
// 使 local_dir 的**内容**直接落在 remote_path 下(符合"把目录传到该目录"的直觉)。
export function buildArchiveExtractScript(opts = {}) {
  const archivePath = shellQuote(String(opts.archivePath != null ? opts.archivePath : ''))
  const remoteDir = shellQuote(String(opts.remoteDir != null ? opts.remoteDir : ''))
  const strip = opts.keepRootDir === true ? 0 : 1
  const lines = [
    'mkdir -p ' + remoteDir + ' || { echo "dsh-ecs: 远端目录创建失败" >&2; exit 96; }',
    'n=$(tar -tzf ' + archivePath + ' 2>/dev/null | wc -l) || { echo "dsh-ecs: 归档不可读" >&2; exit 95; }',
    'tar -xzf ' + archivePath + ' -C ' + remoteDir + (strip > 0 ? ' --strip-components=' + strip : '') + '; rc=$?',
    'if [ "$rc" -eq 0 ]; then printf "__DSH_ECS_ENTRIES__%s\\n" "$n"; fi',
    ...(opts.keepArchive === true ? [] : ['rm -f ' + archivePath]),
    'exit $rc',
  ]
  return lines.join('\n')
}

// 从解包输出中取出条目数并剥离标记行
export function parseArchiveEntries(text) {
  let out = String(text != null ? text : '')
  let entries
  const m = /__DSH_ECS_ENTRIES__\s*(\d+)\s*\n?/.exec(out)
  if (m !== null) {
    entries = Number(m[1])
    out = (out.slice(0, m.index) + out.slice(m.index + m[0].length)).replace(/\n$/, '')
  }
  return { text: out, entries }
}

// ----------------------------------------------------------------------------
// 脚本直送(S1): 把脚本正文以 base64 投递到远端文件后执行, 使脚本内容完全
// 不进入远端 `sh -c` 的引用层 —— docker exec / node -e 这类多层引号组合不再
// 需要任何转义。
// 两级投递(Windows CreateProcess 命令行上限约 32KB, base64 膨胀 4/3):
//   - base64 长度 ≤ SCRIPT_INLINE_LIMIT_BYTES: 单条命令一次写入;
//   - 否则分片追加(每片 SCRIPT_CHUNK_BYTES), 每次 argv 都在 ~11KB 内。
// 落盘后校验字节数(与本地 UTF-8 字节数比对), 截断会被显式发现而不是静默执行。
// 返回 { commands: [...前置命令, 末条执行命令], ... }; 末条命令自带退出码透传,
// 可单独用于后台任务。
// ----------------------------------------------------------------------------
export const SCRIPT_INLINE_LIMIT_BYTES = 16 * 1024
export const SCRIPT_CHUNK_BYTES = 8 * 1024

export function buildScriptDelivery(script, opts = {}) {
  const prep = buildScriptPrep(script, opts)
  const expected = prep.expected_bytes
  const cleanup = 'rm -f ' + prep.b64_path + (opts.keep === true ? '' : ' ' + prep.script_path)
  const run = 'n=$(wc -c < ' + prep.script_path + '); [ "$n" -eq ' + expected + ' ] || { echo "dsh-ecs: 脚本落盘字节数不符 (远端 $n != 本地 ' + expected + ')" >&2; ' +
    cleanup + '; exit 97; }; ' + prep.shell + ' ' + prep.script_path + '; rc=$?; ' + cleanup + '; exit $rc'
  return {
    shell: prep.shell,
    script_path: prep.script_path,
    b64_path: prep.b64_path,
    expected_bytes: expected,
    base64_bytes: prep.base64_bytes,
    inline: prep.inline,
    chunks: prep.chunks,
    commands: prep.commands.concat([run]),
    runner: prep.shell + ' ' + prep.script_path,
  }
}

// 投递前置段(建目录 + base64 写入 + 解码落盘 + 字节数校验), 供前台执行与
// detach 长任务共用。返回 commands 均为"前置命令", 不含最终执行/启动命令。
export function buildScriptPrep(script, opts = {}) {
  const text = String(script != null ? script : '')
  const shell = opts.shell === 'sh' ? 'sh' : 'bash'
  const dir = (opts.dir !== undefined ? String(opts.dir) : '/tmp').replace(/\/+$/, '')
  const id = opts.id !== undefined ? String(opts.id) : shortId()
  const scriptPath = dir + '/.dsh-ecs-' + id + '.sh'
  const b64Path = dir + '/.dsh-ecs-' + id + '.b64'

  const expected = utf8ByteLength(text)
  const b64 = base64Encode(text)
  const inline = b64.length <= SCRIPT_INLINE_LIMIT_BYTES

  const commands = []
  if (dir !== '/tmp') commands.push('mkdir -p ' + shellQuote(dir))
  if (inline) {
    commands.push("printf '%s' " + shellQuote(b64) + ' > ' + shellQuote(b64Path))
  } else {
    commands.push(': > ' + shellQuote(b64Path))
    for (let i = 0; i < b64.length; i += SCRIPT_CHUNK_BYTES) {
      commands.push("printf '%s' " + shellQuote(b64.slice(i, i + SCRIPT_CHUNK_BYTES)) + ' >> ' + shellQuote(b64Path))
    }
  }
  commands.push('{ base64 -d ' + shellQuote(b64Path) + ' 2>/dev/null || base64 -D ' + shellQuote(b64Path) + '; } > ' + shellQuote(scriptPath))

  return {
    shell,
    dir,
    id,
    script_path: scriptPath,
    b64_path: b64Path,
    expected_bytes: expected,
    base64_bytes: b64.length,
    inline,
    chunks: commands.length,
    commands,
    check: 'n=$(wc -c < ' + scriptPath + '); [ "$n" -eq ' + expected + ' ]',
  }
}


// 已在远端落盘的脚本直接执行(供大脚本走 upload 后复用同一收尾语义)
export function buildScriptRunner(scriptPath, opts = {}) {
  const shell = opts.shell === 'sh' ? 'sh' : 'bash'
  const cleanup = opts.keep === true ? '' : 'rm -f ' + scriptPath + '; '
  return shell + ' ' + scriptPath + '; rc=$?; ' + cleanup + 'exit $rc'
}

// ----------------------------------------------------------------------------
// detach 长任务(S2): 远端 nohup 启动 + 日志文件 + 退出码文件。
// 这套约定让"远端日志文件"成为唯一事实源 —— 插件侧轮询只是搬运增量,
// 因此模型读得慢也不会丢段/重复(v0.3.x 的内存环形缓冲正是这个毛病)。
// 目录: <dir>/.dsh-ecs-<id>/{run.sh, out.log, exit}
// ----------------------------------------------------------------------------
export function buildDetachLaunch(script, opts = {}) {
  const baseDir = (opts.dir !== undefined ? String(opts.dir) : '/tmp').replace(/\/+$/, '')
  const id = opts.id !== undefined ? String(opts.id) : shortId()
  const jobDir = baseDir + '/.dsh-ecs-' + id
  const prep = buildScriptPrep(script, { ...opts, dir: jobDir, id })
  const logPath = jobDir + '/out.log'
  const exitPath = jobDir + '/exit'
  const runBody = prep.shell + ' ' + prep.script_path + '; echo $? > ' + shellQuote(exitPath)
  const launch = 'nohup sh -c ' + shellQuote(runBody) +
    ' > ' + shellQuote(logPath) + ' 2>&1 & echo __DSH_ECS_PID__$!'
  return {
    shell: prep.shell,
    job_id: id,
    dir: jobDir,
    script_path: prep.script_path,
    b64_path: prep.b64_path,
    log_path: logPath,
    exit_path: exitPath,
    expected_bytes: prep.expected_bytes,
    inline: prep.inline,
    prepare_commands: prep.commands.concat([prep.check + ' || { echo "dsh-ecs: 脚本落盘字节数不符" >&2; exit 97; }']),
    launch_command: launch,
    runner: prep.shell + ' ' + prep.script_path,
  }
}

// 日志游标读命令: 先报总字节数(meta), 再按字节游标输出增量(tail -c +N+1 | head -c M),
// 最后在退出码文件出现时报出退出码。全部为只读命令。
export function buildLogReadCommand(opts = {}) {
  const logPath = String(opts.logPath != null ? opts.logPath : '')
  const after = Math.max(0, Number(opts.after) || 0)
  const maxBytes = Math.max(1, Number(opts.maxBytes) || 262144)
  const sleepSec = Number(opts.sleep) > 0 ? Number(opts.sleep) : 0
  const parts = []
  if (sleepSec > 0) parts.push('sleep ' + sleepSec)
  parts.push('n=$(wc -c < ' + shellQuote(logPath) + ' 2>/dev/null || echo 0); printf "__DSH_ECS_META__ %s\\n" "$n"')
  parts.push('tail -c +' + (after + 1) + ' ' + shellQuote(logPath) + ' 2>/dev/null | head -c ' + maxBytes)
  if (opts.exitPath !== undefined && opts.exitPath !== null && String(opts.exitPath).length > 0) {
    const exitPath = shellQuote(String(opts.exitPath))
    parts.push('if [ -f ' + exitPath + ' ]; then printf "\\n__DSH_ECS_EXIT__ %s\\n" "$(cat ' + exitPath + ')"; fi')
  }
  return parts.join('; ')
}

// 解析 buildLogReadCommand 的输出: 文本增量 + 下一个字节游标 + 总字节数 + 退出码。
// 字节数按远端 wc -c 计算, 因此游标精确(即使 head -c 切断了多字节字符)。
export function parseLogRead(output, after = 0, maxBytes = 262144) {
  const start = Math.max(0, Number(after) || 0)
  const cap = Math.max(1, Number(maxBytes) || 262144)
  let text = String(output != null ? output : '')
  let total
  const meta = /__DSH_ECS_META__\s*(\d+)[^\n]*\n?/.exec(text)
  if (meta !== null) {
    total = Number(meta[1])
    text = text.slice(0, meta.index) + text.slice(meta.index + meta[0].length)
  }
  let exitCode
  const exitMatch = /__DSH_ECS_EXIT__\s*(-?\d+)\s*/.exec(text)
  if (exitMatch !== null) {
    exitCode = Number(exitMatch[1])
    text = text.slice(0, exitMatch.index) + text.slice(exitMatch.index + exitMatch[0].length)
  }
  const available = total === undefined ? undefined : Math.max(0, total - start)
  const bytes = available === undefined ? utf8ByteLength(text) : Math.min(available, cap)
  return {
    text: text.replace(/\n$/, ''),
    total_bytes: total,
    exit_code: exitCode,
    bytes,
    next_offset: start + bytes,
    truncated: available !== undefined && available > cap,
  }
}

// 从 detach 启动输出中解析远端 PID
export function parseDetachPid(output) {
  const m = /__DSH_ECS_PID__(\d+)/.exec(String(output != null ? output : ''))
  return m === null ? undefined : Number(m[1])
}

// ----------------------------------------------------------------------------
// 定时等待: 优先用 Cordis timer 服务(随 fiber 释放), 其次本机 setTimeout,
// 两者都没有(动态挂载的受限环境)时返回 false, 由调用方改用远端 sleep 兜底。
// ----------------------------------------------------------------------------
export function hasLocalTimer(ctx) {
  if (ctx !== undefined && typeof ctx.get === 'function') {
    const timer = ctx.get('timer')
    if (timer !== undefined && timer !== null && typeof timer.timeout === 'function') return true
  }
  return typeof setTimeout === 'function'
}

export function delay(ctx, ms) {
  if (ctx !== undefined && typeof ctx.get === 'function') {
    const timer = ctx.get('timer')
    if (timer !== undefined && timer !== null && typeof timer.timeout === 'function') {
      try {
        return timer.timeout(ms)
      } catch (err) {
        /* 上下文已释放: 回落到本机定时器 */
      }
    }
  }
  if (typeof setTimeout === 'function') return new Promise((resolve) => setTimeout(resolve, ms))
  return Promise.resolve()
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

// ----------------------------------------------------------------------------
// 无损 JSON 边界: DSH 工具管线在返回结果前执行 lossless 校验(isJsonValue),
// 任何 undefined 值属性 / NaN ±Infinity / -0 / 稀疏数组 / 循环引用都会触发
// "not lossless JSON" 使整次工具调用失败。这里递归剔除 undefined 值属性
// (JSON 语义等价于缺省, 不丢任何可表达内容), 其余值原样保留。
// ----------------------------------------------------------------------------
export function omitUndefined(value) {
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(omitUndefined)
  const out = {}
  for (const key of Object.keys(value)) {
    const v = value[key]
    if (v === undefined) continue
    out[key] = omitUndefined(v)
  }
  return out
}

// ----------------------------------------------------------------------------
// 按实例串行化: 同一 ECS 实例上的远程执行共用 Workbench 会话输出流(实测同一
// 实例复用同一 session_id, 如 s-8or9sgn524lit3916), 并发调用会互相串流。
// CLI 没有"每次调用独立会话"的开关(session 只有 list/close), 因此在插件侧对
// 同一 instance_id 的操作加 FIFO 互斥锁: 同实例串行, 不同实例仍可并行。
// 所有触达实例的 CLI 操作(exec/diagnose/deploy/upload/download/sha256 校验 +
// 设置页 RPC)都应经过这里。
// 注意: 锁的持有时长应与"本地 CLI 进程"一致 —— 长任务不要长时间占锁,
// 否则同实例的其它调用会排队到工具调用超时(v0.5 的 detach 轮询模型按此设计)。
// ----------------------------------------------------------------------------
const instanceLocks = new Map()

export function withInstanceLock(instanceId, fn) {
  const key = String(instanceId != null ? instanceId : '')
  const prev = instanceLocks.get(key)
  let release = () => {}
  const gate = new Promise((resolveGate) => { release = resolveGate })
  const chained = prev !== undefined ? prev.then(() => gate) : gate
  instanceLocks.set(key, chained)
  const run = async () => {
    try {
      return await fn()
    } finally {
      release()
      if (instanceLocks.get(key) === chained) instanceLocks.delete(key)
    }
  }
  return prev !== undefined ? prev.then(run) : run()
}
