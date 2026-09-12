// ============================================================================
// lib/tools/ecs-upload.js —— ecs_upload: 上传本地文件/目录到 ECS 实例
// 对应 CLI: workbench upload <local-file> <remote-path> --instance-id <id> [--force]
// 文件经阿里云 OSS 作为中继传输(最大 1GB), 会话自动管理。
// 目录上传(S5b): 本机 tar 归档 -> 上传归档 -> (可选 sha256 校验) -> 远端解包,
//                顺序保证"校验后才解包", 坏包不会落到远端目录。
// ============================================================================
import {
  runWorkbench, runProcess, decodeLoose, commandLine, omitUndefined, withInstanceLock,
  localSha256, remoteSha256, remoteJoin, shortId, resolveTimeout,
  resolveLocalTool, removeLocalFile, buildTarCreateArgv, buildArchiveExtractScript,
  parseArchiveEntries, splitLocalPath, cleanOutput,
} from '../common.js'

// 远端解包命令的超时(秒): 必须显式下发 —— CLI 的 --timeout 默认只有 30 秒(D1)
const UPLOAD_EXTRACT_TIMEOUT = 120

// 归档暂存名的前缀(位于会话工作区根目录, 上传后立即清理)
const UPLOAD_ARCHIVE_PREFIX = '.dsh-ecs-upload-'

