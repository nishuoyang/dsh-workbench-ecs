// ============================================================================
// lib/tools/ecs-upload.js —— ecs_upload: 上传本地文件到 ECS 实例
// 对应 CLI: workbench upload <local-file> <remote-path> --instance-id <id> [--force]
// 文件经阿里云 OSS 作为中继传输(最大 1GB), 会话自动管理。
// ============================================================================
import { runWorkbench, decodeLoose, commandLine, omitUndefined, withInstanceLock, localSha256, remoteSha256, remoteJoin } from '../common.js'

export function ecsUploadDefinition(ctx) {
  return {
    name: 'ecs_upload',
    description: '通过本机阿里云 Workbench CLI 把本地文件上传到指定 ECS 实例(经 OSS 中继, 最大 1GB)。' +
      '远程路径已存在时默认需要确认, 显式 force=true 会覆盖; ' +
      'verify_sha256=true 时上传后比对本地/远端 sha256, 传输损坏会在上传阶段直接暴露; ' +
      '上传后通常配合 ecs_exec 重启服务完成发布。适用于无公网 IP 的实例。',
    parameters: {
      local_file: { type: 'string', required: true, description: '本地文件路径(相对路径基于会话工作区)' },
      remote_path: { type: 'string', required: true, description: '远端目标路径, 例如 /opt/app/app.jar 或 /opt/app/(以分隔符结尾视为目录)' },
      instance_id: { type: 'string', required: true, description: '目标 ECS 实例 ID(可由 ecs_list 取得)' },
      region: { type: 'string', description: '地域, 可缺省: CLI 会从实例 ID 自动推断' },
      force: { type: 'boolean', description: '覆盖远端已存在文件而不需确认(默认 false)' },
      verify_sha256: { type: 'boolean', description: '上传后比对本地与远端 sha256(默认 false; 发布关键路径建议开启)' },
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
          sha256_local: { type: 'string' },
          sha256_remote: { type: 'string' },
          sha256_ok: { type: 'boolean' },
          verification: { type: 'string' },
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
          (value.verification !== undefined
            ? '[sha256: ' + (value.verification === 'ok' ? '校验通过 ' + value.sha256_local
                : (value.verification === 'mismatch'
                  ? '✘ 不一致 (本地 ' + value.sha256_local + ' / 远端 ' + value.sha256_remote + ')'
                  : '跳过/不可用 (' + value.verification + ')')) + ']\n'
            : '') +
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
      const remoteFile = remoteJoin(args.remote_path, args.local_file)

      // 上传与随后的校验在同一实例锁内完成: 同实例其它调用不会插在中间改文件。
      // (注意: 锁不可重入, 因此校验阶段以 locked:true 复用本锁)
      const out = await withInstanceLock(args.instance_id, async () => {
        const r = await runWorkbench(ctx, argv, exec.signal)
        if (exec.signal.aborted) throw new Error('工具调用已被取消')
        const decoded = decodeLoose(r, 'ecs_upload')
        const exitCode = r.exitCode != null ? r.exitCode : 0

        // 可选完整性校验: 传输损坏在上传阶段暴露, 而不是留到远端部署时才发现
        let sha256Local
        let sha256Remote
        let sha256Ok
        let verification
        if (args.verify_sha256 === true && exitCode === 0) {
          sha256Local = await localSha256(ctx, args.local_file, exec.signal)
          sha256Remote = await remoteSha256(ctx, args.instance_id, remoteFile, { region: args.region, signal: exec.signal, timeout: 60, locked: true })
          if (sha256Local === undefined) verification = 'local-tool-unavailable'
          else if (sha256Remote === undefined) verification = 'remote-unavailable'
          else {
            sha256Ok = sha256Local === sha256Remote
            verification = sha256Ok ? 'ok' : 'mismatch'
          }
        }
        return { r, decoded, exitCode, sha256Local, sha256Remote, sha256Ok, verification }
      })

      const { r, decoded } = out
      const message = decoded.text.length > 0 ? decoded.text : (decoded.json !== undefined ? JSON.stringify(decoded.json) : '')
      return omitUndefined({
        kind: 'upload',
        instance_id: args.instance_id,
        local_file: args.local_file,
        remote_path: args.remote_path,
        exit_code: out.exitCode,
        message,
        detail_json: decoded.json,
        force: args.force === true,
        sha256_local: out.sha256Local,
        sha256_remote: out.sha256Remote,
        sha256_ok: out.sha256Ok,
        verification: out.verification,
        stdout_truncated: r.stdoutTruncated === true,
        stdout_spill_path: r.stdoutSpillPath,
        command_line: commandLine(argv),
      })
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
