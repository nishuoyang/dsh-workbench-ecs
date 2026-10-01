// ============================================================================
// test/compat.mjs —— 跨 DSH 运行时兼容性守卫(v0.9.0, 桌面端适配)
// ----------------------------------------------------------------------------
// 背景(实测于 2026-10-01):
//   * 浏览器端 = `dsh web`, 运行 **DSH 0.1.1-rc.2**(全局 npm 安装);
//   * 桌面端   = DeepSeek Harness 桌面应用, 宿主进程是 Electron 内自带的
//     `@deepseek-ai/dsh-desktop-host`, 运行 **DSH 0.2.0-rc.2**, 加载
//     `%DSH_HOME%\profiles\desktop` 配置文件 —— 仍然是 web 面(内置 dsh-web-app,
//     客户端模块系统依旧只收 `dsh.client.platform === "web"`)。
//
// 这带来两类**会让插件在桌面端彻底消失**的坑, 本文件把两类都变成回归项:
//
// 1) 版本闸门(`evaluatePluginCompatibility`, dsh-app-boot):
//    宿主会把 peerDependencies 里每个 `@deepseek-ai/dsh-*` 与运行时版本比对,
//    不满足就把**整个 bundle 跳过**(skippedBundles) —— 插件一行都不加载。
//    `^0.1.1-rc.2` 在 semver 下等于 `>=0.1.1-rc.2 <0.2.0-0`, 桌面端的
//    0.2.0-rc.2 **不满足**, 于是插件静默消失(实测确认)。第 1 节断言声明的
//    区间同时覆盖两个已验证的运行时。
//
// 2) 工具定义契约:`defineTool` 会把 parameters / output.schema 编译进受支持的
//    JSON Schema 子集, `tools.register()` 再校验 `output { schema, render }`。
//    第 2 节用**真内核**(@deepseek-ai/dsh-tools, 本机 0.1.1-rc.2; 桌面端打包的是
//    0.2.0-rc.2 —— 两者的 defineTool / register / schema 校验源码已逐行比对一致)
//    对每个注册后的定义做一遍离线复核。
//
// 运行: node test/compat.mjs  (由 npm test 串起)
// ============================================================================
import assert from 'node:assert'
import { readFileSync, existsSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { name, inject, apply } from '../lib/index.js'

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

// ---------------------------------------------------------------------------
// 一、版本闸门: peerDependencies 必须同时满足两个已实测的桌面/浏览器运行时
// ---------------------------------------------------------------------------
// 「已验证的 DSH 运行时」清单 —— 新增适配时在这里加一行, 测试会自动要求
// peer 区间覆盖它。semver 的预发布语义容易反直觉(见下方注释), 因此这里
// **自己实现**一个够用的比较器, 而不是引入 semver 依赖(本包运行时零依赖);
// 下方还会用本机真实 semver(若存在)对这套比较器做交叉验证。
const KNOWN_DSH_RUNTIMES = [
  { version: '0.1.1-rc.2', where: '浏览器端 `dsh web`(全局 npm 安装)' },
  { version: '0.2.0-rc.2', where: '桌面应用内置运行时(dsh-desktop-host)' },
]

// 解析 `x.y.z[-prerelease]` 为数字段 + 预发布标识数组。
function parseVersion(text) {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(String(text).trim())
  assert.ok(m !== null, '无法解析版本号: ' + text)
  return {
    major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]),
    pre: m[4] === undefined ? [] : m[4].split('.'),
  }
}

// semver 的 `-` 比较: 数字标识按数值比, 字母标识按字典序; 有预发布 < 无预发布。
function comparePre(left, right) {
  if (left.length === 0 && right.length === 0) return 0
  if (left.length === 0) return 1          // 1.0.0 > 1.0.0-rc.1
  if (right.length === 0) return -1
  const max = Math.max(left.length, right.length)
  for (let i = 0; i < max; i++) {
    const a = left[i]
    const b = right[i]
    if (a === undefined) return -1
    if (b === undefined) return 1
    const na = /^\d+$/.test(a)
    const nb = /^\d+$/.test(b)
    if (na && nb) {
      if (Number(a) !== Number(b)) return Number(a) < Number(b) ? -1 : 1
    } else if (na !== nb) {
      return na ? -1 : 1                 // 数字标识优先级低于字母标识
    } else if (a !== b) {
      return a < b ? -1 : 1
    }
  }
  return 0
}

function compareVersions(a, b) {
  for (const key of ['major', 'minor', 'patch']) {
    if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1
  }
  return comparePre(a.pre, b.pre)
}

