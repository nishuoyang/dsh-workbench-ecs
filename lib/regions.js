// ============================================================================
// lib/regions.js —— 地域清单与跨地域实例检索(F1, v0.7.0)
// ----------------------------------------------------------------------------
// 动机(反馈 §二.1): 仓库里没有任何地方记录目标机的地域与 instance_id, 于是只能
// "猜地域": 实测 CLI 侧 **没有任何办法** 列地域或一次查多地域 ——
//   - `--region all` → {"code":2,"message":"invalid region \"all\": region does not exist or is not recognized"};
//   - profile 里也**存不下默认地域**(`config set` 只支持 language/log_level, 缺省恒为 cn-hangzhou),
//     这正是"cn-hangzhou 查 0 台"的机制解释;
//   - `workbench list ecs` 的 JSON 不含 NextToken(实测 v1.0.1), 因此单地域内也无法自动翻页。
// 结论: 跨地域能力只能在插件侧实现 —— 内置一份**公共地域清单**, 逐地域并发查询,
// 并如实回报"查过哪些地域、哪些地域查失败了"(反馈的口径: 少列几台比多列几台危险得多)。
// 本模块只做机制, 不假设任何项目信息。
// ============================================================================
import { runWorkbench, decodeCliOutput, commandLine, runWithConcurrency } from './common.js'

// 阿里云公共地域清单(静态; 可用 region 参数显式收窄或扩写)。
// 顺序只影响 regions_tried 的展示顺序, 不影响结果完整性。
export const ECS_PUBLIC_REGIONS = [
  'cn-shanghai',
  'cn-hangzhou',
  'cn-beijing',
  'cn-shenzhen',
  'cn-guangzhou',
  'cn-zhangjiakou',
  'cn-qingdao',
  'cn-chengdu',
  'cn-wulanchabu',
  'cn-hongkong',
  'ap-southeast-1',
  'ap-southeast-2',
  'ap-southeast-3',
  'ap-southeast-5',
  'ap-northeast-1',
  'ap-northeast-2',
  'ap-south-1',
  'eu-central-1',
  'eu-west-1',
  'us-west-1',
  'us-east-1',
  'me-east-1',
]

// 跨地域检索的默认并发(只读查询, 跨地域天然安全; 同地域仍由调用侧串行)
export const REGION_SEARCH_CONCURRENCY = 4

// 地域名归一(去空白、小写): CLI 对大小写敏感, 这里统一成小写
export function normalizeRegion(value) {
  return String(value != null ? value : '').trim().toLowerCase()
}

// 解析 region 参数:
//   undefined / '' / 'all'   → { mode: 'all', regions: 内置清单 }
//   'cn-shanghai'            → { mode: 'single', regions: ['cn-shanghai'] }
//   'cn-shanghai,cn-beijing' → { mode: 'list', regions: [...] }
export function parseRegionSpec(region) {
  const raw = normalizeRegion(region)
  if (raw.length === 0 || raw === 'all' || raw === '*') {
    return { mode: 'all', regions: ECS_PUBLIC_REGIONS.slice() }
  }
  const parts = raw.split(/[\s,;]+/).map((r) => r.trim()).filter((r) => r.length > 0)
  const unique = Array.from(new Set(parts))
  return { mode: unique.length > 1 ? 'list' : 'single', regions: unique }
}

// ecs_list / ecs_find 共用的 argv 构造(保持 ecs_list 既有行为逐字不变)
export function buildListEcsArgv(opts = {}) {
  const argv = ['list', 'ecs', '--region', String(opts.region), '--output', 'json']
  if (opts.status !== undefined && opts.status !== null && String(opts.status).length > 0) {
    argv.push('--status', String(opts.status))
  }
  if (Array.isArray(opts.tag)) {
    for (const t of opts.tag) argv.push('--tag', String(t))
  }
  if (opts.instance_type !== undefined && opts.instance_type !== null && String(opts.instance_type).length > 0) {
    argv.push('--instance-type', String(opts.instance_type))
  }
  if (opts.instance_name !== undefined && opts.instance_name !== null && String(opts.instance_name).length > 0) {
    argv.push('--instance-name', String(opts.instance_name))
  }
  if (opts.vpc_id !== undefined && opts.vpc_id !== null && String(opts.vpc_id).length > 0) argv.push('--vpc-id', String(opts.vpc_id))
  if (opts.vswitch_id !== undefined && opts.vswitch_id !== null && String(opts.vswitch_id).length > 0) {
    argv.push('--vswitch-id', String(opts.vswitch_id))
  }
  if (opts.zone_id !== undefined && opts.zone_id !== null && String(opts.zone_id).length > 0) argv.push('--zone-id', String(opts.zone_id))
  if (Array.isArray(opts.private_ip) && opts.private_ip.length > 0) {
    argv.push('--private-ip', opts.private_ip.map((ip) => String(ip)).join(','))
  }
  if (opts.image_id !== undefined && opts.image_id !== null && String(opts.image_id).length > 0) {
    argv.push('--image-id', String(opts.image_id))
  }
  if (opts.limit !== undefined && opts.limit !== null) argv.push('--limit', String(opts.limit))
  if (opts.next_token !== undefined && opts.next_token !== null && String(opts.next_token).length > 0) {
    argv.push('--next-token', String(opts.next_token))
  }
  return argv
}

