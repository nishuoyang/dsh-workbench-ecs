// ============================================================================
// lib/tools/ecs-deploy.js —— ecs_deploy: 受控发布(上传 + 重启 + 健康检查)
// 流程: (可选)上传文件 -> (可选)sha256 校验 -> 执行重启/生效命令 -> (可选)健康检查;
// 三个阶段结果全部返回, 普通失败不中断后续阶段(由模型与用户判断处理);
// 但 sha256 校验失败属于"发布物已损坏", 会中止后续阶段(不重启坏包)。
// v0.4.0: 每个阶段显式下发默认超时(180s), 上传阶段默认开启 sha256 校验。
// ============================================================================
import { runWorkbench, decodeLoose, decodeCliOutput, commandLine, guardDestructiveCommand, omitUndefined, withInstanceLock, localSha256, remoteSha256, remoteJoin, resolveTimeout, cleanOutput } from '../common.js'

// 每阶段默认超时(秒): 必须显式下发(CLI --timeout 默认仅 30)
const DEFAULT_STAGE_TIMEOUT = 180

export function ecsDeployDefinition(ctx) {
  // 单阶段执行: 返回 { ok, exit_code, output, error }
  // opts.loose=true 用于 upload 这类"CLI 输出人类可读文本而非 JSON"的命令
  // (workbench upload 即使带 --output json 也只打印进度与 Upload complete 文本,
  //  此前的严格 JSON 解码会让 ecs_deploy 的上传阶段恒为失败)。
  async function runStage(argv, signal, opts = {}) {
    try {
      const r = await runWorkbench(ctx, argv, signal, { stdoutSpillMaxBytes: 64 * 1024 * 1024 })
      if (signal.aborted) throw new Error('工具调用已被取消')
      if (opts.loose === true) {
        const decoded = decodeLoose(r, 'ecs_deploy')
        const exitCode = r.exitCode != null ? r.exitCode : 0
        const text = decoded.text.length > 0 ? decoded.text : (decoded.json !== undefined ? JSON.stringify(decoded.json) : '')
        return omitUndefined({
          ok: exitCode === 0,
          exit_code: exitCode,
          output: cleanOutput(text, true),
          stdout_truncated: r.stdoutTruncated === true,
          stdout_spill_path: r.stdoutSpillPath,
          error: undefined,
        })
      }
      const data = decodeCliOutput(r, 'ecs_deploy')
      if (data === null || typeof data !== 'object' || Array.isArray(data)) {
        throw new Error('意外的输出结构: ' + r.stdout.slice(0, 300))
      }
      const remoteExit = typeof data.exit_code === 'number' ? data.exit_code : undefined
      const exitCode = remoteExit !== undefined ? remoteExit : (r.exitCode != null ? r.exitCode : 0)
      return omitUndefined({
        ok: exitCode === 0,
        exit_code: exitCode,
        output: data.output !== undefined ? String(data.output) : '',
        stdout_truncated: r.stdoutTruncated === true,
        stdout_spill_path: r.stdoutSpillPath,
        error: undefined,
      })
    } catch (err) {
      return {
        ok: false,
        exit_code: 0,
        output: '',
        stdout_truncated: false,
        error: err && err.message !== undefined ? String(err.message) : String(err),
      }
    }
  }

  function renderStages(value) {
    const lines = []
    lines.push('受控发布 — 实例: ' + value.instance_id + ', 阶段 ' + value.done_stage + '/' + value.total_stage + ', 结果: ' + (value.ok === true ? '成功' : '失败'))
    if (value.aborted === true) lines.push('已中止: ' + (value.abort_reason !== undefined ? value.abort_reason : '校验失败'))
    for (const s of value.stages) {
      lines.push('')
      lines.push('[' + s.name + '] ' + (s.ok === true ? 'OK' : 'FAIL'))
      if (s.ok !== true) {
        if (s.error !== undefined && s.error.length > 0) lines.push('  错误: ' + s.error)
      }
      if (s.sha256_local !== undefined) lines.push('  sha256 本地: ' + s.sha256_local)
      if (s.sha256_remote !== undefined) lines.push('  sha256 远端: ' + s.sha256_remote)
      if (s.output !== undefined && s.output.length > 0) {
        for (const line of String(s.output).split('\n')) lines.push('  ' + line)
      }
      if (s.exit_code !== undefined && s.exit_code !== null && s.ok !== true) {
        lines.push('  [exit code: ' + s.exit_code + ']')
      }
    }
    return lines.join('\n')
  }

  return {
    name: 'ecs_deploy',
    description: '受控发布组合工具: (1) 可选上传本地文件; (2) 上传后可选 sha256 校验(默认开启, 失败即中止发布); ' +
      '(3) 执行重启/生效命令; (4) 可选健康检查命令。' +
      '各阶段结果全部返回; 破坏性命令同样需要用户确认。' +
      '适用于"改代码 -> 上传 -> 校验 -> 重启 -> 验证"的完整修复闭环。',
    parameters: {
      instance_id: { type: 'string', required: true, description: '目标 ECS 实例 ID(可由 ecs_list 取得)' },
      command: { type: 'string', required: true, description: '重启/生效命令, 例如 docker compose restart 或 systemctl restart nginx' },
      local_file: { type: 'string', description: '可选: 要上传的本地文件(相对路径基于会话工作区)' },
      remote_path: { type: 'string', description: '可选: 上传目标远端路径(local_file 提供时必填; 以 / 结尾视为目录)' },
      health_check: { type: 'string', description: '可选: 健康检查命令, 例如 curl -fsS http://127.0.0.1/health || true' },
      region: { type: 'string', description: '地域, 可缺省: CLI 会从实例 ID 自动推断' },
      force: { type: 'boolean', description: '上传时覆盖远端已存在文件而不需确认(默认 false)' },
      verify_sha256: { type: 'boolean', description: '上传后校验本地与远端 sha256(默认 true); 校验失败会中止发布, 不执行重启' },
      timeout: { type: 'integer', description: '每个阶段命令超时时间(秒), 默认 ' + DEFAULT_STAGE_TIMEOUT },
    },
    timeoutMs: 900000,
    output: {
      schema: {
        type: 'object',
        properties: {
          instance_id: { type: 'string' },
          ok: { type: 'boolean' },
          done_stage: { type: 'integer' },
          total_stage: { type: 'integer' },
          aborted: { type: 'boolean' },
          abort_reason: { type: 'string' },
          stages: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                ok: { type: 'boolean' },
                exit_code: { type: 'integer' },
                output: { type: 'string' },
                stdout_truncated: { type: 'boolean' },
                stdout_spill_path: { type: 'string' },
                error: { type: 'string' },
                sha256_local: { type: 'string' },
                sha256_remote: { type: 'string' },
              },
              additionalProperties: false,
            },
          },
          command_line: { type: 'string' },
        },
        additionalProperties: false,
      },
      render: (args, value) => [{ type: 'text', text: renderStages(value) }],
      presentationMeta: (args, value) => omitUndefined({
        ok: value.ok, done_stage: value.done_stage, total_stage: value.total_stage, aborted: value.aborted,
      }),
    },
    async execute(args, exec) {
      const uploadNeeded = args.local_file !== undefined && args.local_file.length > 0
      if (uploadNeeded && (args.remote_path === undefined || args.remote_path.length === 0)) {
        throw new Error('ecs_deploy: 提供 local_file 时必须同时提供 remote_path')
      }
      // 破坏性命令守卫: 重启/健康检查命令都可能包含危险模式
      await guardDestructiveCommand(ctx, exec, args.command)
      if (args.health_check !== undefined) {
        await guardDestructiveCommand(ctx, exec, args.health_check)
      }

      const stageTimeout = String(resolveTimeout(args.timeout, DEFAULT_STAGE_TIMEOUT))
      const verify = args.verify_sha256 !== false

      // 整段发布占用实例锁: 上传/校验/重启/健康检查之间不被同实例的其它调用插入
      return withInstanceLock(args.instance_id, async () => {
        const stages = []
        const total = (uploadNeeded ? 1 : 0) + (verify && uploadNeeded ? 1 : 0) + 1 + (args.health_check !== undefined ? 1 : 0)
        let doneStage = 0
        let aborted = false
        let abortReason

        // 阶段 1: 上传(可选)
        if (uploadNeeded) {
          const argv = ['upload', args.local_file, args.remote_path, '--instance-id', args.instance_id, '--output', 'json']
          if (args.region !== undefined) argv.push('--region', args.region)
          if (args.force === true) argv.push('--force')
          if (exec.signal.aborted) throw new Error('工具调用已被取消')
          const stage = await runStage(argv, exec.signal, { loose: true })
          stages.push({ name: '上传 ' + args.local_file, ...stage })
          doneStage += 1
        }

        // 阶段 2: sha256 校验(可选, 默认开启) —— 发布物损坏必须在重启前发现
        if (verify && uploadNeeded) {
          const remoteFile = remoteJoin(args.remote_path, args.local_file)
          const localHash = await localSha256(ctx, args.local_file, exec.signal)
          const remoteHash = await remoteSha256(ctx, args.instance_id, remoteFile, { region: args.region, signal: exec.signal, timeout: 60, locked: true })
          if (localHash === undefined) {
            stages.push({
              name: '校验 sha256', ok: true, exit_code: 0,
              output: '本机无可用哈希工具(sha256sum/shasum/certutil), 已跳过校验; 远端哈希: ' + (remoteHash !== undefined ? remoteHash : '(不可用)'),
              error: undefined,
              sha256_remote: remoteHash,
            })
          } else if (remoteHash === undefined) {
            stages.push({
              name: '校验 sha256', ok: false, exit_code: 0, output: '',
              error: '无法获取远端 sha256(远端缺少 sha256sum/shasum 或文件不存在): ' + remoteFile,
              sha256_local: localHash,
            })
            aborted = true
            abortReason = 'sha256 校验无法完成, 已中止发布'
          } else if (localHash !== remoteHash) {
            stages.push({
              name: '校验 sha256', ok: false, exit_code: 0, output: '',
              error: 'sha256 不一致: 上传物与本地文件不同, 可能是传输损坏',
              sha256_local: localHash, sha256_remote: remoteHash,
            })
            aborted = true
            abortReason = 'sha256 不一致(' + localHash.slice(0, 12) + '… vs ' + remoteHash.slice(0, 12) + '…), 已中止发布'
          } else {
            stages.push({
              name: '校验 sha256', ok: true, exit_code: 0, output: 'sha256 一致: ' + localHash,
              error: undefined, sha256_local: localHash, sha256_remote: remoteHash,
            })
          }
          doneStage += 1
        }

        // 阶段 3/4: 只有在未中止时才继续
        if (!aborted) {
          {
            const argv = ['exec', '--instance-id', args.instance_id, '--command', args.command, '--timeout', stageTimeout, '--output', 'json']
            if (args.region !== undefined) argv.push('--region', args.region)
            if (exec.signal.aborted) throw new Error('工具调用已被取消')
            const stage = await runStage(argv, exec.signal)
            stages.push({ name: '重启/生效', ...stage })
            doneStage += 1
          }

          if (args.health_check !== undefined) {
            const argv = ['exec', '--instance-id', args.instance_id, '--command', args.health_check, '--timeout', stageTimeout, '--output', 'json']
            if (args.region !== undefined) argv.push('--region', args.region)
            if (exec.signal.aborted) throw new Error('工具调用已被取消')
            const stage = await runStage(argv, exec.signal)
            stages.push({ name: '健康检查', ...stage })
            doneStage += 1
          }
        }

        return omitUndefined({
          instance_id: args.instance_id,
          ok: stages.every((s) => s.ok === true),
          done_stage: doneStage,
          total_stage: total,
          aborted: aborted === true ? true : undefined,
          abort_reason: abortReason,
          stages,
          command_line: commandLine(['deploy', args.instance_id, args.command, '--timeout', stageTimeout]),
        })
      })
    },
    presentCall(args) {
      return {
        card: 'generic',
        title: '受控发布 ' + args.instance_id,
        kind: 'execute',
        rawInput: omitUndefined({ command: args.command, upload: args.local_file, health_check: args.health_check }),
      }
    },
  }
}
