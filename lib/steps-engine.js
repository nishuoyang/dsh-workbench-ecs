// ============================================================================
// lib/steps-engine.js —— steps 编排引擎(v0.6.2): 与 DSH 上下文无关的执行核心
// ----------------------------------------------------------------------------
// 动机: 同一套编排语义有两类调用方 ——
//   (A) 模型工具 ecs_deploy(带审批守卫、整段持实例锁);
//   (B) 设置页 RPC(面板里预演/执行 runbook, 无审批上下文, 破坏性命令直接拒绝)。
// 两边若各写一份, 迟早出现"面板跑得通、工具跑不通"这类漂移(v0.5.1 的 D8、
// v0.6.1 的 D10 都是同源问题)。因此把**纯逻辑**集中到这里:
//   - 步骤结构校验与计划(dry_run 与实际执行共用同一份构造);
//   - 输出解码(宽松/严格两种口径);
//   - 断言求值;
//   - 执行循环(upload/exec/assert/tail + sha256 校验 + 中止语义)。
// 一切与本机进程、审批、锁相关的部分都由调用方通过 **adapter** 注入:
//   adapter.run(argv)                -> { exitCode, stdout, stderr, ... }
//   adapter.localSha256(file)        -> digest | undefined
//   adapter.remoteSha256(path, opts) -> digest | undefined(调用方已持实例锁)
//   adapter.sleep(ms) / adapter.hasTimer
// 本模块不使用任何 Node 内置能力, 因此两条投递通道(npm 包与动态挂载 body)
// 与两种调用方行为完全一致。
// ============================================================================
import {
  decodeLoose, decodeCliOutput, cleanOutput, omitUndefined, resolveTimeout, commandLine,
  utf8ByteLength, remoteJoin, buildScriptDelivery, buildLogReadCommand, parseLogRead,
} from './common.js'

// 每步默认超时(秒): 必须显式下发(CLI --timeout 默认仅 30)
export const STEPS_STAGE_TIMEOUT = 180
// 单步超时上限(秒): 挡住 timeout: 300000 这类笔误把一次调用挂成几小时
// (与 tail 的 wait_seconds 上限对齐)
export const STEPS_MAX_STEP_TIMEOUT = 3600
// 步骤上限: 防止一次调用变成不可审计的巨型脚本
export const STEPS_MAX_STEPS = 20
// tail 步骤默认单次读取字节数与轮询间隔
export const STEPS_TAIL_BYTES = 256 * 1024
export const STEPS_TAIL_POLL_SECONDS = 2
// 合法步骤类型
export const STEPS_KINDS = ['upload', 'exec', 'assert', 'tail']

// ----------------------------------------------------------------------------
// 输出解码: 把一次本机 CLI 运行结果变成阶段结果 { ok, exit_code, output, ... }
// opts.loose=true 用于 upload 这类"CLI 输出人类可读文本而非 JSON"的命令
// (workbench upload 即使带 --output json 也只打印进度与 Upload complete 文本,
//  严格 JSON 解码会让上传阶段恒为失败)。
// ----------------------------------------------------------------------------
export function decodeStageRun(r, opts = {}) {
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
    throw new Error('意外的输出结构: ' + String(r.stdout).slice(0, 300))
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
}

function errorText(err) {
  return err && err.message !== undefined ? String(err.message) : String(err)
}

// 执行一条 CLI 命令并解码为阶段结果; 任何失败都以 { ok:false, error } 返回,
// 不向调用方抛异常(编排需要把失败留在步骤结果里, 而不是中断整个循环)。
export async function execStage(adapter, argv, opts = {}) {
  try {
    const r = await adapter.run(argv)
    return decodeStageRun(r, opts)
  } catch (err) {
    return {
      ok: false,
      exit_code: 0,
      output: '',
      stdout_truncated: false,
      error: errorText(err),
    }
  }
}

// ----------------------------------------------------------------------------
// 步骤结构校验与计划(dry_run 与实际执行共用: 预演的命令行与真正下发的一致)
// ----------------------------------------------------------------------------
export function stepKindOf(step, index) {
  const raw = step.kind !== undefined
    ? String(step.kind)
    : (step.local_file !== undefined ? 'upload' : (step.expect !== undefined ? 'assert' : 'exec'))
  if (!STEPS_KINDS.includes(raw)) {
    throw new Error('ecs_deploy: steps[' + index + '].kind 非法: ' + raw + '(应为 ' + STEPS_KINDS.join(' / ') + ')')
  }
  return raw
}

