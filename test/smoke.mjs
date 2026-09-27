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
import { readFileSync, readdirSync } from 'node:fs'
import { name, inject, apply } from '../lib/index.js'
import { lintRunbook, parseRunbook, buildRunbookRun, collectParamNames, parseParamDeclarations } from '../lib/runbooks.js'
import { planSteps } from '../lib/steps-engine.js'

// 全部工具的必填参数契约
// 注意: ecs_exec 的 command 自 v0.4.0 起与 script 二选一, 两者都可缺省;
//       ecs_upload 的 local_file 自 v0.5.1 起与 local_dir 二选一, 均非必填;
//       ecs_deploy 的 command 自 v0.6.0 起可用 steps 编排替代, 也非必填
//       (以上均由 execute 内部校验), 因此必填列表为空/不含这些。
const EXPECTED = {
  ecs_list: ['region'],
  ecs_find: [],
  ecs_exec: [],
  // v0.7.0: ecs_log 的 path 与新增的 paths 二选一(由 execute 内部校验), 因此只有 instance_id 必填
  ecs_log: ['instance_id'],
  ecs_upload: ['remote_path', 'instance_id'],
  ecs_download: ['remote_path', 'instance_id'],
  ecs_diagnose: ['instance_id'],
  ecs_deploy: ['instance_id'],
  ecs_runbook: ['action'],
  ecs_snapshot: ['action'],
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
assert.ok(clientText.includes('\\biptables\\s+-[FX]\\b'), 'client.js 预检应包含 iptables 规则(与 DANGEROUS_PATTERNS 对齐)')
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

// ---- 动态 body 完整性守卫:D10 回归 ----
// v0.6.1 曾出现: 新增 lib/runbooks.js 但 to-body.mjs 的模块清单是硬编码的,
// body 里引用到未拼入的符号(ReferenceError: RUNBOOK_DIR is not defined)。
// 这里按"谁 import 了谁"**递归**反查: 每个被 import 的本地模块都必须真的出现
// 在 body 里(v0.6.2 起 to-body.mjs 同样递归发现, 两层守卫互为对照)。
const libDirUrl = new URL('../lib/', import.meta.url)
const libConsumers = [readFileSync(new URL('index.js', libDirUrl), 'utf8')]
for (const f of readdirSync(new URL('tools/', libDirUrl))) {
  if (f.endsWith('.js')) libConsumers.push(readFileSync(new URL('tools/' + f, libDirUrl), 'utf8'))
}
const localModules = new Set()
const pending = libConsumers.slice()
const importRe = /from\s+['"]\.\.?\/([A-Za-z0-9._-]+)\.js['"]/g
while (pending.length > 0) {
  const text = pending.shift()
  importRe.lastIndex = 0
  let match = importRe.exec(text)
  while (match !== null) {
    const file = match[1] + '.js'
    if (!localModules.has(file)) {
      localModules.add(file)
      pending.push(readFileSync(new URL(file, libDirUrl), 'utf8'))
    }
    match = importRe.exec(text)
  }
}
assert.ok(localModules.size >= 3, '应至少发现 common.js / runbooks.js / steps-engine.js, 实际: ' + [...localModules].join(','))
for (const file of localModules) {
  const src = readFileSync(new URL(file, libDirUrl), 'utf8')
  const marker = /export (?:async )?(?:function|const) ([A-Za-z0-9_$]+)/.exec(src)
  assert.ok(marker !== null, 'lib/' + file + ' 应有可识别的导出符号')
  assert.ok(bodyText.includes(marker[1]), 'lib/' + file + ' 未拼进动态 body(缺符号 ' + marker[1] + ')')
}

// ---- 通用跑书模板守卫(v0.6.7 / v0.8.0) ----
// templates/runbooks/*.json 是随包分发的**通用跑书**: 用户直接拷进项目工作区就用。
// 模板最容易烂在没人跑: 少个默认值、字段写错、改成非法 timeout、参数契约与默认值自相矛盾
// (例如 pattern 匹配不上自己的 default) —— 静态校验全都能提前看见, 所以这里把
// "每份模板必须 lint 全绿(0 错误 0 提醒) + 参数齐备 + 无残留占位符 + 可完整展开"变成回归项。
// v0.8.0 起还要保证: 参数契约(required/pattern/enum)对**默认值本身**也成立。
const templateDirUrl = new URL('../templates/runbooks/', import.meta.url)
const templateFiles = readdirSync(templateDirUrl).filter((f) => f.endsWith('.json')).sort()
assert.ok(templateFiles.length >= 3, '应至少有 3 份通用跑书模板, 实际: ' + templateFiles.length)
for (const file of templateFiles) {
  const label = file.replace(/\.json$/, '')
  const text = readFileSync(new URL(file, templateDirUrl), 'utf8')
  const lint = lintRunbook(text, { name: label })
  assert.ok(lint.ok, '模板 ' + label + ' 必须有 0 个错误: ' + JSON.stringify(lint.issues))
  assert.equal(lint.warn_count, 0, '模板 ' + label + ' 不应有提醒: ' + JSON.stringify(lint.issues))
  const runbook = parseRunbook(text, label)
  const run = buildRunbookRun(runbook, {}, { instance_id: 'i-smoke', region: 'cn-shanghai' })
  assert.deepEqual(run.missing, [], '模板 ' + label + ' 的占位符必须都有默认值, 缺: ' + run.missing.join(','))
  assert.equal(collectParamNames(run.steps).size, 0, '模板 ' + label + ' 替换后不应残留占位符: ' + [...collectParamNames(run.steps)].join(','))
  // 参数契约必须与默认值自洽(pattern/enum 不能把默认值自己拒掉)
  assert.deepEqual((run.param_issues !== undefined ? run.param_issues : []), [],
    '模板 ' + label + ' 的参数契约与默认值矛盾: ' + JSON.stringify(run.param_issues))
  const decl = parseParamDeclarations(runbook.params)
  assert.ok(Object.keys(decl.specs).length >= 1, '模板 ' + label + ' 应至少用一处参数描述符作为写法示范(v0.8.0)')
  const plan = planSteps(run.steps, { instance_id: 'i-smoke', region: 'cn-shanghai' })
  assert.equal(plan.length, runbook.steps.length, '模板 ' + label + ' 应能完整展开成计划')
  for (const step of plan) {
    assert.ok(Number(step.timeout) > 0, '模板 ' + label + ' 的 steps[' + step.index + '] 超时应为正数')
  }
  assert.ok(lint.replay !== undefined, '模板 ' + label + ' 应能给出重跑建议(v0.8.0)')
}
assert.ok(pkg.files.includes('templates/'), 'package.json 的 files 必须包含 templates/(否则模板不会随 npm 包分发)')

// ---- v0.7.0 不变量: 护栏/审批/超时/重试/锚点 收敛在 common 与 anchors, 不得各处复制 ----
const commonText = readFileSync(new URL('../lib/common.js', import.meta.url), 'utf8')
for (const symbol of ['scanWriteCommands', 'scanDangerousCommands', 'remoteResultOf', 'withRetry', 'classifyTransientFailure', 'READ_ONLY_ADVICE']) {
  assert.ok(new RegExp('export (?:async )?(?:function|const) ' + symbol + '\\b').test(commonText),
    'lib/common.js 应提供 ' + symbol)
}
// 超时结算只能有一个入口: 各工具不得再自己写"以 JSON exit_code 为准"的回退逻辑
for (const file of readdirSync(new URL('../lib/tools/', import.meta.url)).filter((f) => f.endsWith('.js'))) {
  const src = readFileSync(new URL('../lib/tools/' + file, import.meta.url), 'utf8')
  assert.ok(!/typeof data\.exit_code === 'number'/.test(src),
    'lib/tools/' + file + ' 不应自行判断远端 exit_code(请改用 common.remoteResultOf 以正确处理 timed_out)')
}
// 实例锚点约定: 工具参数说明与 README 口径一致(至少 ecs_exec/ecs_deploy 提到锚点)
const anchorsText = readFileSync(new URL('../lib/anchors.js', import.meta.url), 'utf8')
assert.ok(anchorsText.includes('.dsh/workbench-ecs/instances.json'), '锚点文件路径应写在 lib/anchors.js 里')
const indexText = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
assert.ok(indexText.includes('resolveAnchorsInArgs'), '工具注册边界应统一解析实例锚点(A1)')
assert.ok(readFileSync(new URL('../lib/regions.js', import.meta.url), 'utf8').includes('ECS_PUBLIC_REGIONS'),
  '跨地域检索应基于内置地域清单(F1)')

// ---- v0.8.0 不变量: 参数契约/raw/重跑建议/快照 都收敛在 runbooks+steps-engine+snapshots ----
const runbooksText = readFileSync(new URL('../lib/runbooks.js', import.meta.url), 'utf8')
for (const symbol of ['parseParamDeclarations', 'validateParamValues']) {
  assert.ok(new RegExp('export (?:async )?(?:function|const) ' + symbol + '\\b').test(runbooksText),
    'lib/runbooks.js 应提供 ' + symbol + '(参数契约的唯一实现)')
}
const stepsText = readFileSync(new URL('../lib/steps-engine.js', import.meta.url), 'utf8')
for (const symbol of ['replayAdvice', 'resolveFromStep']) {
  assert.ok(new RegExp('export (?:async )?(?:function|const) ' + symbol + '\\b').test(stepsText),
    'lib/steps-engine.js 应提供 ' + symbol)
}
// 快照采集脚本必须恒为只读(工具里必须真的过护栏), 且清单落在工作区
const snapshotToolText = readFileSync(new URL('../lib/tools/ecs-snapshot.js', import.meta.url), 'utf8')
assert.ok(snapshotToolText.includes('guardReadOnly(script'), 'ecs_snapshot 的采集脚本必须过只读护栏')
const snapshotsText = readFileSync(new URL('../lib/snapshots.js', import.meta.url), 'utf8')
assert.ok(snapshotsText.includes('.dsh/workbench-ecs/snapshots'), '快照清单目录应由 lib/snapshots.js 定义')
assert.ok(readFileSync(new URL('../templates/instances.json', import.meta.url), 'utf8').includes('instance_id'),
  'templates/instances.json 应随包分发(实例锚点模板)')

// ---- 源文件编码守卫: 所有文本文件必须是合法 UTF-8 ----
// 为什么需要: 本机 pwsh 是 Windows PowerShell 5.1, 用 Get-Content/Set-Content 改文件
// 会把 UTF-8 读成 GBK 再写回, 多字节尾部字节被替换成 '?'(2026-09-27 真实损坏过
// lib/common.js 与 package.json, 600+ 处字节丢失)。这条守卫让同类损坏 CI 就能红。
{
  const decoder = new TextDecoder('utf-8', { fatal: true })
  const dirs = ['', 'lib', 'lib/tools', 'test', 'scripts', 'templates', 'templates/runbooks', 'docs']
  let checked = 0
  for (const dir of dirs) {
    const base = new URL('../' + (dir.length > 0 ? dir + '/' : ''), import.meta.url)
    let entries
    try {
      entries = readdirSync(base)
    } catch (err) {
      continue
    }
    for (const name of entries) {
      if (!/\.(js|mjs|json|md|yml|yaml|ps1)$/.test(name)) continue
      const bytes = readFileSync(new URL(name, base))
      checked += 1
      assert.doesNotThrow(() => decoder.decode(bytes), dir + '/' + name + ' 不是合法 UTF-8(疑似被按 ANSI 写回)')
    }
  }
  assert.ok(checked > 10, '编码守卫应至少检查 10 个文件, 实际 ' + checked)
  console.log('encoding OK: ' + checked + ' 个文本文件均为合法 UTF-8')
}

console.log('smoke OK: name =', name, '| tools =', Object.keys(EXPECTED).sort().join(', '))
console.log('rpc OK: 设置页路由 /dsh-workbench-ecs 已注册 (' + routes[0].kind + ')')
console.log('client OK: lib/client.js 工厂结构与 package.json dsh.client/bundle 声明一致')
console.log('body OK: 动态挂载 body 语法合法且与 lib 注册一致 (' + bodyText.split('\n').length + ' 行)')
console.log('body 完整性 OK: 本地共享模块均已拼入 (' + [...localModules].sort().join(', ') + ')')

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
