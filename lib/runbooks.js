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
// 隐式可用参数: instance_id、region(由调用参数带入)。
// ----------------------------------------------------------------------------
// ----------------------------------------------------------------------------

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

function has(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key)
}

// 递归替换占位符。missing 非空时, 未提供的参数名会被收集进去(而不是静默留空)。
export function substituteParams(value, params, missing) {
  if (typeof value === 'string') {
    const exact = PLACEHOLDER_EXACT_RE.exec(value)
    if (exact !== null) {
      const key = exact[1]
      if (has(params, key)) return params[key]
      if (missing !== undefined) missing.add(key)
      return value
    }
    return value.replace(PLACEHOLDER_SCAN_RE, (whole, key) => {
      if (has(params, key)) return String(params[key])
      if (missing !== undefined) missing.add(key)
      return whole
    })
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
    PLACEHOLDER_SCAN_RE.lastIndex = 0
    let match = PLACEHOLDER_SCAN_RE.exec(value)
    while (match !== null) {
      names.add(match[1])
      match = PLACEHOLDER_SCAN_RE.exec(value)
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
  const rootRaw = opts.workspaceRoot !== undefined && opts.workspaceRoot !== null ? String(opts.workspaceRoot) : ''
  const root = rootRaw.replace(/[\\/]+$/, '')
  const dir = (root.length > 0 ? root + '/' : '') + RUNBOOK_DIR
  return { fs, dir }
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
