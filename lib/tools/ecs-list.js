// ============================================================================
// lib/tools/ecs-list.js —— ecs_list: 列出指定地域的 ECS 实例
// 对应 CLI: workbench list ecs --region <region> [过滤项...] --output json
// ============================================================================
import { runWorkbench, decodeCliOutput, commandLine } from '../common.js'

// 工厂: 每次 apply 创建工具定义(捕获 ctx, 供 execute 使用)
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
    }
    lines.push('命令: ' + value.command)
    return lines.join('\n')
  }

  return {
    name: 'ecs_list',
    description: '通过本机阿里云 Workbench CLI 列出指定地域的 ECS 实例, 支持状态/标签/规格/名称过滤, ' +
      '返回实例清单(实例ID为后续 ecs_exec/ecs_upload 的输入)。适用于无公网 IP 的实例查询。',
    parameters: {
      region: { type: 'string', required: true, description: '阿里云地域, 例如 cn-hangzhou(必填)' },
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
      limit: { type: 'integer', description: '每页数量, 10-100, 默认 50(ECS API 页大小下限为 10)' },
    },
    timeoutMs: 60000,
    output: {
      schema: {
        type: 'object',
        properties: {
          command: { type: 'string' },
          region: { type: 'string' },
          count: { type: 'integer' },
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
      render: (args, value) => [{ type: 'text', text: renderList(value) }],
      presentationMeta: (args, value) => ({ count: value.count, region: value.region }),
    },
    async execute(args, exec) {
      // 构造 CLI 参数(显式 argv, 不经 shell, 值无需转义)
      const argv = ['list', 'ecs', '--region', args.region, '--output', 'json']
      if (args.status !== undefined) argv.push('--status', args.status)
      if (args.tag !== undefined && args.tag.length > 0) {
        for (const t of args.tag) argv.push('--tag', t)
      }
      if (args.instance_type !== undefined) argv.push('--instance-type', args.instance_type)
      if (args.instance_name !== undefined) argv.push('--instance-name', args.instance_name)
      if (args.limit !== undefined) argv.push('--limit', String(args.limit))

      const r = await runWorkbench(ctx, argv, exec.signal)
      if (exec.signal.aborted) throw new Error('工具调用已被取消')

      const data = decodeCliOutput(r, 'ecs_list')
      // 兼容两种返回结构: 官方文档为数组 [...], 实测 CLI 返回 { instances: [...] } 包装对象
      let instances
      if (Array.isArray(data)) {
        instances = data
      } else if (data !== null && typeof data === 'object' && Array.isArray(data.instances)) {
        instances = data.instances
      } else {
        throw new Error('ecs_list: 意外的输出结构: ' + r.stdout.slice(0, 300))
      }
      return {
        command: commandLine(argv),
        region: args.region,
        count: instances.length,
        instances: instances.map((it) => ({
          instance_id: it.instance_id !== undefined ? String(it.instance_id) : '',
          instance_name: it.instance_name !== undefined ? String(it.instance_name) : '',
          instance_type: it.instance_type !== undefined ? String(it.instance_type) : '',
          region_id: it.region_id !== undefined ? String(it.region_id) : '',
          status: it.status !== undefined ? String(it.status) : '',
          private_ip: it.private_ip !== undefined ? String(it.private_ip) : '',
          public_ip: it.public_ip !== undefined ? String(it.public_ip) : '',
          os_type: it.os_type !== undefined ? String(it.os_type) : '',
          image_id: it.image_id !== undefined ? String(it.image_id) : '',
          tags: it.tags !== undefined ? it.tags : {},
        })),
      }
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
