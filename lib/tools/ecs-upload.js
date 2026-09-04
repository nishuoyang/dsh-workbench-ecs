// ============================================================================
// lib/tools/ecs-upload.js —— ecs_upload: 上传本地文件到 ECS 实例
// 对应 CLI: workbench upload <local-file> <remote-path> --instance-id <id> [--force]
// 文件经阿里云 OSS 作为中继传输(最大 1GB), 会话自动管理。
// ============================================================================
import { runWorkbench, decodeLoose, commandLine } from '../common.js'

export function ecsUploadDefinition(ctx) {
  return {
    name: 'ecs_upload',
    description: '通过本机阿里云 Workbench CLI 把本地文件上传到指定 ECS 实例(经 OSS 中继, 最大 1GB)。' +
      '远程路径已存在时默认需要确认, 显式 force=true 会覆盖; ' +
      '上传后通常配合 ecs_exec 重启服务完成发布。适用于无公网 IP 的实例。',
    parameters: {
      local_file: { type: 'string', required: true, description: '本地文件路径(相对路径基于会话工作区)' },
      remote_path: { type: 'string', required: true, description: '远端目标路径, 例如 /opt/app/app.jar 或 /opt/app/' },
      instance_id: { type: 'string', required: true, description: '目标 ECS 实例 ID(可由 ecs_list 取得)' },
      region: { type: 'string', description: '地域, 可缺省: CLI 会从实例 ID 自动推断' },
      force: { type: 'boolean', description: '覆盖远端已存在文件而不需确认(默认 false)' },
    },
    timeoutMs: 300000,
    output: {
      schema: {
        type: 'object',
        properties: {
          kind: { type: 'string' },
          instance_id: { type: 'string' },
          local_file: { type: 'string' },
          remote_path: { type: 'string' },
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
        text: '上传完成 — 实例: ' + value.instance_id + '\n' +
          '$ ' + value.local_file + ' -> ' + value.remote_path + '\n' +
          (value.message.length > 0 ? value.message.replace(/\n$/, '') + '\n' : '') +
          '[exit code: ' + value.exit_code + ']' +
          (value.stdout_truncated === true
            ? '\n[输出过长, 已截断' + (value.stdout_spill_path !== undefined && value.stdout_spill_path !== null
                ? '; 完整输出: ' + value.stdout_spill_path : '') + ']'
            : ''),
      }],
    },
    async execute(args, exec) {
      const argv = ['upload', args.local_file, args.remote_path, '--instance-id', args.instance_id, '--output', 'json']
      if (args.region !== undefined) argv.push('--region', args.region)
      if (args.force === true) argv.push('--force')

      const r = await runWorkbench(ctx, argv, exec.signal)
      if (exec.signal.aborted) throw new Error('工具调用已被取消')

      const decoded = decodeLoose(r, 'ecs_upload')
      const message = decoded.text.length > 0 ? decoded.text : (decoded.json !== undefined ? JSON.stringify(decoded.json) : '')
      return {
        kind: 'upload',
        instance_id: args.instance_id,
        local_file: args.local_file,
        remote_path: args.remote_path,
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
        title: '上传 ' + (args.local_file.length > 60 ? args.local_file.slice(0, 60) + '…' : args.local_file),
        kind: 'execute',
        rawInput: { local: args.local_file, remote: args.remote_path, instance: args.instance_id },
      }
    },
  }
}
