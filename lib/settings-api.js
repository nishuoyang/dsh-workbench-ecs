// ============================================================================
// lib/settings-api.js —— 设置页 RPC 核心 (host 侧, 与 DSH 上下文无关)
// ----------------------------------------------------------------------------
// createSettingsCore(runCli, deps) 返回一组纯逻辑操作, 由 lib/index.js 的
// /dsh-workbench-ecs 路由调用; runCli(argv) 每次运行一条 workbench 命令,
// 返回 { exitCode, stdout, stderr }。把 CLI 依赖整个抽出, 使 RPC 可以
// 在单元测试里用 Node child_process 替换, 无需运行中的 Harness。
//
// v0.6.2 起 deps 再注入三件事, 让面板也能"列出/预演/执行"工作区 runbook:
//   listRunbooks()            -> 可用 runbook 名字(无 fs 时返回 [])
//   loadRunbook(name)         -> { text, path }(失败信息里带可用名字)
//   makeStepsAdapter(args)    -> steps 引擎的本机执行适配器(见 steps-engine.js)
// 三者都由 lib/index.js 用真实 ctx(fs / subprocess / 实例锁)装配, 本模块
// 因此仍然不依赖任何 DSH 服务, 保持可单测。
// ============================================================================
import { DANGEROUS_PATTERNS, decodeLoose, guardReadOnly, withInstanceLock, omitUndefined } from './common.js'
import { parseRunbook, buildRunbookRun, summarizeRunbook, lintRunbook } from './runbooks.js'
import { planSteps, planPreview, assertStepCount, runSteps } from './steps-engine.js'


// ----------------------------------------------------------------------------
// 破坏性命令检测 (UI 层直接拒绝, 不做审批 —— 与 ecs_exec 工具审批互补)
// ----------------------------------------------------------------------------
export function checkDangerous(command) {
  const cmd = command != null ? String(command) : ''
  const hit = DANGEROUS_PATTERNS.find((p) => p.test.test(cmd))
  return hit !== undefined ? hit.source : undefined
}

// ----------------------------------------------------------------------------
// 标准实例字段提取 (workbench list output json 的字段名保守兼容)
// ----------------------------------------------------------------------------
function normalizeInstance(it) {
  if (it == null) return null
  return {
    instance_id: String(it.instance_id != null ? it.instance_id : ''),
    instance_name: String(it.instance_name != null ? it.instance_name : ''),
    instance_type: String(it.instance_type != null ? it.instance_type : ''),
    region_id: String(it.region_id != null ? it.region_id : ''),
    status: String(it.status != null ? it.status : ''),
    private_ip: String(it.private_ip != null ? it.private_ip : ''),
    public_ip: String(it.public_ip != null ? it.public_ip : ''),
    os_type: String(it.os_type != null ? it.os_type : ''),
    image_id: String(it.image_id != null ? it.image_id : ''),
    tags: JSON.stringify(it.tags != null ? it.tags : {}),
  }
}

