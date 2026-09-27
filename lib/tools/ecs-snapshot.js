// ============================================================================
// lib/tools/ecs-snapshot.js —— ecs_snapshot: 发布快照(创建 / 清点 / 差异)
// ----------------------------------------------------------------------------
// N1(v0.8.0; 反馈 §四.10): 把"动手前的回滚点 + 动手后的差异核对"做成一等公民,
// 而不是每次由 agent 手写 docker tag / docker cp / docker images 的拼装脚本。
//
//   create —— 一次只读采集: 默认(主机信息 / 镜像清单 / 容器清单 / 监听端口)
//             + paths(逐个文件/目录的 sha256、大小、mtime)+ commands(自定义采集器),
//             清单写到工作区 .dsh/workbench-ecs/snapshots/<name>.json;
//   list   —— 列出工作区快照(零远程调用);
//   diff   —— 按清单里记录的采集器重采一次, 逐项对差异(文件增删改 / 采集输出变化)。
//
// 采集器内容由**项目**给(具名 profile: .dsh/workbench-ecs/snapshot-profiles.json),
// 插件只提供机制。采集脚本恒为只读, 且**总是**过一遍只读护栏 —— 快照流程不可能改远端。
// ============================================================================
import {
  runWorkbench, commandLine, guardReadOnly, omitUndefined, withInstanceLock, cleanOutput,
  resolveWorkspaceRoot, decodeCliOutput, remoteResultOf, resolveTimeout, buildScriptDelivery,
  PLUGIN_VERSION,
} from '../common.js'
import {
  SNAPSHOT_DIR, SNAPSHOT_PROFILES_FILE, DEFAULT_SNAPSHOT_COLLECTOR_LABELS,
  isValidSnapshotName, snapshotDirOf, resolveCollectors, resolveCommandCollectors, resolvePaths,
  buildSnapshotScript, parseSnapshotOutput, diffFacts,
  loadSnapshotProfile, loadSnapshot, listSnapshotNames, saveSnapshot,
} from '../snapshots.js'

const SNAPSHOT_ACTIONS = ['create', 'list', 'diff']
const SNAPSHOT_DEFAULT_TIMEOUT = 180

