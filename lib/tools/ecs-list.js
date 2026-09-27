// ============================================================================
// lib/tools/ecs-list.js —— ecs_list: 列出指定地域的 ECS 实例
// 对应 CLI: workbench list ecs --region <region> [过滤项...] --output json
// v0.7.0: argv 构造/实例归一与 ecs_find 共用(lib/regions.js); 0 台时提示改用
//         ecs_find 跨地域查找(反馈 §二.1: "猜地域"的摩擦点)。
// ============================================================================
import { runWorkbench, decodeCliOutput, commandLine, omitUndefined } from '../common.js'
import { buildListEcsArgv, normalizeLimit, normalizeInstanceRow, instancesOf } from '../regions.js'

export function ecsListDefinition(ctx) {
  // 把实例列表渲染成可读的文本表格
  function renderList(value) {
    const cols = [
      { key: 'instance_id', title: '实例ID', width: 22 },
      { key: 'instance_name', title: '名称', width: 18 },
      { key: 'instance_type', title: '规格', width: 16 },
      { key: 'status', title: '状态', width: 10 },
      { key: 'private_ip', title: '私网IP', width: 16 },
      { key: 'public_ip', title: '公网IP', width: 16 },
      { key: 'os_type', title: '系统', width: 8 },
    ]
    const lines = []
    lines.push('ECS 实例列表 — 地域: ' + value.region + ', 共 ' + value.count + ' 台')
    if (value.count > 0) {
      lines.push(cols.map((c) => c.title.padEnd(c.width)).join('  '))
      for (const inst of value.instances) {
        lines.push(cols.map((c) => String(inst[c.key] === undefined ? '' : inst[c.key]).padEnd(c.width)).join('  '))
      }
    } else {
      lines.push('(没有符合条件的实例)')
      if (value.empty_hint !== undefined) lines.push('[提示: ' + value.empty_hint + ']')
    }
    if (value.next_token !== undefined) lines.push('下一页 token: ' + value.next_token)
    if (value.pagination_note !== undefined) lines.push('[提示: ' + value.pagination_note + ']')
    lines.push('命令: ' + value.command)
    return lines.join('\n')
  }

  // 分页汇总: CLI 的 JSON 输出目前只含 instances —— 只在真拿到 token 时透出,
  // 拿不到而返回条数又已顶到 limit 时必须显式提示(而不是让模型以为"就这么多")
  function paginationOf(data, returned, limit) {
    const token = data !== null && typeof data === 'object' && !Array.isArray(data)
      ? (data.next_token !== undefined ? data.next_token : (data.nextToken !== undefined ? data.nextToken : undefined))
      : undefined
    const nextToken = token !== undefined && token !== null && String(token).length > 0 ? String(token) : undefined
    const totalRaw = data !== null && typeof data === 'object' && !Array.isArray(data)
      ? (data.total_count !== undefined ? data.total_count : (data.total !== undefined ? data.total : undefined))
      : undefined
    const total = typeof totalRaw === 'number' ? totalRaw : undefined
    let note
    if (nextToken === undefined && returned >= limit) {
      note = '返回条数已达 limit(' + limit + '), 可能存在下一页, 但 CLI 的 JSON 输出未包含 NextToken(v1.0.1 实测); ' +
        '可收紧过滤条件(instance_name/tag/status/vpc_id)缩小范围, 或用 ecs_find 跨地域检索, ' +
        '或为 CLI 提交 NextToken 透出需求'
    }
    return { nextToken, total, note }
  }

  return {
    name: 'ecs_list',
    description: '通过本机阿里云 Workbench CLI 列出指定地域的 ECS 实例, 支持状态/标签/规格/名称/VPC/交换机/可用区/私网IP/镜像过滤, ' +
      '返回实例清单(实例ID为后续 ecs_exec/ecs_upload 的输入)。适用于无公网 IP 的实例查询。' +
      '本工具**必须显式给出目标地域**; 不知道实例在哪个地域时请改用 ecs_find(它支持跨地域检索)。' +
      '注意: CLI 的 JSON 输出当前不含分页 token, 结果条数顶到 limit 时会显式提示。',
    parameters: {
      region: { type: 'string', required: true, description: '阿里云地域, 例如 cn-hangzhou(必填; 跨地域查找用 ecs_find)' },
      status: {
        type: 'string', enum: ['Running', 'Stopped', 'Starting', 'Stopping'],
        description: '按实例状态过滤',
      },
      tag: {
        type: 'array', items: { type: 'string' },
        description: '按标签过滤, 每项为 key=value 或 key, 可重复, 多个条件取交集',
      },
      instance_type: { type: 'string', description: '按实例规格过滤, 例如 ecs.g7.large' },
      instance_name: { type: 'string', description: '按实例名称过滤, 支持 * 通配符' },
      vpc_id: { type: 'string', description: '按 VPC ID 过滤' },
      vswitch_id: { type: 'string', description: '按交换机(VSwitch) ID 过滤' },
      zone_id: { type: 'string', description: '按可用区过滤, 例如 cn-shanghai-a' },
      private_ip: {
        type: 'array', items: { type: 'string' },
        description: '按私网 IP 过滤, 可多个(插件会以逗号拼接为 CLI 的逗号分隔参数)',
      },
      image_id: { type: 'string', description: '按镜像 ID 过滤' },
      limit: { type: 'integer', description: '每页数量, 10-100, 默认 50(ECS API 页大小下限为 10)' },
      next_token: { type: 'string', description: '上一页返回的 token(透传给 CLI; 当前 CLI 的 JSON 输出不返回该值)' },
      output_json: { type: 'boolean', description: '以稳定 JSON 文本返回结果, 便于下游自动化解析(默认 false)' },
    },
    timeoutMs: 60000,
    output: {
      schema: {
        type: 'object',
        properties: {
          command: { type: 'string' },
          region: { type: 'string' },
          count: { type: 'integer' },
          limit: { type: 'integer' },
          next_token: { type: 'string' },
          total: { type: 'integer' },
          pagination_note: { type: 'string' },
          empty_hint: { type: 'string' },
          instances: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                instance_id: { type: 'string' },
                instance_name: { type: 'string' },
                instance_type: { type: 'string' },
                region_id: { type: 'string' },
                status: { type: 'string' },
                private_ip: { type: 'string' },
                public_ip: { type: 'string' },
                os_type: { type: 'string' },
                image_id: { type: 'string' },
                tags: { type: 'object', additionalProperties: true },
              },
              additionalProperties: true,
            },
          },
        },
        additionalProperties: false,
      },
      render: (args, value) => [{
        type: 'text',
        text: args.output_json === true ? JSON.stringify(value, null, 2) : renderList(value),
      }],
      presentationMeta: (args, value) => ({ count: value.count, region: value.region }),
    },
    async execute(args, exec) {
      const limit = normalizeLimit(args.limit)
      const argv = buildListEcsArgv({
        region: args.region,
        status: args.status,
        tag: args.tag,
        instance_type: args.instance_type,
        instance_name: args.instance_name,
        vpc_id: args.vpc_id,
        vswitch_id: args.vswitch_id,
        zone_id: args.zone_id,
        private_ip: args.private_ip,
        image_id: args.image_id,
        limit: args.limit !== undefined ? limit : undefined,
        next_token: args.next_token,
      })

      const r = await runWorkbench(ctx, argv, exec.signal, { exec })
      if (exec.signal.aborted) throw new Error('工具调用已被取消')

      const data = decodeCliOutput(r, 'ecs_list')
      // 兼容两种返回结构: 官方文档为数组 [...], 实测 CLI 返回 { instances: [...] };
      // 另: **无实例时 CLI 返回裸数组 []**(实测 v1.0.1), 数组分支不可删。
      const instances = instancesOf(data)
      if (instances === undefined) {
        throw new Error('ecs_list: 意外的输出结构: ' + r.stdout.slice(0, 300))
      }
      const page = paginationOf(data, instances.length, limit)
      return omitUndefined({
        command: commandLine(argv),
        region: args.region,
        count: instances.length,
        limit,
        next_token: page.nextToken,
        total: page.total,
        pagination_note: page.note,
        empty_hint: instances.length === 0
          ? '该地域没有符合条件的实例。实例可能在别的地域 —— 用 ecs_find { keyword: "<实例名或IP>" } 跨地域查找' +
            '(内置公共地域清单, 并发检索); 也请先确认地域拼写是否写错。'
          : undefined,
        instances: instances.map(normalizeInstanceRow),
      })
    },
    presentCall(args) {
      return {
        card: 'generic',
        title: '列出 ' + args.region + ' 的 ECS 实例',
        kind: 'execute',
        rawInput: args.region,
        content: [{ type: 'text', text: 'workbench list ecs' }],
      }
    },
  }
}
