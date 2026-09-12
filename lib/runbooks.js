// ============================================================================
// lib/runbooks.js —— Runbook 机制(S4b, v0.6.1): 把"发布跑书"做成**纯数据**
// ----------------------------------------------------------------------------
// 设计边界(与用户确认的口径一致):
//   - 插件只提供**机制**: 读取 / 校验 / 参数替换 / 展开成 steps;
//   - **内容**留在项目仓库 —— 脚本本体由 steps 里的 upload 上传, runbook 只是
//     "步骤 + 断言 + 参数占位"的数据, 插件里不硬编码任何项目逻辑。
//
// runbook 文件位置(相对会话工作区): .dsh/workbench-ecs/runbooks/<name>.json
// 文件形状:
//   {
//     "name": "release",              // 可选, 仅用于展示
//     "description": "…",             // 可选
//     "params": { "sha": "latest" },  // 可选: 参数默认值(调用方可用 runbook_params 覆盖)
//     "steps": [ … ]                  // 必填: 与 ecs_deploy 的 steps 同构
//   }
// 占位符: ${name}(在任意字符串里替换); 整串恰好是一个占位符时保留原始类型
//   (例如 "timeout": "${t}" + params.t=300 → 数字 300)。
//   `$${name}` 是**转义**: 原样保留 ${name}(留给远端 shell 展开, 插件不替换)。
// 隐式可用参数: instance_id、region(由调用参数带入)。
// v0.6.3: 增加 lintRunbook —— 把结构/参数/字段/护栏类问题在执行之前一次性报出。
// ----------------------------------------------------------------------------
import { DANGEROUS_PATTERNS, checkWriteCommand } from './common.js'
import { planSteps, STEPS_MAX_STEP_TIMEOUT, STEPS_STAGE_TIMEOUT } from './steps-engine.js'

// 相对会话工作区的 runbook 目录
export const RUNBOOK_DIR = '.dsh/workbench-ecs/runbooks'
// runbook 名字白名单: 直接拼进路径, 因此必须挡住 / \ .. 等穿越写法
export const RUNBOOK_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
// 与 ecs_deploy 的 steps 上限一致(命名带模块前缀: 动态 body 同作用域不能重名)
export const RUNBOOK_MAX_STEPS = 20

export function isValidRunbookName(name) {
  return RUNBOOK_NAME_RE.test(String(name != null ? name : ''))
}

const PLACEHOLDER_SCAN_RE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g
const PLACEHOLDER_EXACT_RE = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/
// 转义: `$${name}` 表示"字面量 ${name}", 不参与替换。
// 为什么需要: runbook 的步骤里常常是 shell 脚本, `${HOME}` / `${PATH}` 这类 shell 展开
// 与 runbook 占位符写法完全相同, 没有转义就只能把参数名起得跟 shell 变量错开。
// 实现: 替换前把 `$${` 换成不可能出现的哨兵, 替换后再还原。
const RUNBOOK_ESCAPE_TOKEN = '\u0000DSH_RB_ESC\u0000'

function protectEscapes(text) {
  return String(text).replace(/\$\$\{/g, RUNBOOK_ESCAPE_TOKEN)
}

function restoreEscapes(text) {
  return String(text).split(RUNBOOK_ESCAPE_TOKEN).join('${')
}

function has(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key)
}

// 递归替换占位符。missing 非空时, 未提供的参数名会被收集进去(而不是静默留空)。
export function substituteParams(value, params, missing) {
  if (typeof value === 'string') {
    const guarded = protectEscapes(value)
    const exact = PLACEHOLDER_EXACT_RE.exec(guarded)
    if (exact !== null) {
      const key = exact[1]
      if (has(params, key)) return params[key]
      if (missing !== undefined) missing.add(key)
      return value
    }
    return restoreEscapes(guarded.replace(PLACEHOLDER_SCAN_RE, (whole, key) => {
      if (has(params, key)) return String(params[key])
      if (missing !== undefined) missing.add(key)
      return whole
    }))
  }
  if (Array.isArray(value)) return value.map((item) => substituteParams(item, params, missing))
  if (value !== null && typeof value === 'object') {
    const out = {}
    for (const key of Object.keys(value)) out[key] = substituteParams(value[key], params, missing)
    return out
  }
  return value
}