// 区间求值, 对齐 **semver.satisfies(version, range, { includePrerelease: true })**:
// dsh-app-boot 的 evaluatePluginCompatibility 正是这样调用 semver 的。
// 关键细节(实测): includePrerelease 下 semver 把 `^x.y.z[-pre]` 的排他上界写成
// `X.Y.Z-0` —— 实测 validRange('^0.1.1-rc.2', {includePrerelease:true}) 返回
// '>=0.1.1-rc.2 <0.2.0-0'。因此 `^0.1.1-rc.2` 接受 0.1.2-alpha.1(同 minor 线),
// 却拒绝 0.2.0-rc.1 / 0.2.0-rc.2 —— 这就是桌面端此前被静默跳过的根因。
function satisfies(versionText, rangeText) {
  const version = parseVersion(versionText)
  return String(rangeText).split('||').some((clause) =>
    parseComparators(clause.trim()).every((comparator) => comparatorSatisfied(version, comparator)))
}

// 把一个子句解析成 {op, bound} 清单(`*`/空 = 无界)。
function parseComparators(clause) {
  if (clause === '' || clause === '*' || clause === 'x') return [{ op: '*', bound: undefined }]
  const comparators = []
  for (const part of clause.split(/\s+/).filter((piece) => piece.length > 0)) {
    if (part.startsWith('^')) {
      const lower = parseVersion(part.slice(1))
      const upper = lower.major > 0
        ? { major: lower.major + 1, minor: 0, patch: 0, pre: ['0'] }
        : lower.minor > 0
          ? { major: 0, minor: lower.minor + 1, patch: 0, pre: ['0'] }
          : { major: 0, minor: 0, patch: lower.patch + 1, pre: ['0'] }
      comparators.push({ op: '>=', bound: lower }, { op: '<', bound: upper })
      continue
    }
    if (part.startsWith('~')) {
      const lower = parseVersion(part.slice(1))
      comparators.push({ op: '>=', bound: lower }, { op: '<', bound: { major: lower.major, minor: lower.minor + 1, patch: 0, pre: ['0'] } })
      continue
    }
    const m = /^(>=|<=|>|<|=)?\s*(.+)$/.exec(part)
    assert.ok(m !== null, '无法解析区间比较符: ' + part)
    comparators.push({ op: m[1] === undefined ? '=' : m[1], bound: parseVersion(m[2]) })
  }
  return comparators
}

function comparatorSatisfied(version, comparator) {
  if (comparator.op === '*') return true
  const cmp = compareVersions(version, comparator.bound)
  switch (comparator.op) {
    case '>=': return cmp >= 0
    case '<=': return cmp <= 0
    case '>': return cmp > 0
    case '<': return cmp < 0
    default: return cmp === 0
  }
}

// 自检: 比较器本身不能是"永远返回 true"的摆设
assert.equal(satisfies('0.2.0-rc.2', '^0.1.1-rc.2'), false,
  '比较器自检: ^0.1.1-rc.2 必须**拒绝** 0.2.0-rc.2(这正是桌面端此前被静默跳过的原因)')
assert.equal(satisfies('0.2.0-rc.1', '^0.1.1-rc.2'), false, '比较器自检: ^0.1.1-rc.2 也必须拒绝 0.2.0-rc.1')
assert.equal(satisfies('0.1.2-alpha.1', '^0.1.1-rc.2'), true, '比较器自检: 0.1.x 的预发布在 includePrerelease 下应被接受')
assert.equal(satisfies('0.1.1', '^0.1.1-rc.2'), true, '比较器自检: 下界自身必须满足')
assert.equal(satisfies('0.3.0-rc.1', '^0.1.1-rc.2 || ^0.2.0-rc.2'), false, '比较器自检: 0.3.x 不应被接受')
assert.equal(satisfies('0.2.0', '^0.1.1-rc.2 || ^0.2.0-rc.2'), true, '比较器自检: 0.2.0 正式版应被接受')
assert.equal(satisfies('0.2.0-rc.2', '>=0.1.1-rc.2 <0.3.0'), true, '比较器自检: 显式区间必须接受 0.2.0-rc.2')
assert.equal(satisfies('4.0.4', '^4.0.1'), true, '比较器自检: cordis 4.0.4 应满足 ^4.0.1')

const peers = pkg.peerDependencies !== undefined ? pkg.peerDependencies : {}
const dshPeers = Object.keys(peers).filter((key) => key === '@deepseek-ai/dsh' || key.startsWith('@deepseek-ai/dsh-'))

// 找到一份可用的 semver: 优先包名解析, 其次 dsh 自己的依赖树。
function findSemver() {
  try {
    return import.meta.resolve('semver')
  } catch { /* 未安装: 继续探 dsh 依赖树 */ }
  const candidates = []
  if (process.env.DSH_HOME) candidates.push(process.env.DSH_HOME + '/profiles/node_modules/semver/index.js')
  if (process.env.USERPROFILE) candidates.push(process.env.USERPROFILE + '/.dsh/profiles/node_modules/semver/index.js')
  for (const candidate of candidates) {
    if (existsSync(candidate)) return pathToFileURL(candidate).href
  }
  return null
}

