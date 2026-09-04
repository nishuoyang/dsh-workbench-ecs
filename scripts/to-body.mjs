// ============================================================================
// scripts/to-body.mjs —— 把发布版 lib/ 多模块转换为动态挂载可用的 host body
// ----------------------------------------------------------------------------
// 用途: 动态挂载环境(cordis_define 的 code.host)没有 import/export,
//       本脚本把 lib/common.js + lib/tools/*.js + lib/index.js 按依赖顺序拼接,
//       去除 import/export 外壳, 生成与发布源码同源的单一 body。
// 用法: node scripts/to-body.mjs [输出路径]
// ============================================================================
import { readFileSync, writeFileSync } from 'node:fs'
import { readdirSync } from 'node:fs'

const rootUrl = new URL('../', import.meta.url)
const libUrl = new URL('lib/', rootUrl)

// 模块顺序: common 先(被引用), tools 次, index 最后
const commonSrc = readFileSync(new URL('common.js', libUrl), 'utf8')
const toolsDir = readdirSync(new URL('tools/', libUrl)).filter((f) => f.endsWith('.js')).sort()
const toolsSrc = toolsDir.map((f) => readFileSync(new URL('tools/' + f, libUrl), 'utf8'))
const indexSrc = readFileSync(new URL('index.js', libUrl), 'utf8')

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

const body = [
  '// 由 scripts/to-body.mjs 从 lib/ 各模块自动生成 — 动态挂载用 host body',
  'const defineTool = harness.defineTool',
  '',
  compact(strip(commonSrc)),
  '',
  // 注意: selectedTools 是文件名数组, 这里按文件名读取内容后再转换
  ...selectedTools.map((f) => compact(strip(readFileSync(new URL('tools/' + f, libUrl), 'utf8')))),
  '',
  compact(processIndex(strip(indexSrc), selectedTools)),
  '',
  'return { name, inject, apply }',
  '',
].join('\n')

const outPath = process.argv[2] ?? 'test/body.generated.js'
writeFileSync(new URL(outPath, rootUrl), body)
console.log('已生成: ' + outPath + ' (' + body.length + ' 字符, ' + body.split('\n').length + ' 行, pretty=' + pretty + ')')
console.log('模块: lib/common.js + lib/tools/' + selectedTools.join(', ') + ' + lib/index.js')
