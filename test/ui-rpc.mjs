// ============================================================================
// test/ui-rpc.mjs —— 设置页 RPC 真机测试 (不触碰运行中的 Harness)
// ----------------------------------------------------------------------------
// 用与 lib/index.js 相同的 apply 挂进一个内存 fake context:
//   - tools: 捕获注册 (不验证)
//   - webServer: 捕获路由, 用 node:http 起临时服务器直连 handler
//   - subprocess: 用 Node child_process 实现的最小 stub (真正 spawn workbench)
// 然后通过真实 HTTP fetch 验证 /dsh-workbench-ecs/rpc 全部操作:
//   health / status(缓存/force) / list / exec(守卫+真机) / deploy(echo) /
//   session-list / 未知操作。
// 运行: npm run test:ui   (需要本机已安装并配置 workbench CLI)
// ============================================================================
import assert from 'node:assert'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { apply } from '../lib/index.js'

// 版本漂移防护: /health 的 version 必须与发布包 package.json 一致
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

const CLI = 'C:\\Program Files\\workbench\\workbench.exe'
const REGION = 'cn-shanghai'

// ---- 最小 subprocess stub: 真正在本机执行 workbench ----
const subprocessStub = {
  async resolveExecutable(p) {
    if (p === 'workbench') return CLI
    return p
  },
  spawn(opts) {
    const child = spawn(opts.argv[0], opts.argv.slice(1), {
      cwd: opts.cwd || process.cwd(),
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => { stdout = (stdout + d.toString()).slice(0, 2 * 1024 * 1024) })
    child.stderr.on('data', (d) => { stderr = (stderr + d.toString()).slice(0, 512 * 1024) })
    const done = new Promise((resolveDone) => {
      child.on('close', (code, signal) => resolveDone({ exitCode: code, signal }))
      child.on('error', () => resolveDone({ exitCode: -1, signal: null }))
    })
    return {
      done,
      collected: {
        stdout: { readFrom(offset) { return { text: stdout.slice(offset || 0), lossy: false, spillPath: undefined } } },
        stderr: { readFrom(offset) { return { text: stderr.slice(offset || 0), lossy: false, spillPath: undefined } } },
      },
    }
  },
}

// ---- fake ctx + 捕获路由 ----
const capturedTools = []
const routes = []
const ctx = {
  tools: { register(def) { capturedTools.push(def); return () => { /* noop */ } } },
  webServer: { register(route) { routes.push(route); return () => { /* noop */ } } },
  get(name) {
    if (name === 'subprocess') return subprocessStub
    if (name === 'sandboxPolicy') return { workspaceRoot: process.cwd() }
    return undefined
  },
  effect(fn) { return fn() },
}

apply(ctx)
assert.equal(routes.length, 1, '应注册一条路由')
assert.equal(routes[0].path, '/dsh-workbench-ecs', '路由路径应为 /dsh-workbench-ecs')
assert.ok(capturedTools.length >= 7, '应注册全部工具 (' + capturedTools.length + ')')

// ---- 临时 HTTP 服务器, 直连路由 handler ----
const server = createServer((req, res) => {
  routes[0].handler(req, res)
})
await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen))
const port = server.address().port
const base = `http://127.0.0.1:${port}`

async function rpc(op, args, expectOk = true) {
  const resp = await fetch(base + '/dsh-workbench-ecs/rpc', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ op, args: args === undefined ? {} : args }),
  })
  if (expectOk) {
    assert.equal(resp.status, 200, op + ' 应返回 HTTP 200')
  } else {
    assert.ok(resp.status >= 400, op + ' 应返回错误状态码 (实际 ' + resp.status + ')')
  }
  return resp.json()
}

let pass = 0
function ok(label, cond, detail) {
  assert.ok(cond, label + (detail !== undefined ? ' — ' + JSON.stringify(detail) : ''))
  pass += 1
  console.log('  ✓ ' + label)
}

// 1. health
{
  const resp = await fetch(base + '/dsh-workbench-ecs/health')
  assert.equal(resp.status, 200, 'health 应返回 200')
  const j = await resp.json()
  ok('health 返回插件标识', j != null && j.ok === true && j.plugin === 'dsh-workbench-ecs', j)
  ok('health 版本与 package.json 一致', j != null && j.version === pkg.version, j)
}

// 2. status (真实 CLI)
const st1 = await rpc('status')
ok('status 返回 cli_ok=true', st1 != null && st1.cli_ok === true, st1)
ok('status 携带版本号', typeof st1.version === 'string' && st1.version.length > 0, st1.version)

// 3. 缓存: 20s 内再次调用应命中 (cached_at 不变)
const st2 = await rpc('status')
ok('status 第二次命中缓存', st2 != null && st2.cached === true && st2.cached_at === st1.cached_at, st2)

// 4. force 重查: cached_at 应更新
const st3 = await rpc('status', { force: true })
ok('status force 重查 (cached_at 更新)', st3 != null && st3.cached_at >= st1.cached_at, st3)

// 5. list (真实 CLI)
const list1 = await rpc('list', { region: REGION })
ok('list 返回实例数组', list1 != null && list1.ok === true && Array.isArray(list1.instances), list1)
const sample = list1.instances.find((i) => i.status === 'Running')
console.log('  · cn-shanghai 共 ' + list1.instances.length + ' 台 (Running 示例: ' + (sample ? sample.instance_id : '无') + ')')

// 6. 破坏性命令守卫
const guarded = await rpc('exec', { instance_id: 'i-test', command: 'rm -rf /' })
ok('exec 拦截 rm -rf', guarded != null && guarded.ok === false && /已拦截/.test(String(guarded.error || '')), guarded)

// 7. 真机 exec (若存在运行中实例)
if (sample !== undefined) {
  const ex1 = await rpc('exec', { instance_id: sample.instance_id, command: 'echo dsh-workbench-ecs-rpc-ok', timeout: 30, region: REGION })
  ok('exec 真机 echo 成功', ex1 != null && ex1.ok === true && /dsh-workbench-ecs-rpc-ok/.test(String(ex1.output || '')), ex1)
} else {
  console.log('  · 无运行中实例, 跳过真机 exec')
}

// 8. deploy (纯 echo, 不触碰服务)
const dep1 = await rpc('deploy', { instance_id: sample != null ? sample.instance_id : 'i-test', command: 'echo deploy-ok', health_check: 'echo hc-ok', timeout: 30, region: REGION })
ok('deploy 两阶段成功', dep1 != null && dep1.ok === true && dep1.stages != null && dep1.stages.length === 2 && dep1.stages.every((s) => s.ok === true), dep1)

// 9. session-list 形状
const sess = await rpc('session-list')
ok('session-list 返回数组', Array.isArray(sess), sess)

// 10. 未知操作
const unknown = await rpc('no-such-op', undefined, false)
ok('未知操作被拒绝', unknown != null && unknown.ok === false && /未知操作/.test(String(unknown.error || '')), unknown)

server.close()
console.log('')
console.log('ui-rpc OK: ' + pass + ' 项断言全部通过 (真实 Workbench CLI)')
