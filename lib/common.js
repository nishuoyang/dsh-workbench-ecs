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
export const PLUGIN_VERSION = '0.4.0'

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
// 启动一条本机子进程(显式 stdio: stdout 内存尾部 + 溢出落盘; stderr 仅内存尾部)。
// argv[0] 即程序本身, 不做 shell 解释, 不套本地 shell。
// opts: { stdoutMaxBytes, stdoutSpillMaxBytes, stderrMaxBytes, stdin }
// ----------------------------------------------------------------------------
export function spawnProcess(ctx, argv, signal, opts = {}) {
  const subprocess = ctx.get('subprocess')
  if (subprocess === undefined) {
    return Promise.reject(new Error('subprocess 服务不可用, 无法在本机执行命令'))
  }
  const stdoutMaxBytes = opts.stdoutMaxBytes ?? 2 * 1024 * 1024
  const stdoutSpillMaxBytes = opts.stdoutSpillMaxBytes ?? 32 * 1024 * 1024
  const stderrMaxBytes = opts.stderrMaxBytes ?? 512 * 1024

  // 工作目录: 优先会话工作区根目录, 兜底进程当前目录
  const sandboxPolicy = ctx.get('sandboxPolicy')
  const cwd = (sandboxPolicy !== undefined && sandboxPolicy.workspaceRoot !== undefined && sandboxPolicy.workspaceRoot !== null)
    ? String(sandboxPolicy.workspaceRoot) : '.'

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
// 只读护栏: 命中 WRITE_PATTERNS 的写操作返回来源说明(供测试/面板复用)。
// ----------------------------------------------------------------------------
export function checkWriteCommand(text) {
  const cmd = text != null ? String(text) : ''
  const hit = WRITE_PATTERNS.find((p) => p.test.test(cmd))
  return hit !== undefined ? hit.source : undefined
}

// 只读护栏(防呆): read_only=true 时拒绝写操作; 直接拒绝, 不走审批。
export function guardReadOnly(text, label) {
  const hit = checkWriteCommand(text)
  if (hit === undefined) return
  const excerpt = String(text != null ? text : '').slice(0, 200)
  throw new Error((label !== undefined ? label + ': ' : '') +
    'read_only=true 下检测到写操作模式 (' + hit + '), 已拒绝执行: ' + excerpt +
    '; 若确实需要写入, 请显式传 read_only=false')
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

export async function localSha256(ctx, filePath, signal) {
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
      r = await runProcess(ctx, [exe, ...tool.args(filePath)], signal, { stdoutMaxBytes: 64 * 1024 })
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
  const runOnce = () => runWorkbench(ctx, argv, opts.signal)
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
  const text = String(script != null ? script : '')
  const shell = opts.shell === 'sh' ? 'sh' : 'bash'
  const dir = (opts.dir !== undefined ? String(opts.dir) : '/tmp').replace(/\/+$/, '')
  const id = opts.id !== undefined ? String(opts.id) : shortId()
  const scriptPath = dir + '/.dsh-ecs-' + id + '.sh'
  const b64Path = dir + '/.dsh-ecs-' + id + '.b64'

  const expected = utf8ByteLength(text)
  const b64 = base64Encode(text)
  const inline = b64.length <= SCRIPT_INLINE_LIMIT_BYTES

  const prep = []
  if (inline) {
    prep.push("printf '%s' " + shellQuote(b64) + ' > ' + b64Path)
  } else {
    prep.push(': > ' + b64Path)
    for (let i = 0; i < b64.length; i += SCRIPT_CHUNK_BYTES) {
      prep.push("printf '%s' " + shellQuote(b64.slice(i, i + SCRIPT_CHUNK_BYTES)) + ' >> ' + b64Path)
    }
  }
  prep.push('{ base64 -d ' + b64Path + ' 2>/dev/null || base64 -D ' + b64Path + '; } > ' + scriptPath)

  const cleanup = 'rm -f ' + b64Path + (opts.keep === true ? '' : ' ' + scriptPath)
  const run = 'n=$(wc -c < ' + scriptPath + '); [ "$n" -eq ' + expected + ' ] || { echo "dsh-ecs: 脚本落盘字节数不符 (远端 $n != 本地 ' + expected + ')" >&2; ' +
    cleanup + '; exit 97; }; ' + shell + ' ' + scriptPath + '; rc=$?; ' + cleanup + '; exit $rc'

  return {
    shell,
    script_path: scriptPath,
    b64_path: b64Path,
    expected_bytes: expected,
    base64_bytes: b64.length,
    inline,
    chunks: prep.length,
    commands: prep.concat([run]),
    runner: shell + ' ' + scriptPath,
  }
}

// 已在远端落盘的脚本直接执行(供大脚本走 upload 后复用同一收尾语义)
export function buildScriptRunner(scriptPath, opts = {}) {
  const shell = opts.shell === 'sh' ? 'sh' : 'bash'
  const cleanup = opts.keep === true ? '' : 'rm -f ' + scriptPath + '; '
  return shell + ' ' + scriptPath + '; rc=$?; ' + cleanup + 'exit $rc'
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
