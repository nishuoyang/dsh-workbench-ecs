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
  runWorkbench, decodeLoose, decodeCliOutput, commandLine, guardDestructiveCommand, guardReadOnly,
  omitUndefined, withInstanceLock, localSha256, remoteSha256, remoteJoin, resolveTimeout, cleanOutput,
  buildScriptDelivery, buildLogReadCommand, parseLogRead, hasLocalTimer, delay, utf8ByteLength,
} from '../common.js'
import { loadRunbook, parseRunbook, buildRunbookRun, listRunbookNames, RUNBOOK_DIR } from '../runbooks.js'

// 每阶段/步骤默认超时(秒): 必须显式下发(CLI --timeout 默认仅 30)
const DEPLOY_STAGE_TIMEOUT = 180
// steps 编排上限: 防止一次调用变成不可审计的巨型脚本
const DEPLOY_MAX_STEPS = 20
// tail 步骤默认单次读取字节数与轮询间隔
const DEPLOY_TAIL_BYTES = 256 * 1024
const DEPLOY_TAIL_POLL_SECONDS = 2
const DEPLOY_STEP_KINDS = ['upload', 'exec', 'assert', 'tail']

export function ecsDeployDefinition(ctx) {
  // 单阶段执行: 返回 { ok, exit_code, output, stderr, error }
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
        stderr: data.stderr !== undefined && String(data.stderr).length > 0 ? cleanOutput(String(data.stderr), opts.stripAnsi !== false) : undefined,
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

  // --------------------------------------------------------------------------
  // Runbook(S4b, v0.6.1): 插件只做机制 —— 读文件/校验/参数替换/展开成 steps。
  // 内容(步骤与断言)留在项目仓库, 插件不硬编码任何项目逻辑。
  // --------------------------------------------------------------------------
  function workspaceRootOf() {
    const sandboxPolicy = ctx.get('sandboxPolicy')
    if (sandboxPolicy !== undefined && sandboxPolicy !== null &&
        sandboxPolicy.workspaceRoot !== undefined && sandboxPolicy.workspaceRoot !== null) {
      return String(sandboxPolicy.workspaceRoot)
    }
    return undefined
  }

  async function resolveRunbook(args, exec) {
    const raw = args.runbook
    const workspaceRoot = workspaceRootOf()
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
  // steps 编排(v0.6.0)
  // --------------------------------------------------------------------------
  function stepKindOf(step, index) {
    const raw = step.kind !== undefined
      ? String(step.kind)
      : (step.local_file !== undefined ? 'upload' : (step.expect !== undefined ? 'assert' : 'exec'))
    if (!DEPLOY_STEP_KINDS.includes(raw)) {
      throw new Error('ecs_deploy: steps[' + index + '].kind 非法: ' + raw + '(应为 ' + DEPLOY_STEP_KINDS.join(' / ') + ')')
    }
    return raw
  }

  function stepNameOf(kind, step, index) {
    if (step.description !== undefined && String(step.description).length > 0) return String(step.description)
    if (kind === 'upload') return '上传 ' + String(step.local_file)
    if (kind === 'tail') return '读取日志 ' + String(step.path)
    const body = step.script !== undefined ? '[script] ' + String(step.script).split('\n')[0] : String(step.command)
    return (kind === 'assert' ? '断言 ' : '执行 ') + (body.length > 60 ? body.slice(0, 60) + '…' : body)
  }

  function stepPayload(step, index, kind) {
    const hasCommand = step.command !== undefined && String(step.command).length > 0
    const hasScript = step.script !== undefined && String(step.script).length > 0
    if (kind === 'exec' || kind === 'assert') {
      if (hasCommand && hasScript) {
        throw new Error('ecs_deploy: steps[' + index + '] 的 command 与 script 只能二选一')
      }
      if (!hasCommand && !hasScript) {
        throw new Error('ecs_deploy: steps[' + index + '] 必须提供 command 或 script')
      }
    }
    return { hasCommand, hasScript, payload: hasScript ? String(step.script) : (hasCommand ? String(step.command) : '') }
  }

  // 校验步骤结构并给出"计划"(dry_run 与实际执行共用同一份构造逻辑,
  // 因此预演的 argv 与真正下发的一致)
  function planSteps(steps, args) {
    const timeout = String(resolveTimeout(args.timeout, DEPLOY_STAGE_TIMEOUT))
    return steps.map((step, index) => {
      if (step === null || typeof step !== 'object' || Array.isArray(step)) {
        throw new Error('ecs_deploy: steps[' + index + '] 必须是对象')
      }
      const kind = stepKindOf(step, index)
      const name = stepNameOf(kind, step, index)
      if (kind === 'upload') {
        if (step.local_file === undefined || String(step.local_file).length === 0) {
          throw new Error('ecs_deploy: steps[' + index + '](upload) 缺少 local_file')
        }
        if (step.remote_path === undefined || String(step.remote_path).length === 0) {
          throw new Error('ecs_deploy: steps[' + index + '](upload) 缺少 remote_path')
        }
        const argv = ['upload', String(step.local_file), String(step.remote_path), '--instance-id', args.instance_id, '--output', 'json']
        if (args.region !== undefined) argv.push('--region', String(args.region))
        if (step.force === true || args.force === true) argv.push('--force')
        return {
          index, kind, name, argv, timeout, loose: true,
          verify: step.verify_sha256 !== false,
          local_file: String(step.local_file),
          remote_path: String(step.remote_path),
          command_line: commandLine(argv),
          payload: '',
        }
      }
      if (kind === 'tail') {
        if (step.path === undefined || String(step.path).length === 0) {
          throw new Error('ecs_deploy: steps[' + index + '](tail) 缺少 path')
        }
        const waitSeconds = Number.isFinite(Number(step.wait_seconds)) && Number(step.wait_seconds) > 0
          ? Math.min(Math.floor(Number(step.wait_seconds)), 3600) : 0
        return {
          index, kind, name, timeout, loose: false,
          path: String(step.path),
          after: Number.isFinite(Number(step.after)) && Number(step.after) > 0 ? Math.floor(Number(step.after)) : 0,
          max_bytes: Number.isFinite(Number(step.max_bytes)) && Number(step.max_bytes) > 0
            ? Math.min(Math.floor(Number(step.max_bytes)), 4 * 1024 * 1024) : DEPLOY_TAIL_BYTES,
          exit_file: step.exit_file !== undefined && String(step.exit_file).length > 0 ? String(step.exit_file) : undefined,
          wait_seconds: waitSeconds,
          command_line: 'workbench exec --instance-id ' + args.instance_id + ' --command <tail -c +N ' + String(step.path) + '>',
          payload: '',
        }
      }
      // exec / assert
      const { payload } = stepPayload(step, index, kind)
      const useScript = step.script !== undefined && String(step.script).length > 0
      const argv = useScript
        ? ['exec', '--instance-id', args.instance_id, '--command', '<script ' + utf8ByteLength(payload) + ' bytes>',
          '--timeout', timeout, '--output', 'json']
        : ['exec', '--instance-id', args.instance_id, '--command', payload, '--timeout', timeout, '--output', 'json']
      if (args.region !== undefined) argv.push('--region', String(args.region))
      return {
        index, kind, name, argv, timeout, loose: false, verify: false,
        script: useScript ? payload : undefined,
        shell: step.shell === 'sh' ? 'sh' : 'bash',
        keep_script: step.keep_script === true,
        read_only: step.read_only === true || args.read_only === true,
        expect: kind === 'assert'
          ? (step.expect !== null && typeof step.expect === 'object' && !Array.isArray(step.expect) ? step.expect : {})
          : undefined,
        command_line: useScript
          ? 'workbench exec --instance-id ' + args.instance_id + ' --command <script ' + utf8ByteLength(payload) + ' bytes> --timeout ' + timeout
          : commandLine(argv),
        payload,
      }
    })
  }

  function arrOf(value) {
    if (value === undefined || value === null) return []
    return Array.isArray(value) ? value.map((x) => String(x)) : [String(value)]
  }

  // 断言求值: 逐条给出 (check, expected, actual, ok), 失败原因定位到具体一条
  function evaluateAssertions(expect, stage) {
    const stdout = String(stage.output !== undefined && stage.output !== null ? stage.output : '')
    const stderr = String(stage.stderr !== undefined && stage.stderr !== null ? stage.stderr : '')
    const results = []
    const expectedCode = expect !== undefined && typeof expect.exit_code === 'number' ? expect.exit_code : 0
    results.push({
      check: 'exit_code',
      expected: String(expectedCode),
      actual: String(stage.exit_code),
      ok: stage.exit_code === expectedCode,
    })
    for (const needle of arrOf(expect !== undefined ? expect.stdout_contains : undefined)) {
      const found = stdout.includes(needle)
      results.push({ check: 'stdout_contains', expected: needle, actual: found ? 'found' : 'missing', ok: found })
    }
    for (const needle of arrOf(expect !== undefined ? expect.stdout_not_contains : undefined)) {
      const found = stdout.includes(needle)
      results.push({ check: 'stdout_not_contains', expected: needle, actual: found ? 'found' : 'missing', ok: !found })
    }
    for (const needle of arrOf(expect !== undefined ? expect.stderr_contains : undefined)) {
      const found = stderr.includes(needle)
      results.push({ check: 'stderr_contains', expected: needle, actual: found ? 'found' : 'missing', ok: found })
    }
    return results
  }

  // exec/assert 步骤: script 走 base64 直送(零转义), command 直接下发
  async function runRemoteStep(step, args, signal) {
    if (step.script === undefined) {
      const stage = await runStage(step.argv, signal)
      return stage
    }
    const delivery = buildScriptDelivery(step.script, { shell: step.shell, keep: step.keep_script })
    const prep = delivery.commands.slice(0, -1)
    const finalCommand = delivery.commands[delivery.commands.length - 1]
    for (let i = 0; i < prep.length; i++) {
      const argv = ['exec', '--instance-id', args.instance_id, '--command', prep[i], '--timeout', step.timeout, '--output', 'json']
      if (args.region !== undefined) argv.push('--region', String(args.region))
      const r = await runStage(argv, signal)
      if (r.ok !== true) {
        return Object.assign({}, r, {
          error: '脚本投递失败(第 ' + (i + 1) + '/' + prep.length + ' 步, exit ' + r.exit_code + ')',
        })
      }
    }
    const argv = ['exec', '--instance-id', args.instance_id, '--command', finalCommand, '--timeout', step.timeout, '--output', 'json']
    if (args.region !== undefined) argv.push('--region', String(args.region))
    return await runStage(argv, signal)
  }

  // tail 步骤: 按字节游标读远端文件(只读), 可选等待退出码文件出现
  async function runTailStep(step, args, signal) {
    const localTimer = hasLocalTimer(ctx)
    const deadline = Date.now() + step.wait_seconds * 1000
    let cursor = step.after
    let text = ''
    let last
    let rounds = 0
    for (;;) {
      const command = buildLogReadCommand({
        logPath: step.path,
        exitPath: step.exit_file,
        after: cursor,
        maxBytes: step.max_bytes,
        sleep: localTimer ? 0 : DEPLOY_TAIL_POLL_SECONDS,
      })
      const argv = ['exec', '--instance-id', args.instance_id, '--command', command, '--timeout', step.timeout, '--output', 'json']
      if (args.region !== undefined) argv.push('--region', String(args.region))
      const r = await runStage(argv, signal)
      if (r.ok !== true) {
        return Object.assign({}, r, { error: r.error !== undefined ? r.error : '日志读取失败 (exit ' + r.exit_code + ')' })
      }
      last = parseLogRead(r.output, cursor, step.max_bytes)
      if (last.text.length > 0) text = text.length === 0 ? last.text : text + '\n' + last.text
      cursor = last.next_offset
      rounds += 1
      const reachedEnd = last.exit_code !== undefined || last.total_bytes === undefined
      if (reachedEnd || step.wait_seconds === 0 || Date.now() > deadline) break
      if (localTimer) await delay(ctx, DEPLOY_TAIL_POLL_SECONDS * 1000)
    }
    return omitUndefined({
      ok: true,
      exit_code: last.exit_code !== undefined ? last.exit_code : 0,
      output: text,
      next_offset: cursor,
      total_bytes: last.total_bytes,
      eof: last.exit_code !== undefined ? true : undefined,
      error: undefined,
      rounds,
    })
  }

  async function executeSteps(args, exec, steps, extra = {}) {
    if (steps.length > DEPLOY_MAX_STEPS) {
      throw new Error('ecs_deploy: steps 上限为 ' + DEPLOY_MAX_STEPS + ' 步(收到 ' + steps.length + ')')
    }
    const plan = planSteps(steps, args)
    const dryRun = args.dry_run === true
    const runbookMeta = extra.runbook

    // 预演: 不执行任何东西, 也不请求审批(不产生任何副作用)
    if (dryRun) {
      return omitUndefined({
        instance_id: args.instance_id,
        mode: 'steps',
        dry_run: true,
        ok: true,
        done_stage: 0,
        total_stage: plan.length,
        runbook: runbookMeta,
        plan: plan.map((s) => omitUndefined({
          index: s.index, kind: s.kind, name: s.name,
          command_line: s.command_line,
          read_only: s.read_only === true ? true : undefined,
          verify_sha256: s.kind === 'upload' ? s.verify : undefined,
        })),
        command_line: commandLine(['deploy', args.instance_id, '--steps ' + plan.length + ' (dry_run)']),
      })
    }

    // 破坏性命令守卫 + 只读护栏: 全部步骤先过闸, 再开始执行
    for (const step of plan) {
      if (step.read_only === true) guardReadOnly(step.payload, 'ecs_deploy steps[' + step.index + ']')
      if (step.kind === 'exec' || step.kind === 'assert') {
        await guardDestructiveCommand(ctx, exec, step.payload)
      }
      if (exec.signal.aborted) throw new Error('工具调用已被取消')
    }

    const continueOnError = args.continue_on_error === true
    return withInstanceLock(args.instance_id, async () => {
      const stages = []
      let doneStage = 0
      let stoppedAt
      let stoppedReason
      const failedSteps = []
      let aborted = false
      let abortReason

      for (const step of plan) {
        if (exec.signal.aborted) throw new Error('工具调用已被取消')
        // 前一步失败且未开启 continue_on_error: 余下步骤标记为跳过(而不是静默消失)
        if (stoppedAt !== undefined) {
          stages.push({ index: step.index, kind: step.kind, name: step.name, ok: false, skipped: true, exit_code: 0, output: '' })
          continue
        }

        let stage
        if (step.kind === 'upload') {
          stage = await runStage(step.argv, exec.signal, { loose: true })
          if (stage.ok === true && step.verify) {
            const remoteFile = remoteJoin(step.remote_path, step.local_file)
            const localHash = await localSha256(ctx, step.local_file, exec.signal)
            const remoteHash = await remoteSha256(ctx, args.instance_id, remoteFile,
              { region: args.region, signal: exec.signal, timeout: 60, locked: true })
            stage.sha256_local = localHash
            stage.sha256_remote = remoteHash
            if (localHash === undefined) {
              stage.output = (stage.output !== undefined && stage.output.length > 0 ? stage.output + '\n' : '') +
                '本机无可用哈希工具, 已跳过校验; 远端 sha256: ' + (remoteHash !== undefined ? remoteHash : '(不可用)')
            } else if (remoteHash === undefined) {
              stage.ok = false
              stage.error = '无法获取远端 sha256(远端缺少 sha256sum/shasum 或文件不存在): ' + remoteFile
              aborted = true
              abortReason = 'sha256 校验无法完成, 已中止编排'
            } else if (localHash !== remoteHash) {
              stage.ok = false
              stage.error = 'sha256 不一致: 上传物与本地文件不同, 可能是传输损坏'
              aborted = true
              abortReason = 'sha256 不一致(' + localHash.slice(0, 12) + '… vs ' + remoteHash.slice(0, 12) + '…), 已中止编排'
            }
          }
        } else if (step.kind === 'tail') {
          stage = await runTailStep(step, args, exec.signal)
        } else {
          stage = await runRemoteStep(step, args, exec.signal)
          if (step.kind === 'assert') {
            // 断言以 exit_code/stdout/stderr 为判据; 命令本身失败也一并体现在断言条目里
            stage.assertions = evaluateAssertions(step.expect, stage)
            const failed = stage.assertions.filter((a) => a.ok !== true)
            if (failed.length > 0) {
              stage.ok = false
              stage.error = '断言未通过: ' + failed.map((a) => a.check + '(' + a.expected + ') 实际 ' + a.actual).join('; ')
            } else {
              stage.ok = true
            }
          }
        }

        stages.push(Object.assign({ index: step.index, kind: step.kind, name: step.name }, stage))
        doneStage += 1
        if (stage.ok !== true) {
          failedSteps.push(step.index)
          // 中止(aborted, 如 sha256 校验失败)一律停: 即使开了 continue_on_error
          // 也不能拿着损坏的发布物继续跑后续步骤
          if (stoppedAt === undefined && (aborted === true || !continueOnError)) {
            stoppedAt = step.index
            stoppedReason = aborted === true
              ? abortReason
              : (step.name + ': ' + (stage.error !== undefined ? stage.error : ('exit code ' + stage.exit_code)))
          }
        }
      }

      return omitUndefined({
        instance_id: args.instance_id,
        mode: 'steps',
        ok: stages.every((s) => s.ok === true),
        done_stage: doneStage,
        total_stage: plan.length,
        runbook: runbookMeta,
        stopped_at: stoppedAt,
        stopped_reason: stoppedReason,
        failed_steps: failedSteps.length > 0 ? failedSteps : undefined,
        aborted: aborted === true ? true : undefined,
        abort_reason: abortReason,
        continue_on_error: continueOnError === true ? true : undefined,
        stages,
        command_line: commandLine(['deploy', args.instance_id, '--steps', String(plan.length)]),
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
