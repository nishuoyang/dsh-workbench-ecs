// ============================================================================
// lib/tools/ecs-download.js —— ecs_download: 从 ECS 实例下载文件到本地
// 对应 CLI: workbench download <remote-path> [local-path] --instance-id <id> [--force]
// 文件经阿里云 OSS 作为中继传输(最大 1GB), 省略 local-path 时保存到当前
// 会话工作区(由插件执行环境决定, 一般为会话工作区根目录)。
// ============================================================================
import { runWorkbench, decodeLoose, commandLine } from '../common.js'

export function ecsDownloadDefinition(ctx) {
  return {
    name: 'ecs_download',
    description: '通过本机阿里云 Workbench CLI 从指定 ECS 实例下载文件到本地(经 OSS 中继, 最大 1GB)。' +
      'local_path 省略时保存到当前会话工作区目录; 本地已存在文件时默认需要确认, force=true 覆盖。' +
      '适用于无公网 IP 的实例。',
    parameters: {
      remote_path: { type: 'string', required: true, description: '远端文件路径, 例如 /var/log/app.log' },
      local_path: { type: 'string', description: '本地保存路径(文件或目录, 相对路径基于会话工作区; 省略=当前目录)' },
      instance_id: { type: 'string', required: true, description: '目标 ECS 实例 ID(可由 ecs_list 取得)' },
      region: { type: 'string', description: '地域, 可缺省: CLI 会从实例 ID 自动推断' },
      force: { type: 'boolean', description: '覆盖本地已存在文件而不需确认(默认 false)' },
    },
    timeoutMs: 300000,
    output: {
      schema: {
        type: 'object',
        properties: {
          kind: { type: 'string' },
          instance_id: { type: 'string' },
          remote_path: { type: 'string' },
          local_path: { type: 'string' },
          exit_code: { type: 'integer' },
          message: { type: 'string' },
          detail_json: { type: 'json' },
          force: { type: 'boolean' },
          stdout_truncated: { type: 'boolean' },
          stdout_spill_path: { type: 'string' },
          command_line: { type: 'string' },
        },
        additionalProperties: false,
      },
      render: (args, value) => [{
        type: 'text',
        text: '下载完成 — 实例: ' + value.instance_id + '\n' +
          '$ ' + value.remote_path + ' -> ' + (value.local_path.length > 0 ? value.local_path : '(当前目录)') + '\n' +
          (value.message.length > 0 ? value.message.replace(/\n$/, '') + '\n' : '') +
          '[exit code: ' + value.exit_code + ']' +
          (value.stdout_truncated === true
            ? '\n[输出过长, 已截断' + (value.stdout_spill_path !== undefined && value.stdout_spill_path !== null
                ? '; 完整输出: ' + value.stdout_spill_path : '') + ']'
            : ''),
      }],
    },
    async execute(args, exec) {
      const argv = ['download', args.remote_path, '--instance-id', args.instance_id, '--output', 'json']
      if (args.local_path !== undefined && args.local_path.length > 0) argv.push(args.local_path)
      if (args.region !== undefined) argv.push('--region', args.region)
      if (args.force === true) argv.push('--force')

      const r = await runWorkbench(ctx, argv, exec.signal)
      if (exec.signal.aborted) throw new Error('工具调用已被取消')

      const decoded = decodeLoose(r, 'ecs_download')
      const message = decoded.text.length > 0 ? decoded.text : (decoded.json !== undefined ? JSON.stringify(decoded.json) : '')
      return {
        kind: 'download',
        instance_id: args.instance_id,
        remote_path: args.remote_path,
        local_path: args.local_path !== undefined ? args.local_path : '',
        exit_code: r.exitCode !== null ? r.exitCode : 0,
        message,
        detail_json: decoded.json,
        force: args.force === true,
        stdout_truncated: r.stdoutTruncated,
        stdout_spill_path: r.stdoutSpillPath,
        command_line: commandLine(argv),
      }
    },
    presentCall(args) {
      return {
        card: 'generic',
        title: '下载 ' + (args.remote_path.length > 60 ? args.remote_path.slice(0, 60) + '…' : args.remote_path),
        kind: 'execute',
        rawInput: { remote: args.remote_path, local: args.local_path ?? '(当前目录)', instance: args.instance_id },
      }
    },
  }
}
