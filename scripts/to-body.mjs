// ============================================================================
// scripts/to-body.mjs —— 把发布版 lib/index.js 转换为动态挂载可用的 host body
// ----------------------------------------------------------------------------
// 用途: 动态挂载环境(cordis_define 的 code.host)没有 import/export,
//       本脚本提取 apply 与 name/inject, 生成与发布源码逐字一致的 body。
// 用法: node scripts/to-body.mjs [输出路径]
// ============================================================================
import { readFileSync, writeFileSync } from 'node:fs'

const rootUrl = new URL('../', import.meta.url)
const src = readFileSync(new URL('lib/index.js', rootUrl), 'utf8')

// 1) 提取 name / inject
const nameMatch = src.match(/export const name = '([^']+)'/)
if (nameMatch === null) throw new Error('无法从 lib/index.js 提取 name')
const injectMatch = src.match(/export const inject = (\[[^\]]*\])/)
if (injectMatch === null) throw new Error('无法从 lib/index.js 提取 inject')

// 2) 提取 apply 函数体(从 "export function apply(ctx) {" 之后到文件末尾最后一个 "}")
const applyStart = src.indexOf('export function apply(ctx) {')
if (applyStart === -1) throw new Error('无法从 lib/index.js 定位 apply')
const bodyStart = src.indexOf('{', applyStart) + 1
const bodyEnd = src.lastIndexOf('}')
const applyBody = src.slice(bodyStart, bodyEnd)

// 3) 组装动态 body
const body = [
  '// 由 scripts/to-body.mjs 从 lib/index.js 自动生成 — 动态挂载用 host body',
  '// 与 lib/index.js 的 apply 实现逐字一致(仅 import 换成 harness 提供的 defineTool)',
  'const defineTool = harness.defineTool',
  '',
  'return {',
  `  name: '${nameMatch[1]}',`,
  `  inject: ${injectMatch[1]},`,
  '  apply(ctx) {',
  applyBody,
  '  },',
  '}',
  '',
].join('\n')

const outPath = process.argv[2] ?? 'test/body.generated.js'
writeFileSync(new URL(outPath, rootUrl), body)
console.log('已生成: ' + outPath + ' (' + body.length + ' 字符)')
console.log('apply 文本与 lib/index.js 一致: ' + (applyBody === src.slice(bodyStart, bodyEnd)))