export function stepNameOf(kind, step, index) {
  if (step.description !== undefined && String(step.description).length > 0) return String(step.description)
  if (kind === 'upload') return '上传 ' + String(step.local_file)
  if (kind === 'tail') return '读取日志 ' + String(step.path)
  const body = step.script !== undefined ? '[script] ' + String(step.script).split('\n')[0] : String(step.command)
  return (kind === 'assert' ? '断言 ' : '执行 ') + (body.length > 60 ? body.slice(0, 60) + '…' : body)
}

export function stepPayloadOf(step, index, kind) {
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

// ----------------------------------------------------------------------------
// 单步超时(v0.6.6): 步骤自带的 timeout 优先于全局 args.timeout。
// 此前 planSteps 只把全局值算一次再发给每一步 —— 工具 schema 承诺的
// "本步骤命令超时(秒), 默认 180" 被**静默忽略**: 长步骤(如发布脚本)仍会在
// 全局超时处被 CLI 掐断, 而预演里看到的超时也不是调用方写的那个值。
// 非法值(非正数/非数字)退回全局值; 超过上限的值截断到上限(lint 会提前提醒)。
export function stepTimeoutOf(step, fallback) {
  const raw = step !== null && typeof step === 'object' ? step.timeout : undefined
  if (raw === undefined || raw === null || raw === '') return String(fallback)
  const seconds = Number(raw)
  if (!Number.isFinite(seconds) || seconds <= 0) return String(fallback)
  return String(Math.min(Math.floor(seconds), STEPS_MAX_STEP_TIMEOUT))
}

// args: { instance_id, region, timeout, force, read_only }
export function planSteps(steps, args) {
  const globalTimeout = String(resolveTimeout(args.timeout, STEPS_STAGE_TIMEOUT))
  const instanceId = args.instance_id !== undefined && args.instance_id !== null && String(args.instance_id).length > 0
    ? String(args.instance_id) : '<instance_id>'
  return steps.map((step, index) => {
    if (step === null || typeof step !== 'object' || Array.isArray(step)) {
      throw new Error('ecs_deploy: steps[' + index + '] 必须是对象')
    }
    const kind = stepKindOf(step, index)
    const timeout = stepTimeoutOf(step, globalTimeout)
    const name = stepNameOf(kind, step, index)
    if (kind === 'upload') {
      if (step.local_file === undefined || String(step.local_file).length === 0) {
        throw new Error('ecs_deploy: steps[' + index + '](upload) 缺少 local_file')
      }
      if (step.remote_path === undefined || String(step.remote_path).length === 0) {
        throw new Error('ecs_deploy: steps[' + index + '](upload) 缺少 remote_path')
      }
      const argv = ['upload', String(step.local_file), String(step.remote_path), '--instance-id', instanceId, '--output', 'json']
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
          ? Math.min(Math.floor(Number(step.max_bytes)), 4 * 1024 * 1024) : STEPS_TAIL_BYTES,
        exit_file: step.exit_file !== undefined && String(step.exit_file).length > 0 ? String(step.exit_file) : undefined,
        wait_seconds: waitSeconds,
        command_line: 'workbench exec --instance-id ' + instanceId + ' --command <tail -c +N ' + String(step.path) + '>',
        payload: '',
      }
    }
    // exec / assert
    const { payload } = stepPayloadOf(step, index, kind)
    const useScript = step.script !== undefined && String(step.script).length > 0
    const argv = useScript
      ? ['exec', '--instance-id', instanceId, '--command', '<script ' + utf8ByteLength(payload) + ' bytes>',
        '--timeout', timeout, '--output', 'json']
      : ['exec', '--instance-id', instanceId, '--command', payload, '--timeout', timeout, '--output', 'json']
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
        ? 'workbench exec --instance-id ' + instanceId + ' --command <script ' + utf8ByteLength(payload) + ' bytes> --timeout ' + timeout
        : commandLine(argv),
      payload,
    }
  })
}

