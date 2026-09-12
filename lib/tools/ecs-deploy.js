// ============================================================================
// lib/tools/ecs-deploy.js —— ecs_deploy: 受控发布 / 多步编排
// ----------------------------------------------------------------------------
// 两种模式:
//   (A) 老三阶段(向后兼容): 上传 -> sha256 校验 -> 重启命令 -> 健康检查;
//   (B) steps 编排(v0.6.0): 把同一实例上的一串动作建模为一次调用 ——
//       upload / exec / assert / tail, 支持 dry_run 预演与 continue_on_error。
// 共同不变式:
//   - 整段编排占用实例锁, 同实例其它调用不会插进中间;
//   - 每个阶段/步骤显式下发超时(CLI --timeout 默认只有 30s);
//   - sha256 校验失败即中止, 绝不拿损坏的发布物去重启;
//   - 断言(assert)失败即中止并逐条标出失败原因, 不靠人肉看日志;
//   - 破坏性命令仍走 Harness 审批(dry_run 不执行任何东西, 因此不请求审批)。
// ============================================================================
import {
  runWorkbench, commandLine, guardDestructiveCommand, guardReadOnly, resolveWorkspaceRoot,
  omitUndefined, withInstanceLock, localSha256, remoteSha256, remoteJoin, resolveTimeout, hasLocalTimer, delay,
} from '../common.js'
import { loadRunbook, parseRunbook, buildRunbookRun, RUNBOOK_DIR } from '../runbooks.js'
// steps 编排引擎(v0.6.2 抽出): 纯逻辑集中在 lib/steps-engine.js, 供模型工具与
// 设置页 RPC(面板里预演/执行 runbook)共用同一套语义, 不再各写一份。
import {
  STEPS_STAGE_TIMEOUT, STEPS_MAX_STEPS, STEPS_TAIL_BYTES, STEPS_KINDS,
  execStage, planSteps, planPreview, assertStepCount, runSteps,
} from '../steps-engine.js'

// 每阶段/步骤默认超时(秒): 必须显式下发(CLI --timeout 默认仅 30)
const DEPLOY_STAGE_TIMEOUT = STEPS_STAGE_TIMEOUT
// steps 编排上限: 防止一次调用变成不可审计的巨型脚本
const DEPLOY_MAX_STEPS = STEPS_MAX_STEPS
// tail 步骤默认单次读取字节数
const DEPLOY_TAIL_BYTES = STEPS_TAIL_BYTES
const DEPLOY_STEP_KINDS = STEPS_KINDS

