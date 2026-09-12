// ============================================================================
// scripts/to-body.mjs —— 把发布版 lib/ 多模块转换为动态挂载可用的 host body
// ----------------------------------------------------------------------------
// 用途: 动态挂载环境(cordis_define 的 code.host)没有 import/export,
//       本脚本把 lib/ 下的共享模块(自动发现) + lib/tools/*.js + lib/index.js
//       按依赖顺序拼接, 去除 import/export 外壳, 生成与发布源码同源的单一 body。
// 用法: node scripts/to-body.mjs [输出路径] [--tools=a,b] [--pretty]
// 注意: 共享模块**从 index.js 与 tools/*.js 的 import 递归自动发现** —— 新增
//       lib/xxx.js 无需改本脚本(此前是硬编码清单, 漏加会让动态挂载 body 里
//       引用到未拼入的符号, 表现为 ReferenceError)。
// ============================================================================
import { readFileSync, writeFileSync, readdirSync } from 'node:fs'

const rootUrl = new URL('../', import.meta.url)
const libUrl = new URL('lib/', rootUrl)

const toolsDir = readdirSync(new URL('tools/', libUrl)).filter((f) => f.endsWith('.js')).sort()
const toolSrcTexts = toolsDir.map((f) => readFileSync(new URL('tools/' + f, libUrl), 'utf8'))
const indexSrc = readFileSync(new URL('index.js', libUrl), 'utf8')

// 从消费者(index.js 与 tools/*.js)的本地 import 里**递归**发现共享模块。
// 递归很关键: lib/settings-api.js 这类"只被共享模块引用"的文件, 若只扫一层
// 就会被漏掉, 表现为动态挂载 body 里的 ReferenceError(D10 的同类问题)。
function discoverSharedModules(seeds) {
  const found = new Set()
  const queue = seeds.slice()
  const re = /from\s+['"]\.\.?\/([A-Za-z0-9._-]+)\.js['"]/g
  while (queue.length > 0) {
    const text = queue.shift()
    re.lastIndex = 0
    let match = re.exec(text)
    while (match !== null) {
      const file = match[1] + '.js'
      if (!found.has(file)) {
        found.add(file)
        queue.push(readFileSync(new URL(file, libUrl), 'utf8'))
      }
      match = re.exec(text)
    }
  }
  // 依赖顺序: common.js 必须最先(其余共享模块都依赖它), 之后按字母序稳定排列。
  // 注意: 共享模块之间只在**函数体**内互相引用, 因此字母序不会造成 TDZ 问题。
  return Array.from(found).sort((a, b) => {
    if (a === 'common.js') return -1
    if (b === 'common.js') return 1
    return a.localeCompare(b)
  })
}

const sharedFiles = discoverSharedModules([indexSrc, ...toolSrcTexts])
const sharedSrc = sharedFiles.map((f) => readFileSync(new URL(f, libUrl), 'utf8'))

// 模块 -> 无 import/export 外壳的源码
function stripModule(src) {
  // 删除 import 语句(支持多行: import {a, b} from 'x')
  const withoutImports = src.replace(/import[\s\S]*?from\s+['"][^'"]+['"]\s*;?/g, '')
  return withoutImports
    .split('\n')
    .map((line) => {
      const t = line.trim()
      if (t.startsWith('export const ')) return line.replace(/^export const /, 'const ')
      if (t.startsWith('export function ')) return line.replace(/^export function /, 'function ')
      if (t.startsWith('export async function ')) return line.replace(/^export async function /, 'async function ')
      return line
    })
    .join('\n')
}

// 紧凑化: 去掉行注释与空行(功能等值, 用于降低动态挂载载荷)
function compactModule(src) {
  return src
    .split('\n')
    .map((line) => line)
    .filter((line) => {
      const t = line.trim()
      if (t.length === 0) return false
      if (t.startsWith('//')) return false
      return true
    })
    .join('\n')
}


const strip = (s) => stripModule(s)
const compact = (s) => compactModule(s)
// 兼容参数: node scripts/to-body.mjs [输出路径] [--tools=t1,t2] (默认打包全部工具)
// --pretty: 保留注释与空行(仅用于调试 body; 动态挂载载荷用默认紧凑模式)
const pretty = process.argv.includes('--pretty')
const toolsArg = process.argv.find((a) => a.startsWith('--tools='))
const filter = toolsArg !== undefined ? toolsArg.slice('--tools='.length).split(',') : undefined
const selectedTools = filter === undefined
  ? toolsDir
  : toolsDir.filter((f) => filter.includes(f.replace(/\.js$/, '')))
if (filter !== undefined && selectedTools.length !== filter.length) {
  console.warn('警告: 部分工具未匹配 (' + filter.filter((f) => !selectedTools.some((s) => s.replace(/\.js$/, '') === f)).join(', ') + ')')
}

// 处理 index.js: 把 TOOL_FACTORIES 数组替换为选中工具的工厂名(子集模式)
function processIndex(src, selected) {
  const defs = selected.map((f) => {
    const parts = f.replace(/\.js$/, '').split('-')
    // ecs-list -> ecsListDefinition (首个小写, 其余驼峰)
    return parts[0] + parts.slice(1).map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join('') + 'Definition'
  })
  return src.replace(/const TOOL_FACTORIES = \[[\s\S]*?\]/, 'const TOOL_FACTORIES = [' + defs.join(', ') + ']')
}

// 紧凑化仅在非 --pretty 模式生效: pretty 用于生成可读 body 调试
const render = (src) => (pretty ? strip(src) : compact(strip(src)))
const body = [
  '// 由 scripts/to-body.mjs 从 lib/ 各模块自动生成 — 动态挂载用 host body',
  'const defineTool = harness.defineTool',
  '',
  ...sharedSrc.flatMap((src) => [render(src), '']),
  // 注意: selectedTools 是文件名数组, 这里按文件名读取内容后再转换
  ...selectedTools.flatMap((f) => [render(readFileSync(new URL('tools/' + f, libUrl), 'utf8')), '']),
  render(processIndex(strip(indexSrc), selectedTools)),
  '',
  'return { name, inject, apply }',
  '',
].join('\n')

const outPath = process.argv[2] ?? 'test/body.generated.js'
writeFileSync(new URL(outPath, rootUrl), body)
console.log('已生成: ' + outPath + ' (' + body.length + ' 字符, ' + body.split('\n').length + ' 行, pretty=' + pretty + ')')
console.log('共享模块(自动发现): lib/' + sharedFiles.join(', lib/'))
console.log('工具: lib/tools/' + selectedTools.join(', ') + ' + lib/index.js')