// 步骤数上限检查(结构与计划之外的前置闸门)
export function assertStepCount(steps) {
  if (steps.length > STEPS_MAX_STEPS) {
    throw new Error('ecs_deploy: steps 上限为 ' + STEPS_MAX_STEPS + ' 步(收到 ' + steps.length + ' 步)')
  }
}

// 预演结果: 只回显将要执行的命令, 不产生任何副作用(因此调用方也不应请求审批)
export function planPreview(plan, args, extra = {}) {
  return omitUndefined(Object.assign({
    instance_id: args.instance_id,
    mode: 'steps',
    dry_run: true,
    ok: true,
    done_stage: 0,
    total_stage: plan.length,
    plan: plan.map((s) => omitUndefined({
      index: s.index, kind: s.kind, name: s.name,
      timeout: Number(s.timeout),
      command_line: s.command_line,
      read_only: s.read_only === true ? true : undefined,
      verify_sha256: s.kind === 'upload' ? s.verify : undefined,
    })),
    command_line: commandLine(['deploy', String(args.instance_id), '--steps ' + plan.length + ' (dry_run)']),
  }, extra))
}

// ----------------------------------------------------------------------------
// 断言求值: 逐条给出 (check, expected, actual, ok), 失败原因定位到具体一条
// ----------------------------------------------------------------------------
export function arrOf(value) {
  if (value === undefined || value === null) return []
  return Array.isArray(value) ? value.map((x) => String(x)) : [String(value)]
}