// 收集一份结构里出现的所有占位符名(用于"声明了哪些参数"与"哪些参数没用上")
export function collectParamNames(value, out) {
  const names = out !== undefined ? out : new Set()
  if (typeof value === 'string') {
    const guarded = protectEscapes(value)
    PLACEHOLDER_SCAN_RE.lastIndex = 0
    let match = PLACEHOLDER_SCAN_RE.exec(guarded)
    while (match !== null) {
      names.add(match[1])
      match = PLACEHOLDER_SCAN_RE.exec(guarded)
    }
    PLACEHOLDER_SCAN_RE.lastIndex = 0
  } else if (Array.isArray(value)) {
    for (const item of value) collectParamNames(item, names)
  } else if (value !== null && typeof value === 'object') {
    for (const key of Object.keys(value)) collectParamNames(value[key], names)
  }
  return names
}

// 解析 + 形状校验(错误信息带 runbook 名字, 便于定位)
export function parseRunbook(text, label = 'runbook') {
  let data
  try {
    data = JSON.parse(String(text != null ? text : ''))
  } catch (err) {
    throw new Error(label + ': JSON 解析失败: ' + (err && err.message ? err.message : String(err)))
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error(label + ': 顶层必须是对象 { params?, steps: [...] }')
  }
  if (!Array.isArray(data.steps) || data.steps.length === 0) {
    throw new Error(label + ': 缺少非空的 steps 数组')
  }
  if (data.steps.length > RUNBOOK_MAX_STEPS) {
    throw new Error(label + ': steps 上限为 ' + RUNBOOK_MAX_STEPS + ' 步(收到 ' + data.steps.length + ')')
  }
  if (data.params !== undefined && (data.params === null || typeof data.params !== 'object' || Array.isArray(data.params))) {
    throw new Error(label + ': params 必须是对象(参数名 → 默认值)')
  }
  return {
    name: data.name !== undefined ? String(data.name) : undefined,
    description: data.description !== undefined ? String(data.description) : undefined,
    params: data.params !== undefined ? data.params : {},
    steps: data.steps,
  }
}

// 合并参数(隐式 < 默认值 < 调用方)并展开 steps;缺参数/多余参数都显式报告
export function buildRunbookRun(runbook, callParams, implicit) {
  const defaults = runbook.params !== undefined ? runbook.params : {}
  const provided = callParams !== null && typeof callParams === 'object' && !Array.isArray(callParams) ? callParams : {}
  const params = Object.assign({}, implicit !== undefined ? implicit : {}, defaults, provided)
  const missing = new Set()
  const steps = substituteParams(runbook.steps, params, missing)
  const declared = collectParamNames(runbook.steps)
  const unused = Object.keys(provided).filter((key) => !declared.has(key))
  return {
    steps,
    params,
    missing: Array.from(missing).sort(),
    declared: Array.from(declared).sort(),
    unused: unused.sort(),
  }
}

// 步骤类型归类(不做结构校验, 只按字段推断): 供面板列表与校验报告展示形状
export function rawStepKind(step) {
  if (step === null || typeof step !== 'object' || Array.isArray(step)) return 'unknown'
  if (step.kind !== undefined) return String(step.kind)
  if (step.local_file !== undefined) return 'upload'
  if (step.expect !== undefined) return 'assert'
  return 'exec'
}

// runbook 形状摘要: 步数 / 各类步骤数量 / 声明的占位符 / 参数默认值
export function summarizeRunbook(runbook) {
  const counts = {}
  for (const step of runbook.steps) {
    const kind = rawStepKind(step)
    counts[kind] = (counts[kind] !== undefined ? counts[kind] : 0) + 1
  }
  return {
    step_count: runbook.steps.length,
    kinds: Object.keys(counts).sort().map((kind) => ({ kind, count: counts[kind] })),
    declared_params: Array.from(collectParamNames(runbook.steps)).sort(),
    params: runbook.params !== undefined ? runbook.params : {},
  }
}