// 交叉验证: 版本闸门属于"写错就静默消失"的一类错误, 值得用真实 semver 对照。
// 找不到 semver 时跳过(CI 的 npm 依赖里没有它, 断言仍按内置比较器执行)。
const semverPath = findSemver()
if (semverPath !== null) {
  const semver = (await import(semverPath)).default
  const ranges = [...new Set([...Object.values(peers), '^0.1.1-rc.2', '^0.1.1-rc.2 || ^0.2.0-rc.2', '>=0.1.1-rc.2 <0.3.0', '~0.1.1'])]
  const versions = ['0.1.1-rc.1', '0.1.1-rc.2', '0.1.1', '0.1.2-alpha.1', '0.1.7-rc.2', '0.2.0-rc.1', '0.2.0-rc.2', '0.2.0', '0.3.0-rc.1', '4.0.1', '4.0.4', '5.0.0']
  const mismatches = []
  for (const range of ranges) {
    for (const version of versions) {
      const expected = semver.satisfies(version, range, { includePrerelease: true })
      const actual = satisfies(version, range)
      if (expected !== actual) mismatches.push(version + ' in ' + JSON.stringify(range) + ': 本实现=' + actual + ' semver=' + expected)
    }
  }
  assert.deepEqual(mismatches, [], '区间比较器与真实 semver 不一致(版本闸门判断会跑偏): ' + mismatches.join('; '))
  const semverPkg = JSON.parse(readFileSync(new URL('./package.json', semverPath), 'utf8'))
  console.log('compat: 区间比较器已与 semver@' + semverPkg.version + ' 交叉验证一致(' + ranges.length + ' 区间 × ' + versions.length + ' 版本)')
} else {
  console.log('compat: 未找到 semver, 跳过区间比较器交叉验证(断言仍按内置比较器执行)')
}

assert.ok(dshPeers.length > 0, 'package.json 必须声明至少一个 @deepseek-ai/dsh* peer(否则宿主无从判断兼容性)')
for (const runtime of KNOWN_DSH_RUNTIMES) {
  for (const peer of dshPeers) {
    assert.ok(satisfies(runtime.version, peers[peer]),
      'peerDependencies[' + peer + '] = "' + peers[peer] + '" 不覆盖 ' + runtime.version +
      '(' + runtime.where + ') —— 宿主会把整个 bundle 静默跳过(skippedBundles), 插件在那一端完全不加载。' +
      '请把区间写成能同时覆盖 ' + KNOWN_DSH_RUNTIMES.map((r) => r.version).join(' 与 ') + ' 的形式')
  }
}
// cordis 不在宿主的版本闸门里(闸门只看 @deepseek-ai/dsh*), 但它决定 ESM 解析,
// 所以同样要求覆盖两个运行时实测的 cordis 版本。
for (const cordisVersion of ['4.0.1', '4.0.4']) {
  if (peers['@deepseek-ai/cordis'] !== undefined) {
    assert.ok(satisfies(cordisVersion, peers['@deepseek-ai/cordis']),
      'peerDependencies["@deepseek-ai/cordis"] = "' + peers['@deepseek-ai/cordis'] + '" 不覆盖实测的 cordis ' + cordisVersion)
  }
}
assert.equal(pkg.dsh.client.platform, 'web',
  'dsh.client.platform 必须保持 "web": 桌面端宿主同样只收 platform === "web" 的客户端半(0.2.0 客户端模块系统源码实测)')

// ---------------------------------------------------------------------------
// 二、工具定义契约: 用**真内核**离线复核每个注册后的定义
// ---------------------------------------------------------------------------
// 用与内核同形的 ctx 跑一遍 apply, 拿到"注册后"的真实定义。
const registered = []
const routes = []
const ctx = {
  tools: { register(def) { registered.push(def); return () => { /* 随 fiber 清理 */ } } },
  webServer: { register(route) { routes.push(route); return () => { /* noop */ } } },
  get() { return undefined },
  effect(fn) { return fn() },
}
apply(ctx)

assert.equal(name, pkg.name, '插件 name 应与包名一致')
assert.deepEqual(inject, ['tools', 'webServer', 'subprocess'], 'inject 应包含 tools/webServer/subprocess(桌面端同样提供这三项)')
assert.ok(registered.length >= 11, '应注册全部工具, 实际 ' + registered.length)
assert.equal(routes.length, 1, '应注册 1 条同源路由(/dsh-workbench-ecs 前缀)')
assert.equal(routes[0].kind, 'prefix', '设置页路由应为 prefix 类型(与 webServer.register 契约一致)')
assert.ok(String(routes[0].path).startsWith('/dsh-workbench-ecs'), '设置页路由前缀应为 /dsh-workbench-ecs')

