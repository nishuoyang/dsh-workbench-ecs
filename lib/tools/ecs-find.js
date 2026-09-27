// ============================================================================
// lib/tools/ecs-find.js —— ecs_find: 跨地域检索 ECS 实例(F1, v0.7.0)
// ----------------------------------------------------------------------------
// 动机(反馈 §二.1): "仓库里没有任何地方记录这台机器的 instance_id 和 region,
// 只能靠猜" —— 实测 CLI 不支持 `--region all`, 也没有"列地域"的子命令, profile
// 里也存不下默认地域。因此跨地域检索只能由插件提供: 内置公共地域清单, 逐地域
// 并发查询并如实回报"查过哪些地域 / 哪些地域失败了"。
//
// 与 ecs_list 的分工:
//   ecs_list  —— "这个地域里有哪些实例"(必填 region, 单地域);
//   ecs_find  —— "我的实例在哪个地域"(region 可省, 默认全地域检索)。
// 本工具同时把工作区实例锚点(instances.json)一并列出 —— 一次查询就能回答
// "机器在哪 + 项目里有没有记过这台机器"。
// ============================================================================
import { omitUndefined, resolveWorkspaceRoot, commandLine } from '../common.js'
import { ECS_PUBLIC_REGIONS, searchInstances, normalizeLimit, parseRegionSpec } from '../regions.js'
import { loadAnchors, INSTANCES_FILE } from '../anchors.js'

const FIND_DEFAULT_CONCURRENCY = 4

