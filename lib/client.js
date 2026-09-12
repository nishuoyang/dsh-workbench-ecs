// ============================================================================
// lib/client.js —— dsh-workbench-ecs 浏览器半 (单文件 client bundle)
// ----------------------------------------------------------------------------
// 以 DSH 客户端模块系统的工厂形式注册: window.__ModuleLoader__.load({id, factory})。
// 仅 require 平台种子 'react'; 宿主交互全部走同源路由 /dsh-workbench-ecs/rpc
// (host 侧由 lib/index.js 的 webServer.register 提供, 见 cordis.patch.yml)。
// 面板能力: CLI 状态(20s 缓存+本地秒显)/实例列表(搜索/批量/30s 自动刷新)/
//          一键诊断+磁盘内存仪表盘/受控发布向导+模板/远程命令(破坏性两次确认+
//          历史)/会话管理/操作时间线/实例详情+日志。
// 已并入 v4→v5 的布局补丁: 面板 100% 撑满设置页, 表格横向滚动不裁列。
// ============================================================================
window.__ModuleLoader__.load({
  id: 'dsh-workbench-ecs',
  factory: function (require) {
    var module = { exports: {} }
    var exports = module.exports
    var React = require('react')

    // ---------- 样式 (双主题 + 布局修复, !important 已并入基础规则) ----------
    var CSS_TEXT =
      '.wbecs-panel{--wb-bg:#f9fafb;--wb-layer1:#ffffff;--wb-layer2:#f2f3f5;--wb-overlay:#ffffff;--wb-border1:#e5e6e8;--wb-border2:#d4d6da;--wb-brand:#4176e6;--wb-label1:#0f1115;--wb-label2:#61666b;--wb-ok:#22c55e;--wb-warn:#f59e0b;--wb-err:#dc2626;display:flex;flex-direction:column;gap:16px;width:100%;min-width:0;max-width:none;box-sizing:border-box;font-size:13px;color:var(--wb-label1)}' +
      'body[data-ds-dark-theme] .wbecs-panel{--wb-bg:#151517;--wb-layer1:#1d1d20;--wb-layer2:#26262a;--wb-overlay:#2c2c31;--wb-border1:#33353a;--wb-border2:#474950;--wb-brand:#4d8dff;--wb-label1:#f9fafb;--wb-label2:#cfd3d6;--wb-ok:#39c66d;--wb-warn:#e0a53d;--wb-err:#e5534b}' +
      '.wbecs-card{background:var(--wb-layer1);border:1px solid var(--wb-border1);border-radius:10px;padding:14px 16px;box-sizing:border-box;min-width:0;max-width:100%}' +
      '.wbecs-card h3{margin:0 0 10px;font-size:14px;font-weight:600;color:var(--wb-label1)}' +
      '.wbecs-row{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:10px}' +
      '.wbecs-input,.wbecs-select{background:var(--wb-layer2);border:1px solid var(--wb-border2);border-radius:6px;color:var(--wb-label1);padding:5px 9px;font-size:13px;min-width:110px}' +
      '.wbecs-input:focus,.wbecs-select:focus{outline:none;border-color:var(--wb-brand)}' +
      '.wbecs-btn{background:var(--wb-overlay);border:1px solid var(--wb-border2);border-radius:6px;color:var(--wb-label1);padding:5px 12px;font-size:13px;cursor:pointer}' +
      '.wbecs-btn:hover:not(:disabled){border-color:var(--wb-brand)}' +
      '.wbecs-btn:disabled{opacity:.45;cursor:default}' +
      '.wbecs-btn-primary{background:var(--wb-brand);border-color:var(--wb-brand);color:#fff}' +
      '.wbecs-btn-danger{border-color:var(--wb-err);color:var(--wb-err)}' +
      '.wbecs-btn-confirm{border-color:var(--wb-err);color:#fff;background:var(--wb-err)}' +
      '.wbecs-badge{display:inline-block;border-radius:4px;padding:1px 7px;font-size:11px;background:var(--wb-layer2);border:1px solid var(--wb-border1)}' +
      '.wbecs-badge-ok{color:var(--wb-ok);border-color:var(--wb-ok)}' +
      '.wbecs-badge-warn{color:var(--wb-warn);border-color:var(--wb-warn)}' +
      '.wbecs-badge-err{color:var(--wb-err);border-color:var(--wb-err)}' +
      '.wbecs-table{width:100%;display:block;overflow-x:auto;border-collapse:collapse;font-size:12.5px}' +
      '.wbecs-table th{text-align:left;padding:6px 8px;color:var(--wb-label2);border-bottom:1px solid var(--wb-border1);font-weight:500;white-space:nowrap}' +
      '.wbecs-table td{padding:6px 8px;border-bottom:1px solid var(--wb-border1);white-space:nowrap}' +
      '.wbecs-table tbody tr:hover td{background:var(--wb-layer2)}' +
      '.wbecs-pre{background:var(--wb-bg);border:1px solid var(--wb-border1);border-radius:8px;padding:10px 12px;font-family:ui-monospace,Consolas,monospace;font-size:12px;line-height:1.55;white-space:pre-wrap;word-break:break-all;max-height:300px;max-width:100%;overflow:auto;box-sizing:border-box;color:var(--wb-label1)}' +
      '.wbecs-empty{color:var(--wb-label2);padding:8px 0}' +
      '.wbecs-status-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px;width:100%}' +
      '.wbecs-kv{display:flex;flex-direction:column;gap:2px}' +
      '.wbecs-kv .k{color:var(--wb-label2);font-size:11px}' +
      '.wbecs-kv .v{font-weight:500}' +
      '.wbecs-mono{font-family:ui-monospace,Consolas,monospace;font-size:12px}' +
      '.wbecs-actions{display:flex;gap:6px;align-items:center}' +
      '.wbecs-exec-form{display:flex;gap:8px;flex-wrap:wrap}' +
      '.wbecs-exec-form .wbecs-input{flex:1;min-width:0}' +
      '.wbecs-strip{display:flex;gap:10px;flex-wrap:wrap;margin:0 0 10px}' +
      '.wbecs-strip .seg{display:inline-flex;align-items:center;gap:5px;font-size:12px;color:var(--wb-label2)}' +
      '.wbecs-strip .dot{width:8px;height:8px;border-radius:50%}' +
      '.wbecs-bar{background:var(--wb-layer2);border-radius:999px;height:8px;overflow:hidden;flex:1;min-width:60px}' +
      '.wbecs-barFill{height:100%;border-radius:999px}' +
      '.wbecs-modal-back{position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:1000;display:flex;align-items:center;justify-content:center}' +
      '.wbecs-modal{background:var(--wb-layer1);border:1px solid var(--wb-border2);border-radius:14px;padding:18px 20px;width:min(640px,92vw);max-height:80vh;overflow:auto;box-shadow:0 12px 40px rgba(0,0,0,.35)}' +
      '.wbecs-modal h3{margin:0 0 12px;font-size:15px}' +
      '.wbecs-modal .wbecs-row{margin-bottom:8px}' +
      '.wbecs-modal .wbecs-input{max-width:100%;box-sizing:border-box}' +
      '.wbecs-stage{display:flex;gap:8px;align-items:center;padding:8px 0;border-bottom:1px solid var(--wb-border1)}' +
      '.wbecs-flex{display:flex;gap:12px;align-items:center;flex-wrap:wrap}' +
      '.wbecs-check{width:16px;height:16px;accent-color:var(--wb-brand)}' +
      '.wbecs-tl{font-family:ui-monospace,Consolas,monospace;font-size:12px;color:var(--wb-label2)}'

    // ---------- 同源 RPC: POST /dsh-workbench-ecs/rpc ----------
    function rpc(op, args) {
      return fetch('/dsh-workbench-ecs/rpc', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ op: op, args: args === undefined || args === null ? {} : args }),
      }).then(function (resp) {
        if (!resp.ok) {
          return resp.json().catch(function () { return { ok: false, error: 'RPC HTTP ' + resp.status } })
        }
        return resp.json()
      })
    }

    // ---------- 纯辅助 ----------
    function el(type, props) {
      return React.createElement.apply(null, [type, props].concat(Array.prototype.slice.call(arguments, 2)))
    }
    function parseDisk(text) {
      const rows = []
      const lines = String(text).split('\n')
      for (const line of lines) {
        const m = /(\d+)%\s+(\/[^\s]+)\s*$/.exec(line)
        if (m != null) rows.push({ mount: m[2], pct: Number(m[1]) })
      }
      return rows
    }
    function parseMem(text) {
      const line = String(text).split('\n').find((l) => /^Mem:/i.test(l.trim()))
      if (line == null) return null
      const nums = line.trim().split(/\s+/).slice(1).map((x) => Number(x)).filter((n) => Number.isFinite(n) && n >= 0)
      if (nums.length < 2) return null
      const total = nums[0]
      const used = nums[1]
      return { total, used, pct: total > 0 ? Math.round((used / total) * 100) : 0 }
    }
    // 面板侧预检(双保险, 真源是 host 的 DANGEROUS_PATTERNS —— lib/common.js;
    // 面板仅做快速提示, 最终拦截始终由 host 完成。
    // 修改模式时请与 DANGEROUS_PATTERNS 保持同步。)
    function isDangerousCommand(cmd) {
      const c = String(cmd || '')
      return /(^|[;&|]\s*)rm\s+-[a-zA-Z]*(?:r[a-zA-Z]*f|f[a-zA-Z]*r)/.test(c) ||
        /(^|[;&|]\s*|\b)(shutdown|poweroff|reboot|halt)\b/.test(c) ||
        /\bmkfs(\.[a-z0-9]+)?\s/.test(c) || /\bdd\b\s+(if=|of=\/dev\/)/.test(c) ||
        /\binit\s+[06]\b/.test(c) || /\bsystemctl\s+(stop|disable|mask)\b/.test(c) ||
        /\bservice\s+[a-z0-9_.-]+\s+stop\b/.test(c) || /\biptables\s+-[FX]\b/.test(c) ||
        /\b(userdel|groupdel)\b/.test(c)
    }
    function timestamps(now) {
      const d = new Date(now)
      const pad = (n) => String(n).padStart(2, '0')
      return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds())
    }
    // 状态缓存: 模块级 + localStorage(3 分钟 TTL) —— 面板秒开
    let lastStatus = null
    function readCachedStatus() {
      if (lastStatus !== null) return lastStatus
      try {
        if (typeof localStorage === 'undefined') return null
        const raw = localStorage.getItem('wbecs-status-cache')
        if (raw == null) return null
        const j = JSON.parse(raw)
        if (j != null && j.at != null && (Date.now() - j.at) < 180000 && j.value != null) {
          return Object.assign({}, j.value, { cached_at: j.at })
        }
      } catch (e) { /* localStorage 不可用时静默跳过 */ }
      return null
    }
    function rememberStatus(value, at) {
      lastStatus = value
      try {
        if (typeof localStorage === 'undefined') return
        localStorage.setItem('wbecs-status-cache', JSON.stringify({ at: at != null ? at : Date.now(), value }))
      } catch (e2) { /* 同上 */ }
    }

    // ---------- 设置页面板 ----------
    function WorkbenchPanel() {
      const [status, setStatus] = React.useState(null)
      const [statusErr, setStatusErr] = React.useState('')
      const [statusBusy, setStatusBusy] = React.useState(false)
      const [region, setRegion] = React.useState('cn-shanghai')
      const [filter, setFilter] = React.useState('')
      const [search, setSearch] = React.useState('')
      const [autoRefresh, setAutoRefresh] = React.useState(false)
      const [instances, setInstances] = React.useState([])
      const [listErr, setListErr] = React.useState('')
      const [listBusy, setListBusy] = React.useState(false)
      const [selected, setSelected] = React.useState([])
      const [execTarget, setExecTarget] = React.useState('')
      const [execCmd, setExecCmd] = React.useState('df -h')
      const [execTimeout, setExecTimeout] = React.useState('30')
      const [execBusy, setExecBusy] = React.useState(false)
      const [execResult, setExecResult] = React.useState(null)
      const [confirmArm, setConfirmArm] = React.useState(false)
      const [history, setHistory] = React.useState([])
      const [diag, setDiag] = React.useState({ open: false, id: '', data: null, err: '', busy: false })
      const [detail, setDetail] = React.useState({ open: false, inst: null, log: '', logBusy: false })
      const [pb, setPb] = React.useState({ open: false, id: '', mode: 'manual', runbookName: '', runbookParams: '', preview: false, form: { local_file: '', remote_path: '', command: 'systemctl restart nginx', health_check: '', force: true, timeout: 120 }, stages: [], busy: false, error: '' })
      // Runbook(v0.6.2): 面板里列出工作区的发布跑书并支持预演/执行。
      // runbook 是**纯数据**(步骤 + 断言 + ${参数} 占位), 脚本本体留在项目仓库。
      const [rb, setRb] = React.useState({ list: [], dir: '', dirOverride: '', busy: false, err: '', target: '', params: '', active: '', preview: null, result: null, runBusy: false, error: '', validate: null, validateFor: '' })
      const [templates, setTemplates] = React.useState([{ name: '重启 nginx', local_file: '', remote_path: '', command: 'systemctl restart nginx', health_check: 'curl -fsS http://127.0.0.1/ || true' }, { name: '重启奶龙容器', local_file: '', remote_path: '', command: 'cd /root/nailonghub && docker compose -f docker-compose.prod.yml restart', health_check: 'curl -fsS http://127.0.0.1/ || true' }])
      const [templName, setTemplName] = React.useState('')
      const [sessions, setSessions] = React.useState([])
      const [sessBusy, setSessBusy] = React.useState(false)
      const [sessMsg, setSessMsg] = React.useState('')
      const [log, setLog] = React.useState([])
      function pushLog(kind, text) {
        setLog((prev) => [{ t: timestamps(Date.now()), kind, text: String(text).slice(0, 400) }].concat(prev).slice(0, 30))
      }
      async function call(op, args) {
        const res = await rpc(op, args)
        pushLog(op, JSON.stringify((args != null ? args : {})))
        return res
      }
      async function loadStatus(force) {
        setStatusErr('')
        const cached = readCachedStatus()
        if (cached !== null) setStatus(cached)
        setStatusBusy(true)
        try {
          const args = {}
          if (force === true) args.force = true
          const res = await rpc('status', args)
          rememberStatus(res)
          setStatus(res)
        } catch (e) { setStatusErr(String((e && e.message) || e)) } finally { setStatusBusy(false) }
      }
      async function loadInstances(quiet) {
        setListBusy(true)
        if (quiet !== true) setListErr('')
        try {
          const args = { region: region }
          if (filter != null && filter !== '') args.status = filter
          const res = await rpc('list', args)
          if (res != null && res.ok === false) { if (quiet !== true) setListErr(res.error || '查询失败') }
          else { setInstances((res && res.instances) || []); setListErr('') }
        } catch (e) { if (quiet !== true) setListErr(String((e && e.message) || e)) } finally { setListBusy(false) }
      }
      async function runExec() {
        if (!execTarget) { setExecResult({ error: '请先在实例表格中点击 [执行] 选择目标实例' }); return }
        if (isDangerousCommand(execCmd)) {
          if (confirmArm !== true) {
            setConfirmArm(true)
            setExecResult({ error: '检测到破坏性命令模式, 再次点击 [执行] 按钮以确认（Host 端仍会二次拦截; 正式流程请联系 Agent 用 ecs_exec 经审批执行）' })
            return
          }
          setConfirmArm(false)
        }
        setExecBusy(true); setExecResult(null)
        try {
          const res = await call('exec', { instance_id: execTarget, command: execCmd, timeout: Number(execTimeout) || 30 })
          setExecResult(res)
          setHistory((prev) => [execCmd].concat(prev.filter((c) => c !== execCmd)).slice(0, 20))
        } catch (e) { setExecResult({ error: String((e && e.message) || e) }) } finally { setExecBusy(false) }
      }
      async function runBatch() {
        if (selected.length === 0) { setExecResult({ error: '请先勾选要批量执行的实例' }); return }
        if (isDangerousCommand(execCmd)) {
          if (confirmArm !== true) { setConfirmArm(true); setExecResult({ error: '检测到破坏性命令模式, 再次点击按钮确认' }); return }
          setConfirmArm(false)
        }
        setExecBusy(true); setExecResult({ batch: [] })
        try {
          const results = []
          for (const id of selected) {
            try {
              const res = await rpc('exec', { instance_id: id, command: execCmd, timeout: Number(execTimeout) || 30 })
              results.push({ instance_id: id, ok: res != null && res.ok === true, error: res != null && res.ok === true ? undefined : ((res && res.error) || 'failed'), output: res != null && res.ok === true ? (res.output || '') : '' })
            } catch (e) { results.push({ instance_id: id, ok: false, error: String((e && e.message) || e) }) }
          }
          setExecResult({ batch: results })
        } finally {
          setExecBusy(false)
        }
      }
      async function runDiag(id) {
        setDiag({ open: true, id, data: null, err: '', busy: true })
        try {
          const res = await rpc('exec', { instance_id: id, command: 'hostname; uname -a; cat /etc/os-release 2>/dev/null | head -3; echo ====LOAD====; uptime; echo ====MEM====; free -m; echo ====DISK====; df -h; echo ====SERVICES====; systemctl --no-pager list-units --type=service --state=running 2>/dev/null | head -25; docker ps --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}" 2>/dev/null; echo ====PROCS====; ps aux --sort=-%mem 2>/dev/null | head -15; echo ====PORTS====; ss -tlnp 2>/dev/null | head -30', timeout: 120 })
          if (res != null && res.ok === true) setDiag({ open: true, id, data: res, err: '', busy: false })
          else setDiag({ open: true, id, data: null, err: ((res && res.error) || '诊断失败'), busy: false })
        } catch (e) { setDiag({ open: true, id, data: null, err: String((e && e.message) || e), busy: false }) }
      }
      function openDetail(inst) {
        setDetail({ open: true, inst, log: '', logBusy: false })
      }
      async function viewLog(inst) {
        setDetail((prev) => ({ ...prev, logBusy: true }))
        try {
          const res = await rpc('exec', { instance_id: inst.instance_id, command: 'journalctl -n 80 --no-pager 2>/dev/null || tail -n 80 /var/log/syslog 2>/dev/null || echo NO_LOG', timeout: 60 })
          setDetail((prev) => ({ ...prev, logBusy: false, log: (res != null && res.ok === true) ? (res.output || '(无日志输出)') : ((res && res.error) || '获取日志失败') }))
        } catch (e) { setDetail((prev) => ({ ...prev, logBusy: false, log: String((e && e.message) || e) })) }
      }
      function applyTemplate(tpl) {
        setPb((prev) => ({ ...prev, form: { ...prev.form, local_file: tpl.local_file, remote_path: tpl.remote_path, command: tpl.command, health_check: tpl.health_check } }))
      }
      function saveTemplate() {
        const name = templName.trim()
        if (name === '') return
        setTemplates((prev) => [{ name: name, ...pb.form }, ...prev.filter((t) => t.name !== name)])
        setTemplName('')
      }
      // ---------- Runbook(v0.6.2): 列出 / 预演 / 执行 ----------
      // 参数文本框是 JSON 对象文本(可留空): 用于替换 runbook 里的 ${name} 占位符。
      function parseRunbookParams(text) {
        const s = String(text == null ? '' : text).trim()
        if (s === '' || s === '{}') return { ok: true, params: undefined }
        try {
          const parsed = JSON.parse(s)
          if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
            return { ok: false, error: '参数必须是 JSON 对象, 例如 {"sha":"abc123"}' }
          }
          return { ok: true, params: parsed }
        } catch (e) {
          return { ok: false, error: '参数不是合法 JSON: ' + String((e && e.message) || e) }
        }
      }
      async function loadRunbooks() {
        setRb((prev) => ({ ...prev, busy: true, err: '' }))
        try {
          const args = rb.dirOverride.trim() !== '' ? { dir: rb.dirOverride.trim() } : {}
          const res = await call('runbook-list', args)
          if (res != null && res.ok === false) setRb((prev) => ({ ...prev, busy: false, err: res.error || '读取 runbook 失败' }))
          else setRb((prev) => ({ ...prev, busy: false, err: '', list: (res && res.runbooks) || [], dir: (res && res.dir) || '' }))
        } catch (e) {
          setRb((prev) => ({ ...prev, busy: false, err: String((e && e.message) || e) }))
        }
      }
      function runbookArgs(name, dryRun) {
        const target = (rb.target || execTarget || '').trim()
        if (target === '') return { error: '请先填写目标实例 ID(查询实例后点行内 [执行] 可带入)' }
        const p = parseRunbookParams(rb.params)
        if (p.ok !== true) return { error: p.error }
        const args = { instance_id: target, runbook: name }
        if (rb.dirOverride.trim() !== '') args.dir = rb.dirOverride.trim()
        if (region != null && region !== '') args.region = region
        if (p.params !== undefined) args.params = p.params
        if (dryRun === true) args.dry_run = true
        return { args: args, target: target }
      }
      async function runRunbook(name, dryRun) {
        const built = runbookArgs(name, dryRun)
        if (built.error !== undefined) { setRb((prev) => ({ ...prev, error: built.error })); return }
        setRb((prev) => ({ ...prev, runBusy: true, error: '', active: name, preview: dryRun === true ? null : prev.preview, result: dryRun === true ? prev.result : null }))
        try {
          const res = await call(dryRun === true ? 'runbook-plan' : 'runbook-run', built.args)
          setRb((prev) => ({
            ...prev,
            runBusy: false,
            preview: dryRun === true ? res : prev.preview,
            result: dryRun === true ? prev.result : res,
            error: (res != null && res.ok === false) ? String(res.error || '执行失败') : '',
          }))
        } catch (e) {
          setRb((prev) => ({ ...prev, runBusy: false, error: String((e && e.message) || e) }))
        }
      }
      // 静态校验(v0.6.3): 不触达实例, 把结构/参数/字段笔误/护栏矛盾一次报全
      async function validateRunbook(name) {
        setRb((prev) => ({ ...prev, runBusy: true, error: '', validate: null, validateFor: name }))
        try {
          const args = { runbook: name }
          if (rb.dirOverride.trim() !== '') args.dir = rb.dirOverride.trim()
          const p = parseRunbookParams(rb.params)
          if (p.ok === true && p.params !== undefined) args.params = p.params
          if (rb.target != null && rb.target.trim() !== '') args.instance_id = rb.target.trim()
          const res = await call('runbook-validate', args)
          setRb((prev) => ({ ...prev, runBusy: false, validate: res, validateFor: name }))
        } catch (e) {
          setRb((prev) => ({ ...prev, runBusy: false, validate: null, error: String((e && e.message) || e) }))
        }
      }
      async function runPublish() {
        // Runbook 模式(v0.6.2): 发布向导直接选一份工作区跑书执行, 走同一条
        // runbook-run 通道(与 Runbook 卡片一致)。
        if (pb.mode === 'runbook') {
          if (pb.runbookName == null || pb.runbookName === '') {
            setPb((prev) => ({ ...prev, error: '请先选择一份 runbook' }))
            return
          }
          const p = parseRunbookParams(pb.runbookParams)
          if (p.ok !== true) { setPb((prev) => ({ ...prev, error: p.error })); return }
          setPb((prev) => ({ ...prev, busy: true, stages: [], error: '', preview: false }))
          try {
            const args = { instance_id: pb.id, runbook: pb.runbookName }
            if (region != null && region !== '') args.region = region
            if (p.params !== undefined) args.params = p.params
            const res = await call('runbook-run', args)
            setPb((prev) => ({ ...prev, busy: false, stages: (res && res.stages) || [], error: (res != null && res.ok === false) ? String(res.error || '执行失败') : '' }))
          } catch (e) {
            setPb((prev) => ({ ...prev, busy: false, error: String((e && e.message) || e) }))
          }
          return
        }
        if (isDangerousCommand(pb.form.command) || isDangerousCommand(pb.form.health_check)) {
          setPb((prev) => ({ ...prev, error: '已拦截: 重启/健康检查命令命中破坏性模式' }))
          return
        }
        setPb((prev) => ({ ...prev, busy: true, stages: [], error: '' }))
        try {
          const res = await call('deploy', Object.assign({ instance_id: pb.id }, pb.form))
          setPb((prev) => ({ ...prev, busy: false, stages: (res && res.stages) || [], error: (res != null && res.ok === false && res.error != null) ? res.error : '' }))
        } catch (e) { setPb((prev) => ({ ...prev, busy: false, error: String((e && e.message) || e) })) }
      }
      // 发布向导里的 runbook 预演: 同一份计划渲染成"步骤行"(复用阶段表格)
      async function previewRunbookInPublish() {
        if (pb.runbookName == null || pb.runbookName === '') {
          setPb((prev) => ({ ...prev, error: '请先选择一份 runbook' }))
          return
        }
        const p = parseRunbookParams(pb.runbookParams)
        if (p.ok !== true) { setPb((prev) => ({ ...prev, error: p.error })); return }
        setPb((prev) => ({ ...prev, busy: true, error: '', stages: [], preview: true }))
        try {
          const args = { instance_id: pb.id, runbook: pb.runbookName, dry_run: true }
          if (region != null && region !== '') args.region = region
          if (p.params !== undefined) args.params = p.params
          const res = await call('runbook-plan', args)
          if (res != null && res.ok === false) {
            setPb((prev) => ({ ...prev, busy: false, preview: false, error: String(res.error || '预演失败') }))
            return
          }
          const stages = ((res && res.plan) || []).map((step) => ({
            name: '[' + step.index + '] ' + step.kind + ' · ' + step.name,
            ok: true,
            output: step.command_line + (step.read_only === true ? '  [read_only]' : '') + (step.verify_sha256 === true ? '  [上传后校验 sha256]' : ''),
          }))
          setPb((prev) => ({ ...prev, busy: false, preview: true, stages: stages, error: '' }))
        } catch (e) {
          setPb((prev) => ({ ...prev, busy: false, preview: false, error: String((e && e.message) || e) }))
        }
      }
      async function loadSessions() {
        setSessBusy(true); setSessMsg('')
        try {
          const res = await rpc('session-list', {})
          setSessions(Array.isArray(res) ? res : ((res && res.sessions) || []))
        } catch (e) { setSessMsg(String((e && e.message) || e)) } finally { setSessBusy(false) }
      }
      async function closeSession(id) {
        setSessBusy(true); setSessMsg('')
        try {
          const args = {}
          if (id != null && id !== '') args.session_id = id
          const res = await rpc('session-close', args)
          setSessMsg((res && res.message) || 'ok')
          await loadSessions()
        } catch (e) { setSessMsg(String((e && e.message) || e)) } finally { setSessBusy(false) }
      }
      React.useEffect(() => { loadStatus() }, [])
      React.useEffect(() => { loadRunbooks() }, [])
      React.useEffect(() => {
        if (autoRefresh !== true) return
        const timer = window.setInterval(() => { loadInstances(true) }, 30000)
        return () => window.clearInterval(timer)
      }, [autoRefresh, region, filter])
      const s = status || {}
      const visible = instances.filter((inst) => {
        const q = search.trim().toLowerCase()
        if (q === '') return true
        return String(inst.instance_id).toLowerCase().includes(q) || String(inst.instance_name).toLowerCase().includes(q)
      })
      const counts = { Running: 0, Stopped: 0, Starting: 0, Stopping: 0 }
      for (const inst of instances) { if (counts[inst.status] != null) counts[inst.status] += 1 }
      const rows = []
      const kv = (k, v) => el('div', { className: 'wbecs-kv' }, el('span', { className: 'k' }, k), el('span', { className: 'v' }, v))
      rows.push(el('div', { key: 'status', className: 'wbecs-card' },
        el('h3', null, 'Workbench CLI 状态', s.cached_at != null ? el('span', { className: 'wbecs-badge', style: { marginLeft: 8 } }, '缓存于 ' + timestamps(s.cached_at)) : null),
        statusErr !== '' ? el('div', { className: 'wbecs-badge wbecs-badge-err' }, statusErr)
          : (status == null && statusBusy) ? el('div', { className: 'wbecs-empty' }, '正在读取 CLI 状态…')
          : el('div', { className: 'wbecs-status-grid' },
            kv('CLI', s.cli_ok === true ? el('span', { className: 'wbecs-badge wbecs-badge-ok' }, '可用') : el('span', { className: 'wbecs-badge wbecs-badge-err' }, '不可用')),
            kv('版本', el('span', { className: 'wbecs-mono' }, s.version || '-')),
            kv('凭据 Profile', el('span', { className: 'wbecs-mono' }, s.config_exists === true ? ((s.profile || 'default') + ' · ' + (s.mode || '?')) : '未配置')),
            (s.mode === 'AK' && s.cli_ok === true) ? el('span', { className: 'wbecs-badge wbecs-badge-warn', style: { alignSelf: 'center' } }, '长期 AK: 建议 RamRoleArn') : null,
            kv('Daemon', s.daemon === true ? el('span', { className: 'wbecs-badge wbecs-badge-ok' }, '运行中') : el('span', { className: 'wbecs-badge wbecs-badge-warn' }, s.daemon === false ? '未运行' : '未知')),
            el('div', { className: 'wbecs-actions' }, el('button', { className: 'wbecs-btn', onClick: () => loadStatus(true), disabled: statusBusy }, statusBusy ? '刷新中…' : '刷新')))))
      rows.push(el('div', { key: 'list', className: 'wbecs-card' },
        el('h3', null, 'ECS 实例'),
        el('div', { className: 'wbecs-row' },
          el('input', { className: 'wbecs-input', list: 'wbecs-regions', value: region, onChange: (e) => setRegion(e.target.value), placeholder: '地域, 如 cn-shanghai' }),
          el('datalist', { id: 'wbecs-regions' }, ['cn-shanghai', 'cn-hangzhou', 'cn-beijing', 'cn-shenzhen', 'cn-guangzhou', 'cn-qingdao', 'cn-zhangjiakou'].map((r) => el('option', { key: r, value: r }))),
          el('select', { className: 'wbecs-select', value: filter, onChange: (e) => setFilter(e.target.value) },
            el('option', { value: '' }, '全部状态'), ['Running', 'Stopped', 'Starting', 'Stopping'].map((st) => el('option', { key: st, value: st }, st))),
          el('input', { className: 'wbecs-input', value: search, onChange: (e) => setSearch(e.target.value), placeholder: '搜索名称/ID', style: { minWidth: 140 } }),
          el('button', { className: 'wbecs-btn wbecs-btn-primary', onClick: () => loadInstances(false), disabled: listBusy }, listBusy ? '查询中…' : '查询'),
          el('label', { className: 'wbecs-flex', style: { fontSize: 12, color: 'var(--wb-label2)' } }, el('input', { type: 'checkbox', className: 'wbecs-check', checked: autoRefresh, onChange: (e) => setAutoRefresh(e.target.checked) }), '30s 自动刷新'),
          el('span', { className: 'wbecs-empty' }, '共 ' + instances.length + ' 台 / 选中 ' + selected.length)),
        el('div', { className: 'wbecs-strip' }, ['Running', 'Stopped', 'Starting', 'Stopping'].map((st) => counts[st] > 0 ? el('span', { key: st, className: 'seg' }, el('span', { className: 'dot', style: { background: st === 'Running' ? 'var(--wb-ok)' : st === 'Stopped' ? 'var(--wb-warn)' : 'var(--wb-brand)' } }), st + ' ' + counts[st]) : null)),
        listErr !== '' ? el('div', { className: 'wbecs-badge wbecs-badge-err', style: { marginBottom: 8 } }, listErr) : null,
        visible.length === 0
          ? el('div', { className: 'wbecs-empty' }, listErr !== '' ? '' : '输入地域后点击查询（默认 cn-shanghai）')
          : el('table', { className: 'wbecs-table' },
            el('thead', null, el('tr', null,
              el('th', null, el('input', { type: 'checkbox', className: 'wbecs-check', checked: visible.length > 0 && visible.every((v) => selected.indexOf(v.instance_id) >= 0), onChange: (e) => { if (e.target.checked) { setSelected(Array.from(new Set(selected.concat(visible.map((v) => v.instance_id))))) } else { setSelected(selected.filter((id) => visible.every((v) => v.instance_id !== id))) } } })),
              ['实例ID', '名称', '规格', '状态', '私网IP', '公网IP', '操作'].map((hd) => el('th', { key: hd }, hd)))),
            el('tbody', null, visible.map((inst) => el('tr', { key: inst.instance_id },
              el('td', null, el('input', { type: 'checkbox', className: 'wbecs-check', checked: selected.indexOf(inst.instance_id) >= 0, onChange: (e) => { if (e.target.checked) setSelected(Array.from(new Set(selected.concat([inst.instance_id])))); else setSelected(selected.filter((id) => id !== inst.instance_id)) } })),
              el('td', { className: 'wbecs-mono' }, inst.instance_id),
              el('td', null, inst.instance_name),
              el('td', null, inst.instance_type),
              el('td', null, el('span', { className: inst.status === 'Running' ? 'wbecs-badge wbecs-badge-ok' : (inst.status === 'Stopped' ? 'wbecs-badge wbecs-badge-warn' : 'wbecs-badge') }, inst.status)),
              el('td', { className: 'wbecs-mono' }, inst.private_ip),
              el('td', { className: 'wbecs-mono' }, inst.public_ip),
              el('td', null, el('div', { className: 'wbecs-actions' },
                el('button', { className: 'wbecs-btn', onClick: () => setExecTarget(inst.instance_id) }, '执行'),
                el('button', { className: 'wbecs-btn', onClick: () => runDiag(inst.instance_id), disabled: diag.busy }, '诊断'),
                el('button', { className: 'wbecs-btn', onClick: () => setPb((prev) => ({ ...prev, open: true, id: inst.instance_id })) }, '发布'),
                el('button', { className: 'wbecs-btn', onClick: () => openDetail(inst) }, '详情'))))))),
        selected.length > 0
          ? el('div', { className: 'wbecs-row', style: { marginTop: 8, paddingTop: 10, borderTop: '1px solid var(--wb-border1)' } },
            el('span', { className: 'wbecs-badge' }, '批量执行 ' + selected.length + ' 台'),
            el('input', { className: 'wbecs-input', value: execCmd, onChange: (e) => setExecCmd(e.target.value), placeholder: '对勾选实例执行的命令', style: { flex: 1, minWidth: 200 } }),
            el('button', { className: 'wbecs-btn wbecs-btn-primary', onClick: runBatch, disabled: execBusy }, execBusy ? '执行中…' : '批量执行'))
          : null))
      const disks = diag.data != null ? parseDisk(diag.data.output) : []
      const mem = diag.data != null ? parseMem(diag.data.output) : null
      const bar = (label, pct, fill) => el('div', { className: 'wbecs-flex', key: label }, el('span', { style: { width: 90, fontSize: 12, color: 'var(--wb-label2)' } }, label), el('div', { className: 'wbecs-bar' }, el('div', { className: 'wbecs-barFill', style: { width: Math.min(100, pct) + '%', background: pct >= 85 ? 'var(--wb-err)' : pct >= 70 ? 'var(--wb-warn)' : fill } })), el('span', { className: 'wbecs-mono', style: { width: 48, textAlign: 'right' } }, pct + '%'))
      const batchBody = execResult != null && execResult.batch != null
        ? el('table', { className: 'wbecs-table' },
          el('thead', null, el('tr', null, ['实例', '结果', '详情'].map((hd) => el('th', { key: hd }, hd)))),
          el('tbody', null, execResult.batch.map((b) =>
            el('tr', { key: b.instance_id },
              el('td', { className: 'wbecs-mono' }, b.instance_id),
              el('td', null, el('span', { className: b.ok === true ? 'wbecs-badge wbecs-badge-ok' : 'wbecs-badge wbecs-badge-err' }, b.ok === true ? 'OK' : 'FAIL')),
              el('td', { className: 'wbecs-mono' }, b.error != null ? b.error : String(b.output || '').replace(/\n/g, ' ').slice(0, 120))))))
        : null
      rows.push(el('div', { key: 'exec', className: 'wbecs-card' },
        el('h3', null, '远程命令' + (diag.id !== '' && diag.data != null ? ' · 仪表盘(' + diag.id + ')' : '')),
        (diag.data != null && (disks.length > 0 || mem != null))
          ? el('div', { style: { marginBottom: 10, display: 'flex', flexDirection: 'column', gap: 6 } },
            mem != null ? el('div', { key: 'mem', className: 'wbecs-flex' }, el('span', { style: { width: 90, fontSize: 12, color: 'var(--wb-label2)' } }, '内存 ' + Math.round(mem.used / 1024) + '/' + Math.round(mem.total / 1024) + 'G'), el('div', { className: 'wbecs-bar' }, el('div', { className: 'wbecs-barFill', style: { width: Math.min(100, mem.pct) + '%', background: mem.pct >= 85 ? 'var(--wb-err)' : mem.pct >= 70 ? 'var(--wb-warn)' : 'var(--wb-brand)' } })), el('span', { className: 'wbecs-mono', style: { width: 48, textAlign: 'right' } }, mem.pct + '%')) : null,
            disks.slice(0, 6).map((d) => bar(d.mount, d.pct, 'var(--wb-brand)')))
          : null,
        el('div', { className: 'wbecs-exec-form' },
          el('input', { className: 'wbecs-input', value: execTarget, onChange: (e) => setExecTarget(e.target.value), placeholder: '目标实例 ID (查询后点 [执行] 选择)' }),
          el('input', { className: 'wbecs-input', list: 'wbecs-history', value: execCmd, onChange: (e) => setExecCmd(e.target.value), placeholder: '命令, 如 df -h' }),
          el('datalist', { id: 'wbecs-history' }, history.map((c) => el('option', { key: c, value: c }))),
          el('input', { className: 'wbecs-input', value: execTimeout, onChange: (e) => setExecTimeout(e.target.value), placeholder: '超时(秒)', style: { minWidth: 80 } }),
          el('button', { className: confirmArm === true ? 'wbecs-btn wbecs-btn-confirm' : 'wbecs-btn wbecs-btn-primary', onClick: runExec, disabled: execBusy }, execBusy ? '执行中…' : (confirmArm === true ? '再次点击确认' : '执行'))),
        execResult != null
          ? el('div', { style: { marginTop: 10 } }, batchBody,
            execResult.batch == null && execResult.error != null
              ? el('span', { className: 'wbecs-badge wbecs-badge-err' }, execResult.error)
              : (execResult.batch == null
                ? el('div', null,
                  el('pre', { className: 'wbecs-pre' }, String(execResult.output || '(无输出)')),
                  el('div', { style: { marginTop: 6 } }, el('span', { className: execResult.exit_code === 0 ? 'wbecs-badge wbecs-badge-ok' : 'wbecs-badge wbecs-badge-err' }, 'exit code: ' + (execResult.exit_code == null ? '?' : execResult.exit_code))),
                  execResult.stderr != null && execResult.stderr !== '' ? el('pre', { className: 'wbecs-pre', style: { marginTop: 6 } }, String(execResult.stderr)) : null)
                : null))
          : null))
      // ---------- Runbook 卡片(v0.6.2) ----------
      const kindText = (kinds) => (kinds || []).map((k) => k.kind + '×' + k.count).join(' ')
      const rbStageRows = (stages) => (stages || []).map((sg, i) => el('div', { key: String(i), className: 'wbecs-stage' },
        el('span', {
          className: sg.skipped === true ? 'wbecs-badge'
            : (sg.ok === true ? 'wbecs-badge wbecs-badge-ok' : 'wbecs-badge wbecs-badge-err'),
        }, sg.skipped === true ? '跳过' : (sg.ok === true ? '✓' : '✗')),
        el('span', { style: { minWidth: 150 } }, (sg.index != null ? '[' + sg.index + '] ' : '') + sg.name),
        el('div', { style: { flex: 1, minWidth: 0 } },
          el('div', { className: 'wbecs-mono', style: { color: sg.error != null ? 'var(--wb-err)' : 'var(--wb-label2)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
            sg.error != null ? String(sg.error) : String(sg.output || '').replace(/\n/g, ' ').slice(0, 160)),
          (sg.assertions != null && sg.assertions.length > 0)
            ? el('div', { className: 'wbecs-mono', style: { fontSize: 11, color: 'var(--wb-label2)' } },
              sg.assertions.map((a) => (a.ok === true ? '✔ ' : '✘ ') + a.check + '(' + a.expected + ')').join('  '))
            : null)))
      const rbPreview = (rb.preview != null && rb.preview.ok !== false && Array.isArray(rb.preview.plan))
        ? el('div', { style: { marginTop: 10, paddingTop: 8, borderTop: '1px solid var(--wb-border1)' } },
          el('div', { style: { marginBottom: 6 } }, el('span', { className: 'wbecs-badge wbecs-badge-ok' },
            '预演 · ' + ((rb.preview.runbook && rb.preview.runbook.name) || rb.active) + ' · ' + rb.preview.total_stage + ' 步(未执行任何命令)')),
          rb.preview.plan.map((p) => el('div', { key: String(p.index), className: 'wbecs-stage' },
            el('span', { className: 'wbecs-badge' }, p.kind),
            el('span', { style: { minWidth: 150 } }, '[' + p.index + '] ' + p.name),
            el('span', { className: 'wbecs-mono', style: { color: 'var(--wb-label2)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
              p.command_line + (p.read_only === true ? '  [read_only]' : '') + (p.verify_sha256 === true ? '  [校验 sha256]' : '')))))
        : null
      const rbResult = (rb.result != null)
        ? el('div', { style: { marginTop: 10, paddingTop: 8, borderTop: '1px solid var(--wb-border1)' } },
          el('div', { style: { marginBottom: 6 } },
            el('span', { className: rb.result.ok === true ? 'wbecs-badge wbecs-badge-ok' : 'wbecs-badge wbecs-badge-err' },
              '执行 · ' + ((rb.result.runbook && rb.result.runbook.name) || rb.active) + ' · ' +
              String(rb.result.done_stage != null ? rb.result.done_stage : 0) + '/' + String(rb.result.total_stage != null ? rb.result.total_stage : 0) +
              ' 步 · ' + (rb.result.ok === true ? '成功' : '失败')),
            rb.result.aborted === true ? el('span', { className: 'wbecs-badge wbecs-badge-warn', style: { marginLeft: 6 } }, '已中止: ' + String(rb.result.abort_reason || '')) : null),
          rbStageRows(rb.result.stages))
        : null
      const rbValidate = (rb.validate != null && rb.validateFor !== '')
        ? el('div', { style: { marginTop: 10, paddingTop: 8, borderTop: '1px solid var(--wb-border1)' } },
          el('div', { style: { marginBottom: 6 } },
            el('span', {
              className: (rb.validate.ok === true ? 'wbecs-badge wbecs-badge-ok' : 'wbecs-badge wbecs-badge-err'),
            }, '校验 · ' + rb.validateFor + ' · ' + String(rb.validate.error_count != null ? rb.validate.error_count : 0) + ' 错误 / ' +
              String(rb.validate.warn_count != null ? rb.validate.warn_count : 0) + ' 提醒'),
            rb.validate.error != null ? el('span', { className: 'wbecs-badge wbecs-badge-err', style: { marginLeft: 6 } }, String(rb.validate.error)) : null,
            el('button', { className: 'wbecs-btn', style: { marginLeft: 8 }, onClick: () => setRb((prev) => ({ ...prev, validate: null, validateFor: '' })) }, '收起')),
          ((rb.validate.issues || []).length === 0
            ? el('div', { className: 'wbecs-empty' }, '未发现问题。')
            : (rb.validate.issues || []).map((is, i) => el('div', { key: String(i), className: 'wbecs-stage' },
              el('span', { className: is.level === 'error' ? 'wbecs-badge wbecs-badge-err' : 'wbecs-badge wbecs-badge-warn' },
                is.level === 'error' ? '错误' : '提醒'),
              el('span', { className: 'wbecs-mono', style: { flex: 1, whiteSpace: 'normal' } },
                (is.step != null ? 'steps[' + is.step + '] ' : '') + String(is.message) +
                (is.code != null ? '  (' + is.code + ')' : ''))))))
        : null
      const rbTable = rb.list.length === 0
        ? el('div', { className: 'wbecs-empty' }, rb.busy === true ? '正在读取 runbook…' : '未发现 runbook —— 在项目仓库的 ' + (rb.dir || '.dsh/workbench-ecs/runbooks') + '/ 下放置 <name>.json 即可')
        : el('table', { className: 'wbecs-table' },
          el('thead', null, el('tr', null, ['名称', '说明', '步骤', '类型', '参数占位', '校验', '操作'].map((hd) => el('th', { key: hd }, hd)))),
          el('tbody', null, rb.list.map((item) => el('tr', { key: item.name },
            el('td', { className: 'wbecs-mono' }, item.name),
            el('td', null, item.valid === true
              ? String(item.description || item.display_name || '-')
              : el('span', { className: 'wbecs-badge wbecs-badge-err' }, String(item.error || '解析失败'))),
            el('td', null, item.valid === true ? String(item.step_count) + ' 步' : '-'),
            el('td', { className: 'wbecs-mono', style: { fontSize: 11 } }, item.valid === true ? kindText(item.kinds) : ''),
            el('td', { className: 'wbecs-mono', style: { fontSize: 11 } }, item.valid === true
              ? ((item.declared_params || []).map((k) => '${' + k + '}').join(' ') || '-') +
                ((item.required_params || []).length > 0 ? '  (必填: ' + item.required_params.join(', ') + ')' : '')
              : ''),
            el('td', null, item.valid === true
              ? (item.lint_ok === true && (item.warn_count || 0) === 0
                ? el('span', { className: 'wbecs-badge wbecs-badge-ok' }, '通过')
                : el('span', { className: item.lint_ok === true ? 'wbecs-badge wbecs-badge-warn' : 'wbecs-badge wbecs-badge-err' },
                  String(item.error_count || 0) + ' 错误 / ' + String(item.warn_count || 0) + ' 提醒'))
              : ''),
            el('td', null, el('div', { className: 'wbecs-actions' },
              el('button', { className: 'wbecs-btn', onClick: () => validateRunbook(item.name), disabled: rb.runBusy }, '校验'),
              el('button', { className: 'wbecs-btn', onClick: () => runRunbook(item.name, true), disabled: rb.runBusy || item.valid !== true }, '预演'),
              el('button', { className: 'wbecs-btn wbecs-btn-primary', onClick: () => runRunbook(item.name, false), disabled: rb.runBusy || item.valid !== true || item.lint_ok === false }, '执行')))))))
      rows.push(el('div', { key: 'runbooks', className: 'wbecs-card' },
        el('h3', null, 'Runbook（发布跑书）',
          el('span', { className: 'wbecs-badge', style: { marginLeft: 8 } }, '纯数据: 步骤 + 断言 + ${参数}')),
        el('div', { className: 'wbecs-row' },
          el('button', { className: 'wbecs-btn', onClick: loadRunbooks, disabled: rb.busy }, rb.busy === true ? '刷新中…' : '刷新列表'),
          el('input', {
            className: 'wbecs-input', value: rb.dirOverride,
            onChange: (e) => setRb((prev) => ({ ...prev, dirOverride: e.target.value })),
            placeholder: '跑书目录(留空 = 跟随 Agent 会话): ' + (rb.dir || '.dsh/workbench-ecs/runbooks'),
            title: '当前生效目录: ' + (rb.dir || '.dsh/workbench-ecs/runbooks'),
            style: { flex: 1, minWidth: 260, fontSize: 11 },
          }),
          rb.dirOverride.trim() !== ''
            ? el('button', { className: 'wbecs-btn', onClick: () => { setRb((prev) => ({ ...prev, dirOverride: '' })); setTimeout(loadRunbooks, 0) } }, '跟随会话')
            : null,
          el('input', {
            className: 'wbecs-input', value: rb.target, onChange: (e) => setRb((prev) => ({ ...prev, target: e.target.value })),
            list: 'wbecs-rb-instances', placeholder: '目标实例 ID', style: { minWidth: 180 },
          }),
          el('datalist', { id: 'wbecs-rb-instances' }, instances.map((inst) => el('option', { key: inst.instance_id, value: inst.instance_id }))),
          el('input', {
            className: 'wbecs-input', value: rb.params, onChange: (e) => setRb((prev) => ({ ...prev, params: e.target.value })),
            placeholder: '参数 JSON(可选), 如 {"sha":"abc123"}', style: { flex: 1, minWidth: 200 },
          })),
        el('div', { className: 'wbecs-empty', style: { fontSize: 11, marginBottom: 8 } },
          '当前目录: ' + (rb.dir || '(未解析)') + (rb.dirOverride.trim() !== '' ? '(手动指定)' : '(跟随 Agent 最近一次会话的工作区)')),
        rb.err !== '' ? el('div', { className: 'wbecs-badge wbecs-badge-err', style: { marginBottom: 8 } }, rb.err) : null,
        rb.error !== '' ? el('div', { className: 'wbecs-badge wbecs-badge-err', style: { marginBottom: 8 } }, rb.error) : null,
        rbTable,
        rbValidate,
        rbPreview,
        rbResult,
        el('div', { className: 'wbecs-empty', style: { fontSize: 11, marginTop: 8 } },
          '「校验」只读且不触达实例(结构/参数/字段笔误/护栏矛盾一次报全); 「预演」只回显将要下发的命令行; 「执行」走与 Agent 侧 ecs_deploy 相同的编排引擎。破坏性命令面板直接拒绝(需用 Agent 工具经审批执行); shell 变量请写 $${NAME} 转义。')))
      const sessTable = sessions.length === 0
        ? el('div', { className: 'wbecs-empty' }, '无活动会话（会话自动管理；此表用于排障与资源回收）')
        : el('table', { className: 'wbecs-table' },
          el('thead', null, el('tr', null, ['会话ID', '实例', '状态', '操作'].map((hd) => el('th', { key: hd }, hd)))),
          el('tbody', null, sessions.map((ss, idx) => el('tr', { key: String((ss.session_id || ss.id || idx)) },
            el('td', { className: 'wbecs-mono' }, ss.session_id || ss.id || '-'),
            el('td', { className: 'wbecs-mono' }, ss.instance_id || ss.instance || '-'),
            el('td', null, ss.status || '-'),
            el('td', null, el('button', { className: 'wbecs-btn', onClick: () => closeSession(ss.session_id || ss.id), disabled: sessBusy }, '关闭'))))))
      rows.push(el('div', { key: 'sessions', className: 'wbecs-card' },
        el('h3', null, 'Workbench 会话'),
        el('div', { className: 'wbecs-row' },
          el('button', { className: 'wbecs-btn', onClick: loadSessions, disabled: sessBusy }, sessBusy ? '刷新中…' : '刷新会话'),
          sessions.length > 0 ? el('button', { className: 'wbecs-btn wbecs-btn-danger', onClick: () => closeSession(undefined), disabled: sessBusy }, '关闭全部') : null,
          sessMsg !== '' ? el('span', { className: 'wbecs-badge' }, sessMsg) : null),
        sessTable))
      rows.push(el('div', { key: 'timeline', className: 'wbecs-card' },
        el('h3', null, '操作时间线（本次会话）'),
        log.length === 0 ? el('div', { className: 'wbecs-empty' }, '暂无操作') : el('div', null, log.map((l, i) => el('div', { key: String(i), className: 'wbecs-tl' }, el('span', { style: { color: 'var(--wb-label2)' } }, l.t + ' '), '[' + l.kind + '] ' + l.text)))
      ))
      if (diag.open) {
        rows.push(el('div', { key: 'diag-modal', className: 'wbecs-modal-back', onClick: () => setDiag({ open: false, id: '', data: null, err: '', busy: false }) },
          el('div', { className: 'wbecs-modal', onClick: (e) => e.stopPropagation() },
            el('h3', null, '一键诊断 · ' + diag.id),
            diag.busy ? el('div', { className: 'wbecs-empty' }, '诊断执行中…') : (diag.err !== '' ? el('div', { className: 'wbecs-badge wbecs-badge-err' }, diag.err) : el('div', null,
              (disks.length > 0 || mem != null) ? el('div', { style: { display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 10 } }, mem != null ? bar('内存', mem.pct, 'var(--wb-brand)') : null, disks.slice(0, 6).map((d) => bar(d.mount, d.pct, 'var(--wb-brand)'))) : null,
              el('pre', { className: 'wbecs-pre', style: { maxHeight: '45vh' } }, diag.data != null ? String(diag.data.output) : ''))),
            el('div', { className: 'wbecs-row', style: { marginTop: 10, marginBottom: 0 } }, el('button', { className: 'wbecs-btn', onClick: () => setDiag({ open: false, id: '', data: null, err: '', busy: false }) }, '关闭')))))
      }
      if (detail.open && detail.inst != null) {
        const inst = detail.inst
        let tagsText = ''
        try { tagsText = JSON.stringify(JSON.parse(inst.tags || '{}')) } catch (e2) { tagsText = inst.tags || '' }
        rows.push(el('div', { key: 'detail-modal', className: 'wbecs-modal-back', onClick: () => setDetail({ open: false, inst: null, log: '', logBusy: false }) },
          el('div', { className: 'wbecs-modal', onClick: (e) => e.stopPropagation() },
            el('h3', null, '实例详情 · ' + inst.instance_id),
            el('div', { className: 'wbecs-status-grid', style: { marginBottom: 10 } },
              kv('名称', inst.instance_name), kv('规格', inst.instance_type), kv('状态', inst.status),
              kv('地域', inst.region_id), kv('系统', inst.os_type), kv('镜像', el('span', { className: 'wbecs-mono', style: { fontSize: 11 } }, inst.image_id)),
              kv('私网IP', el('span', { className: 'wbecs-mono' }, inst.private_ip)), kv('公网IP', el('span', { className: 'wbecs-mono' }, inst.public_ip)),
              kv('标签', el('span', { className: 'wbecs-mono', style: { fontSize: 11 } }, tagsText))),
            el('div', { className: 'wbecs-row' },
              el('button', { className: 'wbecs-btn', onClick: () => viewLog(inst), disabled: detail.logBusy }, detail.logBusy ? '读取中…' : '查看最近日志'),
              el('button', { className: 'wbecs-btn', onClick: () => setDetail({ open: false, inst: null, log: '', logBusy: false }) }, '关闭')),
            detail.log !== '' ? el('pre', { className: 'wbecs-pre' }, String(detail.log)) : null)))
      }
      if (pb.open) {
        const f = pb.form
        rows.push(el('div', { key: 'pb-modal', className: 'wbecs-modal-back', onClick: () => setPb((prev) => ({ ...prev, open: false, stages: [], error: '' })) },
          el('div', { className: 'wbecs-modal', onClick: (e) => e.stopPropagation() },
            el('h3', null, '受控发布 · ' + pb.id),
            el('div', { className: 'wbecs-row' },
              el('span', { className: 'wbecs-badge' }, '模式'),
              el('select', {
                className: 'wbecs-select', value: pb.mode,
                onChange: (e) => setPb((prev) => ({ ...prev, mode: e.target.value, stages: [], error: '', preview: false })),
              },
                el('option', { value: 'manual' }, '手动三阶段(上传 → 重启 → 健康检查)'),
                el('option', { value: 'runbook' }, 'Runbook(选择工作区跑书)' + (rb.list.length > 0 ? ' · ' + rb.list.length + ' 份' : '')))),
            pb.mode === 'manual'
              ? el('div', { key: 'pb-manual' },
                el('div', { className: 'wbecs-row' },
                  el('span', { className: 'wbecs-badge' }, '模板'),
                  el('select', { className: 'wbecs-select', value: '', onChange: (e) => { const tpl = templates.find((t) => t.name === e.target.value); if (tpl != null) applyTemplate(tpl) } },
                    el('option', { value: '' }, '选择应用…'), templates.map((t) => el('option', { key: t.name, value: t.name }, t.name))),
                  el('input', { className: 'wbecs-input', value: templName, onChange: (e) => setTemplName(e.target.value), placeholder: '保存为模板名', style: { minWidth: 130 } }),
                  el('button', { className: 'wbecs-btn', onClick: saveTemplate }, '保存模板')),
                el('div', { className: 'wbecs-row' },
                  el('input', { className: 'wbecs-input', value: f.local_file, onChange: (e) => setPb((prev) => ({ ...prev, form: { ...prev.form, local_file: e.target.value } })), placeholder: '本机文件路径(可选, 如 E:\\app.jar)' }),
                  el('input', { className: 'wbecs-input', value: f.remote_path, onChange: (e) => setPb((prev) => ({ ...prev, form: { ...prev.form, remote_path: e.target.value } })), placeholder: '远端路径(上传时必填)' })),
                el('div', { className: 'wbecs-row' },
                  el('input', { className: 'wbecs-input', value: f.command, onChange: (e) => setPb((prev) => ({ ...prev, form: { ...prev.form, command: e.target.value } })), placeholder: '重启/生效命令', style: { flex: 2 } }),
                  el('input', { className: 'wbecs-input', value: f.health_check, onChange: (e) => setPb((prev) => ({ ...prev, form: { ...prev.form, health_check: e.target.value } })), placeholder: '健康检查(可选)', style: { flex: 2 } }),
                  el('input', { className: 'wbecs-input', value: String(f.timeout), onChange: (e) => setPb((prev) => ({ ...prev, form: { ...prev.form, timeout: Number(e.target.value) || 120 } })), placeholder: '超时(秒)', style: { minWidth: 76 } })),
                el('div', { className: 'wbecs-row' },
                  el('label', { className: 'wbecs-flex', style: { fontSize: 12, color: 'var(--wb-label2)' } }, el('input', { type: 'checkbox', className: 'wbecs-check', checked: f.force === true, onChange: (e) => setPb((prev) => ({ ...prev, form: { ...prev.form, force: e.target.checked } })) }), 'force 覆盖上传目标'),
                  el('button', { className: 'wbecs-btn wbecs-btn-primary', onClick: runPublish, disabled: pb.busy }, pb.busy ? '发布中…' : '开始发布')))
              : el('div', { key: 'pb-runbook' },
                el('div', { className: 'wbecs-row' },
                  el('span', { className: 'wbecs-badge' }, 'Runbook'),
                  el('select', {
                    className: 'wbecs-select', value: pb.runbookName,
                    onChange: (e) => setPb((prev) => ({ ...prev, runbookName: e.target.value, stages: [], error: '', preview: false })),
                  },
                    el('option', { value: '' }, rb.list.length === 0 ? '(工作区未发现 runbook)' : '选择跑书…'),
                    rb.list.filter((x) => x.valid === true).map((x) => el('option', { key: x.name, value: x.name },
                      x.name + ' · ' + x.step_count + ' 步' + (x.description != null ? ' · ' + x.description : ''))))),
                el('div', { className: 'wbecs-row' },
                  el('input', {
                    className: 'wbecs-input', value: pb.runbookParams,
                    onChange: (e) => setPb((prev) => ({ ...prev, runbookParams: e.target.value })),
                    placeholder: '参数 JSON(可选), 如 {"sha":"abc123"}', style: { flex: 2 },
                  }),
                  el('button', { className: 'wbecs-btn', onClick: previewRunbookInPublish, disabled: pb.busy }, '预演'),
                  el('button', { className: 'wbecs-btn wbecs-btn-primary', onClick: runPublish, disabled: pb.busy }, pb.busy ? '执行中…' : '开始执行')),
                el('div', { className: 'wbecs-empty', style: { fontSize: 11 } },
                  '跑书是纯数据(步骤 + 断言 + ${参数}), 文件在 ' + (rb.dir || '.dsh/workbench-ecs/runbooks') + '/; 与 Agent 侧 ecs_deploy 共用同一套编排引擎。')),
            pb.error !== '' ? el('div', { className: 'wbecs-badge wbecs-badge-err', style: { marginTop: 8 } }, pb.error) : null,
            pb.stages.length > 0 ? el('div', { style: { marginTop: 10 } },
              pb.preview === true ? el('div', { style: { marginBottom: 6 } }, el('span', { className: 'wbecs-badge wbecs-badge-ok' }, '预演(未执行任何命令)')) : null,
              pb.stages.map((sg, i) => el('div', { key: String(i), className: 'wbecs-stage' },
                el('span', { className: sg.skipped === true ? 'wbecs-badge' : (sg.ok === true ? 'wbecs-badge wbecs-badge-ok' : 'wbecs-badge wbecs-badge-err') }, sg.skipped === true ? '跳过' : (sg.ok === true ? '✓' : '✗')),
                el('span', { style: { minWidth: 90 } }, sg.name),
                el('span', { className: 'wbecs-mono', style: { color: 'var(--wb-label2)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, sg.error != null ? sg.error : String(sg.output || '').replace(/\n/g, ' ').slice(0, 120))))) : null,
            el('div', { className: 'wbecs-row', style: { marginTop: 10, marginBottom: 0 } }, el('button', { className: 'wbecs-btn', onClick: () => setPb((prev) => ({ ...prev, open: false, stages: [], error: '' })) }, '关闭')))))
      }
      return el('div', { className: 'wbecs-panel' }, rows)
    }

    // ---------- 插件声明 ----------
    exports.name = 'dsh-workbench-ecs'
    exports.inject = ['slots']

    function apply(ctx) {
      var tag = document.createElement('style')
      tag.textContent = CSS_TEXT
      document.head.appendChild(tag)
      ctx.effect(function () {
        return function () {
          if (tag.parentNode) tag.parentNode.removeChild(tag)
        }
      })
      var slots = ctx.slots
      if (!slots) return
      slots.inject('settings.section', function () {
        return slots.register(
          { name: 'settings.section', id: 'workbench-ecs', order: 40, label: 'Workbench ECS' },
          function () {
            return React.createElement(WorkbenchPanel)
          },
        )
      })
    }
    exports.apply = apply

    return module.exports
  },
})