// ----------------------------------------------------------------------------
// 从工作区读取 runbook 文件(可选依赖 fs 服务: 没有 fs 时应改用内联 runbook)
// ----------------------------------------------------------------------------
function runbookPaths(ctx, opts = {}) {
  const fs = ctx.get('fs')
  if (fs === undefined || fs === null) {
    throw new Error('ecs_deploy: 当前环境未挂载 fs 服务, 无法按名字读取 runbook; ' +
      '可改用内联 runbook: runbook: { params?, steps: [...] }')
  }
  // 目录解析(v0.6.4, D11):
  //   opts.runbookDir      —— 显式绝对目录(设置面板的「目录」输入框 / 调用方覆盖);
  //   opts.workspaceRoot   —— 会话工作区根目录(工具路径, 由 common.resolveWorkspaceRoot 给出,
  //                          即 exec.agent.session.header.cwd, 而不是部署兜底的 process.cwd());
  //   两者都没有时退化为相对路径, 交给 fs 服务自己解析。
  const direct = opts.runbookDir !== undefined && opts.runbookDir !== null ? String(opts.runbookDir).trim() : ''
  if (direct.length > 0) return { fs, dir: direct.replace(/[\\/]+$/, '') }
  const rootRaw = opts.workspaceRoot !== undefined && opts.workspaceRoot !== null ? String(opts.workspaceRoot) : ''
  const root = rootRaw.replace(/[\\/]+$/, '')
  const dir = (root.length > 0 ? root + '/' : '') + RUNBOOK_DIR
  return { fs, dir }
}

// 解析 runbook 目录(展示用): opts.runbookDir 优先, 其次会话工作区 + RUNBOOK_DIR
export function runbookDirOf(opts = {}) {
  const direct = opts.runbookDir !== undefined && opts.runbookDir !== null ? String(opts.runbookDir).trim() : ''
  if (direct.length > 0) return direct.replace(/[\\/]+$/, '')
  const rootRaw = opts.workspaceRoot !== undefined && opts.workspaceRoot !== null ? String(opts.workspaceRoot) : ''
  const root = rootRaw.replace(/[\\/]+$/, '')
  return (root.length > 0 ? root + '/' : '') + RUNBOOK_DIR
}

function entryName(entry) {
  if (typeof entry === 'string') return entry
  if (entry === null || entry === undefined) return ''
  if (typeof entry !== 'object') return String(entry)
  if (typeof entry.name === 'string') return entry.name
  if (typeof entry.path === 'string') return entry.path.split(/[\\/]/).pop()
  if (typeof entry.targetKey === 'string') return entry.targetKey.split(/[\\/]/).pop()
  return String(entry)
}

// 列出可用的 runbook 名字(目录不存在或无 fs 时返回空数组, 不抛错)
export async function listRunbookNames(ctx, opts = {}) {
  let fs
  let dir
  try {
    const paths = runbookPaths(ctx, opts)
    fs = paths.fs
    dir = paths.dir
  } catch (err) {
    return []
  }
  try {
    const target = await fs.resolve(dir, opts.signal !== undefined ? { signal: opts.signal } : undefined)
    const entries = await fs.listDir(target, opts.signal)
    return entries
      .map(entryName)
      .filter((name) => name.endsWith('.json'))
      .map((name) => name.slice(0, -'.json'.length))
      .sort()
  } catch (err) {
    return []
  }
}

// 按名字读取并解析 runbook;读取失败时把可用名字回给模型(便于自我纠正)
export async function loadRunbook(ctx, name, opts = {}) {
  if (!isValidRunbookName(name)) {
    throw new Error('ecs_deploy: runbook 名字非法(只允许字母/数字/._-, 且不以 . 开头): ' + String(name))
  }
  const { fs, dir } = runbookPaths(ctx, opts)
  const path = dir + '/' + name + '.json'
  const target = await fs.resolve(path, opts.signal !== undefined ? { signal: opts.signal } : undefined)
  let text
  try {
    text = await fs.readText(target, opts.signal)
  } catch (err) {
    const available = await listRunbookNames(ctx, opts)
    throw new Error('ecs_deploy: 读取 runbook 失败(' + path + '): ' +
      (err && err.message ? err.message : String(err)) +
      (available.length > 0
        ? '; 该目录下可用的 runbook: ' + available.join(', ')
        : '; 该目录下没有可用的 .json runbook(请先在工作区 ' + RUNBOOK_DIR + '/ 下创建)'))
  }
  return { text, path, dir }
}