// ----------------------------------------------------------------------------
// 组装 RPC 操作集合。状态结果 20 秒 TTL 缓存 (force 重查), 复用 v4 行为。
// ----------------------------------------------------------------------------
export function createSettingsCore(runCli, deps = {}) {
  const statusCache = { at: 0, value: null }
  // in-flight 共享: 并发 status 请求(面板挂载 + 手动刷新)只跑一轮 CLI,
  // 其余请求复用同一结果; 完成后清空, 缓存逻辑不变。
  let statusInflight = null

  // 单次 exec 调用 (deploy 复用)
  async function execOnce(instanceId, command, timeout, region) {
    const argv = ['exec', '--instance-id', instanceId, '--command', command, '--output', 'json']
    if (timeout != null && timeout > 0) argv.push('--timeout', String(timeout))
    if (region != null && region !== '') argv.push('--region', region)
    // 与 Agent 工具共用同一实例锁: 设置页并发操作同实例时也不串流
    const r = await withInstanceLock(instanceId, () => runCli(argv))
    let j
    try {
      j = decodeLoose(r, 'exec').json
    } catch (err) {
      return { ok: false, exit_code: r.exitCode != null ? r.exitCode : 0, output: '', stderr: String(r.stderr || ''), error: String((err && err.message) || err) }
    }
    return {
      ok: r.exitCode == null || r.exitCode === 0,
      exit_code: r.exitCode != null ? r.exitCode : 0,
      output: j != null && j.output != null ? String(j.output) : '',
      stderr: j != null && j.stderr != null ? String(j.stderr) : '',
    }
  }

  async function status(args) {
    const force = args != null && args.force === true
    const now = Date.now()
    if (force !== true && statusCache.value !== null && (now - statusCache.at) < 20000) {
      return Object.assign({}, statusCache.value, { cached: true, cached_at: statusCache.at })
    }
    if (statusInflight === null) {
      statusInflight = readStatusFresh().finally(() => { statusInflight = null })
    }
    return statusInflight
  }

  async function readStatusFresh() {
    let v
    let cfg
    let dm
    try {
      v = await runCli(['version'])
      cfg = await runCli(['config', 'get'])
      dm = await runCli(['daemon', 'status'])
    } catch (err) {
      return { cli_ok: false, error: String((err != null && err.message != null) ? err.message : err) }
    }
    let mode = ''
    let profile = ''
    try {
      const j = decodeLoose(cfg, 'config').json
      if (j !== undefined && j !== null && typeof j === 'object') {
        mode = j.mode || ''
        profile = j.profile || ''
        if (j.current != null) profile = String(j.current)
      }
    } catch (e2) { /* config 非 JSON 时忽略 */ }
    const versionText = (v.stdout.trim() + ' ' + v.stderr.trim()).trim()
    const result = {
      cli_ok: true,
      version: versionText.split('\n')[0],
      config_exists: (cfg.stdout.trim() + cfg.stderr.trim()).length > 0,
      profile: profile || '',
      mode: mode || '',
      daemon: /running|alive|\bok\b/i.test(dm.stdout + ' ' + dm.stderr),
    }
    statusCache.value = result
    statusCache.at = Date.now()
    return Object.assign({}, result, { cached: true, cached_at: statusCache.at })
  }

  async function list(args) {
    const region = (args != null && args.region) || 'cn-hangzhou'
    const argv = ['list', 'ecs', '--region', region, '--output', 'json']
    if (args != null && args.status) argv.push('--status', args.status)
    const r = await runCli(argv)
    const j = decodeLoose(r, 'list').json
    const insts = Array.isArray(j) ? j : (j != null && Array.isArray(j.instances) ? j.instances : [])
    return { ok: true, instances: insts.map(normalizeInstance).filter((x) => x != null) }
  }

  async function exec(args) {
    if (args == null || !args.instance_id || !args.command) {
      return { ok: false, error: '需要 instance_id 与 command' }
    }
    const hit = checkDangerous(args.command)
    if (hit !== undefined) {
      return {
        ok: false,
        error: '已拦截破坏性命令 (' + hit + '), 请通过 Agent 的 ecs_exec 工具(带审批守卫)执行: ' +
          String(args.command).slice(0, 200),
      }
    }
    return execOnce(args.instance_id, args.command, args.timeout, args.region)
  }

  async function deploy(args) {
    if (args == null || !args.instance_id) return { ok: false, error: '需要 instance_id' }
    const stages = []
    const timeout = (args.timeout != null ? args.timeout : 120) || 120
    try {
      if (args.local_file != null && args.local_file !== '') {
        if (args.remote_path == null || args.remote_path === '') {
          return { ok: false, error: '提供 local_file 时必须同时提供 remote_path' }
        }
        const argv = ['upload', args.local_file, args.remote_path, '--instance-id', args.instance_id, '--output', 'json']
        if (args.force === true) argv.push('--force')
        if (args.region != null && args.region !== '') argv.push('--region', args.region)
        const r = await withInstanceLock(args.instance_id, () => runCli(argv))
        const j = decodeLoose(r, 'upload').json
        const text = j != null && j.text != null ? String(j.text)
          : (j != null && typeof j === 'object' && j.output != null ? String(j.output)
            : (r.stdout.trim() !== '' ? r.stdout.trim() : ''))
        stages.push({ name: '上传 ' + args.local_file, ok: r.exitCode == null || r.exitCode === 0, exit_code: r.exitCode != null ? r.exitCode : 0, output: text, error: undefined })
      }
      const cmdHit = checkDangerous(args.command)
      if (cmdHit !== undefined) {
        stages.push({ name: '重启/生效', ok: false, exit_code: 0, output: '', error: '已拦截破坏性命令 (' + cmdHit + ')' })
        return { ok: false, stages }
      }
      const restart = await execOnce(args.instance_id, args.command, timeout, args.region)
      stages.push({
        name: '重启/生效', ok: restart.ok, exit_code: restart.exit_code,
        output: restart.output, error: restart.ok ? undefined : String(restart.error || restart.stderr || ''),
      })
      if (args.health_check != null && args.health_check !== '') {
        const hcHit = checkDangerous(args.health_check)
        if (hcHit !== undefined) {
          stages.push({ name: '健康检查', ok: false, exit_code: 0, output: '', error: '已拦截破坏性命令 (' + hcHit + ')' })
        } else {
          const hc = await execOnce(args.instance_id, args.health_check, timeout, args.region)
          stages.push({ name: '健康检查', ok: hc.ok, exit_code: hc.exit_code, output: hc.output, error: hc.ok ? undefined : String(hc.error || hc.stderr || '') })
        }
      }
      return { ok: stages.every((s) => s.ok === true), stages }
    } catch (err) {
      return { ok: false, error: String((err != null && err.message != null) ? err.message : err) }
    }
  }

  async function sessionList() {
    const r = await runCli(['session', 'list', '--output', 'json'])
    const j = decodeLoose(r, 'session-list').json
    return Array.isArray(j) ? j
      : (j != null && Array.isArray(j.sessions) ? j.sessions
        : (j != null && typeof j === 'object' ? [j] : []))
  }

  async function sessionClose(args) {
    try {
      const argv = ['session', 'close']
      if (args != null && args.session_id) argv.push(String(args.session_id))
      else argv.push('--all')
      argv.push('--output', 'json')
      const r = await runCli(argv)
      const j = decodeLoose(r, 'session-close').json
      let message = r.stdout.trim() || 'ok'
      if (j != null && typeof j === 'object' && j.message != null) message = String(j.message)
      return { ok: true, message }
    } catch (err) {
      return { ok: false, error: String((err != null && err.message != null) ? err.message : err) }
    }
  }

  // --------------------------------------------------------------------------
  // Runbook(v0.6.2): 面板侧的"列出 / 预演 / 执行"
  // ----------------------------------------------------------------------------
  // 与模型工具 ecs_deploy 走**同一个引擎**(lib/steps-engine.js), 因此面板
  // 预演出来的命令行与 Agent 真正下发的逐字一致。差别只在守卫:
  //   - Agent 侧: 破坏性命令走 Harness 审批, 获批才继续;
  //   - 面板侧: 没有审批上下文, 命中即直接拒绝(与 exec 操作同一口径)。
  // --------------------------------------------------------------------------
  const PANEL_STAGE_TEXT_LIMIT = 4000

  function message(err) {
    return String(err != null && err.message != null ? err.message : err)
  }

  // 跑书目录: 优先 deps.runbookDirOf(args)(面板可传 dir 覆盖 / 跟随最近会话工作区),
  // 兼容旧的固定字符串 deps.runbookDir。
  function runbookDirArgs(args) {
    const safe = args !== null && args !== undefined && typeof args === 'object' ? args : {}
    if (typeof deps.runbookDirOf === 'function') {
      try {
        return String(deps.runbookDirOf(safe))
      } catch (err) {
        /* 回落固定目录 */
      }
    }
    return String(deps.runbookDir != null ? deps.runbookDir : '')
  }

  function clipText(text) {
    const s = String(text != null ? text : '')
    if (s.length <= PANEL_STAGE_TEXT_LIMIT) return s
    return s.slice(0, PANEL_STAGE_TEXT_LIMIT) + '\n… [已截断 ' + (s.length - PANEL_STAGE_TEXT_LIMIT) + ' 字符, 完整内容请用 Agent 侧 ecs_deploy / ecs_log 查看]'
  }

  // 参数既接受对象(工具/RPC 直传), 也接受 JSON 文本(面板的参数输入框)
  function readParams(raw) {
    if (raw === undefined || raw === null || raw === '') return { params: {} }
    if (typeof raw === 'string') {
      try {
        const parsed = JSON.parse(raw)
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
          return { error: '参数必须是 JSON 对象, 例如 {"sha":"abc123"}' }
        }
        return { params: parsed }
      } catch (err) {
        return { error: '参数不是合法 JSON: ' + message(err) }
      }
    }
    if (typeof raw !== 'object' || Array.isArray(raw)) return { error: '参数必须是 JSON 对象' }
    return { params: raw }
  }

  async function resolveRunbookInput(raw, args) {
    const implicit = omitUndefined({ instance_id: args.instance_id, region: args.region })
    if (typeof raw === 'string' && raw.length > 0) {
      const loaded = await deps.loadRunbook(raw, args)
      const runbook = parseRunbook(loaded.text, 'runbook ' + raw)
      return { runbook, name: runbook.name !== undefined ? runbook.name : raw, path: loaded.path, implicit }
    }
    if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
      const runbook = parseRunbook(JSON.stringify(raw), 'runbook(内联)')
      return { runbook, name: runbook.name !== undefined ? runbook.name : '(内联)', path: undefined, implicit }
    }
    throw new Error('runbook 必须是名字字符串(读工作区 ' + String(runbookDirArgs(args)) + '/<name>.json)或内联对象 { params?, steps }')
  }

  // 预演与执行共用: 解析 runbook → 合并参数 → 校验结构 → 产出计划
  async function buildRunbookPlan(args) {
    if (typeof deps.loadRunbook !== 'function') {
      return { ok: false, error: '当前环境未提供 runbook 读取能力(缺少 fs 服务)' }
    }
    const rawParams = args.params !== undefined ? args.params : args.runbook_params
    const paramsResult = readParams(rawParams)
    if (paramsResult.error !== undefined) return { ok: false, error: paramsResult.error }
    let resolved
    try {
      resolved = await resolveRunbookInput(args.runbook, args)
    } catch (err) {
      return { ok: false, error: message(err) }
    }
    const run = buildRunbookRun(resolved.runbook, paramsResult.params, resolved.implicit)
    const shape = summarizeRunbook(resolved.runbook)
    const meta = omitUndefined({
      name: resolved.name,
      source: resolved.path !== undefined ? 'workspace' : 'inline',
      path: resolved.path,
      description: resolved.runbook.description,
      param_keys: Object.keys(paramsResult.params).sort().length > 0 ? Object.keys(paramsResult.params).sort() : undefined,
      declared_params: run.declared.length > 0 ? run.declared : undefined,
      unused_params: run.unused.length > 0 ? run.unused : undefined,
    })
    if (run.missing.length > 0) {
      return {
        ok: false,
        error: 'runbook ' + resolved.name + ' 缺少参数: ' + run.missing.join(', ') +
          '(该 runbook 声明的占位符: ' + (run.declared.length > 0 ? run.declared.join(', ') : '(无)') + ')',
        runbook: meta,
        missing: run.missing,
        declared: run.declared,
        shape,
      }
    }
    let plan
    try {
      assertStepCount(run.steps)
      plan = planSteps(run.steps, { instance_id: args.instance_id, region: args.region, timeout: args.timeout, read_only: args.read_only })
    } catch (err) {
      return { ok: false, error: message(err), runbook: meta, shape }
    }
    return { ok: true, plan, meta, run, shape }
  }

  async function runbookList(args) {
    // 归一化: RPC 可能不带参数调用, 而目录解析/文件读取都要看到同一个 args
    const input = args !== null && args !== undefined && typeof args === 'object' ? args : {}
    if (typeof deps.listRunbooks !== 'function') {
      return { ok: true, dir: runbookDirArgs(input), runbooks: [] }
    }
    let names = []
    try {
      names = await deps.listRunbooks(input)
    } catch (err) {
      return { ok: false, error: message(err) }
    }
    const runbooks = []
    for (const name of names) {
      try {
        const loaded = await deps.loadRunbook(name, input)
        const runbook = parseRunbook(loaded.text, 'runbook ' + name)
        const shape = summarizeRunbook(runbook)
        // 顺便静态校验(v0.6.3): 列表里就能看出"这份跑书写坏了"。
        // "缺参数"在此视图里不算问题 —— 是否缺取决于本次要传什么; 需要齐备性用 runbook-validate。
        const lint = lintRunbook(runbook, { name })
        const structural = lint.issues.filter((i) => i.code !== 'missing_param')
        const defaults = shape.params
        const required = shape.declared_params.filter((key) => !Object.prototype.hasOwnProperty.call(defaults, key) &&
          key !== 'instance_id' && key !== 'region')
        runbooks.push(omitUndefined({
          name,
          path: loaded.path,
          display_name: runbook.name,
          description: runbook.description,
          valid: true,
          step_count: shape.step_count,
          kinds: shape.kinds,
          declared_params: shape.declared_params,
          required_params: required.length > 0 ? required : undefined,
          params: shape.params,
          lint_ok: structural.every((i) => i.level !== 'error'),
          error_count: structural.filter((i) => i.level === 'error').length,
          warn_count: structural.filter((i) => i.level === 'warn').length,
          first_issue: structural.length > 0 ? structural[0].message : undefined,
        }))
      } catch (err) {
        runbooks.push({ name, valid: false, lint_ok: false, error_count: 1, warn_count: 0, error: message(err) })
      }
    }
    return { ok: true, dir: runbookDirArgs(input), runbooks }
  }

  // runbook-validate(v0.6.3): 对单份 runbook 逐条给出静态校验问题
  async function runbookValidate(args) {
    const input = args != null ? args : {}
    if (typeof deps.loadRunbook !== 'function') {
      return { ok: false, error: '当前环境未提供 runbook 读取能力(缺少 fs 服务)' }
    }
    let loaded
    try {
      if (typeof input.runbook === 'string' && input.runbook.length > 0) {
        loaded = Object.assign({ source: 'workspace', name: input.runbook }, await deps.loadRunbook(input.runbook, input))
      } else if (input.runbook !== null && typeof input.runbook === 'object' && !Array.isArray(input.runbook)) {
        loaded = { text: JSON.stringify(input.runbook), source: 'inline', name: input.runbook.name !== undefined ? String(input.runbook.name) : '(内联)' }
      } else {
        return { ok: false, error: 'runbook 必须是名字字符串或内联对象' }
      }
    } catch (err) {
      return { ok: false, error: message(err) }
    }
    const paramsResult = readParams(input.params !== undefined ? input.params : input.runbook_params)
    if (paramsResult.error !== undefined) return { ok: false, error: paramsResult.error }
    const report = lintRunbook(loaded.text, {
      name: loaded.name,
      params: paramsResult.params,
      instance_id: input.instance_id,
      region: input.region,
    })
    return Object.assign({ path: loaded.path, source: loaded.source }, report)
  }

  async function runbookPlan(args) {
    const built = await buildRunbookPlan(args != null ? args : {})
    if (built.ok !== true) {
      return omitUndefined({
        ok: false, error: built.error,
        runbook: built.runbook, missing: built.missing, declared_params: built.declared,
      })
    }
    return Object.assign(planPreview(built.plan, args, { runbook: built.meta }), {
      ok: true,
      dry_run: true,
      missing: [],
      shape: built.shape,
      resolved_params: built.run.params,
      valid: true,
    })
  }

  async function runbookRun(args) {
    if (args == null || args.instance_id === undefined || String(args.instance_id).length === 0) {
      return { ok: false, error: '需要 instance_id' }
    }
    const built = await buildRunbookPlan(args)
    if (built.ok !== true) {
      return omitUndefined({
        ok: false, error: built.error,
        runbook: built.runbook, missing: built.missing, declared_params: built.declared,
      })
    }
    // 预演分支: 与 runbookPlan 同一份输出(面板的"预演"按钮)
    if (args.dry_run === true) {
      return Object.assign(planPreview(built.plan, args, { runbook: built.meta }), {
        ok: true, missing: [], shape: built.shape, resolved_params: built.run.params, valid: true,
      })
    }
    // 面板无审批上下文 → 破坏性命令直接拒绝; read_only 步骤按只读护栏预检
    for (const step of built.plan) {
      if (step.read_only === true) {
        try {
          guardReadOnly(step.payload, 'runbook steps[' + step.index + ']')
        } catch (err) {
          return { ok: false, error: message(err), runbook: built.meta }
        }
      }
      if (step.kind === 'exec' || step.kind === 'assert') {
        const hit = checkDangerous(step.payload)
        if (hit !== undefined) {
          return {
            ok: false,
            runbook: built.meta,
            error: '已拦截破坏性命令 (' + hit + ') 于步骤 [' + step.index + '] ' + step.name +
              '; 面板无审批上下文, 请改用 Agent 的 ecs_deploy 工具(带审批守卫)执行',
          }
        }
      }
    }
    const adapter = typeof deps.makeStepsAdapter === 'function' ? deps.makeStepsAdapter(args) : undefined
    if (adapter === undefined) {
      return { ok: false, error: '当前环境未提供本机执行适配器, 面板无法执行 runbook(可用 Agent 的 ecs_deploy 工具)', runbook: built.meta }
    }
    try {
      const result = await withInstanceLock(args.instance_id, async () => {
        return await runSteps(adapter, built.plan, args, { extra: { runbook: built.meta } })
      })
      return Object.assign({}, result, {
        stages: result.stages.map((stage) => omitUndefined(Object.assign({}, stage, {
          output: stage.output !== undefined ? clipText(stage.output) : undefined,
          stderr: stage.stderr !== undefined ? clipText(stage.stderr) : undefined,
        }))),
      })
    } catch (err) {
      return { ok: false, error: message(err), runbook: built.meta }
    }
  }

  return { status, list, exec, deploy, sessionList, sessionClose, runbookList, runbookValidate, runbookPlan, runbookRun }
}
