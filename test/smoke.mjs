// ============================================================================
// test/smoke.mjs —— 发布包冒烟测试
// 验证: 模块导出 name/inject/apply, apply 注册全部 7 个工具,
//       每个工具契约(execute/output/render/parameters/必填参数)经 defineTool 校验,
//       apply 同时注册设置页 RPC 路由 (/dsh-workbench-ecs 前缀),
//       静态 client bundle(lib/client.js) 与 package.json 声明一致,
//       动态挂载 body(scripts/to-body.mjs 生成)与 lib 注册一致。
// 运行: npm test  (需先 npm install)
// ============================================================================
import assert from 'node:assert'
import { readFileSync } from 'node:fs'
import { name, inject, apply } from '../lib/index.js'

// 全部工具的必填参数契约
const EXPECTED = {
  ecs_list: ['region'],
  ecs_exec: ['command'],
  ecs_upload: ['local_file', 'remote_path', 'instance_id'],
  ecs_download: ['remote_path', 'instance_id'],
  ecs_diagnose: ['instance_id'],
  ecs_deploy: ['instance_id', 'command'],
  ecs_session: ['action'],
}

function makeCtx({ webServer = true } = {}) {
  const captured = []
  const routes = []
  const ctx = {
    tools: {
      register(def) {
        captured.push(def)
        return () => { /* 无操作: 注册随 fiber 自动清理 */ }
      },
    },
    get() { return undefined },
    // 模拟 Cordis ctx.effect: 立即执行并返回其 disposer
    effect(fn) { return fn() },
  }
  if (webServer) {
    ctx.webServer = {
      register(route) {
        routes.push(route)
        return () => { /* 无操作 */ }
      },
    }
  }
  return { ctx, captured, routes }
}

// ---- lib 模块 ----
const { ctx, captured, routes } = makeCtx()
apply(ctx)
assert.equal(name, 'dsh-workbench-ecs', '插件 name 应为 dsh-workbench-ecs')
assert.deepEqual(inject, ['tools', 'webServer', 'subprocess'], '插件应注入 tools/webServer/subprocess')
assert.deepEqual(
  captured.map((d) => d.name).sort(),
  Object.keys(EXPECTED).sort(),
  '应注册全部 ' + Object.keys(EXPECTED).length + ' 个工具',
)
// 设置页 RPC 路由: 前缀 /dsh-workbench-ecs, 且 handler 为函数
assert.equal(routes.length, 1, '应注册一条 RPC 路由')
assert.equal(routes[0].kind, 'prefix', 'RPC 路由应为 prefix 类型')
assert.equal(routes[0].path, '/dsh-workbench-ecs', 'RPC 路由路径应为 /dsh-workbench-ecs')
assert.ok(typeof routes[0].handler === 'function', 'RPC 路由应有 handler')

// ---- 每个工具的关键契约 ----
for (const def of captured) {
  assert.ok(typeof def.execute === 'function', def.name + ' 应有 execute')
  assert.ok(def.output !== undefined && typeof def.output.schema === 'object', def.name + ' 应声明输出 schema')
  assert.ok(typeof def.output.render === 'function', def.name + ' 应有输出 render')
  assert.ok(def.parameters !== undefined, def.name + ' 应声明参数')
  // defineTool 会把 DSL 的 required: true 提升为 schema 顶层 required 数组
  const required = Array.isArray(def.parameters.required) ? def.parameters.required : []
  assert.deepEqual(required.sort(), [...EXPECTED[def.name]].sort(), def.name + ' 必填参数应为 ' + EXPECTED[def.name].join('/'))
  // 危险工具应带 presentCall 渲染(终端卡片)
  if (['ecs_exec', 'ecs_diagnose'].includes(def.name)) {
    assert.ok(typeof def.presentCall === 'function', def.name + ' 应有 presentCall')
  }
}

// ---- 无 webServer 环境应优雅降级(只注册工具, 不抛错) ----
const { ctx: ctx2, captured: captured2 } = makeCtx({ webServer: false })
apply(ctx2)
assert.equal(captured2.length, Object.keys(EXPECTED).length, '无 webServer 时也应注册全部工具')