export function ecsFindDefinition(ctx) {
  function renderFind(value) {
    const lines = []
    lines.push('跨地域实例检索 — 关键词: ' + (value.keyword !== undefined ? '"' + value.keyword + '"' : '(无, 列出全部)') +
      ', 命中 ' + value.total + ' 台')
    lines.push('[检索范围: ' + value.regions_tried.length + ' 个地域, 成功 ' + value.regions_ok +
      ', 扫描 ' + value.scanned + ' 台' +
      (value.concurrency > 1 ? ', 并发 ' + value.concurrency : '') + ']')
    if (value.total === 0) {
      lines.push('')
      lines.push('(没有命中的实例)')
      if (value.keyword !== undefined) {
        lines.push('提示: 关键词会同时匹配 实例名/实例ID/公网·私网IP/规格/标签; 也可用 instance_name(支持 * 通配)或 tag 过滤。')
      }
    }
    for (const hit of value.hits) {
      lines.push('')
      lines.push('── ' + hit.region + ' (' + hit.count + '/' + hit.region_total + ' 台) ──')
      for (const inst of hit.instances) {
        lines.push('  ' + inst.instance_id + '  ' + (inst.instance_name !== undefined ? inst.instance_name : '') +
          '  [' + inst.status + ']')
        lines.push('      ' + inst.instance_type + ' · 私网 ' + (inst.private_ip !== undefined ? inst.private_ip : '-') +
          ' · 公网 ' + (inst.public_ip !== undefined ? inst.public_ip : '-') + ' · ' + inst.os_type)
        const tags = Object.keys(inst.tags !== undefined ? inst.tags : {})
        if (tags.length > 0) lines.push('      tags: ' + tags.map((k) => k + '=' + inst.tags[k]).join(', '))
      }
    }
    if (value.regions_failed !== undefined && value.regions_failed.length > 0) {
      lines.push('')
      lines.push('[部分地域查询失败(不影响其它地域的结果) — 共 ' + value.regions_failed.length + ' 个]')
      for (const item of value.regions_failed) {
        lines.push('  ✘ ' + item.region + ': ' + item.error)
      }
    }
    if (value.regions_maxed !== undefined && value.regions_maxed > 0) {
      lines.push('')
      lines.push('[提示: 有 ' + value.regions_maxed + ' 个地域的返回条数顶到 limit(' + value.limit + '), ' +
        '可能还有未列出的实例; CLI 的 JSON 输出不含 NextToken(v1.0.1 实测), 无法自动翻页 —— ' +
        '请收紧过滤(instance_name/tag/status)或提高 limit(≤100)]')
    }
    lines.push('')
    if (value.anchors !== undefined && value.anchors.count > 0) {
      lines.push('[工作区实例锚点 ' + value.anchors.path + ' — ' + value.anchors.count + ' 个]')
      for (const anchor of value.anchors.names) {
        lines.push('  ' + anchor + ' → ' + value.anchors.items[anchor].instance_id +
          (value.anchors.items[anchor].region !== undefined ? ' @ ' + value.anchors.items[anchor].region : ''))
      }
      lines.push('  (可直接把锚点名当 instance_id 用, 例如 ecs_exec { instance_id: "' + value.anchors.names[0] + '" })')
    } else {
      lines.push('[工作区还没有实例锚点文件 ' + INSTANCES_FILE + ': 建议把常用机器记进去, ' +
        '之后 instance_id 可以直接写锚点名(region 会自动补齐)]')
    }
    lines.push('命令: ' + value.command)
    return lines.join('\n')
  }

  return {
    name: 'ecs_find',
    description: '跨地域检索 ECS 实例 —— 回答"我的实例在哪个地域", 不需要先猜地域。' +
      'keyword 会同时匹配 实例名/实例ID/公网·私网IP/规格/标签(大小写不敏感); region 缺省即检索内置公共地域清单' +
      '(' + ECS_PUBLIC_REGIONS.length + ' 个), 也可写单个地域或逗号分隔的多个地域。' +
      '并发查询, 某个地域失败不影响其它地域(结果里如实列出 regions_failed); ' +
      '同时列出工作区实例锚点 ' + INSTANCES_FILE + '。' +
      '注意: CLI 的 JSON 输出不含分页 token(实测 v1.0.1), 单地域返回条数顶到 limit 时会提示(无法自动翻页)。',
    parameters: {
      keyword: { type: 'string', description: '关键词(可选): 子串匹配 实例名/实例ID/私网IP/公网IP/规格/标签值, 大小写不敏感' },
      region: {
        type: 'string',
        description: '地域: 缺省或 "all" = 检索内置公共地域清单(' + ECS_PUBLIC_REGIONS.length + ' 个); ' +
          '也可写单个(如 cn-shanghai)或逗号分隔多个(如 cn-shanghai,cn-hangzhou)',
      },
      status: { type: 'string', enum: ['Running', 'Stopped', 'Starting', 'Stopping'], description: '按实例状态过滤' },
      instance_name: { type: 'string', description: '按实例名称过滤(CLI 侧, 支持 * 通配); 与 keyword 可同用' },
      tag: { type: 'array', items: { type: 'string' }, description: '按标签过滤, 每项 key=value 或 key, 可重复' },
      instance_type: { type: 'string', description: '按实例规格过滤, 例如 ecs.g7.large' },
      limit: { type: 'integer', description: '每个地域的页大小, 10-100, 默认 50(CLI 页大小下限 10)' },
      concurrency: { type: 'integer', description: '地域并发度, 默认 ' + FIND_DEFAULT_CONCURRENCY + '(上限 8)' },
      output_json: { type: 'boolean', description: '以稳定 JSON 文本返回结果(默认 false 返回可读文本)' },
    },
    timeoutMs: 180000,
    output: {
      schema: {
        type: 'object',
        properties: {
          keyword: { type: 'string' },
          mode: { type: 'string' },
          command: { type: 'string' },
          limit: { type: 'integer' },
          concurrency: { type: 'integer' },
          total: { type: 'integer' },
          scanned: { type: 'integer' },
          regions_tried: { type: 'array', items: { type: 'string' } },
          regions_ok: { type: 'integer' },
          regions_failed: {
            type: 'array',
            items: {
              type: 'object',
              properties: { region: { type: 'string' }, error: { type: 'string' } },
              additionalProperties: false,
            },
          },
          regions_maxed: { type: 'integer' },
          hits: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                region: { type: 'string' },
                count: { type: 'integer' },
                region_total: { type: 'integer' },
                instances: { type: 'array', items: { type: 'json' } },
              },
              additionalProperties: false,
            },
          },
          anchors: { type: 'json' },
        },
        additionalProperties: false,
      },
      render: (args, value) => [{
        type: 'text',
        text: args.output_json === true ? JSON.stringify(value, null, 2) : renderFind(value),
      }],
      presentationMeta: (args, value) => omitUndefined({ total: value.total, regions_ok: value.regions_ok, keyword: value.keyword }),
    },
    async execute(args, exec) {
      const limit = normalizeLimit(args.limit)
      const concurrency = Number.isFinite(Number(args.concurrency)) && Number(args.concurrency) > 0
        ? Math.min(Math.floor(Number(args.concurrency)), 8)
        : FIND_DEFAULT_CONCURRENCY
      const spec = parseRegionSpec(args.region)

      const found = await searchInstances(ctx, {
        region: args.region,
        keyword: args.keyword,
        limit,
        concurrency,
        signal: exec.signal,
        exec,
        filters: {
          status: args.status,
          instance_name: args.instance_name,
          tag: args.tag,
          instance_type: args.instance_type,
        },
      })
      if (exec.signal.aborted) throw new Error('工具调用已被取消')

      // 锚点: 只读工作区文件, 不触达实例(文件不存在时如实说明而非报错)
      const loaded = await loadAnchors(ctx, { workspaceRoot: resolveWorkspaceRoot(ctx, exec) })
      const anchorItems = {}
      if (loaded.ok === true) {
        for (const name of loaded.names) {
          anchorItems[name] = omitUndefined({
            instance_id: loaded.anchors[name].instance_id,
            region: loaded.anchors[name].region,
            fields: Object.keys(loaded.anchors[name].fields).length > 0 ? Object.keys(loaded.anchors[name].fields) : undefined,
          })
        }
      }

      const firstArgv = ['list', 'ecs', '--region', spec.mode === 'all' ? '<all: ' + spec.regions.length + ' regions>' : spec.regions[0], '--output', 'json']
      return omitUndefined({
        keyword: found.keyword,
        mode: found.mode,
        command: commandLine(firstArgv),
        limit,
        concurrency: found.concurrency,
        total: found.total,
        scanned: found.scanned,
        regions_tried: found.regions_tried,
        regions_ok: found.regions_ok,
        regions_failed: found.regions_failed,
        regions_maxed: found.regions_maxed,
        hits: found.hits,
        anchors: loaded.ok === true
          ? { path: loaded.path, count: loaded.names.length, names: loaded.names, items: anchorItems }
          : omitUndefined({ path: loaded.path, count: 0, names: [], items: {}, note: anchorNote(loaded) }),
      })
    },
    presentCall(args) {
      const target = args.keyword !== undefined && String(args.keyword).length > 0
        ? '关键词 ' + String(args.keyword)
        : (args.region !== undefined ? String(args.region) : '全部地域')
      return {
        card: 'generic',
        title: '跨地域查找实例 — ' + target,
        kind: 'read',
        rawInput: omitUndefined({ keyword: args.keyword, region: args.region }),
        content: [{ type: 'text', text: 'workbench list ecs (多地域)' }],
      }
    },
  }
}

// 锚点文件不可用时的说明(区分"没有文件"与"文件坏了")
function anchorNote(loaded) {
  if (loaded.reason === 'missing') return '工作区还没有 ' + INSTANCES_FILE + '(建议把常用机器记进去)'
  if (loaded.reason === 'no-fs') return '当前环境未挂载 fs 服务, 无法读取 ' + INSTANCES_FILE
  if (loaded.reason === 'invalid-json') return INSTANCES_FILE + ' 不是合法 JSON: ' + (loaded.error !== undefined ? loaded.error : '')
  if (loaded.reason === 'invalid-shape') return INSTANCES_FILE + ' 顶层必须是对象'
  return INSTANCES_FILE + ' 不可读: ' + (loaded.error !== undefined ? loaded.error : loaded.reason)
}