export function ecsUploadDefinition(ctx) {
  // ---- 目录上传: 归档 -> 上传 -> 校验 -> 解包 (全程一次实例锁) ----
  async function uploadDirectory(args, exec) {
    const parts = splitLocalPath(args.local_dir)
    if (parts.base.length === 0 || parts.base === '.' || parts.base === '..') {
      throw new Error('ecs_upload: local_dir 必须是具体目录(如 deploy 或 dist/), 不能是 "." 或 ".."')
    }
    const tarExe = await resolveLocalTool(ctx, ['tar'])
    if (tarExe === undefined) {
      throw new Error('ecs_upload: 目录上传需要本机 tar(Windows 10+ / Linux 自带), 当前未找到; ' +
        '可改用 local_file 逐个上传')
    }

    const id = shortId()
    // 相对会话工作区: spawnProcess 的 cwd 即工作区根, tar/upload/sha256 三处一致
    const archiveLocal = UPLOAD_ARCHIVE_PREFIX + id + '.tar.gz'
    const archiveRemote = '/tmp/dsh-ecs-upload-' + id + '.tar.gz'
    const remoteDir = String(args.remote_path)
    const verify = args.verify_sha256 === true

    // 1) 本机归档(在实例锁之外, 纯本地操作)
    const tarRun = await runProcess(ctx, buildTarCreateArgv(tarExe, archiveLocal, args.local_dir), exec.signal, { exec,
      stdoutMaxBytes: 64 * 1024, stderrMaxBytes: 64 * 1024,
    })
    if (tarRun.exitCode !== 0) {
      throw new Error('ecs_upload: 本机归档失败 (exit ' + tarRun.exitCode + '): ' +
        cleanOutput(tarRun.stdout + tarRun.stderr, true).slice(0, 400))
    }

    let sha256Local
    if (verify) sha256Local = await localSha256(ctx, archiveLocal, exec.signal, { exec })

    const uploadArgv = ['upload', archiveLocal, archiveRemote, '--instance-id', args.instance_id, '--output', 'json']
    if (args.region !== undefined) uploadArgv.push('--region', args.region)
    if (args.force === true) uploadArgv.push('--force')

    const extractScript = buildArchiveExtractScript({
      archivePath: archiveRemote,
      remoteDir,
      keepRootDir: args.keep_root_dir === true,
      keepArchive: args.keep_archive === true,
    })
    const extractArgv = ['exec', '--instance-id', args.instance_id, '--command', extractScript,
      '--timeout', String(resolveTimeout(args.timeout, UPLOAD_EXTRACT_TIMEOUT)), '--output', 'json']
    if (args.region !== undefined) extractArgv.push('--region', args.region)

    // 2) 上传 + 校验 + 解包在同一实例锁内: 同实例其它调用不会插进中间
    //    (锁不可重入, 故校验以 locked:true 复用本锁)
    let cleanup = 'skipped'
    try {
      const out = await withInstanceLock(args.instance_id, async () => {
        const up = await runWorkbench(ctx, uploadArgv, exec.signal, { exec })
        if (exec.signal.aborted) throw new Error('工具调用已被取消')
        const decoded = decodeLoose(up, 'ecs_upload')
        const uploadExit = up.exitCode != null ? up.exitCode : 0
        const uploadMessage = decoded.text.length > 0 ? decoded.text
          : (decoded.json !== undefined ? JSON.stringify(decoded.json) : '')

        let sha256Remote
        let verification
        if (verify && uploadExit === 0) {
          sha256Remote = await remoteSha256(ctx, args.instance_id, archiveRemote,
            { region: args.region, signal: exec.signal, timeout: 60, locked: true })
          if (sha256Local === undefined) verification = 'local-tool-unavailable'
          else if (sha256Remote === undefined) verification = 'remote-unavailable'
          else verification = sha256Local === sha256Remote ? 'ok' : 'mismatch'
        }

        // 校验失败即中止: 坏包绝不落地(与 ecs_deploy 的 abort 语义一致)
        if (verification === 'mismatch') {
          return {
            uploadExit, uploadMessage, sha256Remote, verification,
            aborted: true, abortReason: 'sha256-mismatch', extracted: false,
            extractExit: 0, extractOutput: '', entries: undefined,
            uploadTruncated: up.stdoutTruncated === true, uploadSpill: up.stdoutSpillPath,
          }
        }

        const ex = await runWorkbench(ctx, extractArgv, exec.signal, { exec })
        if (exec.signal.aborted) throw new Error('工具调用已被取消')
        const exDecoded = decodeLoose(ex, 'ecs_upload 解包')
        // 解包走 exec --output json: 内容在 JSON 的 output 字段里
        // (decodeLoose 在 stdout 为合法 JSON 时 text 为空串, 直接用 text 会丢掉一切输出)
        const exJson = exDecoded.json !== undefined && exDecoded.json !== null && typeof exDecoded.json === 'object'
          ? exDecoded.json : undefined
        const exText = exJson !== undefined && exJson.output !== undefined ? String(exJson.output) : exDecoded.text
        const parsed = parseArchiveEntries(exText)
        // 远端退出码以 JSON 的 exit_code 为准(D5): CLI 自身退出码仅作回退
        const extractExit = exJson !== undefined && typeof exJson.exit_code === 'number'
          ? exJson.exit_code
          : (ex.exitCode != null ? ex.exitCode : 0)
        return {
          uploadExit, uploadMessage, sha256Remote, verification,
          aborted: false, abortReason: undefined, extracted: extractExit === 0,
          extractExit, extractOutput: parsed.text, entries: parsed.entries,
          uploadTruncated: up.stdoutTruncated === true, uploadSpill: up.stdoutSpillPath,
        }
      })
      // 3) 本地归档清理(尽力; 不影响结果)
      const removed = await removeLocalFile(ctx, archiveLocal, undefined, { exec })
      cleanup = removed
      return omitUndefined({
        kind: 'upload',
        mode: 'dir',
        instance_id: args.instance_id,
        local_file: args.local_dir,
        local_dir: args.local_dir,
        remote_path: remoteDir,
        archive_local: archiveLocal,
        archive_remote: archiveRemote,
        exit_code: out.extracted ? out.extractExit : out.uploadExit,
        message: out.uploadMessage,
        force: args.force === true,
        sha256_local: sha256Local,
        sha256_remote: out.sha256Remote,
        sha256_ok: out.verification === 'ok' ? true : undefined,
        verification: out.verification,
        entries: out.entries,
        extracted: out.extracted,
        keep_root_dir: args.keep_root_dir === true ? true : undefined,
        keep_archive: args.keep_archive === true ? true : undefined,
        aborted: out.aborted === true ? true : undefined,
        abort_reason: out.abortReason,
        extract_output: out.extractOutput.length > 0 ? out.extractOutput : undefined,
        local_archive_cleanup: cleanup,
        stdout_truncated: out.uploadTruncated === true ? true : undefined,
        stdout_spill_path: out.uploadSpill,
        command_line: commandLine(uploadArgv),
      })
    } catch (err) {
      // 失败也要清掉本地归档, 避免在工作区留下垃圾
      await removeLocalFile(ctx, archiveLocal, undefined, { exec }).catch(() => {})
      throw err
    }
  }

  async function uploadFile(args, exec) {
    const argv = ['upload', args.local_file, args.remote_path, '--instance-id', args.instance_id, '--output', 'json']
    if (args.region !== undefined) argv.push('--region', args.region)
    if (args.force === true) argv.push('--force')
    const remoteFile = remoteJoin(args.remote_path, args.local_file)

    // 上传与随后的校验在同一实例锁内完成: 同实例其它调用不会插在中间改文件。
    // (注意: 锁不可重入, 因此校验阶段以 locked:true 复用本锁)
    const out = await withInstanceLock(args.instance_id, async () => {
      const r = await runWorkbench(ctx, argv, exec.signal, { exec })
      if (exec.signal.aborted) throw new Error('工具调用已被取消')
      const decoded = decodeLoose(r, 'ecs_upload')
      const exitCode = r.exitCode != null ? r.exitCode : 0

      // 可选完整性校验: 传输损坏在上传阶段暴露, 而不是留到远端部署时才发现
      let sha256Local
      let sha256Remote
      let sha256Ok
      let verification
      if (args.verify_sha256 === true && exitCode === 0) {
        sha256Local = await localSha256(ctx, args.local_file, exec.signal, { exec })
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
    // 清洗(与 ecs_deploy 的上传阶段同口径): workbench upload 会把 spinner/百分比帧
    // 直接写进输出, 原样返回会让卡片被数百个重绘帧淹没 —— 只保留结论行。
    const rawMessage = decoded.text.length > 0 ? decoded.text : (decoded.json !== undefined ? JSON.stringify(decoded.json) : '')
    const message = cleanOutput(rawMessage, true)
    return omitUndefined({
      kind: 'upload',
      mode: 'file',
      instance_id: args.instance_id,
      local_file: args.local_file,
      remote_path: args.remote_path,
      exit_code: out.exitCode,
      message,
      force: args.force === true,
      sha256_local: out.sha256Local,
      sha256_remote: out.sha256Remote,
      sha256_ok: out.sha256Ok,
      verification: out.verification,
      stdout_truncated: r.stdoutTruncated === true,
      stdout_spill_path: r.stdoutSpillPath,
      command_line: commandLine(argv),
    })
  }

  return {
    name: 'ecs_upload',
    description: '通过本机阿里云 Workbench CLI 把本地文件或目录上传到指定 ECS 实例(经 OSS 中继, 最大 1GB)。' +
      'local_file 与 local_dir 二选一: local_dir 为目录递归上传(插件在本机 tar 归档后上传, 再在远端解包), ' +
      '省掉手工打包; 远程路径已存在时默认需要确认, 显式 force=true 会覆盖; ' +
      'verify_sha256=true 时上传后比对 sha256, 目录模式下校验失败会**中止解包**(坏包不落地); ' +
      '上传后通常配合 ecs_exec 重启服务完成发布。适用于无公网 IP 的实例。',
    parameters: {
      local_file: { type: 'string', description: '本地文件路径(相对路径基于会话工作区); 与 local_dir 二选一' },
      local_dir: {
        type: 'string',
        description: '本地目录路径(递归上传, 与 local_file 二选一): 本机 tar.gz 归档 -> 上传 -> 远端解包到 remote_path。' +
          '默认剥掉归档顶层目录名(目录内容直接落在 remote_path 下), keep_root_dir=true 可保留',
      },
      remote_path: { type: 'string', required: true, description: '远端目标路径: local_file 时为文件路径(以分隔符结尾视为目录), local_dir 时为目标目录' },
      instance_id: { type: 'string', required: true, description: '目标 ECS 实例 ID(可由 ecs_list 取得)' },
      region: { type: 'string', description: '地域, 可缺省: CLI 会从实例 ID 自动推断' },
      force: { type: 'boolean', description: '覆盖远端已存在文件而不需确认(默认 false)' },
      verify_sha256: { type: 'boolean', description: '上传后比对本地与远端 sha256(默认 false; 发布关键路径建议开启。目录模式校验失败会中止解包)' },
      keep_root_dir: { type: 'boolean', description: '目录模式: 保留归档顶层的目录名(默认 false, 即只上传目录内容)' },
      keep_archive: { type: 'boolean', description: '目录模式: 远端解包后保留归档文件(默认 false, 解包后删除)' },
      timeout: { type: 'integer', description: '目录模式远端解包命令的超时(秒), 默认 ' + UPLOAD_EXTRACT_TIMEOUT },
    },
    timeoutMs: 300000,
    output: {
      schema: {
        type: 'object',
        properties: {
          kind: { type: 'string' },
          mode: { type: 'string' },
          instance_id: { type: 'string' },
          local_file: { type: 'string' },
          local_dir: { type: 'string' },
          remote_path: { type: 'string' },
          archive_local: { type: 'string' },
          archive_remote: { type: 'string' },
          exit_code: { type: 'integer' },
          message: { type: 'string' },
          detail_json: { type: 'json' },
          force: { type: 'boolean' },
          sha256_local: { type: 'string' },
          sha256_remote: { type: 'string' },
          sha256_ok: { type: 'boolean' },
          verification: { type: 'string' },
          entries: { type: 'integer' },
          extracted: { type: 'boolean' },
          keep_root_dir: { type: 'boolean' },
          keep_archive: { type: 'boolean' },
          aborted: { type: 'boolean' },
          abort_reason: { type: 'string' },
          extract_output: { type: 'string' },
          local_archive_cleanup: { type: 'string' },
          stdout_truncated: { type: 'boolean' },
          stdout_spill_path: { type: 'string' },
          command_line: { type: 'string' },
        },
        additionalProperties: false,
      },
      render: (args, value) => {
        const lines = []
        if (value.mode === 'dir') {
          lines.push((value.aborted === true ? '目录上传已中止' : '目录上传完成') +
            ' — 实例: ' + value.instance_id)
          lines.push('$ ' + value.local_dir + '/ -> ' + value.remote_path + '/')
          lines.push('[归档: ' + value.archive_local + ' -> ' + value.archive_remote +
            (value.keep_archive === true ? ' (已保留)' : ' (已清理)') + ']')
        } else {
          lines.push('上传完成 — 实例: ' + value.instance_id)
          lines.push('$ ' + value.local_file + ' -> ' + value.remote_path)
        }
        if (value.message !== undefined && value.message.length > 0) lines.push(value.message.replace(/\n$/, ''))
        if (value.verification !== undefined) {
          lines.push('[sha256: ' + (value.verification === 'ok' ? '校验通过 ' + value.sha256_local
            : (value.verification === 'mismatch'
              ? '✘ 不一致 (本地 ' + value.sha256_local + ' / 远端 ' + value.sha256_remote + ')'
              : '跳过/不可用 (' + value.verification + ')')) + ']')
        }
        if (value.mode === 'dir') {
          if (value.aborted === true) {
            lines.push('[✘ 已中止: sha256 不一致, 未在远端解包(远端目录未被改动)]')
          } else if (value.extracted === true) {
            lines.push('[解包: 成功, 共 ' + (value.entries !== undefined ? value.entries : '?') + ' 个归档条目' +
              (value.keep_root_dir === true ? ', 保留顶层目录' : ', 已剥掉顶层目录') + ']')
          } else {
            lines.push('[✘ 解包失败 (exit ' + value.exit_code + '), 远端目录可能不完整]')
          }
          if (value.extract_output !== undefined && value.extract_output.length > 0) {
            lines.push(value.extract_output.replace(/\n$/, ''))
          }
          if (value.local_archive_cleanup !== undefined && value.local_archive_cleanup !== 'removed') {
            lines.push('[提示: 本地归档未清理 (' + value.local_archive_cleanup + '), 请手工删除 ' + value.archive_local + ']')
          }
        }
        lines.push('[exit code: ' + value.exit_code + ']')
        if (value.stdout_truncated === true) {
          lines.push('[输出过长, 已截断' + (value.stdout_spill_path !== undefined && value.stdout_spill_path !== null
            ? '; 完整输出: ' + value.stdout_spill_path : '') + ']')
        }
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(args, exec) {
      const hasFile = typeof args.local_file === 'string' && args.local_file.length > 0
      const hasDir = typeof args.local_dir === 'string' && args.local_dir.length > 0
      if (hasFile && hasDir) {
        throw new Error('ecs_upload: local_file 与 local_dir 只能二选一')
      }
      if (!hasFile && !hasDir) {
        throw new Error('ecs_upload: 必须提供 local_file 或 local_dir')
      }
      return hasDir ? await uploadDirectory(args, exec) : await uploadFile(args, exec)
    },
    presentCall(args) {
      const isDir = typeof args.local_dir === 'string' && args.local_dir.length > 0
      const src = isDir ? String(args.local_dir) : String(args.local_file != null ? args.local_file : '')
      return {
        card: 'generic',
        title: (isDir ? '上传目录 ' : '上传 ') + (src.length > 60 ? src.slice(0, 60) + '…' : src),
        kind: 'execute',
        rawInput: { local: src, remote: args.remote_path, instance: args.instance_id },
        content: isDir ? [{ type: 'text', text: 'tar.gz -> 远端解包' }] : undefined,
      }
    },
  }
}