export function ecsSnapshotDefinition(ctx) {
  // ---- 一次采集: 组装脚本 -> base64 投递 -> 执行 -> 解析 ----
  async function collect(instanceId, spec, args, exec) {
    const script = buildSnapshotScript(spec)
    // 快照必须只读: 采集脚本恒过护栏(而不是靠"我们写得对")
    guardReadOnly(script, 'ecs_snapshot 采集脚本')
    const delivery = buildScriptDelivery(script, { shell: 'bash' })
    const prep = delivery.commands.slice(0, -1)
    const finalCommand = delivery.commands[delivery.commands.length - 1]
    const timeout = String(resolveTimeout(args.timeout, SNAPSHOT_DEFAULT_TIMEOUT))
    const argvFor = (command) => {
      const argv = ['exec', '--instance-id', instanceId, '--command', command, '--timeout', timeout, '--output', 'json']
      if (args.region !== undefined && args.region !== null && String(args.region).length > 0) argv.push('--region', String(args.region))
      return argv
    }
    return await withInstanceLock(instanceId, async () => {
      for (const step of prep) {
        if (exec.signal.aborted) throw new Error('工具调用已被取消')
        const r = await runWorkbench(ctx, argvFor(step), exec.signal, { stdoutSpillMaxBytes: 64 * 1024 * 1024, exec })
        if (r.exitCode !== 0) {
          throw new Error('ecs_snapshot: 采集脚本投递失败(exit ' + r.exitCode + '): ' +
            cleanOutput(r.stdout + r.stderr, true).slice(0, 300))
        }
      }
      if (exec.signal.aborted) throw new Error('工具调用已被取消')
      const r = await runWorkbench(ctx, argvFor(finalCommand), exec.signal, { stdoutSpillMaxBytes: 64 * 1024 * 1024, exec })
      if (exec.signal.aborted) throw new Error('工具调用已被取消')
      const data = decodeCliOutput(r, 'ecs_snapshot')
      if (data === null || typeof data !== 'object' || Array.isArray(data)) {
        throw new Error('ecs_snapshot: 意外的输出结构: ' + r.stdout.slice(0, 300))
      }
      const remote = remoteResultOf(data, r)
      return {
        output: remote.output,
        exit_code: remote.exit_code,
        timed_out: remote.timed_out === true ? true : undefined,
        duration: remote.duration,
        command_line: commandLine(argvFor('<script ' + delivery.expected_bytes + ' bytes>')),
      }
    })
  }

  // 组装本次采集规格: 默认采集器 + 自定义采集器 + paths(profile 可提供全部三样)
  async function buildSpec(args, exec) {
    const workspaceRoot = resolveWorkspaceRoot(ctx, exec)
    let profileEntry
    let profilePath
    if (args.profile !== undefined && args.profile !== null && String(args.profile).length > 0) {
      const loaded = await loadSnapshotProfile(ctx, String(args.profile), { workspaceRoot, signal: exec.signal })
      profileEntry = loaded.profile
      profilePath = loaded.path
    }
    const source = profileEntry !== undefined ? profileEntry : {}
    const collectors = resolveCollectors(
      args.collectors !== undefined ? args.collectors : source.collectors,
    ).concat(profileEntry !== undefined ? resolveCommandCollectors(profileEntry.commands) : [])
      .concat(resolveCommandCollectors(args.commands))
    const paths = resolvePaths(args.paths !== undefined ? args.paths : source.paths)
    return {
      spec: { collectors, paths },
      profile: args.profile !== undefined && String(args.profile).length > 0 ? String(args.profile) : undefined,
      profile_path: profilePath,
    }
  }

  // ---- create ----
  async function create(args, exec) {
    const name = args.name !== undefined && args.name !== null ? String(args.name).trim() : ''
    if (!isValidSnapshotName(name)) {
      throw new Error('ecs_snapshot: name 非法(只允许字母/数字/._-, 首字符为字母或数字, 不超过 64 字符): ' + JSON.stringify(name))
    }
    const built = await buildSpec(args, exec)
    if (built.spec.collectors.length === 0 && built.spec.paths.length === 0) {
      throw new Error('ecs_snapshot: 采集内容为空(默认采集器也全被 collectors 关掉了); 请给 collectors / commands / paths 之一')
    }
    const collected = await collect(args.instance_id, built.spec, args, exec)
    if (collected.timed_out === true) {
      throw new Error('ecs_snapshot: 采集命令被超时掐断(实跑 ' + (collected.duration !== undefined ? collected.duration : '?') +
        '); 请调大 timeout 或减少 paths/commands 的数量')
    }
    const parsed = parseSnapshotOutput(collected.output, built.spec)
    const manifest = omitUndefined({
      kind: 'ecs-snapshot',
      version: 1,
      plugin_version: PLUGIN_VERSION,
      name,
      created_at: new Date().toISOString(),
      instance_id: args.instance_id,
      region: args.region,
      note: args.note !== undefined && String(args.note).length > 0 ? String(args.note) : undefined,
      profile: built.profile,
      spec: {
        collectors: built.spec.collectors.map((c) => ({ label: c.label, command: c.command })),
        paths: built.spec.paths,
      },
      facts: { commands: parsed.commands, files: parsed.files },
      collect: omitUndefined({
        exit_code: collected.exit_code,
        duration: collected.duration,
        command_line: collected.command_line,
      }),
    })
    const saved = await saveSnapshot(ctx, name, manifest, {
      workspaceRoot: resolveWorkspaceRoot(ctx, exec), signal: exec.signal, exec,
    })
    return omitUndefined({
      action: 'create',
      ok: true,
      name,
      path: saved.path,
      instance_id: args.instance_id,
      region: args.region,
      created_at: manifest.created_at,
      note: manifest.note,
      profile: built.profile,
      collectors: built.spec.collectors.map((c) => c.label),
      paths: built.spec.paths,
      command_count: Object.keys(parsed.commands).length,
      file_count: Object.keys(parsed.files).length,
      files_summary: built.spec.paths.map((p) => omitUndefined({
        path: p,
        status: parsed.files[p] !== undefined ? parsed.files[p].status : 'unknown',
        sha256: parsed.files[p] !== undefined ? parsed.files[p].sha256 : undefined,
        entries: parsed.files[p] !== undefined ? parsed.files[p].entries : undefined,
      })),
      duration: collected.duration,
      dir_status: saved.dir_status,
      command_line: collected.command_line,
    })
  }

  // ---- list ----
  async function list(args, exec) {
    const opts = { workspaceRoot: resolveWorkspaceRoot(ctx, exec), signal: exec.signal }
    const names = await listSnapshotNames(ctx, opts)
    const entries = []
    for (const name of names) {
      try {
        const loaded = await loadSnapshot(ctx, name, opts)
        const manifest = loaded.manifest
        const facts = manifest.facts !== undefined && manifest.facts !== null ? manifest.facts : {}
        entries.push(omitUndefined({
          name,
          path: loaded.path,
          created_at: manifest.created_at,
          instance_id: manifest.instance_id,
          region: manifest.region,
          note: manifest.note,
          profile: manifest.profile,
          collectors: manifest.spec !== undefined && Array.isArray(manifest.spec.collectors)
            ? manifest.spec.collectors.map((c) => c.label) : undefined,
          paths: manifest.spec !== undefined && Array.isArray(manifest.spec.paths) ? manifest.spec.paths : undefined,
          command_count: facts.commands !== undefined ? Object.keys(facts.commands).length : undefined,
          file_count: facts.files !== undefined ? Object.keys(facts.files).length : undefined,
        }))
      } catch (err) {
        entries.push({ name, error: err && err.message !== undefined ? String(err.message) : String(err) })
      }
    }
    return {
      action: 'list',
      ok: true,
      dir: snapshotDirOf(opts),
      count: entries.length,
      snapshots: entries,
      command_line: 'workbench (无) — 本次未调用任何 CLI 命令',
    }
  }

  // ---- diff ----
  async function diff(args, exec) {
    const name = args.name !== undefined && args.name !== null ? String(args.name).trim() : ''
    if (!isValidSnapshotName(name)) {
      throw new Error('ecs_snapshot: diff 需要合法的 name(创建时的快照名)')
    }
    const opts = { workspaceRoot: resolveWorkspaceRoot(ctx, exec), signal: exec.signal }
    const loaded = await loadSnapshot(ctx, name, opts)
    const manifest = loaded.manifest
    const spec = manifest.spec !== undefined && manifest.spec !== null ? manifest.spec : {}
    const against = args.against !== undefined && args.against !== null ? String(args.against).trim() : ''
    let baseline = manifest
    let baselinePath = loaded.path
    if (against.length > 0) {
      if (!isValidSnapshotName(against)) throw new Error('ecs_snapshot: against 需要合法的快照名')
      const other = await loadSnapshot(ctx, against, opts)
      baseline = other.manifest
      baselinePath = other.path
    }
    // 默认按清单记录的采集器重采(也可用 args 覆盖); instance 缺省沿用清单里的
    const instanceId = args.instance_id !== undefined && args.instance_id !== null && String(args.instance_id).length > 0
      ? String(args.instance_id) : String(baseline.instance_id !== undefined ? baseline.instance_id : '')
    if (instanceId.length === 0) {
      throw new Error('ecs_snapshot: diff 需要 instance_id(清单里没有记录时必须在参数里给出)')
    }
    const collectors = args.collectors !== undefined || args.commands !== undefined || args.paths !== undefined
      ? (await buildSpec(args, exec)).spec
      : {
        collectors: (Array.isArray(spec.collectors) ? spec.collectors : []).map((c) => ({ label: c.label, command: c.command })),
        paths: Array.isArray(spec.paths) ? spec.paths : [],
      }
    if (collectors.collectors.length === 0 && collectors.paths.length === 0) {
      throw new Error('ecs_snapshot: 快照清单里没有记录任何采集器, 无法 diff; 请显式给 paths/commands/collectors')
    }
    const argsForCollect = Object.assign({}, args, { region: args.region !== undefined ? args.region : baseline.region })
    const collected = await collect(instanceId, collectors, argsForCollect, exec)
    if (collected.timed_out === true) {
      throw new Error('ecs_snapshot: 采集命令被超时掐断(实跑 ' + (collected.duration !== undefined ? collected.duration : '?') + '); 请调大 timeout')
    }
    const parsed = parseSnapshotOutput(collected.output, collectors)
    const facts = baseline.facts !== undefined && baseline.facts !== null ? baseline.facts : {}
    const result = diffFacts(facts, parsed)
    return omitUndefined({
      action: 'diff',
      ok: true,
      name,
      against: against.length > 0 ? against : undefined,
      instance_id: instanceId,
      region: argsForCollect.region,
      baseline_created_at: baseline.created_at,
      baseline_path: baselinePath,
      current_path: against.length > 0 ? loaded.path : undefined,
      clean: result.clean,
      changed_count: result.changed_count,
      files_changed: result.files_changed,
      commands_changed: result.commands_changed,
      files: result.files,
      commands: result.commands,
      duration: collected.duration,
      command_line: collected.command_line,
    })
  }

  function renderSnapshot(value) {
    const lines = []
    if (value.action === 'create') {
      lines.push('快照已创建 — ' + value.name + ' @ ' + value.instance_id +
        (value.region !== undefined ? '(' + value.region + ')' : ''))
      lines.push('[清单: ' + value.path + ']')
      if (value.note !== undefined) lines.push('[备注: ' + value.note + ']')
      lines.push('[采集器: ' + (value.collectors !== undefined && value.collectors.length > 0 ? value.collectors.join(', ') : '(无)') +
        (value.profile !== undefined ? ' · profile: ' + value.profile : '') + ']')
      if (value.files_summary !== undefined && value.files_summary.length > 0) {
        lines.push('[关键文件 ' + value.files_summary.length + ' 个]')
        for (const item of value.files_summary) {
          lines.push('  ' + item.path + ' → ' + item.status +
            (item.sha256 !== undefined ? ' ' + String(item.sha256).slice(0, 12) + '…' : '') +
            (item.entries !== undefined ? ' (' + item.entries + ' 个文件)' : ''))
        }
      }
      lines.push('')
      lines.push('发布后用它做差异核对: ecs_snapshot { action: "diff", name: "' + value.name + '" }')
      return lines.join('\n')
    }
    if (value.action === 'list') {
      lines.push('工作区快照 — ' + value.dir + '(共 ' + value.count + ' 份)')
      if (value.count === 0) {
        lines.push('')
        lines.push('还没有快照: 用 ecs_snapshot { action: "create", instance_id: "i-xxx", name: "pre-abc123" } 创建。')
      }
      for (const item of value.snapshots) {
        lines.push('')
        if (item.error !== undefined) {
          lines.push('✘ ' + item.name + ' — ' + item.error)
          continue
        }
        lines.push('✔ ' + item.name + '  ' + (item.created_at !== undefined ? item.created_at : '(无时间)') +
          (item.instance_id !== undefined ? '  @ ' + item.instance_id : ''))
        if (item.note !== undefined) lines.push('    ' + item.note)
        lines.push('    采集器: ' + (item.collectors !== undefined ? item.collectors.join(', ') : '(无)') +
          (item.paths !== undefined && item.paths.length > 0 ? ' · 关键文件 ' + item.paths.length + ' 个' : ''))
      }
      return lines.join('\n')
    }
    // diff
    lines.push('快照差异 — ' + value.name +
      (value.against !== undefined ? ' vs ' + value.against : '') +
      ' @ ' + value.instance_id + ': ' + (value.clean === true ? '无差异' : value.changed_count + ' 处变化'))
    if (value.baseline_created_at !== undefined) lines.push('[基线时间: ' + value.baseline_created_at + ']')
    const changedFiles = (value.files !== undefined ? value.files : []).filter((f) => f.status !== 'unchanged')
    const changedCommands = (value.commands !== undefined ? value.commands : []).filter((c) => c.status !== 'unchanged')
    if (changedFiles.length > 0) {
      lines.push('')
      lines.push('[关键文件]')
      for (const item of changedFiles) {
        lines.push('  ' + (item.status === 'changed' ? '✘' : (item.status === 'metadata-only' ? '·' : '✘')) +
          ' ' + item.path + ' — ' + item.status +
          (item.detail !== undefined ? ': ' + item.detail : '') +
          (item.before !== undefined && item.after !== undefined && item.status === 'changed'
            ? ': ' + String(item.before).slice(0, 12) + '… → ' + String(item.after).slice(0, 12) + '…' : ''))
      }
    }
    if (changedCommands.length > 0) {
      lines.push('')
      lines.push('[采集输出]')
      for (const item of changedCommands) {
        lines.push('  ✘ ' + item.label + ' — ' + item.status +
          (item.lines_before !== undefined ? '(' + item.lines_before + ' → ' + item.lines_after + ' 行)' : ''))
        if (item.first_difference !== undefined) {
          lines.push('      首个差异在第 ' + item.first_difference.line + ' 行: ' +
            JSON.stringify(item.first_difference.before) + ' → ' + JSON.stringify(item.first_difference.after))
        }
        if (item.exit_before !== undefined || item.exit_after !== undefined) {
          lines.push('      exit: ' + item.exit_before + ' → ' + item.exit_after)
        }
      }
    }
    if (value.files_changed === 0 && value.commands_changed === 0) {
      lines.push('')
      lines.push('核对结论: 采集范围内一切一致。')
    } else {
      lines.push('')
      lines.push('核对结论: ' + value.files_changed + ' 个文件项 + ' + value.commands_changed + ' 个采集项发生变化' +
        '(未变化项已省略)。')
    }
    return lines.join('\n')
  }

  return {
    name: 'ecs_snapshot',
    description: '发布快照: 把"动手前的回滚点 / 动手后的差异核对"做成一等公民(不用再手写 docker tag + docker cp 拼装脚本)。' +
      'action: create = 一次**只读**采集并写入工作区清单(' + SNAPSHOT_DIR + '/<name>.json): ' +
      '默认采集器(' + DEFAULT_SNAPSHOT_COLLECTOR_LABELS.join(' / ') + ') + paths(逐个文件/目录的 sha256、大小、mtime)' +
      ' + commands(自定义只读采集器), 也可用项目里的具名 profile(' + SNAPSHOT_PROFILES_FILE + '); ' +
      'list = 列出工作区快照(零远程调用); ' +
      'diff = 按清单记录的采集器重采一次并逐项对差异(文件增删改 / 采集输出变化, 含首个差异行)。' +
      '采集脚本恒过只读护栏 —— 快照流程不会改动远端。',
    parameters: {
      action: { type: 'string', required: true, enum: SNAPSHOT_ACTIONS, description: 'create / list / diff' },
      name: { type: 'string', description: 'create / diff 必填: 快照名(只允许字母/数字/._-), 例如 pre-abc1234' },
      instance_id: { type: 'string', description: 'create 必填 / diff 可缺省(沿用清单里的): 目标 ECS 实例 ID, 也可写工作区实例锚点名' },
      region: { type: 'string', description: '地域, 可缺省: CLI 会从实例 ID 自动推断' },
      note: { type: 'string', description: 'create: 备注(如"发布前回滚点"), 会写进清单' },
      profile: { type: 'string', description: 'create: 项目侧具名 profile(' + SNAPSHOT_PROFILES_FILE + ' 里的键), 提供 paths/commands/collectors' },
      paths: { type: 'array', items: { type: 'string' }, description: 'create: 要留指纹的远端文件或目录(逐个 sha256/大小/mtime; 目录记文件清单摘要)' },
      commands: { type: 'json', description: 'create: 自定义只读采集器 { "<标签>": "<命令>" }, 输出只存摘要与行数' },
      collectors: { type: 'array', items: { type: 'string' }, description: 'create: 只取这些默认采集器: ' + DEFAULT_SNAPSHOT_COLLECTOR_LABELS.join(' / ') },
      against: { type: 'string', description: 'diff: 与另一份快照对比(缺省 = 与实时状态对比)' },
      timeout: { type: 'integer', description: '采集命令超时(秒), 默认 ' + SNAPSHOT_DEFAULT_TIMEOUT },
    },
    timeoutMs: 300000,
    output: {
      schema: {
        type: 'object',
        properties: {
          action: { type: 'string' },
          ok: { type: 'boolean' },
          name: { type: 'string' },
          path: { type: 'string' },
          dir: { type: 'string' },
          instance_id: { type: 'string' },
          region: { type: 'string' },
          created_at: { type: 'string' },
          note: { type: 'string' },
          profile: { type: 'string' },
          collectors: { type: 'array', items: { type: 'string' } },
          paths: { type: 'array', items: { type: 'string' } },
          command_count: { type: 'integer' },
          file_count: { type: 'integer' },
          files_summary: { type: 'json' },
          count: { type: 'integer' },
          snapshots: { type: 'array', items: { type: 'json' } },
          against: { type: 'string' },
          baseline_created_at: { type: 'string' },
          baseline_path: { type: 'string' },
          current_path: { type: 'string' },
          clean: { type: 'boolean' },
          changed_count: { type: 'integer' },
          files_changed: { type: 'integer' },
          commands_changed: { type: 'integer' },
          files: { type: 'json' },
          commands: { type: 'json' },
          duration: { type: 'string' },
          dir_status: { type: 'string' },
          command_line: { type: 'string' },
        },
        additionalProperties: false,
      },
      render: (args, value) => [{ type: 'text', text: renderSnapshot(value) }],
      presentationMeta: (args, value) => omitUndefined({
        action: value.action,
        name: value.name,
        instance_id: value.instance_id,
        clean: value.clean,
        changed_count: value.changed_count,
        count: value.count,
      }),
    },
    async execute(args, exec) {
      const action = args.action !== undefined ? String(args.action) : ''
      if (!SNAPSHOT_ACTIONS.includes(action)) {
        throw new Error('ecs_snapshot: action 非法: ' + action + '(应为 ' + SNAPSHOT_ACTIONS.join(' / ') + ')')
      }
      if (action === 'create') {
        if (args.instance_id === undefined || args.instance_id === null || String(args.instance_id).length === 0) {
          throw new Error('ecs_snapshot: create 需要 instance_id')
        }
        return await create(args, exec)
      }
      if (action === 'list') return await list(args, exec)
      return await diff(args, exec)
    },
    presentCall(args) {
      const action = args.action !== undefined ? String(args.action) : '(missing)'
      const name = args.name !== undefined ? String(args.name) : undefined
      return {
        card: 'generic',
        title: '快照 ' + action + (name !== undefined ? ' · ' + name : '') +
          (args.instance_id !== undefined ? ' @ ' + args.instance_id : ''),
        kind: action === 'create' ? 'execute' : 'read',
        rawInput: omitUndefined({ action, name, instance_id: args.instance_id, profile: args.profile }),
        content: [{ type: 'text', text: action === 'create' ? '只读采集 -> 工作区清单' : (action === 'diff' ? '重采 + 逐项对差异' : '扫描 ' + SNAPSHOT_DIR) }],
      }
    },
  }
}