// ---- 静态 client bundle 与 package.json 声明 ----
const clientText = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
assert.ok(clientText.includes("window.__ModuleLoader__.load({"), 'client.js 应以 ModuleLoader 工厂注册')
assert.ok(clientText.includes("id: 'dsh-workbench-ecs'"), 'client.js 应声明 id 为 dsh-workbench-ecs')
assert.ok(clientText.includes("require('react')"), 'client.js 应 require react 种子')
assert.ok(clientText.includes("exports.inject = ['slots']"), 'client.js 应注入 slots')
assert.ok(clientText.includes("'settings.section'"), 'client.js 应注册设置页 section')
assert.ok(clientText.includes("/dsh-workbench-ecs/rpc"), 'client.js 应调用同源 RPC 路由')
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
assert.equal(pkg.dsh.client.platform, 'web', 'dsh.client.platform 应为 web')
assert.equal(pkg.dsh.client.immediately, true, 'dsh.client.immediately 应为 true')
assert.equal(pkg.exports['./client'], './lib/client.js', 'exports["./client"] 应指向 lib/client.js')
assert.ok(pkg.dsh.bundle && pkg.dsh.bundle.patch === './cordis.patch.yml', '应有 dsh.bundle.patch 声明')
const patchText = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
assert.ok(patchText.includes('name: dsh-workbench-ecs'), 'cordis.patch.yml 应包含插件行')

// ---- 动态挂载 body: 语法可执行, 且注册一致 ----
const bodyText = readFileSync(new URL('body.generated.js', import.meta.url), 'utf8')
const factory = new Function('harness', bodyText)
const plugin = factory({ defineTool: (d) => d })
assert.equal(plugin.name, name, 'body 的 name 应与 lib 一致')
assert.deepEqual(plugin.inject, inject, 'body 的 inject 应与 lib 一致')
const capturedBody = []
const ctxBody = { tools: { register: (d) => { capturedBody.push(d); return () => { /* noop */ } } }, get() { return undefined }, effect(fn) { return fn() } }
plugin.apply(ctxBody)
assert.deepEqual(
  capturedBody.map((d) => d.name).sort(),
  Object.keys(EXPECTED).sort(),
  'body 应注册相同的全部工具',
)

console.log('smoke OK: name =', name, '| tools =', Object.keys(EXPECTED).sort().join(', '))
console.log('rpc OK: 设置页路由 /dsh-workbench-ecs 已注册 (' + routes[0].kind + ')')
console.log('client OK: lib/client.js 工厂结构与 package.json dsh.client/bundle 声明一致')
console.log('body OK: 动态挂载 body 语法合法且与 lib 注册一致 (' + bodyText.split('\n').length + ' 行)')

// ---- lib/client.js 工厂在模拟浏览器环境可运行 (load -> factory -> apply) ----
{
  const registrations = []
  globalThis.window = { __ModuleLoader__: { load(reg) { registrations.push(reg) } } }
  const fakeReact = { createElement() { return {} } }
  const styleTag = { textContent: '', removed: false, parentNode: { removeChild(node) { node.removed = true } } }
  globalThis.document = {
    createElement(tag) {
      assert.equal(tag, 'style', 'apply 应创建 style 标签')
      return styleTag
    },
    head: { appendChild() {} },
  }
  // 以脚本方式执行 client.js: window.__ModuleLoader__.load 会注册工厂
  new Function('window', readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8'))(globalThis.window)
  assert.equal(registrations.length, 1, 'client.js 应恰好注册一个模块')
  assert.equal(registrations[0].id, 'dsh-workbench-ecs', '模块 id 应为 dsh-workbench-ecs')
  const plugin = registrations[0].factory((spec) => {
    assert.equal(spec, 'react', '工厂只应 require react 种子')
    return fakeReact
  })
  assert.equal(plugin.name, 'dsh-workbench-ecs', 'client 插件 name 应为 dsh-workbench-ecs')
  assert.deepEqual(plugin.inject, ['slots'], 'client 插件应注入 slots')
  let registered = null
  let effectDisposer = null
  const clientCtx = {
    slots: {
      inject(_slot, fn) { registered = fn() },
    },
    effect(fn) { effectDisposer = fn(); return effectDisposer },
  }
  // slots.register + 组件捕获
  clientCtx.slots.register = function (options, component) {
    assert.equal(options.name, 'settings.section', '应注册 settings.section')
    assert.equal(options.id, 'workbench-ecs', 'section id 应为 workbench-ecs')
    assert.ok(typeof component === 'function', 'section 组件应为函数')
    return () => { /* dispose */ }
  }
  plugin.apply(clientCtx)
  assert.ok(styleTag.textContent.includes('.wbecs-panel'), 'style 标签应写入面板 CSS')
  assert.equal(styleTag.removed, false, '卸载前 style 标签应保留')
  effectDisposer()
  assert.equal(styleTag.removed, true, 'effect 清理应移除 style 标签')
  assert.ok(registered !== undefined, 'slots.inject 回调应可用')
  console.log('client runtime OK: 工厂可执行, 设置页 section 注册成功, style 生命周期干净')
}