export function evaluateAssertions(expect, stage) {
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

// ----------------------------------------------------------------------------
// 单步执行
// ----------------------------------------------------------------------------
function aborted(opts) {
  return opts.signal !== undefined && opts.signal !== null && opts.signal.aborted === true
}

function checkAbort(opts) {
  if (aborted(opts)) throw new Error('工具调用已被取消')
}

const REGION_ARGS = (argv, args) => {
  if (args.region !== undefined && args.region !== null && String(args.region).length > 0) argv.push('--region', String(args.region))
  return argv
}

// exec/assert 步骤: script 走 base64 直送(零转义), command 直接下发
export async function runRemoteStep(adapter, step, args, opts = {}) {
  if (step.script === undefined) {
    return await execStage(adapter, step.argv, { loose: false })
  }
  const delivery = buildScriptDelivery(step.script, { shell: step.shell, keep: step.keep_script })
  const prep = delivery.commands.slice(0, -1)
  const finalCommand = delivery.commands[delivery.commands.length - 1]
  for (let i = 0; i < prep.length; i++) {
    checkAbort(opts)
    const argv = REGION_ARGS(['exec', '--instance-id', String(args.instance_id), '--command', prep[i], '--timeout', step.timeout, '--output', 'json'], args)
    const r = await execStage(adapter, argv, { loose: false })
    if (r.ok !== true) {
      return Object.assign({}, r, {
        error: '脚本投递失败(第 ' + (i + 1) + '/' + prep.length + ' 步, exit ' + r.exit_code + ')',
      })
    }
  }
  checkAbort(opts)
  const argv = REGION_ARGS(['exec', '--instance-id', String(args.instance_id), '--command', finalCommand, '--timeout', step.timeout, '--output', 'json'], args)
  return await execStage(adapter, argv, { loose: false })
}

// tail 步骤: 按字节游标读远端文件(只读), 可选等待退出码文件出现
export async function runTailStep(adapter, step, args, opts = {}) {
  const localTimer = adapter.hasTimer === true
  const deadline = Date.now() + step.wait_seconds * 1000
  let cursor = step.after
  let text = ''
  let last
  let rounds = 0
  for (;;) {
    checkAbort(opts)
    const command = buildLogReadCommand({
      logPath: step.path,
      exitPath: step.exit_file,
      after: cursor,
      maxBytes: step.max_bytes,
      sleep: localTimer ? 0 : STEPS_TAIL_POLL_SECONDS,
    })
    const argv = REGION_ARGS(['exec', '--instance-id', String(args.instance_id), '--command', command, '--timeout', step.timeout, '--output', 'json'], args)
    const r = await execStage(adapter, argv, { loose: false })
    if (r.ok !== true) {
      return Object.assign({}, r, { error: r.error !== undefined ? r.error : '日志读取失败 (exit ' + r.exit_code + ')' })
    }
    last = parseLogRead(r.output, cursor, step.max_bytes)
    if (last.text.length > 0) text = text.length === 0 ? last.text : text + '\n' + last.text
    cursor = last.next_offset
    rounds += 1
    const reachedEnd = last.exit_code !== undefined || last.total_bytes === undefined
    if (reachedEnd || step.wait_seconds === 0 || Date.now() > deadline) break
    if (localTimer) await adapter.sleep(STEPS_TAIL_POLL_SECONDS * 1000)
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

// upload 步骤 + sha256 校验(校验失败 → aborted, 由执行循环统一中止)
async function runUploadStep(adapter, step, args, opts = {}) {
  const stage = await execStage(adapter, step.argv, { loose: true })
  const state = { aborted: false, abortReason: undefined }
  if (stage.ok !== true || step.verify !== true) return { stage, state }
  const remoteFile = remoteJoin(step.remote_path, step.local_file)
  const localHash = await adapter.localSha256(step.local_file)
  const remoteHash = await adapter.remoteSha256(remoteFile, { timeout: 60 })
  stage.sha256_local = localHash
  stage.sha256_remote = remoteHash
  if (localHash === undefined) {
    stage.output = (stage.output !== undefined && stage.output.length > 0 ? stage.output + '\n' : '') +
      '本机无可用哈希工具, 已跳过校验; 远端 sha256: ' + (remoteHash !== undefined ? remoteHash : '(不可用)')
  } else if (remoteHash === undefined) {
    stage.ok = false
    stage.error = '无法获取远端 sha256(远端缺少 sha256sum/shasum 或文件不存在): ' + remoteFile
    state.aborted = true
    state.abortReason = 'sha256 校验无法完成, 已中止编排'
  } else if (localHash !== remoteHash) {
    stage.ok = false
    stage.error = 'sha256 不一致: 上传物与本地文件不同, 可能是传输损坏'
    state.aborted = true
    state.abortReason = 'sha256 不一致(' + localHash.slice(0, 12) + '… vs ' + remoteHash.slice(0, 12) + '…), 已中止编排'
  }
  return { stage, state }
}

// ----------------------------------------------------------------------------
// 执行循环: 前一步失败且未开 continue_on_error 时, 余下步骤显式标记 skipped;
// aborted(如 sha256 校验失败)则一律中止 —— 即使开了 continue_on_error 也不能
// 拿着损坏的发布物继续跑后续步骤。
// ----------------------------------------------------------------------------
export async function runSteps(adapter, plan, args, opts = {}) {
  const continueOnError = args.continue_on_error === true
  const stages = []
  let doneStage = 0
  let stoppedAt
  let stoppedReason
  const failedSteps = []
  let aborted = false
  let abortReason

  for (const step of plan) {
    checkAbort(opts)
    if (stoppedAt !== undefined) {
      stages.push({ index: step.index, kind: step.kind, name: step.name, ok: false, skipped: true, exit_code: 0, output: '' })
      continue
    }

    let stage
    if (step.kind === 'upload') {
      const outcome = await runUploadStep(adapter, step, args, opts)
      stage = outcome.stage
      if (outcome.state.aborted === true) {
        aborted = true
        abortReason = outcome.state.abortReason
      }
    } else if (step.kind === 'tail') {
      stage = await runTailStep(adapter, step, args, opts)
    } else {
      stage = await runRemoteStep(adapter, step, args, opts)
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
      if (stoppedAt === undefined && (aborted === true || !continueOnError)) {
        stoppedAt = step.index
        stoppedReason = aborted === true
          ? abortReason
          : (step.name + ': ' + (stage.error !== undefined ? stage.error : ('exit code ' + stage.exit_code)))
      }
    }
  }

  return omitUndefined(Object.assign({
    instance_id: args.instance_id,
    mode: 'steps',
    ok: stages.every((s) => s.ok === true),
    done_stage: doneStage,
    total_stage: plan.length,
    stopped_at: stoppedAt,
    stopped_reason: stoppedReason,
    failed_steps: failedSteps.length > 0 ? failedSteps : undefined,
    aborted: aborted === true ? true : undefined,
    abort_reason: abortReason,
    continue_on_error: continueOnError === true ? true : undefined,
    stages,
    command_line: commandLine(['deploy', String(args.instance_id), '--steps', String(plan.length)]),
  }, opts.extra !== undefined ? opts.extra : {}))
}
