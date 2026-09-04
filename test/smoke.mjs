// ============================================================================
// test/smoke.mjs —— 发布包冒烟测试
// 验证: 模块导出 name/inject/apply, apply 通过 ctx.tools.register 注册两个工具,
//       且定义经 @deepseek-ai/dsh-tools 的 defineTool 校验通过。
// 运行: npm test  (或 node test/smoke.mjs; 需先 npm install 安装 devDependencies)
// ============================================================================
import assert from 'node:assert'
import { name, inject, apply } from '../lib/index.js'

// 最小 ctx: 只提供 tools.register(捕获定义) 与 get(可选服务返回 undefined)
const captured = []
const ctx = {
  tools: {
    register(def) {
      captured.push(def)
      return () => { /* 无操作: 注册随 fiber 自动清理 */ }
    },
  },
  get() {
    return undefined
  },
}

apply(ctx)

// 插件元信息
assert.equal(name, 'dsh-workbench-ecs', '插件 name 应为 dsh-workbench-ecs')
assert.deepEqual(inject, ['tools'], '插件应注入 tools 服务')

// 工具注册数量与名称
assert.deepEqual(
  captured.map((d) => d.name).sort(),
  ['ecs_exec', 'ecs_list'],
  '应注册 ecs_list 与 ecs_exec 两个工具',
)

// 每个工具的关键契约
for (const def of captured) {
  assert.ok(typeof def.execute === 'function', def.name + ' 应有 execute')
  assert.ok(def.output !== undefined && typeof def.output.schema === 'object', def.name + ' 应声明输出 schema')
  assert.ok(typeof def.output.render === 'function', def.name + ' 应有输出 render')
  assert.ok(def.parameters !== undefined, def.name + ' 应声明参数')
  // 必需参数检查(defineTool 会把 DSL 的 required: true 提升为 schema 顶层 required 数组)
  const required = Array.isArray(def.parameters.required) ? def.parameters.required : []
  if (def.name === 'ecs_list') assert.deepEqual(required, ['region'], 'ecs_list 必填参数应为 region')
  if (def.name === 'ecs_exec') assert.deepEqual(required.sort(), ['command', 'instance_id'], 'ecs_exec 必填参数应为 instance_id/command')
}

// ---------------------------------------------------------------------------
// 校验动态挂载 body (scripts/to-body.mjs 生成): 语法可执行, 且挂载结果一致
// ---------------------------------------------------------------------------
import { readFileSync } from 'node:fs'
const bodyText = readFileSync(new URL('body.generated.js', import.meta.url), 'utf8')
const harnessStub = { defineTool: (d) => d }
const factory = new Function('harness', bodyText)
const plugin = factory(harnessStub)
assert.equal(plugin.name, name, 'body 的 name 应与 lib 一致')
assert.deepEqual(plugin.inject, inject, 'body 的 inject 应与 lib 一致')
const capturedBody = []
plugin.apply({
  tools: { register(d) { capturedBody.push(d); return () => {} } },
  get() { return undefined },
})
assert.deepEqual(
  capturedBody.map((d) => d.name).sort(),
  ['ecs_exec', 'ecs_list'],
  'body 应注册相同的两个工具',
)

console.log('smoke OK: name =', name, '| inject =', inject.join(', '), '| tools =', captured.map((d) => d.name).join(', '))
console.log('body OK: 动态挂载 body 语法合法且与 lib 注册一致')
