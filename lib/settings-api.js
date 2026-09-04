// ============================================================================
// lib/settings-api.js —— 设置页 RPC 核心 (host 侧, 与 DSH 上下文无关)
// ----------------------------------------------------------------------------
// createSettingsCore(runCli) 返回一组纯逻辑操作, 由 lib/index.js 的
// /dsh-workbench-ecs 路由调用; runCli(argv) 每次运行一条 workbench 命令,
// 返回 { exitCode, stdout, stderr }。把 CLI 依赖整个抽出, 使 RPC 可以
// 在单元测试里用 Node child_process 替换, 无需运行中的 Harness。
// ============================================================================
import { DANGEROUS_PATTERNS, decodeLoose } from './common.js'

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
export function createSettingsCore(runCli) {
  const statusCache = { at: 0, value: null }
  // in-flight 共享: 并发 status 请求(面板挂载 + 手动刷新)只跑一轮 CLI,
  // 其余请求复用同一结果; 完成后清空, 缓存逻辑不变。
  let statusInflight = null

  // 单次 exec 调用 (deploy 复用)
  async function execOnce(instanceId, command, timeout, region) {
    const argv = ['exec', '--instance-id', instanceId, '--command', command, '--output', 'json']
    if (timeout != null && timeout > 0) argv.push('--timeout', String(timeout))
    if (region != null && region !== '') argv.push('--region', region)
    const r = await runCli(argv)
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
        const r = await runCli(argv)
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

  return { status, list, exec, deploy, sessionList, sessionClose }
}