// 名称唯一(重复注册同名工具会让宿主直接失败)
const names = registered.map((def) => def.name)
assert.equal(new Set(names).size, names.length, '工具名不得重复: ' + names.join(','))

// 真内核: @deepseek-ai/dsh-tools 已在本仓库 devDependencies 里(npm ci 必有)。
// 导入失败时退化为"只校验形状", 并打印提示 —— 不让收不到网络的环境假红。
let kernel = null
try {
  kernel = await import('@deepseek-ai/dsh-tools')
} catch (err) {
  console.log('compat: 未能加载 @deepseek-ai/dsh-tools 内核(' + String(err.message) + '), 退化为形状校验')
}

// 形状校验: defineTool 归一化后的定义必须满足 register() 的那道闸, 且参数/输出
// 都是对象根(这是宿主工具协议的要求, 与内核版本无关)。
const shapeViolations = []
for (const def of registered) {
  if (typeof def.name !== 'string' || def.name.length === 0) shapeViolations.push('缺少 name')
  if (typeof def.description !== 'string' || def.description.length === 0) shapeViolations.push(def.name + ': 缺少 description')
  if (def.name === 'run_code') shapeViolations.push('run_code 是内核保留名, 不能注册')
  if (def.parameters === null || typeof def.parameters !== 'object') {
    shapeViolations.push(def.name + ': parameters 必须是对象根 schema')
  } else {
    if (def.parameters.type !== 'object') shapeViolations.push(def.name + ': parameters.type 必须是 object')
    if (def.parameters.properties === null || typeof def.parameters.properties !== 'object') {
      shapeViolations.push(def.name + ': parameters.properties 必须是对象')
    }
  }
  if (def.output === null || typeof def.output !== 'object') {
    shapeViolations.push(def.name + ': 缺少 output')
    continue
  }
  if (typeof def.output.render !== 'function') shapeViolations.push(def.name + ': output.render 必须是函数')
  if (def.output.presentationMeta !== undefined && typeof def.output.presentationMeta !== 'function') {
    shapeViolations.push(def.name + ': output.presentationMeta 必须是函数')
  }
  const schema = def.output.schema
  if (schema === null || typeof schema !== 'object') shapeViolations.push(def.name + ': 缺少 output.schema')
  else {
    // 作者手写的 output.schema 必须显式声明 additionalProperties(内核强制)
    if (schema.type !== 'object') shapeViolations.push(def.name + ': output.schema.type 必须是 object')
    if (typeof schema.additionalProperties !== 'boolean') {
      shapeViolations.push(def.name + ': output.schema.additionalProperties 必须显式 true/false')
    }
  }
  if (def.timeoutMs !== undefined && (!Number.isFinite(def.timeoutMs) || def.timeoutMs <= 0)) {
    shapeViolations.push(def.name + ': timeoutMs 必须是正有限数')
  }
  for (const key of ['presentCall', 'presentResult']) {
    if (def[key] !== undefined && typeof def[key] !== 'function') shapeViolations.push(def.name + ': ' + key + ' 必须是函数')
  }
}
assert.deepEqual(shapeViolations, [], '工具定义形状不满足宿主协议: ' + shapeViolations.join('; '))

// 真内核复核: 用内核自己的校验函数把 parameters / output.schema 再走一遍子集校验,
// 并确认定义里"作者手写"的那部分能通过内核编译 —— 这是"桌面端 0.2.0 也能加载"的
// 最强离线证据(两份内核的 defineTool / register / schema 校验源码已逐行比对一致;
// 真正的端到端确认由桌面端重启后的实机核验补上)。
if (kernel !== null) {
  for (const symbol of ['assertSupportedJsonSchema', 'validateArgs', 'defineTool']) {
    assert.equal(typeof kernel[symbol], 'function', '内核应导出 ' + symbol)
  }
  const kernelViolations = []
  for (const def of registered) {
    const check = (label, fn) => {
      try {
        fn()
      } catch (err) {
        kernelViolations.push(def.name + ' ' + label + ': ' + String(err.message).slice(0, 400))
      }
    }
    check('parameters', () => kernel.assertSupportedJsonSchema(def.parameters))
    check('output.schema', () => kernel.assertSupportedJsonSchema(def.output.schema))
  }
  assert.deepEqual(kernelViolations, [], '真内核拒绝这些工具定义(桌面端 0.2.0 会在注册时抛错): ' + kernelViolations.join(' | '))
}

const kernelLabel = kernel !== null ? '@deepseek-ai/dsh-tools 真内核' : '形状规则'
console.log('compat OK: peer 区间覆盖 ' + KNOWN_DSH_RUNTIMES.map((r) => r.version).join(' + ') +
  '; ' + registered.length + ' 个工具的定义均通过 ' + kernelLabel + ' 复核')