export function ecsDeployDefinition(ctx) {
  // --------------------------------------------------------------------------
  // 本机执行适配器(v0.6.2): 引擎只认 { exitCode, stdout, stderr } —— 与设置页
  // RPC 的 runCli 完全同形, 这正是"模型工具"与"设置页面板"能共用同一套编排
  // 语义的原因。所有与 ctx/subprocess/取消 相关的细节都收敛在这里。
  // --------------------------------------------------------------------------
  function stepAdapter(signal, args = {}, exec) {
    return {
      run: async (argv) => {
        const r = await runWorkbench(ctx, argv, signal, { stdoutSpillMaxBytes: 64 * 1024 * 1024, exec })
        if (signal.aborted) throw new Error('工具调用已被取消')
        return r
      },
      localSha256: async (file) => await localSha256(ctx, file, signal, { exec }),
      // locked: 调用方(编排)已持有该实例的锁, 引擎不再重复取锁(不可重入)
      remoteSha256: async (remotePath, opts = {}) => await remoteSha256(ctx, args.instance_id, remotePath,
        { region: args.region, signal, timeout: opts.timeout, locked: true, exec }),
      sleep: (ms) => delay(ctx, ms),
      hasTimer: hasLocalTimer(ctx),
    }
  }

  // 单阶段执行(老三阶段路径复用): 返回 { ok, exit_code, output, stderr, error }
  // opts.loose=true 用于 upload 这类"CLI 输出人类可读文本而非 JSON"的命令
  // (workbench upload 即使带 --output json 也只打印进度与 Upload complete 文本,
  //  此前的严格 JSON 解码会让上传阶段恒为失败)。
  async function runStage(argv, signal, opts = {}, exec) {
    return await execStage(stepAdapter(signal, {}, exec), argv, opts)
  }

  // --------------------------------------------------------------------------
  // Runbook(S4b, v0.6.1): 插件只做机制 —— 读文件/校验/参数替换/展开成 steps。
  // 内容(步骤与断言)留在项目仓库, 插件不硬编码任何项目逻辑。
  // v0.6.4(D11): runbook 目录按**会话工作区**解析(exec.agent.session.header.cwd),
  // 不再是部署兜底的 process.cwd() —— 否则会跑去 $HOME/.dsh/... 找跑书。
  // --------------------------------------------------------------------------
  async function resolveRunbook(args, exec) {
    const raw = args.runbook
    const workspaceRoot = resolveWorkspaceRoot(ctx, exec)
    const implicit = omitUndefined({ instance_id: args.instance_id, region: args.region })
    let runbook
    let source
    let path
    let label
    if (typeof raw === 'string' && raw.length > 0) {
      label = 'runbook ' + raw
      const loaded = await loadRunbook(ctx, raw, { workspaceRoot, signal: exec.signal })
      runbook = parseRunbook(loaded.text, label)
      source = 'workspace'
      path = loaded.path
    } else if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
      label = 'runbook(内联)'
      // 复用同一套形状校验(内联对象已是 JSON, 序列化只为走同一条校验路径)
      runbook = parseRunbook(JSON.stringify(raw), label)
      source = 'inline'
    } else {
      throw new Error('ecs_deploy: runbook 必须是名字字符串(读 ' + RUNBOOK_DIR + '/<name>.json)或内联对象 { params?, steps }')
    }

    const run = buildRunbookRun(runbook, args.runbook_params, implicit)
    if (run.missing.length > 0) {
      throw new Error('ecs_deploy: ' + label + ' 缺少参数: ' + run.missing.join(', ') +
        '(通过 runbook_params 传入; 该 runbook 声明的占位符: ' +
        (run.declared.length > 0 ? run.declared.join(', ') : '(无)') + ')')
    }
    const providedParams = args.runbook_params !== undefined && args.runbook_params !== null &&
      typeof args.runbook_params === 'object' && !Array.isArray(args.runbook_params)
      ? args.runbook_params : {}
    return {
      steps: run.steps,
      meta: omitUndefined({
        name: runbook.name !== undefined ? runbook.name : (typeof raw === 'string' ? raw : undefined),
        source,
        path,
        description: runbook.description,
        param_keys: Object.keys(providedParams).sort().length > 0 ? Object.keys(providedParams).sort() : undefined,
        declared_params: run.declared.length > 0 ? run.declared : undefined,
        unused_params: run.unused.length > 0 ? run.unused : undefined,
      }),
    }
  }

  // --------------------------------------------------------------------------
  // steps 编排(v0.6.0; 引擎于 v0.6.2 抽到 lib/steps-engine.js)
  // 结构校验/计划/断言求值/执行循环全部由引擎提供 —— 设置页 RPC 也调用同一份,
  // 因此"面板预演"与"工具执行"的命令行逐字一致, 不会出现两条通道行为漂移。
  // 这里只保留工具侧独有的两件事:
  //   (1) 审批守卫: exec/assert 步骤的 payload 先过 guardDestructiveCommand;
  //   (2) 整段编排占用实例锁, 同实例其它调用不会插进中间。
  // --------------------------------------------------------------------------
  async function executeSteps(args, exec, steps, extra = {}) {
    assertStepCount(steps)
    const plan = planSteps(steps, args)

    // 预演: 不执行任何东西, 也不请求审批(不产生任何副作用)
    if (args.dry_run === true) {
      return planPreview(plan, args, { runbook: extra.runbook })
    }

    // 破坏性命令守卫 + 只读护栏: 全部步骤先过闸, 再开始执行
    for (const step of plan) {
      if (step.read_only === true) guardReadOnly(step.payload, 'ecs_deploy steps[' + step.index + ']')
      if (step.kind === 'exec' || step.kind === 'assert') {
        await guardDestructiveCommand(ctx, exec, step.payload)
      }
      if (exec.signal.aborted) throw new Error('工具调用已被取消')
    }

    const adapter = stepAdapter(exec.signal, args, exec)
    return withInstanceLock(args.instance_id, async () => {
      return await runSteps(adapter, plan, args, {
        signal: exec.signal,
        extra: omitUndefined({ runbook: extra.runbook }),
      })
    })
  }


  // --------------------------------------------------------------------------
  // 渲染
  // --------------------------------------------------------------------------
  function renderAssertions(lines, assertions) {
    for (const a of assertions) {
      lines.push('    ' + (a.ok === true ? '✔' : '✘') + ' ' + a.check + ': 期望 ' + a.expected +
        (a.ok === true ? '' : ', 实际 ' + a.actual))
    }
  }

  function renderStages(value) {
    const lines = []
    const rb = value.runbook
    const rbLine = rb !== undefined
      ? 'runbook: ' + (rb.name !== undefined ? rb.name : '(未命名)') +
        ' [' + (rb.source === 'workspace' ? '来自 ' + (rb.path !== undefined ? rb.path : RUNBOOK_DIR) : '内联') + ']' +
        (rb.description !== undefined ? ' — ' + rb.description : '')
      : undefined
    if (value.dry_run === true) {
      lines.push('发布预演(dry_run, 未执行任何命令)— 实例: ' + value.instance_id + ', 共 ' + value.total_stage + ' 步')
      if (rbLine !== undefined) lines.push(rbLine)
      for (const p of value.plan) {
        lines.push('')
        lines.push('[' + p.index + '] ' + p.kind + ' · ' + p.name)
        lines.push('  $ ' + p.command_line)
        if (p.read_only === true) lines.push('  [read_only]')
        if (p.verify_sha256 === true) lines.push('  [上传后校验 sha256]')
      }
      lines.push('')
      lines.push('确认无误后去掉 dry_run 重新调用即可执行。')
      return lines.join('\n')
    }

    lines.push('受控发布 — 实例: ' + value.instance_id + ', 步骤 ' + value.done_stage + '/' + value.total_stage +
      ', 结果: ' + (value.ok === true ? '成功' : '失败') + (value.mode === 'steps' ? '(steps 编排)' : ''))
    if (rbLine !== undefined) lines.push(rbLine)
    if (rb !== undefined && rb.unused_params !== undefined && rb.unused_params.length > 0) {
      lines.push('[提示: 传入的参数 ' + rb.unused_params.join(', ') + ' 未被该 runbook 使用]')
    }
    if (value.aborted === true) lines.push('已中止: ' + (value.abort_reason !== undefined ? value.abort_reason : '校验失败'))
    if (value.stopped_at !== undefined) lines.push('中断于步骤 [' + value.stopped_at + '] ' + value.stopped_reason)
    for (const s of value.stages) {
      lines.push('')
      if (s.skipped === true) {
        lines.push('[' + (s.index !== undefined ? s.index + ' ' : '') + s.name + '] 已跳过(前序步骤失败)')
        continue
      }
      lines.push('[' + (s.index !== undefined ? s.index + ' ' : '') + s.name + '] ' + (s.ok === true ? 'OK' : 'FAIL'))
      if (s.ok !== true && s.error !== undefined && s.error.length > 0) lines.push('  错误: ' + s.error)
      if (s.sha256_local !== undefined) lines.push('  sha256 本地: ' + s.sha256_local)
      if (s.sha256_remote !== undefined) lines.push('  sha256 远端: ' + s.sha256_remote)
      if (s.output !== undefined && s.output.length > 0) {
        for (const line of String(s.output).split('\n')) lines.push('  ' + line)
      }
      if (s.stderr !== undefined && s.stderr.length > 0) {
        for (const line of String(s.stderr).split('\n')) lines.push('  [stderr] ' + line)
      }
      if (s.assertions !== undefined && s.assertions.length > 0) renderAssertions(lines, s.assertions)
      if (s.next_offset !== undefined) {
        lines.push('  [字节游标: ' + s.next_offset + (s.total_bytes !== undefined ? ' / 共 ' + s.total_bytes : '') +
          (s.eof === true ? ', 已结束' : '') + ']')
      }
      if (s.exit_code !== undefined && s.exit_code !== null && s.ok !== true) {
        lines.push('  [exit code: ' + s.exit_code + ']')
      }
    }
    return lines.join('\n')
  }

  const ASSERTION_SCHEMA = {
    type: 'object',
    properties: {
      check: { type: 'string' },
      expected: { type: 'string' },
      actual: { type: 'string' },
      ok: { type: 'boolean' },
    },
    additionalProperties: false,
  }

  const STAGE_SCHEMA = {
    type: 'object',
    properties: {
      index: { type: 'integer' },
      kind: { type: 'string' },
      name: { type: 'string' },
      ok: { type: 'boolean' },
      skipped: { type: 'boolean' },
      exit_code: { type: 'integer' },
      output: { type: 'string' },
      stderr: { type: 'string' },
      stdout_truncated: { type: 'boolean' },
      stdout_spill_path: { type: 'string' },
      error: { type: 'string' },
      sha256_local: { type: 'string' },
      sha256_remote: { type: 'string' },
      assertions: { type: 'array', items: ASSERTION_SCHEMA },
      next_offset: { type: 'integer' },
      total_bytes: { type: 'integer' },
      eof: { type: 'boolean' },
      rounds: { type: 'integer' },
    },
    additionalProperties: false,
  }

  return {
    name: 'ecs_deploy',
    description: '受控发布 / 多步编排组合工具。' +
      '两种用法: (A) 老三阶段 —— 可选上传 local_file → sha256 校验(默认开启, 失败即中止) → 执行 command → 可选 health_check; ' +
      '(B) steps 编排 —— 把同一实例上的一串动作写成一次调用, 每步 kind ∈ upload / exec / assert / tail, ' +
      'assert 用 expect(exit_code / stdout_contains / stdout_not_contains / stderr_contains)做断言并在失败时**逐条标出**原因, ' +
      'tail 用字节游标读远端日志(可 wait_seconds 等待退出码文件); ' +
      'dry_run=true 只回显将要执行的命令而不执行(dry_run 不请求审批)。' +
      '也可用 runbook(名字或内联对象)运行一份**纯数据**的跑书: 插件只提供机制(读取/校验/参数替换/展开成 steps), ' +
      '步骤与断言内容留在项目仓库的 ' + RUNBOOK_DIR + '/<name>.json, 插件不硬编码任何项目逻辑。' +
      '整段编排占用实例锁, 同实例其它调用不会插入; 破坏性命令仍需用户确认。',
    parameters: {
      instance_id: { type: 'string', required: true, description: '目标 ECS 实例 ID(可由 ecs_list 取得)' },
      command: { type: 'string', description: '重启/生效命令(老三阶段用法必填; 用 steps 时不需要), 例如 docker compose restart' },
      local_file: { type: 'string', description: '可选: 要上传的本地文件(相对路径基于会话工作区)' },
      remote_path: { type: 'string', description: '可选: 上传目标远端路径(local_file 提供时必填; 以 / 结尾视为目录)' },
      health_check: { type: 'string', description: '可选: 健康检查命令, 例如 curl -fsS http://127.0.0.1/health || true' },
      runbook: {
        type: 'json',
        description: 'Runbook(S4b, v0.6.1): "名字字符串" → 读工作区 ' + RUNBOOK_DIR + '/<name>.json; ' +
          '或内联对象 { name?, description?, params?: {默认值}, steps: [...] }。' +
          'runbook 是**纯数据**(步骤 + 断言 + ${参数} 占位符), 脚本本体留在项目仓库由 upload 步骤上传。' +
          '与 steps 互斥',
      },
      runbook_params: {
        type: 'json',
        description: 'Runbook 参数(对象): 覆盖 runbook 里的 params 默认值, 用于替换 ${name} 占位符; ' +
          '隐式可用 instance_id / region。缺参数会直接报错并列出该 runbook 声明的占位符',
      },
      steps: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            kind: { type: 'string', enum: DEPLOY_STEP_KINDS, description: '步骤类型: upload / exec / assert / tail(缺省时按字段推断)' },
            // upload
            local_file: { type: 'string', description: '[upload] 本地文件路径' },
            remote_path: { type: 'string', description: '[upload] 远端目标路径' },
            force: { type: 'boolean', description: '[upload] 覆盖远端已存在文件(默认 false)' },
            verify_sha256: { type: 'boolean', description: '[upload] 上传后校验 sha256(默认 true, 失败即中止编排)' },
            // exec / assert
            command: { type: 'string', description: '[exec/assert] 远程命令(与 script 二选一)' },
            script: { type: 'string', description: '[exec/assert] 脚本正文, base64 投递零转义(与 command 二选一)' },
            shell: { type: 'string', enum: ['bash', 'sh'], description: '[exec/assert] script 的远端解释器(默认 bash)' },
            read_only: { type: 'boolean', description: '[exec/assert] 只读护栏: 拒绝写操作' },
            expect: { type: 'json', description: '[assert] 断言: { exit_code?, stdout_contains?: [], stdout_not_contains?: [], stderr_contains?: [] }' },
            // tail
            path: { type: 'string', description: '[tail] 远端文件路径(按字节游标读取)' },
            after: { type: 'integer', description: '[tail] 起始字节偏移(默认 0)' },
            max_bytes: { type: 'integer', description: '[tail] 单次最多读取字节数(默认 ' + DEPLOY_TAIL_BYTES + ')' },
            exit_file: { type: 'string', description: '[tail] 退出码文件路径: 出现即视为任务结束并回报退出码' },
            wait_seconds: { type: 'integer', description: '[tail] 最多等待多少秒直到 exit_file 出现(默认 0 = 只读一次)' },
            // 通用
            timeout: { type: 'integer', description: '本步骤命令超时(秒), 默认 ' + DEPLOY_STAGE_TIMEOUT },
            description: { type: 'string', description: '本步骤的用途简述(展示在步骤标题)' },
          },
        },
        description: 'steps 编排(v0.6.0): 每步 { kind, ... } —— ' +
          'upload { local_file, remote_path, force?, verify_sha256? }; ' +
          'exec { command | script, timeout?, read_only?, description? }; ' +
          'assert { command | script, expect: { exit_code?, stdout_contains?, stdout_not_contains?, stderr_contains? } }; ' +
          'tail { path, after?, max_bytes?, exit_file?, wait_seconds? }。最多 ' + DEPLOY_MAX_STEPS + ' 步',
      },
      dry_run: { type: 'boolean', description: '仅配合 steps: 只回显将要执行的命令与断言, 不执行任何东西(不请求审批)' },
      continue_on_error: { type: 'boolean', description: '仅配合 steps: 某步失败后仍继续执行后续步骤(默认 false, 失败即中止并跳过余下步骤)' },
      read_only: { type: 'boolean', description: '仅配合 steps: 对所有 exec/assert 步骤启用只读护栏(默认 false)' },
      region: { type: 'string', description: '地域, 可缺省: CLI 会从实例 ID 自动推断' },
      force: { type: 'boolean', description: '上传时覆盖远端已存在文件而不需确认(默认 false)' },
      verify_sha256: { type: 'boolean', description: '老三阶段: 上传后校验 sha256(默认 true); 校验失败会中止, 不执行重启' },
      timeout: { type: 'integer', description: '每个阶段/步骤的命令超时(秒), 默认 ' + DEPLOY_STAGE_TIMEOUT },
    },
    timeoutMs: 900000,
    output: {
      schema: {
        type: 'object',
        properties: {
          instance_id: { type: 'string' },
          mode: { type: 'string' },
          dry_run: { type: 'boolean' },
          runbook: { type: 'json' },
          ok: { type: 'boolean' },
          done_stage: { type: 'integer' },
          total_stage: { type: 'integer' },
          stopped_at: { type: 'integer' },
          stopped_reason: { type: 'string' },
          failed_steps: { type: 'array', items: { type: 'integer' } },
          continue_on_error: { type: 'boolean' },
          aborted: { type: 'boolean' },
          abort_reason: { type: 'string' },
          plan: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                index: { type: 'integer' },
                kind: { type: 'string' },
                name: { type: 'string' },
                command_line: { type: 'string' },
                read_only: { type: 'boolean' },
                verify_sha256: { type: 'boolean' },
              },
              additionalProperties: false,
            },
          },
          stages: { type: 'array', items: STAGE_SCHEMA },
          command_line: { type: 'string' },
        },
        additionalProperties: false,
      },
      render: (args, value) => [{ type: 'text', text: renderStages(value) }],
      presentationMeta: (args, value) => omitUndefined({
        ok: value.ok,
        done_stage: value.done_stage,
        total_stage: value.total_stage,
        aborted: value.aborted,
        dry_run: value.dry_run,
      }),
    },
    async execute(args, exec) {
      const steps = Array.isArray(args.steps) ? args.steps : undefined
      // ---- Runbook 模式: 机制把纯数据展开成 steps, 再走同一套编排引擎 ----
      if (args.runbook !== undefined && args.runbook !== null) {
        if (steps !== undefined && steps.length > 0) {
          throw new Error('ecs_deploy: runbook 与 steps 不能同时使用(runbook 展开后本身就是 steps)')
        }
        if (args.local_file !== undefined && String(args.local_file).length > 0) {
          throw new Error('ecs_deploy: runbook 模式下上传由 runbook 的 upload 步骤声明, 不要再传 local_file')
        }
        const resolved = await resolveRunbook(args, exec)
        return await executeSteps(args, exec, resolved.steps, { runbook: resolved.meta })
      }
      if (steps !== undefined && steps.length > 0) {
        return await executeSteps(args, exec, steps)
      }
      const uploadNeeded = args.local_file !== undefined && args.local_file.length > 0
      if (uploadNeeded && (args.remote_path === undefined || args.remote_path.length === 0)) {
        throw new Error('ecs_deploy: 提供 local_file 时必须同时提供 remote_path')
      }
      if (args.command === undefined || String(args.command).length === 0) {
        throw new Error('ecs_deploy: 未提供 steps 时必须提供 command(重启/生效命令)')
      }
      // 破坏性命令守卫: 重启/健康检查命令都可能包含危险模式
      await guardDestructiveCommand(ctx, exec, args.command)
      if (args.health_check !== undefined) {
        await guardDestructiveCommand(ctx, exec, args.health_check)
      }

      const stageTimeout = String(resolveTimeout(args.timeout, DEPLOY_STAGE_TIMEOUT))
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
          const stage = await runStage(argv, exec.signal, { loose: true }, exec)
          stages.push({ name: '上传 ' + args.local_file, ...stage })
          doneStage += 1
        }

        // 阶段 2: sha256 校验(可选, 默认开启) —— 发布物损坏必须在重启前发现
        if (verify && uploadNeeded) {
          const remoteFile = remoteJoin(args.remote_path, args.local_file)
          const localHash = await localSha256(ctx, args.local_file, exec.signal, { exec })
          const remoteHash = await remoteSha256(ctx, args.instance_id, remoteFile, { region: args.region, signal: exec.signal, timeout: 60, locked: true, exec })
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
            const stage = await runStage(argv, exec.signal, {}, exec)
            stages.push({ name: '重启/生效', ...stage })
            doneStage += 1
          }

          if (args.health_check !== undefined) {
            const argv = ['exec', '--instance-id', args.instance_id, '--command', args.health_check, '--timeout', stageTimeout, '--output', 'json']
            if (args.region !== undefined) argv.push('--region', args.region)
            if (exec.signal.aborted) throw new Error('工具调用已被取消')
            const stage = await runStage(argv, exec.signal, {}, exec)
            stages.push({ name: '健康检查', ...stage })
            doneStage += 1
          }
        }

        return omitUndefined({
          instance_id: args.instance_id,
          mode: 'legacy',
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
      const steps = Array.isArray(args.steps) ? args.steps : undefined
      if (args.runbook !== undefined && args.runbook !== null) {
        const name = typeof args.runbook === 'string'
          ? args.runbook
          : (args.runbook.name !== undefined ? String(args.runbook.name) : '(内联)')
        const count = typeof args.runbook === 'object' && !Array.isArray(args.runbook) && Array.isArray(args.runbook.steps)
          ? args.runbook.steps.length : undefined
        return {
          card: 'generic',
          title: (args.dry_run === true ? 'runbook 预演 ' : 'runbook ') + name + ' @ ' + args.instance_id,
          kind: 'execute',
          rawInput: { instance_id: args.instance_id, runbook: name },
          content: [{ type: 'text', text: count !== undefined ? count + ' 步' : 'workspace runbook' }],
        }
      }
      if (steps !== undefined && steps.length > 0) {
        const kinds = {}
        for (const s of steps) {
          const k = s !== null && typeof s === 'object' && s.kind !== undefined ? String(s.kind) : 'exec'
          kinds[k] = (kinds[k] !== undefined ? kinds[k] : 0) + 1
        }
        const summary = Object.keys(kinds).map((k) => k + '×' + kinds[k]).join(' ')
        return {
          card: 'generic',
          title: (args.dry_run === true ? '发布预演 ' : '发布编排 ') + args.instance_id + ' (' + steps.length + ' 步)',
          kind: 'execute',
          rawInput: { instance_id: args.instance_id, steps: steps.length },
          content: [{ type: 'text', text: summary }],
        }
      }
      return {
        card: 'generic',
        title: '受控发布 ' + args.instance_id,
        kind: 'execute',
        rawInput: omitUndefined({ command: args.command, upload: args.local_file, health_check: args.health_check }),
      }
    },
  }
}