// ============================================================================
// Runbook 静态校验(lint, v0.6.3)
// ----------------------------------------------------------------------------
// 目的: 把"只有跑到一半才会暴露的问题"提前到执行之前 —— 结构错误、缺参数、
// 字段笔误、assert 没有判据、read_only 与命令矛盾、破坏性命令、tail 只读一次……
// 设计: 结构类错误复用**执行期的同一份校验**(steps-engine.planSteps), 因此
// lint 报出的文案与真正执行时的报错逐字一致, 不会出现"lint 说没事、跑起来才炸"。
// 纯函数: 不读文件、不执行命令, 因此工具/面板/单测三处共用。
// ============================================================================
const STEP_FIELD_WHITELIST = {
  common: ['kind', 'timeout', 'description'],
  upload: ['local_file', 'remote_path', 'force', 'verify_sha256'],
  exec: ['command', 'script', 'shell', 'read_only', 'keep_script'],
  assert: ['command', 'script', 'shell', 'read_only', 'keep_script', 'expect'],
  tail: ['path', 'after', 'max_bytes', 'exit_file', 'wait_seconds'],
}

const STEP_KIND_MAP = { upload: 'upload', exec: 'exec', assert: 'assert', tail: 'tail' }

// 最近的字段名(用于"是不是笔误"的提示): 简易编辑距离, 24 字符以内就够用
function closestFieldName(name, candidates) {
  let best
  let bestScore = Infinity
  const a = String(name).toLowerCase()
  for (const candidate of candidates) {
    const b = candidate.toLowerCase()
    if (a === b) return candidate
    const rows = a.length + 1
    const cols = b.length + 1
    const dist = new Array(rows * cols)
    for (let i = 0; i < rows; i++) dist[i * cols] = i
    for (let j = 0; j < cols; j++) dist[j] = j
    for (let i = 1; i < rows; i++) {
      for (let j = 1; j < cols; j++) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1
        dist[i * cols + j] = Math.min(dist[(i - 1) * cols + j] + 1, dist[i * cols + (j - 1)] + 1, dist[(i - 1) * cols + (j - 1)] + cost)
      }
    }
    const score = dist[rows * cols - 1]
    if (score < bestScore) { bestScore = score; best = candidate }
  }
  // 距离过大就不猜(避免误导)
  return bestScore <= Math.max(2, Math.floor(String(name).length / 2)) ? best : undefined
}

function lintIssue(level, code, message, extra) {
  return Object.assign({ level, code, message }, extra !== undefined ? extra : {})
}

// 还带着未替换的 runbook 占位符(如 "${t}"): 这类值不该按"非法值"报 —— 缺参数
// 那条 error 已经把它说清楚了, 重复报错只会淹没真正的问题。
function isUnresolvedPlaceholder(value) {
  return typeof value === 'string' && /\$\{[A-Za-z_][A-Za-z0-9_]*\}/.test(value)
}

// 参数缺失时的可操作提示: 大写名字很像 shell 变量, 直接给出转义写法
function missingParamMessage(name) {
  const shellLike = /^[A-Z][A-Z0-9_]*$/.test(name)
  return '缺少参数 ' + name + ': 既没有 params 默认值, 调用方也未传入' +
    (shellLike
      ? '; 若它是 shell 变量(如 ${' + name + '} 想留给远端展开), 请写成 $${' + name + '} 转义 —— 插件不再替换它'
      : '')
}

