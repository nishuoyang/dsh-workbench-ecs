// ============================================================================
// test/smoke.mjs —— 发布包冒烟测试
// 验证: 模块导出 name/inject/apply, apply 注册全部 7 个工具,
//       每个工具契约(execute/output/render/parameters/必填参数)经 defineTool 校验,
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

function runApply(ctx) {
  const captured = []
  ctx.tools.register = function register(def) {
    captured.push(def)
    return () => { /* 无操作: 注册随 fiber 自动清理 */ }
  }
  apply(ctx)
  return captured
}

// ---- lib 模块 ----
const captured = runApply({ tools: {}, get() { return undefined } })
assert.equal(name, 'dsh-workbench-ecs', '插件 name 应为 dsh-workbench-ecs')
assert.deepEqual(inject, ['tools'], '插件应注入 tools 服务')
assert.deepEqual(
  captured.map((d) => d.name).sort(),
  Object.keys(EXPECTED).sort(),
  '应注册全部 ' + Object.keys(EXPECTED).length + ' 个工具',
)

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

// ---- 动态挂载 body: 语法可执行, 且注册一致 ----
const bodyText = readFileSync(new URL('body.generated.js', import.meta.url), 'utf8')
const factory = new Function('harness', bodyText)
const plugin = factory({ defineTool: (d) => d })
assert.equal(plugin.name, name, 'body 的 name 应与 lib 一致')
assert.deepEqual(plugin.inject, inject, 'body 的 inject 应与 lib 一致')
const capturedBody = []
const ctxBody = { tools: {}, get() { return undefined } }
ctxBody.tools.register = (d) => { capturedBody.push(d); return () => { /* noop */ } }
plugin.apply(ctxBody)
assert.deepEqual(
  capturedBody.map((d) => d.name).sort(),
  Object.keys(EXPECTED).sort(),
  'body 应注册相同的全部工具',
)

console.log('smoke OK: name =', name, '| tools =', Object.keys(EXPECTED).sort().join(', '))
console.log('body OK: 动态挂载 body 语法合法且与 lib 注册一致 (' + bodyText.split('\n').length + ' 行)')