// limit 归一: CLI 的页大小下限 10、上限 100
export function normalizeLimit(value, fallback = 50) {
  const n = Number(value)
  if (!Number.isFinite(n) || n < 10) return fallback
  return Math.min(Math.floor(n), 100)
}

// 单条实例记录归一(与 ecs_list 的输出字段一致)
export function normalizeInstanceRow(it) {
  const src = it !== null && typeof it === 'object' ? it : {}
  return {
    instance_id: src.instance_id !== undefined ? String(src.instance_id) : '',
    instance_name: src.instance_name !== undefined ? String(src.instance_name) : '',
    instance_type: src.instance_type !== undefined ? String(src.instance_type) : '',
    region_id: src.region_id !== undefined ? String(src.region_id) : '',
    status: src.status !== undefined ? String(src.status) : '',
    private_ip: src.private_ip !== undefined ? String(src.private_ip) : '',
    public_ip: src.public_ip !== undefined ? String(src.public_ip) : '',
    os_type: src.os_type !== undefined ? String(src.os_type) : '',
    image_id: src.image_id !== undefined ? String(src.image_id) : '',
    tags: src.tags !== null && src.tags !== undefined ? src.tags : {},
  }
}

// 兼容两种返回结构: 官方文档为数组 [...], 实测 CLI 返回 { instances: [...] }
// 另: **无实例时 CLI 返回裸数组 []**(实测 v1.0.1), 因此数组分支不可删。
export function instancesOf(data) {
  if (Array.isArray(data)) return data
  if (data !== null && typeof data === 'object' && Array.isArray(data.instances)) return data.instances
  return undefined
}

// 关键字匹配: 实例名 / 实例 ID / 公网·私网 IP / 规格 / tag 的键值, 大小写不敏感
export function matchInstanceKeyword(instance, keyword) {
  const kw = String(keyword != null ? keyword : '').trim().toLowerCase()
  if (kw.length === 0) return true
  const row = normalizeInstanceRow(instance)
  const haystack = [
    row.instance_id, row.instance_name, row.instance_type, row.private_ip, row.public_ip,
    row.image_id, row.region_id, row.status,
    Object.keys(row.tags).join(' '), Object.values(row.tags).map((v) => String(v)).join(' '),
  ].join(' ').toLowerCase()
  return haystack.includes(kw)
}

// 单地域查询(只读): 失败以 error 返回, 不抛错 —— 某个地域不可用不该毁掉整次跨地域检索
export async function listInstancesInRegion(ctx, opts = {}) {
  const region = String(opts.region)
  const limit = normalizeLimit(opts.limit)
  const argv = buildListEcsArgv(Object.assign({}, opts.filters, { region, limit, next_token: opts.next_token }))
  let r
  try {
    r = await runWorkbench(ctx, argv, opts.signal, { exec: opts.exec })
  } catch (err) {
    return { region, ok: false, error: err && err.message !== undefined ? String(err.message) : String(err), command_line: commandLine(argv) }
  }
  let data
  try {
    data = decodeCliOutput(r, 'ecs_list ' + region)
  } catch (err) {
    return {
      region, ok: false,
      error: err && err.message !== undefined ? String(err.message) : String(err),
      command_line: commandLine(argv),
    }
  }
  const instances = instancesOf(data)
  if (instances === undefined) {
    return { region, ok: false, error: '意外的输出结构: ' + String(r.stdout).slice(0, 200), command_line: commandLine(argv) }
  }
  return {
    region,
    ok: true,
    count: instances.length,
    limit,
    instances: instances.map(normalizeInstanceRow),
    command_line: commandLine(argv),
  }
}

// 跨地域检索: 并发查询各候选地域, 汇总命中与失败。
// 不做"命中即停"—— 反馈明确: 少列几台比多列几台危险得多。
export async function searchInstances(ctx, opts = {}) {
  const spec = parseRegionSpec(opts.region)
  const regions = Array.isArray(opts.regions) && opts.regions.length > 0 ? opts.regions : spec.regions
  const keyword = opts.keyword !== undefined && opts.keyword !== null ? String(opts.keyword) : ''
  const concurrency = Math.max(1, Math.min(Math.floor(Number(opts.concurrency) || REGION_SEARCH_CONCURRENCY), 8))
  const results = await runWithConcurrency(regions, concurrency, async (region) => {
    const one = await listInstancesInRegion(ctx, {
      region,
      filters: opts.filters,
      limit: opts.limit,
      signal: opts.signal,
      exec: opts.exec,
    })
    return one
  })
  const hits = []
  const failed = []
  let totalScanned = 0
  let maxedRegions = 0
  for (const one of results) {
    if (one.ok !== true) {
      failed.push({ region: one.region, error: one.error !== undefined ? one.error : '未知错误' })
      continue
    }
    totalScanned += one.count
    if (one.count >= one.limit) maxedRegions += 1
    const matched = one.instances.filter((it) => matchInstanceKeyword(it, keyword))
    if (matched.length > 0) {
      hits.push({
        region: one.region,
        count: matched.length,
        region_total: one.count,
        instances: matched,
      })
    }
  }
  return {
    mode: spec.mode,
    keyword: keyword.length > 0 ? keyword : undefined,
    regions_tried: regions.slice(),
    regions_ok: regions.length - failed.length,
    regions_failed: failed.length > 0 ? failed : undefined,
    regions_maxed: maxedRegions > 0 ? maxedRegions : undefined,
    scanned: totalScanned,
    total: hits.reduce((sum, h) => sum + h.count, 0),
    hits,
    concurrency,
  }
}