export function lintRunbook(input, opts = {}) {
  const label = opts.label !== undefined ? String(opts.label) : (opts.name !== undefined ? 'runbook ' + opts.name : 'runbook')
  const issues = []
  let runbook
  try {
    runbook = typeof input === 'string' ? parseRunbook(input, label) : parseRunbook(JSON.stringify(input), label)
  } catch (err) {
    return {
      ok: false,
      name: opts.name,
      issues: [lintIssue('error', 'parse', String(err && err.message ? err.message : err))],
      summary: undefined,
      error_count: 1,
      warn_count: 0,
    }
  }

  const args = omitUndefinedRunbook({
    instance_id: opts.instance_id !== undefined ? opts.instance_id : '<instance_id>',
    region: opts.region,
    timeout: opts.timeout,
    read_only: opts.read_only,
  })

  // 参数先行: 下面的逐条检查要看**替换之后**的值(执行期真正下发的就是那个),
  // 否则 "timeout": "${t}" 会被当成非法值误报 —— 而它恰恰是模板的常见写法。
  const provided = opts.params !== undefined && opts.params !== null && typeof opts.params === 'object' && !Array.isArray(opts.params)
    ? opts.params : {}
  const run = buildRunbookRun(runbook, provided, omitUndefinedRunbook({
    instance_id: opts.instance_id !== undefined ? opts.instance_id : '<instance_id>',
    region: opts.region,
  }))

  runbook.steps.forEach((step, index) => {
    const at = { step: index }
    if (step === null || typeof step !== 'object' || Array.isArray(step)) {
      issues.push(lintIssue('error', 'step_shape', 'steps[' + index + '] 必须是对象', at))
      return
    }
    // 替换后的同一步骤(参数齐备时与执行期逐字一致; 缺参数时仍是原样占位符)
    const effective = run.steps[index] !== null && typeof run.steps[index] === 'object' && !Array.isArray(run.steps[index])
      ? run.steps[index] : step
    // (1) 结构: 复用执行期的同一套校验, 文案逐字一致
    let planned
    try {
      planned = planSteps([step], args)[0]
    } catch (err) {
      issues.push(lintIssue('error', 'step_invalid', String(err && err.message ? err.message : err).replace(/^ecs_deploy: /, ''), at))
      return
    }
    // (2) 字段白名单: 抓笔误(多余字段会被静默忽略, 是最难发现的一类问题)
    const kind = planned.kind
    const allowed = STEP_FIELD_WHITELIST.common.concat(STEP_FIELD_WHITELIST[kind] !== undefined ? STEP_FIELD_WHITELIST[kind] : [])
    for (const key of Object.keys(step)) {
      if (allowed.includes(key)) continue
      const guess = closestFieldName(key, allowed)
      issues.push(lintIssue('warn', 'unknown_field',
        'steps[' + index + '] 的字段 ' + key + ' 不被 ' + kind + ' 步骤识别, 会被忽略' +
        (guess !== undefined ? '(是否想写 ' + guess + '?)' : ''), at))
    }
    const isUploadPlanned = kind === 'upload'
    if (isUploadPlanned && step.command !== undefined && step.kind === undefined) {
      issues.push(lintIssue('warn', 'ambiguous_kind',
        'steps[' + index + '] 同时含 local_file 与 command(未显式声明 kind): 会按 upload 处理, command 被忽略', at))
    }
    // (2b) 单步超时(v0.6.6): 合法值覆盖全局默认; 非法值被忽略、超大值被截断 ——
    // 两种"写了但没按你写的执行"都必须提前说出来, 否则又变成静默忽略。
    // 仍然含未替换占位符时跳过(缺参数那条 error 已经报过, 别重复报错)。
    const timeoutValue = effective.timeout
    if (timeoutValue !== undefined && timeoutValue !== null && !isUnresolvedPlaceholder(timeoutValue)) {
      const seconds = Number(timeoutValue)
      if (!Number.isFinite(seconds) || seconds <= 0) {
        issues.push(lintIssue('warn', 'bad_timeout',
          'steps[' + index + '] 的 timeout 不是正数(收到 ' + JSON.stringify(timeoutValue) +
          '): 会被忽略, 该步按全局超时 ' + STEPS_STAGE_TIMEOUT + ' 秒下发', at))
      } else if (seconds > STEPS_MAX_STEP_TIMEOUT) {
        issues.push(lintIssue('warn', 'timeout_clamped',
          'steps[' + index + '] 的 timeout=' + Math.floor(seconds) + ' 超过单步上限 ' + STEPS_MAX_STEP_TIMEOUT +
          ' 秒: 会按 ' + STEPS_MAX_STEP_TIMEOUT + ' 秒下发', at))
      }
    }
    // (3) 只读护栏矛盾 / 破坏性命令: 面板会直接拒绝, Agent 侧需要审批
    if (planned.payload !== undefined && planned.payload.length > 0) {
      const writeHit = checkWriteCommand(planned.payload)
      if (planned.read_only === true && writeHit !== undefined) {
        issues.push(lintIssue('error', 'read_only_conflict',
          'steps[' + index + '] 声明 read_only 但命令命中写操作模式 (' + writeHit + '), 执行时会被只读护栏拒绝', at))
      }
      const danger = DANGEROUS_PATTERNS.find((p) => p.test.test(planned.payload))
      if (danger !== undefined) {
        issues.push(lintIssue('warn', 'destructive',
          'steps[' + index + '] 命中破坏性命令模式 (' + danger.source + '): Agent 侧需要审批放行, 设置面板会直接拒绝', at))
      }
    }
    // (4) 各类型的具体建议
    if (kind === 'assert') {
      const expectKeys = step.expect !== null && typeof step.expect === 'object' && !Array.isArray(step.expect)
        ? Object.keys(step.expect) : []
      if (expectKeys.length === 0) {
        issues.push(lintIssue('warn', 'weak_assert',
          'steps[' + index + '] 是 assert 但没有内容判据(expect 为空), 实际只校验了 exit_code=0', at))
      }
    }
    if (kind === 'upload' && step.verify_sha256 === false) {
      issues.push(lintIssue('warn', 'no_verify',
        'steps[' + index + '] 显式关闭了 sha256 校验(verify_sha256: false): 传输损坏将无法发现', at))
    }
    if (kind === 'tail') {
      const wait = Number(step.wait_seconds)
      const hasWait = Number.isFinite(wait) && wait > 0
      const hasExitFile = step.exit_file !== undefined && String(step.exit_file).length > 0
      if (!hasWait && !hasExitFile) {
        issues.push(lintIssue('warn', 'tail_once',
          'steps[' + index + '] 的 tail 只读取一次(after=' + planned.after + '): 若远端文件仍在写入, 建议给 wait_seconds 或 exit_file', at))
      }
    }
  })

  // (5) 参数维度: 缺参数是 error(执行必然失败), 多余/未使用的参数只是 warn
  // (provided / run 已在循环之前算好 —— 逐条检查用的是替换后的值)
  for (const name of run.missing) {
    issues.push(lintIssue('error', 'missing_param', missingParamMessage(name)))
  }
  for (const name of run.unused) {
    issues.push(lintIssue('warn', 'unused_param', '传入的参数 ' + name + ' 未被任何步骤使用'))
  }
  const defaults = runbook.params !== undefined ? runbook.params : {}
  for (const key of Object.keys(defaults)) {
    if (!run.declared.includes(key)) {
      issues.push(lintIssue('warn', 'unused_default', 'params 里的 ' + key + ' 未被任何步骤使用(默认值不会生效)'))
    }
  }

  const errorCount = issues.filter((i) => i.level === 'error').length
  const warnCount = issues.filter((i) => i.level === 'warn').length
  return omitUndefinedRunbook({
    ok: errorCount === 0,
    name: runbook.name !== undefined ? runbook.name : opts.name,
    description: runbook.description,
    summary: summarizeRunbook(runbook),
    declared_params: run.declared,
    missing_params: run.missing.length > 0 ? run.missing : undefined,
    issues,
    error_count: errorCount,
    warn_count: warnCount,
  })
}

// 本模块内的 omitUndefined(与 common.js 语义一致): runbooks.js 不引入额外依赖面
function omitUndefinedRunbook(value) {
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(omitUndefinedRunbook)
  const out = {}
  for (const key of Object.keys(value)) {
    if (value[key] === undefined) continue
    out[key] = omitUndefinedRunbook(value[key])
  }
  return out
}

