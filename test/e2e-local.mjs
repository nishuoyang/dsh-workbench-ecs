// ============================================================================
// test/e2e-local.mjs —— 真实 CLI 端到端测试(需要本机 Workbench CLI + 有效凭据)
// ----------------------------------------------------------------------------
// 直接驱动 lib/tools/*.js 的 execute, 用真实 workbench CLI 与真实 ECS 实例验证:
//   ecs_list / ecs_exec(单/批量/守卫) / ecs_upload / ecs_download /
//   ecs_diagnose / ecs_deploy / ecs_session
// 运行: node test/e2e-local.mjs [实例ID]   (默认 i-uf66ct2o35p7fjcd0sru)
// 说明: 本测试只使用只读命令与 /tmp 临时文件, 不会改动生产数据。
// ============================================================================
import { spawn } from 'node:child_process'
import { writeFileSync, readFileSync, mkdtempSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, isAbsolute, normalize } from 'node:path'
import assert from 'node:assert'
import { isJsonValue } from '@deepseek-ai/dsh-session'

import { ecsListDefinition } from '../lib/tools/ecs-list.js'
import { ecsFindDefinition } from '../lib/tools/ecs-find.js'
import { ecsExecDefinition } from '../lib/tools/ecs-exec.js'
import { ecsLogDefinition } from '../lib/tools/ecs-log.js'
import { ecsUploadDefinition } from '../lib/tools/ecs-upload.js'
import { ecsDownloadDefinition } from '../lib/tools/ecs-download.js'
import { ecsDiagnoseDefinition } from '../lib/tools/ecs-diagnose.js'
import { ecsDeployDefinition } from '../lib/tools/ecs-deploy.js'
import { ecsSessionDefinition } from '../lib/tools/ecs-session.js'
import { ecsRunbookDefinition } from '../lib/tools/ecs-runbook.js'
import { ecsSnapshotDefinition } from '../lib/tools/ecs-snapshot.js'
import { apply } from '../lib/index.js'
import { createSettingsCore } from '../lib/settings-api.js'
import { runWorkbench, localSha256, remoteSha256, delay, hasLocalTimer, REMOTE_TIMEOUT_EXIT_CODE } from '../lib/common.js'
import { RUNBOOK_DIR } from '../lib/runbooks.js'

const INSTANCE_ID = process.argv[2] ?? 'i-uf66ct2o35p7fjcd0sru'
const REGION = 'cn-shanghai'

// ---- 最小 subprocess 服务适配器: 直接调用本机 workbench ----
const WORKBENCH_EXE = 'C:\\Program Files\\workbench\\workbench.exe'
function readerFor(chunks) {
  let next = 0
  return {
    readFrom(from) {
      const buf = Buffer.concat(chunks)
      const text = buf.toString('utf8').slice(from)
      next = buf.length
      return { text, nextOffset: next, lossy: false }
    },
  }
}
const fakeSubprocess = {
  async resolveExecutable(name) {
    if (name === 'workbench') return WORKBENCH_EXE
    // 其它本机程序(sha256sum/shasum/certutil 等)交给 PATH 解析
    return name
  },
  spawn(spec) {
    const child = spawn(spec.argv[0], spec.argv.slice(1), {
      cwd: spec.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const outChunks = []
    const errChunks = []
    child.stdout.on('data', (c) => outChunks.push(c))
    child.stderr.on('data', (c) => errChunks.push(c))
    return {
      pid: child.pid,
      stdin: undefined,
      stdout: undefined,
      stderr: undefined,
      collected: { stdout: readerFor(outChunks), stderr: readerFor(errChunks) },
      done: new Promise((resolve, reject) => {
        child.on('error', reject)
        child.on('close', (code, signal) => resolve({ exitCode: code, signal }))
      }),
      terminate() { child.kill() },
      async waitForExit() { return true },
    }
  },
}

// ---- 构造 ctx 与 exec 上下文 ----
function makeCtx(overrides = {}) {
  return {
    get(name) {
      if (name === 'subprocess') return fakeSubprocess
      if (name === 'sandboxPolicy') {
        return { workspaceRoot: overrides.workspaceRoot !== undefined ? overrides.workspaceRoot : process.cwd() }
      }
      if (name === 'approval') return overrides.approval
      if (name === 'jobs') return overrides.jobs
      if (name === 'fs') return overrides.fs
      return undefined
    },
  }
}

// 最小 fs 服务替身(真实文件系统): 实现 runbook 机制与快照清单用到的
// resolve/readText/writeText/stat/listDir(v0.8.0 快照要真的落盘)
function nodeFsAdapter(root) {
  return {
    async resolve(p) {
      const abs = isAbsolute(String(p)) ? String(p) : join(root, String(p))
      return { targetKey: normalize(abs) }
    },
    async readText(target) {
      return readFileSync(target.targetKey, 'utf8')
    },
    async writeText(target, content) {
      writeFileSync(target.targetKey, content)
      return { version: 'v1' }
    },
    async stat(target) {
      try {
        statSync(target.targetKey)
        return { kind: 'file' }
      } catch (err) {
        return undefined
      }
    },
    async listDir(target) {
      return readdirSync(target.targetKey, { withFileTypes: true }).map((e) => ({ name: e.name }))
    },
  }
}
function makeExec(name) {
  return {
    name,
    signal: new AbortController().signal,
    agent: undefined,
    callId: undefined,
  }
}

// 回归断言: 工具返回值必须通过 DSH 管线的 lossless JSON 校验(isJsonValue),
// 否则真实 Harness 里会报 "not lossless JSON" 使整次调用失败。
// (此前 ecs_exec/ecs_diagnose 因 undefined 值属性(如 stdout_spill_path、
// presentationMeta 中的 job_id/count)触发该错误。)
function assertLossless(label, value) {
  assert.ok(isJsonValue(value), label + ' 必须通过 isJsonValue(lossless JSON)')
}

// ---- 测试执行器 ----
let passed = 0
let failed = 0
async function run(name, fn) {
  try {
    await fn()
    passed += 1
    console.log('  ✔ ' + name)
  } catch (err) {
    failed += 1
    console.log('  ✘ ' + name + ' — ' + (err && err.message ? err.message : String(err)))
  }
}

console.log('== e2e-local: 实例 ' + INSTANCE_ID + ' @ ' + REGION + ' ==')

const ctx = makeCtx()

await run('ecs_list', async () => {
  const def = ecsListDefinition(ctx)
  const args = { region: REGION }
  const value = await def.execute(args, makeExec('ecs_list'))
  assert.ok(Array.isArray(value.instances), 'instances 应为数组')
  assert.ok(value.count >= 1, 'cn-shanghai 至少 1 台实例')
  assertLossless('ecs_list value', value)
  assertLossless('ecs_list presentationMeta', def.output.presentationMeta(args, value))
})

await run('ecs_exec 单实例(真实命令)', async () => {
  const def = ecsExecDefinition(ctx)
  const args = { instance_id: INSTANCE_ID, command: 'echo e2e-ok-123 && uname -s' }
  const value = await def.execute(args, makeExec('ecs_exec'))
  assert.equal(value.kind, 'single')
  assert.ok(value.output.includes('e2e-ok-123'), '输出应包含 e2e-ok-123')
  assert.equal(value.exit_code, 0)
  // D1 回归: 工具声明的默认超时必须显式下发(CLI 默认仅 30s)
  assert.ok(value.command_line.includes('--timeout 60'), '默认超时应显式下发 60, 实际: ' + value.command_line)
  // 排障字段: request_id/cli_session_id 便于事后核对隔离性(CLI 侧共享会话)
  assert.ok(typeof value.request_id === 'string' && value.request_id.startsWith('r-'), '应带回 request_id, 实际: ' + value.request_id)
  assert.ok(typeof value.cli_session_id === 'string', '应带回 cli_session_id')
  assertLossless('ecs_exec single value', value)
  assertLossless('ecs_exec single presentationMeta', def.output.presentationMeta(args, value))
  assertLossless('ecs_exec single presentCall', def.presentCall(args))
})

// ---- S1 脚本直送: 引号/中文/$/反引号/heredoc/多行 全部零转义 ----
await run('ecs_exec script 模式(10 类转义敏感构造)', async () => {
  const def = ecsExecDefinition(ctx)
  const script = [
    'echo "T1:outer \'inner\' done"',
    'echo "T2:中文输出-OK"',
    'V=abc; echo "T3:value=$V"',
    'echo "T4:backtick=`echo bt-ok`"',
    "cat <<'EOF'",
    'T5:heredoc line',
    'EOF',
    'echo "T6:it\'s fine"',
    "printf 'T7:%s\\n' 'a\\b\\c'",
    'ls /dsh-nonexistent-dir 2>/dev/null; echo "T8:redirect-ok"',
    'echo "T9:$(uname -n)"',
    'echo "T10:quote\\"inside\\"done"',
  ].join('\n')
  const args = { instance_id: INSTANCE_ID, script, description: 'e2e script 转义回归' }
  const value = await def.execute(args, makeExec('ecs_exec'))
  assert.equal(value.kind, 'single')
  assert.equal(value.exit_code, 0, 'script 应执行成功, stderr: ' + value.stderr)
  for (let i = 1; i <= 10; i++) {
    assert.ok(value.output.includes('T' + i + ':'), '脚本输出应含 T' + i + ' 段, 实际: ' + value.output)
  }
  assert.ok(value.output.includes("T1:outer 'inner' done"), '双引号嵌套应原样保留')
  assert.ok(value.output.includes('T2:中文输出-OK'), '中文应原样保留')
  assert.ok(value.output.includes('T5:heredoc line'), 'heredoc 应可用')
  assert.ok(value.script_mode === true, '应标记 script_mode')
  assert.ok(value.script_bytes > 100, '应回报脚本字节数')
  assert.equal(value.script_truncated, false)
  assertLossless('ecs_exec script value', value)
  assertLossless('ecs_exec script presentationMeta', def.output.presentationMeta(args, value))
  assertLossless('ecs_exec script presentCall', def.presentCall(args))
})

await run('ecs_exec script 模式: >16KB 分片投递', async () => {
  const def = ecsExecDefinition(ctx)
  const lines = []
  for (let i = 0; i < 1500; i++) lines.push('echo "big-' + i + '"')
  lines.push('echo BIG-SCRIPT-DONE')
  const script = lines.join('\n')
  assert.ok(Buffer.byteLength(script, 'utf8') > 16 * 1024, '脚本应大于内联阈值, 实际 ' + Buffer.byteLength(script, 'utf8'))
  const value = await def.execute({ instance_id: INSTANCE_ID, script, description: 'e2e 大脚本分片' }, makeExec('ecs_exec'))
  assert.equal(value.exit_code, 0, '大脚本应执行成功, stderr: ' + value.stderr)
  assert.ok(value.output.includes('big-1499'), '应执行到脚本末尾')
  assert.ok(value.output.includes('BIG-SCRIPT-DONE'), '应含结束标记')
  assert.ok(value.script_bytes > 16 * 1024, '应回报真实字节数')
  assertLossless('ecs_exec big script value', value)
})

await run('ecs_exec script 模式: 容器内 node -e(反馈 F1 原始场景)', async () => {
  const probe = await ecsExecDefinition(ctx).execute(
    { instance_id: INSTANCE_ID, command: "docker ps --format '{{.Names}}'" },
    makeExec('ecs_exec'),
  )
  const container = probe.output.split('\n').map((s) => s.trim()).find((s) => s.length > 0)
  if (container === undefined) {
    console.log('    (跳过: 该实例上没有运行中的容器)')
    return
  }
  const def = ecsExecDefinition(ctx)
  const script = 'docker exec ' + container + ' node -e "console.log(JSON.stringify({ok:true,msg:\\"容器内引号 OK\\"}))"'
  const value = await def.execute({ instance_id: INSTANCE_ID, script, description: 'e2e 容器内 node -e' }, makeExec('ecs_exec'))
  assert.equal(value.exit_code, 0, '容器内 node -e 应成功, stderr: ' + value.stderr)
  assert.ok(value.output.includes('"ok":true') || value.output.includes('"ok": true'), '应拿到 JSON 输出, 实际: ' + value.output)
  assert.ok(value.output.includes('容器内引号 OK'), '容器内中文/引号应原样返回')
})

await run('ecs_exec: command 与 script 二选一校验', async () => {
  const def = ecsExecDefinition(ctx)
  await assert.rejects(
    def.execute({ instance_id: INSTANCE_ID, command: 'echo a', script: 'echo b' }, makeExec('ecs_exec')),
    /二选一/,
  )
  await assert.rejects(
    def.execute({ instance_id: INSTANCE_ID }, makeExec('ecs_exec')),
    /必须提供 command 或 script/,
  )
})

// ---- S6 只读护栏 ----
await run('ecs_exec read_only: 拒绝写命令, 放行只读命令', async () => {
  const def = ecsExecDefinition(ctx)
  await assert.rejects(
    def.execute({ instance_id: INSTANCE_ID, command: 'echo x > /tmp/dsh-e2e-should-not-exist', read_only: true }, makeExec('ecs_exec')),
    /read_only|写操作/,
    'read_only 下应拒绝重定向写入',
  )
  const value = await def.execute({ instance_id: INSTANCE_ID, command: 'echo readonly-ok', read_only: true }, makeExec('ecs_exec'))
  assert.equal(value.read_only, true)
  assert.ok(value.output.includes('readonly-ok'))
  assertLossless('ecs_exec read_only value', value)
})

await run('ecs_exec 批量(1 成功 + 1 失败)', async () => {
  const def = ecsExecDefinition(ctx)
  const value = await def.execute(
    { instance_ids: [INSTANCE_ID, 'i-bp1dummysmoketest0000'], command: 'echo batch-ok' },
    makeExec('ecs_exec'),
  )
  assert.equal(value.kind, 'batch')
  assert.equal(value.count, 2)
  assert.equal(value.failed_count, 1, '假实例应记为失败')
  assert.equal(value.batch[0].is_error, false)
  assert.equal(value.batch[1].is_error, true)
  assertLossless('ecs_exec batch value', value)
  assertLossless('ecs_exec batch presentationMeta', def.output.presentationMeta({}, value))
})

await run('ecs_exec 批量并发(S7: concurrency 生效且结果保序)', async () => {
  const def = ecsExecDefinition(ctx)
  const value = await def.execute(
    { instance_ids: [INSTANCE_ID, 'i-bp1dummysmoketest0000'], command: 'echo par-ok && uname -s', concurrency: 2 },
    makeExec('ecs_exec'),
  )
  assert.equal(value.kind, 'batch')
  assert.equal(value.count, 2)
  assert.equal(value.concurrency, 2, '显式并发度应回显')
  assert.equal(value.failed_count, 1, '假实例应记为失败')
  assert.equal(value.batch[0].instance_id, INSTANCE_ID, '结果必须按输入顺序')
  assert.ok(value.batch[0].output.includes('par-ok'), '真实实例应成功')
  assertLossless('ecs_exec batch 并发 value', value)
})

await run('ecs_exec 只读批量默认并发 4(S7)', async () => {
  const def = ecsExecDefinition(ctx)
  // 只读命令默认并发 min(4, 台数); 单台时 instance_ids 走单实例路径(无并发概念)
  const two = await def.execute(
    { instance_ids: [INSTANCE_ID, 'i-bp1dummysmoketest0000'], command: 'uptime', read_only: true },
    makeExec('ecs_exec'),
  )
  assert.equal(two.kind, 'batch')
  assert.equal(two.concurrency, 2, '只读批量默认并发应为 min(4, 台数)')
  const single = await def.execute(
    { instance_ids: [INSTANCE_ID], command: 'uptime', read_only: true },
    makeExec('ecs_exec'),
  )
  assert.equal(single.kind, 'single', '单台 instance_ids 仍走单实例路径(保持既有语义)')
  assertLossless('ecs_exec read_only batch value', two)
})

await run('ecs_exec 批量后台(S7: 每台一个 job, 返回 job_ids)', async () => {
  const specs = []
  const jobsMock = {
    start(spec) {
      specs.push(spec)
      return 'job-par-' + specs.length
    },
  }
  const def = ecsExecDefinition(makeCtx({ jobs: jobsMock }))
  const value = await def.execute(
    { instance_ids: [INSTANCE_ID, 'i-bp1dummysmoketest0000'], command: 'echo bg-par-ok', run_in_background: true },
    makeExec('ecs_exec'),
  )
  assert.equal(value.kind, 'batch_background')
  assert.equal(value.count, 2)
  assert.equal(value.failed_count, 0, '两台都应成功注册 job')
  assert.deepEqual(value.job_ids, ['job-par-1', 'job-par-2'])
  assert.equal(value.batch[0].job_id, 'job-par-1')
  assertLossless('ecs_exec batch background value', value)
  assertLossless('ecs_exec batch background presentationMeta', def.output.presentationMeta({}, value))
  // dsh-jobs 契约: 每个 job 的 done 都应解析终态枚举
  const outcomes = await Promise.all(specs.map((s) => s.run().done))
  for (const done of outcomes) {
    assert.ok(['completed', 'killed', 'failed'].includes(done.status),
      'done.status 必须是终态枚举, 实际: ' + String(done.status))
  }
  assert.equal(outcomes[0].status, 'completed', '真实实例应 completed')
})

await run('ecs_exec output_json 模式(S7)', async () => {
  const def = ecsExecDefinition(ctx)
  const args = { instance_id: INSTANCE_ID, command: 'echo json-mode-ok', output_json: true, description: 'e2e json' }
  const value = await def.execute(args, makeExec('ecs_exec'))
  const text = def.output.render(args, value)[0].text
  assert.deepEqual(JSON.parse(text), value, 'output_json 应是 value 的精确 JSON 序列化')
  assert.equal(value.kind, 'single')
  assertLossless('ecs_exec output_json value', value)
})

await run('ecs_list 新过滤器(zone_id/private_ip/vpc_id)', async () => {
  const def = ecsListDefinition(ctx)
  const value = await def.execute(
    { region: REGION, instance_name: 'iZuf66*' },
    makeExec('ecs_list'),
  )
  assert.ok(value.count >= 1, '按名称通配应至少命中 1 台')
  assert.equal(value.limit, 50, '默认 limit 应回显')
  assert.equal(value.pagination_note, undefined, '未顶到 limit 不应提示分页')
  const byZone = await def.execute({ region: REGION, zone_id: 'cn-shanghai-e' }, makeExec('ecs_list'))
  assert.ok(byZone.count >= 0, 'zone_id 过滤应可用(不报错)')
  assertLossless('ecs_list filtered value', byZone)
  const asJson = def.output.render({ output_json: true }, value)[0].text
  assert.deepEqual(JSON.parse(asJson), value, 'output_json 应是 value 的精确 JSON 序列化')
})


await run('ecs_exec 破坏性命令守卫(无审批 -> 拒绝)', async () => {
  const def = ecsExecDefinition(ctx)
  await assert.rejects(
    def.execute({ instance_id: INSTANCE_ID, command: 'rm -rf /tmp/e2e-x' }, makeExec('ecs_exec')),
    /破坏性命令|拒绝执行/,
    '应拒绝 rm -rf',
  )
})

await run('ecs_exec 后台任务(jobs 模拟)', async () => {
  let jobRun
  const jobsMock = {
    start(spec) {
      jobRun = spec.run()
      return 'job-e2e-1'
    },
  }
  const def = ecsExecDefinition(makeCtx({ jobs: jobsMock }))
  const value = await def.execute(
    { instance_id: INSTANCE_ID, command: 'echo bg-ok && sleep 1', run_in_background: true },
    makeExec('ecs_exec'),
  )
  assert.equal(value.kind, 'background')
  assert.equal(value.job_id, 'job-e2e-1')
  assertLossless('ecs_exec background value', value)
  assertLossless('ecs_exec background presentationMeta', def.output.presentationMeta({}, value))
  assertLossless('ecs_exec background presentCall', def.presentCall({ instance_id: INSTANCE_ID, command: 'echo bg-ok', run_in_background: true }))
  const done = await jobRun.done
  const out = jobRun.readOutput()
  assert.ok(out.includes('bg-ok'), '后台输出应包含 bg-ok')
  // dsh-jobs 契约: done 必须解析 JobOutcome{status, detail?}; 否则 job.status
  // 会是 undefined, 使 job_output/job_list 的快照含 undefined 而报 not lossless JSON
  assert.ok(['completed', 'killed', 'failed'].includes(done.status), 'done.status 必须是终态枚举, 实际: ' + String(done.status))
  assert.equal(done.status, 'completed', '退出码 0 应结算为 completed')
  assert.match(String(done.detail), /exit code: 0/, 'done.detail 应含退出码')
  assertLossless('jobs outcome', done)
  // 模拟 dsh-jobs-local 的 snapshot(): status 键无条件存在
  const snapshot = {
    id: 'job-e2e-1', kind: 'workbench-ecs', label: 'ecs_exec', status: done.status,
    ...(done.detail !== undefined ? { detail: done.detail } : {}),
    startedAt: Date.now(), finishedAt: Date.now(), reported: false,
  }
  assertLossless('模拟 jobs snapshot(job_output/job_list 载荷)', snapshot)
})

// 缺陷 2 回归: 同实例并发必须串行化, 互不串流
await run('同实例并发不串流(后台 + 前台)', async () => {
  let jobRun
  const jobsMock = { start(spec) { jobRun = spec.run(); return 'job-conc-1' } }
  const bgDef = ecsExecDefinition(makeCtx({ jobs: jobsMock }))
  const bgValue = await bgDef.execute(
    { instance_id: INSTANCE_ID, command: 'for i in 1 2 3; do echo tick-$i; sleep 1; done; echo done-bg', run_in_background: true },
    makeExec('ecs_exec'),
  )
  assert.equal(bgValue.kind, 'background')
  // 后台任务持有实例锁; 前台并发调用排队, 完成后只应看到自己的输出
  const fgDef = ecsExecDefinition(ctx)
  const fg = await fgDef.execute({ instance_id: INSTANCE_ID, command: 'echo fg-only-marker' }, makeExec('ecs_exec'))
  const bgOut = await (async () => { await jobRun.done; return jobRun.readOutput() })()
  assert.ok(fg.output.includes('fg-only-marker'), '前台输出应含自己的标记, 实际: ' + fg.output)
  assert.ok(!fg.output.includes('tick-'), '前台输出不应混入后台任务内容, 实际: ' + fg.output)
  assert.ok(!fg.output.includes('done-bg'), '前台输出不应含后台结束标记, 实际: ' + fg.output)
  assert.ok(bgOut.includes('done-bg'), '后台输出应完整, 实际: ' + bgOut)
  assert.ok(!bgOut.includes('fg-only-marker'), '后台输出不应混入前台内容, 实际: ' + bgOut)
})

// ---- S2: detach 长任务 + 字节游标日志 + D2 不再长期占锁 ----
await run('ecs_exec detach: 远端长任务 + 增量日志', async () => {
  let jobRun
  const jobsMock = { start(spec) { jobRun = spec.run(); return 'job-detach-1' } }
  const def = ecsExecDefinition(makeCtx({ jobs: jobsMock }))
  const value = await def.execute(
    {
      instance_id: INSTANCE_ID,
      script: 'for i in 1 2 3; do echo tick-$i; sleep 1; done; echo DETACH-DONE',
      detach: true,
      poll_interval: 1,
      description: 'e2e detach 长任务',
    },
    makeExec('ecs_exec'),
  )
  assert.equal(value.kind, 'detached')
  assert.equal(value.job_id, 'job-detach-1')
  assert.ok(typeof value.pid === 'number' && value.pid > 0, '应回报远端 pid, 实际: ' + value.pid)
  assert.ok(String(value.log_path).includes('/.dsh-ecs-'), '应回报日志路径: ' + value.log_path)
  assert.ok(String(value.exit_path).endsWith('/exit'), '应回报退出码文件: ' + value.exit_path)
  assertLossless('ecs_exec detach value', value)
  assertLossless('ecs_exec detach presentationMeta', def.output.presentationMeta({}, value))
  assertLossless('ecs_exec detach presentCall', def.presentCall({ instance_id: INSTANCE_ID, script: 'echo x', detach: true }))

  const done = await jobRun.done
  const out = jobRun.readOutput()
  assert.equal(done.status, 'completed', 'detach 任务应结算为 completed, 实际: ' + JSON.stringify(done))
  assert.match(String(done.detail), /exit code: 0/)
  for (const marker of ['tick-1', 'tick-2', 'tick-3', 'DETACH-DONE']) {
    assert.ok(out.includes(marker), '增量输出应含 ' + marker + ', 实际: ' + out)
  }
  assertLossless('jobs detach outcome', done)

  // 字节游标读: 从 0 读全文 → 再按 next_offset 续读应为空(不重复)
  const logDef = ecsLogDefinition(ctx)
  const first = await logDef.execute({ instance_id: INSTANCE_ID, path: value.log_path, after: 0 }, makeExec('ecs_log'))
  assert.ok(first.text.includes('DETACH-DONE'), '从头读应拿到完整日志')
  assert.ok(first.next_offset > 0)
  assert.equal(first.eof, true, '任务已结束, 应到末尾')
  assertLossless('ecs_log value', first)
  const second = await logDef.execute({ instance_id: INSTANCE_ID, path: value.log_path, after: first.next_offset }, makeExec('ecs_log'))
  assert.equal(second.text, '', '续读不应重复已读内容, 实际: ' + second.text)
  assert.equal(second.next_offset, first.next_offset)
  // 分片读: max_bytes 限定 + truncated 提示 + 游标推进
  const slice = await logDef.execute({ instance_id: INSTANCE_ID, path: value.log_path, after: 0, max_bytes: 8 }, makeExec('ecs_log'))
  assert.equal(slice.bytes, 8, '应按 max_bytes 截断, 实际: ' + slice.bytes)
  assert.equal(slice.next_offset, 8)
  assert.equal(slice.truncated, true)
  // 退出码文件: 存在即回报 exit_code
  const withExit = await logDef.execute({ instance_id: INSTANCE_ID, path: value.log_path, after: first.next_offset, exit_file: value.exit_path }, makeExec('ecs_log'))
  assert.equal(withExit.exit_code, 0, '应读到退出码 0')
})

await run('detach 期间同实例调用不被长期阻塞(D2)', async () => {
  let jobRun
  const jobsMock = { start(spec) { jobRun = spec.run(); return 'job-detach-2' } }
  const detachDef = ecsExecDefinition(makeCtx({ jobs: jobsMock }))
  const value = await detachDef.execute(
    {
      instance_id: INSTANCE_ID,
      script: 'for i in $(seq 1 10); do echo long-$i; sleep 1; done; echo LONG-DONE',
      detach: true,
      poll_interval: 1,
    },
    makeExec('ecs_exec'),
  )
  assert.equal(value.kind, 'detached')
  // 远端任务约 10s, 但实例锁只在每次轮询期间短暂持有 → 前台调用应很快返回
  const t0 = Date.now()
  const fg = await ecsExecDefinition(ctx).execute({ instance_id: INSTANCE_ID, command: 'echo fg-during-detach' }, makeExec('ecs_exec'))
  const elapsed = Date.now() - t0
  assert.ok(fg.output.includes('fg-during-detach'), '前台调用应正常返回: ' + fg.output)
  assert.ok(elapsed < 6000, '前台调用不应等待 detach 任务结束(实际 ' + elapsed + 'ms)')
  const done = await jobRun.done
  assert.equal(done.status, 'completed', 'detach 任务最终应完成: ' + JSON.stringify(done))
  const out = jobRun.readOutput()
  assert.ok(out.includes('LONG-DONE'), '增量输出应含结束标记')
  assert.ok(!out.includes('fg-during-detach'), 'detach 输出不应混入同实例前台调用内容')
})

await run('ecs_exec: detach 与批量/后台互斥校验', async () => {
  const def = ecsExecDefinition(makeCtx({ jobs: { start() { return 'job-x' } } }))
  await assert.rejects(
    def.execute({ instance_ids: [INSTANCE_ID, 'i-bp1dummysmoketest0000'], command: 'echo a', detach: true }, makeExec('ecs_exec')),
    /detach/,
  )
  await assert.rejects(
    def.execute({ instance_id: INSTANCE_ID, command: 'echo a', detach: true, run_in_background: true }, makeExec('ecs_exec')),
    /二选一/,
  )
})

// ---- S3: 伪会话(cwd/环境变量继承 + 隔离) ----
await run('ecs_exec session_id: cwd 与环境变量跨调用继承', async () => {
  const def = ecsExecDefinition(ctx)
  const key = 'e2e-sess-' + Date.now()
  const first = await def.execute(
    { instance_id: INSTANCE_ID, command: 'cd /tmp && pwd', session_id: key, session_reset: true },
    makeExec('ecs_exec'),
  )
  assert.equal(first.session_id, key)
  assert.equal(first.session_cwd, '/tmp', '第一条应把 cwd 记为 /tmp, 实际: ' + first.session_cwd)
  assert.ok(first.output.includes('/tmp'), '输出应含 pwd 结果')
  assert.ok(!first.output.includes('__DSH_ECS_CWD__'), 'cwd 标记不应出现在模型可见输出中')
  assertLossless('ecs_exec session value', first)
  assertLossless('ecs_exec session presentationMeta', def.output.presentationMeta({}, first))

  const second = await def.execute(
    { instance_id: INSTANCE_ID, command: 'pwd; echo "FOO=$FOO"', session_id: key, env: ['FOO=bar'] },
    makeExec('ecs_exec'),
  )
  assert.equal(second.session_cwd, '/tmp', '第二条应继承 /tmp, 实际: ' + second.session_cwd)
  assert.ok(second.output.includes('/tmp'), '第二条 pwd 应为 /tmp, 实际: ' + second.output)
  assert.ok(second.output.includes('FOO=bar'), '会话内环境变量应生效, 实际: ' + second.output)

  const third = await def.execute(
    { instance_id: INSTANCE_ID, command: 'cd /var && pwd', session_id: key },
    makeExec('ecs_exec'),
  )
  assert.equal(third.session_cwd, '/var', '第三条应把 cwd 更新为 /var')

  // 标记行剥离 + 退出码仍透传
  const failing = await def.execute({ instance_id: INSTANCE_ID, command: 'exit 4', session_id: key }, makeExec('ecs_exec'))
  assert.equal(failing.exit_code, 4, '会话模式下退出码应透传')
  assert.ok(!failing.output.includes('__DSH_ECS_CWD__'), '标记不应残留')
})

await run('ecs_exec session_id: 不同会话互不干扰 + 与批量/detach 互斥', async () => {
  const def = ecsExecDefinition(ctx)
  const keyA = 'e2e-sessA-' + Date.now()
  const keyB = 'e2e-sessB-' + Date.now()
  await def.execute({ instance_id: INSTANCE_ID, command: 'cd /tmp', session_id: keyA, session_reset: true }, makeExec('ecs_exec'))
  const b = await def.execute({ instance_id: INSTANCE_ID, command: 'pwd', session_id: keyB, session_reset: true }, makeExec('ecs_exec'))
  assert.notEqual(b.session_cwd, '/tmp', '不同会话不应共享 cwd, 实际: ' + b.session_cwd)
  const a = await def.execute({ instance_id: INSTANCE_ID, command: 'pwd', session_id: keyA }, makeExec('ecs_exec'))
  assert.equal(a.session_cwd, '/tmp', 'A 会话应仍是 /tmp')
  await assert.rejects(
    def.execute({ instance_ids: [INSTANCE_ID, 'i-bp1dummysmoketest0000'], command: 'pwd', session_id: keyA }, makeExec('ecs_exec')),
    /session_id/,
  )
  await assert.rejects(
    def.execute({ instance_id: INSTANCE_ID, command: 'pwd', session_id: keyA, detach: true }, makeExec('ecs_exec')),
    /session_id/,
  )
})

const tmpDir = mkdtempSync(join(tmpdir(), 'dsh-wbecs-e2e-'))
const localFile = join(tmpDir, 'e2e-upload.txt')
writeFileSync(localFile, 'hello-from-dsh-e2e\n')

await run('ecs_upload(真实上传 + sha256 校验)', async () => {
  const def = ecsUploadDefinition(ctx)
  const value = await def.execute(
    { local_file: localFile, remote_path: '/tmp/dsh-e2e-upload.txt', instance_id: INSTANCE_ID, force: true, verify_sha256: true },
    makeExec('ecs_upload'),
  )
  assert.equal(value.exit_code, 0, '上传应成功, 实际 exit=' + value.exit_code + ' message=' + String(value.message).slice(0, 400))
  assert.equal(value.verification, 'ok', 'sha256 应校验通过, 实际: ' + value.verification)
  assert.equal(value.sha256_ok, true)
  assert.match(String(value.sha256_local), /^[0-9a-f]{64}$/, '应回报 64 位十六进制摘要')
  assert.equal(value.sha256_local, value.sha256_remote)
  assertLossless('ecs_upload value', value)
})

await run('ecs_upload(目录语义: remote_path 以 / 结尾)', async () => {
  const def = ecsUploadDefinition(ctx)
  const value = await def.execute(
    { local_file: localFile, remote_path: '/tmp/', instance_id: INSTANCE_ID, force: true, verify_sha256: true },
    makeExec('ecs_upload'),
  )
  assert.equal(value.exit_code, 0, '上传应成功, 实际 exit=' + value.exit_code + ' message=' + String(value.message).slice(0, 400))
  assert.equal(value.verification, 'ok', '目录语义下也应按 <dir>/<basename> 校验通过')
  assertLossless('ecs_upload dir value', value)
})

await run('sha256 断言: 不同内容摘要不同(损坏可被发现)', async () => {
  const other = join(tmpDir, 'e2e-other.txt')
  writeFileSync(other, 'a-different-payload\n')
  const { localSha256, remoteSha256 } = await import('../lib/common.js')
  const h1 = await localSha256(ctx, localFile)
  const h2 = await localSha256(ctx, other)
  const remoteH1 = await remoteSha256(ctx, INSTANCE_ID, '/tmp/dsh-e2e-upload.txt')
  assert.ok(h1 !== undefined && h2 !== undefined, '本机应能计算 sha256')
  assert.notEqual(h1, h2, '不同内容摘要必须不同')
  assert.equal(remoteH1, h1, '远端摘要应与本机一致(校验判据)')
})

// ---- S5b: 目录递归上传(归档 -> 上传 -> 校验 -> 解包) ----
const e2eDirRoot = mkdtempSync(join(tmpdir(), 'dsh-wbecs-e2e-dir-'))
mkdirSync(join(e2eDirRoot, 'src', 'sub'), { recursive: true })
writeFileSync(join(e2eDirRoot, 'src', 'a.txt'), 'alpha\n')
writeFileSync(join(e2eDirRoot, 'src', 'sub', 'b.txt'), 'beta\n')
const e2eSrcDir = join(e2eDirRoot, 'src')

await run('ecs_upload 目录模式(S5b: 归档→上传→校验→解包, 默认剥顶层目录)', async () => {
  const def = ecsUploadDefinition(ctx)
  const value = await def.execute(
    { local_dir: e2eSrcDir, remote_path: '/tmp/dsh-e2e-dir', instance_id: INSTANCE_ID, force: true, verify_sha256: true },
    makeExec('ecs_upload'),
  )
  assert.equal(value.mode, 'dir')
  assert.equal(value.exit_code, 0, '目录上传应成功, 实际 message=' + String(value.message).slice(0, 300) + ' / ' + String(value.extract_output))
  assert.equal(value.verification, 'ok', '归档 sha256 应校验通过, 实际: ' + value.verification)
  assert.equal(value.extracted, true, '应解包成功')
  assert.ok(value.entries >= 3, '归档条目数应 >= 3(顶层目录 + 2 个文件), 实际: ' + value.entries)
  assert.equal(value.local_archive_cleanup, 'removed', '本地归档应被清理')
  assertLossless('ecs_upload dir value', value)

  const execDef = ecsExecDefinition(ctx)
  const check = await execDef.execute(
    { instance_id: INSTANCE_ID, command: 'find /tmp/dsh-e2e-dir -type f | sort' },
    makeExec('ecs_exec'),
  )
  assert.ok(check.output.includes('/tmp/dsh-e2e-dir/a.txt'), '文件应直接落在目标目录下: ' + check.output)
  assert.ok(check.output.includes('/tmp/dsh-e2e-dir/sub/b.txt'), '子目录结构应保留: ' + check.output)
  assert.ok(!check.output.includes('/tmp/dsh-e2e-dir/src/'), '默认应剥掉归档顶层目录名')
})

await run('ecs_upload 目录模式: keep_root_dir 保留顶层目录', async () => {
  const def = ecsUploadDefinition(ctx)
  const value = await def.execute(
    {
      local_dir: e2eSrcDir, remote_path: '/tmp/dsh-e2e-dir-root', instance_id: INSTANCE_ID,
      force: true, verify_sha256: true, keep_root_dir: true,
    },
    makeExec('ecs_upload'),
  )
  assert.equal(value.extracted, true, '应解包成功: ' + String(value.extract_output))
  assert.equal(value.keep_root_dir, true)
  const execDef = ecsExecDefinition(ctx)
  const check = await execDef.execute(
    { instance_id: INSTANCE_ID, command: 'find /tmp/dsh-e2e-dir-root -type f | sort' },
    makeExec('ecs_exec'),
  )
  assert.ok(check.output.includes('/tmp/dsh-e2e-dir-root/src/a.txt'),
    'keep_root_dir=true 应保留顶层目录名: ' + check.output)
  assertLossless('ecs_upload dir keep_root value', value)
})

await run('ecs_upload 目录模式: local_dir 不存在时报错(不留本地归档)', async () => {
  const def = ecsUploadDefinition(ctx)
  await assert.rejects(
    def.execute(
      { local_dir: join(e2eDirRoot, 'no-such-dir'), remote_path: '/tmp/dsh-e2e-dir', instance_id: INSTANCE_ID },
      makeExec('ecs_upload'),
    ),
    /归档失败/,
    '本机 tar 失败应给出明确错误',
  )
  // v0.8.0 回归: tar 失败也会先建出半个归档文件, 清理必须覆盖这一步
  // (此前归档失败发生在 try 之外, 残留的 .dsh-ecs-upload-*.tar.gz 会一直堆在工作区)
  const leftovers = readdirSync(process.cwd()).filter((f) => f.startsWith('.dsh-ecs-upload-'))
  assert.deepEqual(leftovers, [], '归档失败后不得在工作区留下任何 .dsh-ecs-upload-* 残留: ' + leftovers.join(', '))
})

await run('ecs_download(真实下载并校验内容)', async () => {
  const def = ecsDownloadDefinition(ctx)
  const value = await def.execute(
    { remote_path: '/tmp/dsh-e2e-upload.txt', local_path: tmpDir, instance_id: INSTANCE_ID, force: true },
    makeExec('ecs_download'),
  )
  assert.equal(value.exit_code, 0, '下载应成功')
  assertLossless('ecs_download value', value)
  const saved = readFileSync(join(tmpDir, 'dsh-e2e-upload.txt'), 'utf8')
  assert.ok(saved.includes('hello-from-dsh-e2e'), '下载内容应一致')
})

await run('ecs_diagnose(一键体检)', async () => {
  const def = ecsDiagnoseDefinition(ctx)
  const value = await def.execute({ instance_id: INSTANCE_ID }, makeExec('ecs_diagnose'))
  assert.equal(value.exit_code, 0)
  assert.ok(value.output.includes('1/7') || value.output.includes('主机信息'), '体检输出应含分段标记')
  assert.ok(value.output.includes('docker') || value.output.includes('systemctl'), '体检输出应含服务段')
  // v0.4.0: 默认只读护栏 + 默认超时显式下发
  assert.equal(value.read_only, true, '诊断应默认开启只读护栏')
  assert.ok(value.command_line.includes('--timeout 120'), '默认超时应显式下发 120, 实际: ' + value.command_line)
  assertLossless('ecs_diagnose value', value)
  assertLossless('ecs_diagnose presentationMeta', def.output.presentationMeta({}, value))
})

await run('ecs_diagnose: extra_command 写入被只读护栏拒绝', async () => {
  const def = ecsDiagnoseDefinition(ctx)
  await assert.rejects(
    def.execute({ instance_id: INSTANCE_ID, extra_command: 'echo x > /tmp/dsh-e2e-diagnose-should-not-exist' }, makeExec('ecs_diagnose')),
    /read_only|写操作/,
  )
})

await run('ecs_session list', async () => {
  const def = ecsSessionDefinition(ctx)
  const value = await def.execute({ action: 'list' }, makeExec('ecs_session'))
  assert.equal(value.exit_code, 0)
  assertLossless('ecs_session value', value)
})

await run('ecs_deploy(重启 + 健康检查)', async () => {
  const def = ecsDeployDefinition(ctx)
  const value = await def.execute(
    {
      instance_id: INSTANCE_ID,
      command: 'echo deploy-restart-ok',
      health_check: 'true && echo health-ok',
      timeout: 30,
    },
    makeExec('ecs_deploy'),
  )
  assert.equal(value.total_stage, 2)
  assert.equal(value.done_stage, 2)
  assert.equal(value.ok, true, '两阶段都应成功')
  assert.ok(value.stages[0].output.includes('deploy-restart-ok'))
  // 显式超时应被原样下发(该用例传了 timeout: 30)
  assert.ok(value.command_line.includes('--timeout 30'), '显式超时应被采用, 实际: ' + value.command_line)
  assertLossless('ecs_deploy value', value)
  assertLossless('ecs_deploy presentationMeta', def.output.presentationMeta({}, value))
  assertLossless('ecs_deploy presentCall', def.presentCall({ instance_id: INSTANCE_ID, command: 'echo x' }))
})

await run('ecs_deploy(上传 + 默认开启 sha256 校验)', async () => {
  const def = ecsDeployDefinition(ctx)
  const value = await def.execute(
    {
      instance_id: INSTANCE_ID,
      local_file: localFile,
      remote_path: '/tmp/dsh-e2e-deploy.txt',
      force: true,
      command: 'echo deploy-verify-ok',
    },
    makeExec('ecs_deploy'),
  )
  assert.equal(value.total_stage, 3, '应为 上传 + 校验 + 重启 三阶段')
  assert.equal(value.done_stage, 3)
  assert.equal(value.ok, true, '三阶段都应成功: ' + JSON.stringify(value.stages.map((s) => [s.name, s.ok, s.error])))
  assert.equal(value.aborted, undefined, '校验通过时不应中止')
  const verifyStage = value.stages.find((s) => s.name.includes('sha256'))
  assert.ok(verifyStage !== undefined, '应存在 sha256 校验阶段')
  assert.equal(verifyStage.ok, true)
  assert.equal(verifyStage.sha256_local, verifyStage.sha256_remote)
  // D1 回归: 未传 timeout 时必须显式下发默认的 180
  assert.ok(value.command_line.includes('--timeout 180'), '默认阶段超时应为 180, 实际: ' + value.command_line)
  assertLossless('ecs_deploy upload value', value)
})

// ---- S4a: steps 编排(v0.6.0) ----
await run('ecs_deploy steps: dry_run 预演(不执行, 计划可读)', async () => {
  const def = ecsDeployDefinition(ctx)
  // 用一次性路径做判据: dry_run 绝不落盘, 因此这个文件必须不存在(跨运行也成立)
  const dryProbe = '/tmp/dsh-e2e-dryrun-' + Date.now().toString(36) + '.txt'
  const args = {
    instance_id: INSTANCE_ID,
    dry_run: true,
    steps: [
      { kind: 'upload', local_file: localFile, remote_path: dryProbe, force: true },
      { kind: 'exec', command: 'echo steps-dry' },
      { kind: 'assert', command: 'cat ' + dryProbe, expect: { exit_code: 0, stdout_contains: ['hello-from-dsh-e2e'] } },
      { kind: 'tail', path: '/tmp/dsh-e2e-steps.log' },
    ],
  }
  const value = await def.execute(args, makeExec('ecs_deploy'))
  assert.equal(value.dry_run, true)
  assert.equal(value.mode, 'steps')
  assert.equal(value.plan.length, 4)
  assert.deepEqual(value.plan.map((p) => p.kind), ['upload', 'exec', 'assert', 'tail'])
  assert.equal(value.plan[0].verify_sha256, true)
  assert.equal(value.stages, undefined, 'dry_run 不得产生阶段结果')
  const text = def.output.render(args, value)[0].text
  assert.ok(text.includes('未执行任何命令'))
  assertLossless('ecs_deploy dry_run value', value)
  assertLossless('ecs_deploy dry_run presentationMeta', def.output.presentationMeta({}, value))
  assertLossless('ecs_deploy steps presentCall', def.presentCall(args))
  // 预演没有执行任何东西: 远端文件不应存在
  const execDef = ecsExecDefinition(ctx)
  const check = await execDef.execute(
    { instance_id: INSTANCE_ID, command: 'ls ' + dryProbe + ' 2>/dev/null || echo ABSENT' },
    makeExec('ecs_exec'),
  )
  assert.ok(check.output.includes('ABSENT'), 'dry_run 后远端不应出现上传文件: ' + check.output)
})

await run('ecs_deploy steps: 真实编排(上传→校验→断言→日志游标)', async () => {
  const def = ecsDeployDefinition(ctx)
  const value = await def.execute(
    {
      instance_id: INSTANCE_ID,
      steps: [
        { kind: 'upload', local_file: localFile, remote_path: '/tmp/dsh-e2e-steps.txt', force: true, description: '上传发布物' },
        { kind: 'assert', command: 'cat /tmp/dsh-e2e-steps.txt', expect: { exit_code: 0, stdout_contains: ['hello-from-dsh-e2e'], stdout_not_contains: ['CORRUPT'] } },
        { kind: 'exec', script: 'echo "编排脚本 零转义: $HOME"; echo done > /tmp/dsh-e2e-steps.log', description: '脚本步骤' },
        { kind: 'tail', path: '/tmp/dsh-e2e-steps.log', description: '读日志' },
      ],
    },
    makeExec('ecs_deploy'),
  )
  assert.equal(value.mode, 'steps')
  assert.equal(value.total_stage, 4)
  assert.equal(value.done_stage, 4, '四步都应执行: ' + JSON.stringify(value.stages.map((s) => [s.name, s.ok, s.error])))
  assert.equal(value.ok, true, '编排应全部成功: ' + JSON.stringify(value.stages.map((s) => [s.name, s.ok, s.error])))
  assert.equal(value.stopped_at, undefined)
  assert.equal(value.aborted, undefined)
  // 上传步骤默认做了 sha256 校验
  assert.equal(value.stages[0].sha256_local, value.stages[0].sha256_remote, '上传步骤应默认校验 sha256')
  // 断言步骤逐条给出结果
  const asserts = value.stages[1].assertions
  assert.ok(Array.isArray(asserts) && asserts.length === 3, '断言应逐条回报, 实际: ' + JSON.stringify(asserts))
  assert.ok(asserts.every((a) => a.ok === true))
  // 脚本步骤零转义 + 中文
  assert.ok(value.stages[2].output.includes('编排脚本 零转义: /root'), '脚本步骤应原样执行: ' + value.stages[2].output)
  // tail 步骤读到日志并可续读
  assert.equal(value.stages[3].output, 'done')
  assert.ok(value.stages[3].next_offset >= 5, 'tail 应回报字节游标')
  assertLossless('ecs_deploy steps value', value)
  assertLossless('ecs_deploy steps presentationMeta', def.output.presentationMeta({}, value))
})

await run('ecs_deploy steps: 断言失败即中止且不执行后续步骤', async () => {
  const def = ecsDeployDefinition(ctx)
  const value = await def.execute(
    {
      instance_id: INSTANCE_ID,
      steps: [
        { kind: 'exec', command: 'echo step-zero' },
        { kind: 'assert', command: 'echo actual-output', expect: { exit_code: 0, stdout_contains: ['definitely-not-present'] } },
        { kind: 'exec', command: 'touch /tmp/dsh-e2e-should-not-exist', description: '不应被执行' },
      ],
    },
    makeExec('ecs_deploy'),
  )
  assert.equal(value.ok, false)
  assert.equal(value.done_stage, 2, '只应执行到断言那一步')
  assert.equal(value.stopped_at, 1)
  assert.deepEqual(value.failed_steps, [1])
  assert.match(String(value.stopped_reason), /stdout_contains/)
  assert.equal(value.stages[2].skipped, true)
  // 远端验证: 第三步确实没有执行
  const execDef = ecsExecDefinition(ctx)
  const check = await execDef.execute(
    { instance_id: INSTANCE_ID, command: 'ls /tmp/dsh-e2e-should-not-exist 2>/dev/null || echo ABSENT' },
    makeExec('ecs_exec'),
  )
  assert.ok(check.output.includes('ABSENT'), '中止后不得执行后续步骤: ' + check.output)
  assertLossless('ecs_deploy steps aborted value', value)
})

await run('ecs_deploy steps: continue_on_error 时失败不中断', async () => {
  const def = ecsDeployDefinition(ctx)
  const value = await def.execute(
    {
      instance_id: INSTANCE_ID,
      continue_on_error: true,
      steps: [
        { kind: 'exec', command: 'echo will-fail; exit 3', description: '预期失败' },
        { kind: 'exec', command: 'echo ran-after-failure' },
      ],
    },
    makeExec('ecs_deploy'),
  )
  assert.equal(value.done_stage, 2, '两步都应执行')
  assert.equal(value.stopped_at, undefined)
  assert.deepEqual(value.failed_steps, [0])
  assert.equal(value.stages[0].exit_code, 3, '远端退出码应透传')
  assert.ok(value.stages[1].output.includes('ran-after-failure'), '失败后仍应继续执行')
  assertLossless('ecs_deploy continue_on_error value', value)
})

await run('ecs_deploy steps: tail 等待退出码文件(wait_seconds)', async () => {
  const def = ecsDeployDefinition(ctx)
  const value = await def.execute(
    {
      instance_id: INSTANCE_ID,
      steps: [
        {
          kind: 'exec',
          description: '后台写日志',
          script: 'rm -f /tmp/dsh-e2e-wait.log /tmp/dsh-e2e-wait.exit\n' +
            "nohup sh -c 'sleep 4; echo late-line; echo 0 > /tmp/dsh-e2e-wait.exit' > /tmp/dsh-e2e-wait.log 2>&1 &\necho launched",
        },
        { kind: 'tail', path: '/tmp/dsh-e2e-wait.log', exit_file: '/tmp/dsh-e2e-wait.exit', wait_seconds: 30, description: '等待并读日志' },
      ],
    },
    makeExec('ecs_deploy'),
  )
  assert.equal(value.ok, true, '两步都应成功: ' + JSON.stringify(value.stages.map((s) => [s.name, s.ok, s.error])))
  const tail = value.stages[1]
  assert.ok(tail.output.includes('late-line'), '等待后应读到日志内容: ' + JSON.stringify(tail.output))
  assert.equal(tail.eof, true, '退出码文件出现后应标记 eof')
  assert.equal(tail.exit_code, 0)
  assertLossless('ecs_deploy tail wait value', value)
})

// ---- S4b: Runbook 机制(工作区文件 → 参数替换 → 展开执行) ----
const e2eRbRoot = mkdtempSync(join(tmpdir(), 'dsh-wbecs-e2e-rb-'))
const e2eRbDir = join(e2eRbRoot, '.dsh', 'workbench-ecs', 'runbooks')
mkdirSync(e2eRbDir, { recursive: true })
writeFileSync(join(e2eRbDir, 'e2e-smoke.json'), JSON.stringify({
  name: 'e2e-smoke',
  description: 'e2e runbook 机制验证(纯数据, 无项目逻辑)',
  params: { tag: 'default-tag', log: '/tmp/dsh-e2e-runbook.log' },
  steps: [
    {
      kind: 'exec',
      description: '写入标记 ${tag}',
      script: "printf 'rb-line-%s\\n' '${tag}' > ${log}\necho wrote-${tag}",
    },
    { kind: 'assert', command: 'cat ${log}', expect: { exit_code: 0, stdout_contains: ['rb-line-'], stdout_not_contains: ['CORRUPT'] } },
    { kind: 'tail', path: '${log}', description: '读回日志' },
  ],
}, null, 2))
const runbookCtx = makeCtx({ fs: nodeFsAdapter(e2eRbRoot), workspaceRoot: e2eRbRoot })

await run('ecs_deploy runbook: 工作区文件 + 参数替换 + 展开执行(S4b)', async () => {
  const def = ecsDeployDefinition(runbookCtx)
  const value = await def.execute(
    {
      instance_id: INSTANCE_ID,
      runbook: 'e2e-smoke',
      runbook_params: { tag: 'e2e' },
    },
    makeExec('ecs_deploy'),
  )
  assert.equal(value.mode, 'steps')
  assert.equal(value.total_stage, 3)
  assert.equal(value.ok, true, 'runbook 应执行成功: ' + JSON.stringify(value.stages.map((s) => [s.name, s.ok, s.error])))
  assert.equal(value.runbook.name, 'e2e-smoke')
  assert.equal(value.runbook.source, 'workspace')
  assert.ok(String(value.runbook.path).endsWith('e2e-smoke.json'), '应回报 runbook 文件路径: ' + value.runbook.path)
  assert.deepEqual(value.runbook.param_keys, ['tag'])
  assert.equal(value.runbook.unused_params, undefined, '只用了一个参数, 不应报未使用')
  // 参数替换: 步骤描述与命令里都应已替换
  assert.equal(value.stages[0].name, '写入标记 e2e')
  assert.ok(value.stages[0].output.includes('wrote-e2e'), '默认值应被调用方参数覆盖: ' + value.stages[0].output)
  assert.ok(!value.stages[0].output.includes('${'), '不得把未替换的占位符下发到远端')
  // 断言 + tail 步骤
  assert.ok(value.stages[1].assertions.every((a) => a.ok === true), JSON.stringify(value.stages[1].assertions))
  assert.ok(value.stages[2].output.includes('rb-line-e2e'), 'tail 应读到替换后参数写入的内容: ' + JSON.stringify(value.stages[2].output))
  assertLossless('ecs_deploy runbook value', value)
  assertLossless('ecs_deploy runbook presentationMeta', def.output.presentationMeta({}, value))
  const text = def.output.render({}, value)[0].text
  assert.ok(text.includes('runbook: e2e-smoke'), '渲染应标注 runbook: ' + text.slice(0, 200))
})

await run('ecs_deploy runbook: 默认参数生效 + dry_run 预演不执行', async () => {
  const def = ecsDeployDefinition(runbookCtx)
  // 不传 runbook_params: 应使用 runbook 里的默认值 tag=default-tag
  const preview = await def.execute(
    { instance_id: INSTANCE_ID, runbook: 'e2e-smoke', dry_run: true },
    makeExec('ecs_deploy'),
  )
  assert.equal(preview.dry_run, true)
  assert.equal(preview.plan.length, 3)
  assert.equal(preview.runbook.source, 'workspace')
  assert.equal(preview.runbook.param_keys, undefined, '未传参数时不应有 param_keys')
  const execDef = ecsExecDefinition(ctx)
  const check = await execDef.execute(
    { instance_id: INSTANCE_ID, command: 'cat /tmp/dsh-e2e-runbook.log 2>/dev/null || echo ABSENT' },
    makeExec('ecs_exec'),
  )
  assert.ok(check.output.includes('rb-line-e2e'), 'dry_run 不应改动远端日志内容(应仍是上一条用例写入的): ' + check.output)
  assertLossless('ecs_deploy runbook dry_run value', preview)
})

await run('ecs_deploy runbook: 名字不存在时报错并列出可用 runbook', async () => {
  const def = ecsDeployDefinition(runbookCtx)
  await assert.rejects(
    def.execute({ instance_id: INSTANCE_ID, runbook: 'no-such-runbook' }, makeExec('ecs_deploy')),
    /可用的 runbook: e2e-smoke/,
    '应把可用名字回给模型便于自我纠正',
  )
  await assert.rejects(
    def.execute({ instance_id: INSTANCE_ID, runbook: '../etc/passwd' }, makeExec('ecs_deploy')),
    /名字非法/,
    '路径穿越必须被拒绝',
  )
})

// ---- v0.6.2: 设置页面板路径(createSettingsCore + 真实 CLI) ----
// 面板侧与 Agent 侧共用 steps 引擎, 这里用真实实例验证"面板也能跑通",
// 并确认预演(dry_run)确实不触碰实例。
const panelCore = createSettingsCore(
  async (argv) => {
    const r = await runWorkbench(runbookCtx, argv, undefined)
    return { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr, stdoutTruncated: r.stdoutTruncated, stdoutSpillPath: r.stdoutSpillPath }
  },
  {
    runbookDir: join(e2eRbRoot, RUNBOOK_DIR),
    listRunbooks: async () => readdirSync(e2eRbDir).filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, '')).sort(),
    loadRunbook: async (name) => ({
      text: readFileSync(join(e2eRbDir, name + '.json'), 'utf8'),
      path: join(e2eRbDir, name + '.json'),
    }),
    makeStepsAdapter: (args) => ({
      run: async (argv) => {
        const r = await runWorkbench(runbookCtx, argv, undefined)
        return { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr, stdoutTruncated: r.stdoutTruncated, stdoutSpillPath: r.stdoutSpillPath }
      },
      localSha256: async (file) => await localSha256(runbookCtx, file, undefined),
      remoteSha256: async (remotePath, opts = {}) => await remoteSha256(runbookCtx, args.instance_id, remotePath,
        { region: args.region, timeout: opts.timeout, locked: true }),
      sleep: (ms) => delay(runbookCtx, ms),
      hasTimer: hasLocalTimer(runbookCtx),
    }),
  },
)

const panelLog = '/tmp/dsh-e2e-panel-runbook.log'
writeFileSync(join(e2eRbDir, 'panel-smoke.json'), JSON.stringify({
  name: 'panel-smoke',
  description: '设置页面板路径验证',
  params: { tag: 'panel-default', log: panelLog },
  steps: [
    { kind: 'exec', description: '写入 ${tag}', script: "printf 'panel-%s\\n' '${tag}' > ${log}\necho panel-wrote-${tag}" },
    { kind: 'assert', command: 'cat ${log}', expect: { exit_code: 0, stdout_contains: ['panel-'] } },
  ],
}, null, 2))
writeFileSync(join(e2eRbDir, 'panel-danger.json'), JSON.stringify({
  name: 'panel-danger',
  steps: [{ kind: 'exec', command: 'rm -rf /tmp/dsh-e2e-never' }],
}, null, 2))

await run('设置页 runbook-list: 真实工作区扫描(含坏文件不炸)', async () => {
  writeFileSync(join(e2eRbDir, 'panel-broken.json'), '{ broken json }')
  const res = await panelCore.runbookList()
  assert.equal(res.ok, true)
  assert.ok(res.dir.replace(/\\/g, '/').endsWith(RUNBOOK_DIR), '应回报 runbook 目录: ' + res.dir)
  const names = res.runbooks.map((r) => r.name)
  assert.ok(names.includes('e2e-smoke') && names.includes('panel-smoke'), '应列出工作区 runbook: ' + names.join(','))
  assert.equal(res.runbooks.find((r) => r.name === 'panel-broken').valid, false, '坏文件应标为无效')
  const smoke = res.runbooks.find((r) => r.name === 'panel-smoke')
  assert.equal(smoke.valid, true)
  assert.deepEqual(smoke.declared_params, ['log', 'tag'])
  assertLossless('runbook-list result', res)
})

await run('设置页 runbook-plan: 预演不触碰实例', async () => {
  const before = await ecsExecDefinition(runbookCtx).execute(
    { instance_id: INSTANCE_ID, command: 'cat ' + panelLog + ' 2>/dev/null || echo ABSENT' },
    makeExec('ecs_exec'),
  )
  const plan = await panelCore.runbookPlan({ instance_id: INSTANCE_ID, runbook: 'panel-smoke', region: REGION })
  assert.equal(plan.ok, true, JSON.stringify(plan))
  assert.equal(plan.dry_run, true)
  assert.equal(plan.total_stage, 2)
  assert.ok(plan.plan[0].command_line.includes('<script'), '脚本步骤在计划里不应内联正文: ' + plan.plan[0].command_line)
  const after = await ecsExecDefinition(runbookCtx).execute(
    { instance_id: INSTANCE_ID, command: 'cat ' + panelLog + ' 2>/dev/null || echo ABSENT' },
    makeExec('ecs_exec'),
  )
  assert.equal(after.output, before.output, '预演不得改动远端文件内容')
  assertLossless('runbook-plan value', plan)
})

await run('设置页 runbook-run: 面板侧真实执行(与工具同一引擎)', async () => {
  const res = await panelCore.runbookRun({
    instance_id: INSTANCE_ID, runbook: 'panel-smoke', params: { tag: 'panel-live' }, region: REGION,
  })
  assert.equal(res.ok, true, '面板侧执行应成功: ' + JSON.stringify(res.stages.map((s) => [s.name, s.ok, s.error])))
  assert.equal(res.mode, 'steps')
  assert.equal(res.total_stage, 2)
  assert.equal(res.stages[0].name, '写入 panel-live', '参数应已替换')
  assert.ok(String(res.stages[0].output).includes('panel-wrote-panel-live'), res.stages[0].output)
  assert.ok(res.stages[1].assertions.every((a) => a.ok === true), JSON.stringify(res.stages[1].assertions))
  assert.equal(res.runbook.name, 'panel-smoke')
  assert.equal(res.runbook.source, 'workspace')
  assertLossless('runbook-run value', res)
})

await run('设置页 runbook-run: 破坏性命令被直接拒绝(面板无审批上下文)', async () => {
  const res = await panelCore.runbookRun({ instance_id: INSTANCE_ID, runbook: 'panel-danger', region: REGION })
  assert.equal(res.ok, false)
  assert.match(String(res.error), /已拦截破坏性命令/)
  const probe = await ecsExecDefinition(runbookCtx).execute(
    { instance_id: INSTANCE_ID, command: 'test -e /tmp/dsh-e2e-never && echo EXISTS || echo ABSENT' },
    makeExec('ecs_exec'),
  )
  assert.ok(probe.output.includes('ABSENT'), '被拒的 runbook 不得在远端留下任何痕迹')
})

await run('ecs_runbook: 工作区清点 + 静态校验 + 预演(全程零远程调用)', async () => {
  writeFileSync(join(e2eRbDir, 'lint-typo.json'), JSON.stringify({
    name: 'lint-typo',
    params: { sha: 'latest' },
    steps: [
      { kind: 'exec', command: 'echo ${sha}', commnad: '这是字段笔误' },
      { kind: 'assert', command: 'curl -fsS http://127.0.0.1/health', expect: {} },
      { kind: 'tail', path: '/tmp/lint.log' },
    ],
  }, null, 2))
  const def = ecsRunbookDefinition(runbookCtx)
  const exec = makeExec('ecs_runbook')

  const list = await def.execute({ action: 'list' }, exec)
  assert.equal(list.action, 'list')
  assert.ok(list.count >= 3, '应列出工作区全部 runbook, 实际 ' + list.count)
  assert.ok(String(list.dir).replace(/\\/g, '/').endsWith(RUNBOOK_DIR), list.dir)
  const entry = list.runbooks.find((r) => r.name === 'lint-typo')
  assert.equal(entry.ok, true, '只有提醒时仍算通过: ' + entry.first_issue)
  assert.ok(entry.warn_count >= 3, '应有若干提醒: ' + JSON.stringify(entry))
  assert.ok(list.runbooks.find((r) => r.name === 'panel-broken').ok === false, '坏文件应标为不通过')
  assertLossless('ecs_runbook list', list)

  const report = await def.execute({ action: 'validate', runbook: 'lint-typo' }, exec)
  assert.equal(report.action, 'validate')
  const codes = report.issues.map((i) => i.code)
  assert.ok(codes.includes('unknown_field'), '应认出字段笔误: ' + codes.join(','))
  assert.ok(codes.includes('weak_assert'))
  assert.ok(codes.includes('tail_once'))
  assertLossless('ecs_runbook validate', report)
  const reportText = def.output.render({}, report)[0].text
  assert.ok(reportText.includes('是否想写 command'), reportText.slice(0, 300))

  const plan = await def.execute({ action: 'plan', runbook: 'e2e-smoke', runbook_params: { tag: 'lint' }, instance_id: INSTANCE_ID }, exec)
  assert.equal(plan.ok, true, JSON.stringify(plan.issues))
  assert.equal(plan.total_stage, 3)
  assert.ok(plan.plan[0].command_line.includes('<script'), '脚本步骤不应内联正文: ' + plan.plan[0].command_line)
  assert.equal(plan.plan[0].timeout, 180, '应回报默认超时')
  assert.ok(String(plan.command_line).includes('预演不执行任何命令'))
  assertLossless('ecs_runbook plan', plan)
  assertLossless('ecs_runbook presentationMeta', def.output.presentationMeta({}, plan))
  assertLossless('ecs_runbook presentCall', def.presentCall({ action: 'plan', runbook: 'e2e-smoke' }))
})

await run('D11: 跑书目录取会话工作区(而非部署兜底), 面板 dir 覆盖同样生效', async () => {
  // ctx 的 sandboxPolicy 指向"部署兜底"(故意指向一个空的 runbook 目录),
  // 靠 exec.agent.session.header.cwd 指到真实工作区 —— 正是 D11 修复的行为。
  const misleading = mkdtempSync(join(tmpdir(), 'dsh-wbecs-e2e-fallback-'))
  mkdirSync(join(misleading, '.dsh', 'workbench-ecs', 'runbooks'), { recursive: true })
  const ctxFallback = makeCtx({ fs: nodeFsAdapter(e2eRbRoot), workspaceRoot: misleading })
  const execWithSession = {
    name: 'ecs_runbook',
    signal: new AbortController().signal,
    agent: { session: { header: { cwd: e2eRbRoot } } },
  }
  const def = ecsRunbookDefinition(ctxFallback)
  const bySession = await def.execute({ action: 'list' }, execWithSession)
  assert.ok(bySession.count >= 3, '应按会话工作区找到跑书: ' + JSON.stringify(bySession.runbooks.map((r) => r.name)))
  assert.ok(String(bySession.dir).replace(/\\/g, '/').startsWith(e2eRbRoot.replace(/\\/g, '/')),
    '目录应来自会话工作区: ' + bySession.dir)
  const withoutSession = await def.execute({ action: 'list' }, makeExec('ecs_runbook'))
  assert.equal(withoutSession.count, 0, '无会话时应回落部署兜底(那个目录是空的)')
  // 面板侧: 显式 dir 覆盖(设置页没有会话上下文时的逃生门)
  const coreWithDir = createSettingsCore(async () => ({ exitCode: 0, stdout: '{}', stderr: '' }), {
    runbookDirOf: (args) => String(args.dir),
    listRunbooks: async (args) => readdirSync(args.dir).filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, '')),
    loadRunbook: async (name, args) => ({ text: readFileSync(join(args.dir, name + '.json'), 'utf8'), path: join(args.dir, name + '.json') }),
  })
  const overridden = await coreWithDir.runbookList({ dir: e2eRbDir })
  assert.ok(overridden.ok === true && overridden.runbooks.length >= 3, JSON.stringify(overridden).slice(0, 200))
  assert.ok(String(overridden.dir).replace(/\\/g, '/').endsWith('.dsh/workbench-ecs/runbooks'), overridden.dir)
})

// ============================================================================
// v0.7.0 —— 真机核对: F1 跨地域 / D14 超时结算 / A1 实例锚点 / D1 sections /
//          L1 多路径 / S1 校验默认值 / G1 护栏拒绝信息
// ============================================================================
console.log('')
console.log('== v0.7.0 新增能力(真机) ==')

await run('F1: ecs_find 跨地域找到目标实例(内置地域清单)', async () => {
  const def = ecsFindDefinition(ctx)
  const value = await def.execute({ keyword: INSTANCE_ID.slice(0, 10), concurrency: 6 }, makeExec('ecs_find'))
  assert.ok(value.regions_tried.length >= 10, '应检索内置地域清单: ' + value.regions_tried.length)
  assert.ok(value.regions_ok >= 5, '大部分地域应查询成功: ' + value.regions_ok)
  const hit = value.hits.find((h) => h.region === REGION)
  assert.ok(hit !== undefined, '应在 ' + REGION + ' 命中: ' + JSON.stringify(value.hits.map((h) => h.region)))
  assert.ok(hit.instances.some((it) => it.instance_id === INSTANCE_ID), '命中实例应为 ' + INSTANCE_ID)
  assert.ok(value.scanned >= 1)
  assertLossless('ecs_find value', value)
  assertLossless('ecs_find presentationMeta', def.output.presentationMeta({}, value))
  // 只按关键词过滤: 不存在的关键词应为 0 台(而不是把全部实例倒出来)
  const miss = await def.execute({ keyword: 'no-such-instance-xyz', region: REGION }, makeExec('ecs_find'))
  assert.equal(miss.total, 0, '不匹配的关键词应为 0 台')
})

await run('F1: ecs_list 0 台时给出 ecs_find 指引', async () => {
  const def = ecsListDefinition(ctx)
  const value = await def.execute({ region: 'cn-hangzhou', instance_name: 'dsh-no-such-instance-*' }, makeExec('ecs_list'))
  assert.equal(value.count, 0)
  assert.ok(String(value.empty_hint).includes('ecs_find'), '实际: ' + value.empty_hint)
})

await run('D14: 远端超时按 124 结算(不再显示成功 + 无输出)', async () => {
  const def = ecsExecDefinition(ctx)
  const value = await def.execute(
    { instance_id: INSTANCE_ID, command: 'sleep 8; echo done-late', timeout: 3, description: 'e2e 超时结算' },
    makeExec('ecs_exec'),
  )
  assert.equal(value.timed_out, true, '应标记超时: ' + JSON.stringify(value))
  assert.equal(value.exit_code, REMOTE_TIMEOUT_EXIT_CODE, '超时必须结算为 124(此前是 0)')
  assert.ok(value.duration !== undefined, '应带上实际耗时')
  const text = def.output.render({}, value)[0].text
  assert.ok(text.includes('远端命令被 CLI 掐断'), text)
  assert.ok(text.includes('detach=true'), '必须给出 detach 这条下一步: ' + text)
  assertLossless('ecs_exec timeout value', value)
  // 反例: 正常命令不应被标记超时
  const okValue = await def.execute({ instance_id: INSTANCE_ID, command: 'echo ontime' }, makeExec('ecs_exec'))
  assert.equal(okValue.timed_out, undefined)
  assert.equal(okValue.exit_code, 0)
})

await run('A1: 实例锚点(instance_id 写锚点名 + region 自动补齐 + 字段进 runbook 隐式参数)', async () => {
  // 锚点文件写在真实工作区(临时目录), 通过 apply 注册的工具执行 —— 覆盖工具注册边界
  const root = mkdtempSync(join(tmpdir(), 'dsh-wbecs-e2e-anchor-'))
  mkdirSync(join(root, '.dsh', 'workbench-ecs'), { recursive: true })
  writeFileSync(join(root, '.dsh', 'workbench-ecs', 'instances.json'), JSON.stringify({
    prod: { instance_id: INSTANCE_ID, region: REGION, repo: '/root/nailonghub' },
  }))
  const captured = []
  const applyCtx = {
    tools: { register(def) { captured.push(def); return () => {} } },
    webServer: undefined,
    effect(fn) { return fn() },
    get(name) {
      if (name === 'subprocess') return fakeSubprocess
      if (name === 'fs') return nodeFsAdapter(root)
      if (name === 'sandboxPolicy') return { workspaceRoot: root }
      return undefined
    },
  }
  apply(applyCtx)
  const execDef = captured.find((d) => d.name === 'ecs_exec')
  assert.ok(execDef !== undefined, 'apply 应注册 ecs_exec')
  const withSession = {
    name: 'ecs_exec',
    signal: new AbortController().signal,
    agent: { session: { header: { cwd: root } } },
  }
  const value = await execDef.execute({ instance_id: 'prod', command: 'echo anchor-ok && uname -s' }, withSession)
  assert.equal(value.exit_code, 0, JSON.stringify(value))
  assert.ok(String(value.output).includes('anchor-ok'), '锚点名应被解析成真实实例: ' + value.output)
  assertLossless('ecs_exec via anchor', value)

  // 锚点字段成为 runbook 隐式参数: ${repo} 不需显式传参
  const deployDef = captured.find((d) => d.name === 'ecs_deploy')
  const runbook = {
    name: 'anchor-implicit',
    steps: [
      {
        kind: 'assert',
        command: 'test "${repo}" = "/root/nailonghub" && echo repo-ok',
        expect: { stdout_contains: ['repo-ok'] },
      },
    ],
  }
  const deployed = await deployDef.execute({ instance_id: 'prod', runbook }, withSession)
  assert.equal(deployed.ok, true, JSON.stringify(deployed.stages))
  assert.equal(deployed.stages[0].ok, true)
  assert.equal(deployed.runbook.declared_params.includes('repo'), true, 'runbook 应声明 ${repo}: ' + JSON.stringify(deployed.runbook))

  // 锚点名写错 → 列出可用锚点(而不是把错名字丢给 CLI)
  await assert.rejects(
    () => execDef.execute({ instance_id: 'prodd', command: 'echo x' }, withSession),
    /prod/,
    '锚点名写错应给出可用锚点',
  )
})

await run('D1: ecs_diagnose 按需取段 + 默认不回显命令全文', async () => {
  const def = ecsDiagnoseDefinition(ctx)
  const value = await def.execute(
    { instance_id: INSTANCE_ID, sections: ['disk', 'ports'], description: 'e2e 体检子集' },
    makeExec('ecs_diagnose'),
  )
  assert.equal(value.exit_code, 0, JSON.stringify(value).slice(0, 300))
  assert.deepEqual(value.sections, ['disk', 'ports'])
  assert.ok(value.output.includes('4/7 磁盘'), '应采集磁盘段: ' + value.output.slice(0, 200))
  assert.ok(value.output.includes('7/7 监听端口'), '应采集端口段')
  assert.ok(!value.output.includes('1/7 主机信息'), '未选段落不应出现: ' + value.output.slice(0, 200))
  const text = def.output.render({}, value)[0].text
  assert.ok(!text.includes('$ ' + value.command), '默认不应回显整段命令')
  assert.ok(text.includes('[采集段落: disk, ports]'), text.slice(0, 200))
})

await run('L1: ecs_log 一次读多文件(各自游标)', async () => {
  const exec = makeExec('ecs_exec')
  await ecsExecDefinition(ctx).execute({
    instance_id: INSTANCE_ID,
    command: 'printf "alpha\\n" > /tmp/dsh-e2e-multi-a.log; printf "bravo\\n" > /tmp/dsh-e2e-multi-b.log',
  }, exec)
  const def = ecsLogDefinition(ctx)
  const value = await def.execute(
    { instance_id: INSTANCE_ID, paths: ['/tmp/dsh-e2e-multi-a.log', '/tmp/dsh-e2e-multi-b.log'], after: 0 },
    makeExec('ecs_log'),
  )
  assert.equal(value.mode, 'multi')
  assert.equal(value.files.length, 2)
  assert.ok(value.files[0].text.includes('alpha'), JSON.stringify(value.files[0]))
  assert.ok(value.files[1].text.includes('bravo'), JSON.stringify(value.files[1]))
  assert.equal(value.files[0].eof, true, '文件已读完')
  // 续读: 游标到底后再读应为空且游标不倒退
  const again = await def.execute(
    { instance_id: INSTANCE_ID, paths: ['/tmp/dsh-e2e-multi-a.log'], after: { '/tmp/dsh-e2e-multi-a.log': value.files[0].next_offset } },
    makeExec('ecs_log'),
  )
  assert.equal(again.files[0].text, '')
  assert.equal(again.files[0].next_offset, value.files[0].next_offset)
  assertLossless('ecs_log multi value', value)
})

await run('S1: ecs_upload 不传 verify_sha256 时也默认校验', async () => {
  const uploadFile = join(tmpDir, 'e2e-default-verify.txt')
  writeFileSync(uploadFile, 'default-verify\n')
  const def = ecsUploadDefinition(ctx)
  const value = await def.execute(
    { local_file: uploadFile, remote_path: '/tmp/dsh-e2e-default-verify.txt', instance_id: INSTANCE_ID, force: true },
    makeExec('ecs_upload'),
  )
  assert.equal(value.exit_code, 0, JSON.stringify(value).slice(0, 300))
  assert.equal(value.verification, 'ok', '不传 verify_sha256 也必须校验: ' + JSON.stringify(value))
  assert.equal(value.verify_sha256, true)
  assert.ok(value.attempts === 1, '首次成功不应重试: ' + value.attempts)
  assertLossless('ecs_upload default verify', value)
})

await run('G1: 只读护栏拒绝信息逐条给出规则/命中文本/位置与替代写法(真机只读路径)', async () => {
  const def = ecsExecDefinition(ctx)
  let err
  try {
    await def.execute({
      instance_id: INSTANCE_ID,
      script: 'mkdir -p /tmp/dsh-e2e-ro && docker images > /tmp/dsh-e2e-ro/images.txt && curl -o /tmp/x.tar.gz https://example.com/x.tar.gz',
      read_only: true,
    }, makeExec('ecs_exec'))
  } catch (e) {
    err = e
  }
  assert.ok(err !== undefined, '写操作必须被只读护栏拒绝')
  const text = String(err.message)
  assert.ok(text.includes('[1]') && text.includes('[2]') && text.includes('[3]'), '应逐条列出命中: ' + text)
  assert.ok(text.includes('位置'), text)
  assert.ok(text.includes('只读等价写法建议'), text)
  // 确认远端确实没被改动(护栏是拒绝执行, 不是"执行后报错")
  const check = await ecsExecDefinition(ctx).execute({
    instance_id: INSTANCE_ID, command: 'test -e /tmp/dsh-e2e-ro && echo EXISTS || echo ABSENT',
  }, makeExec('ecs_exec'))
  assert.equal(String(check.output).trim(), 'ABSENT', '被拒绝的脚本不得留下任何痕迹')
})

// ============================================================================
// v0.8.0 —— 真机核对: P1 参数契约 / P2 raw / P3 from_step + 重跑建议 / N1 快照
// ============================================================================
console.log('')
console.log('== v0.8.0 新增能力(真机) ==')

await run('P1: 参数契约在 validate/plan 阶段拦住, 执行期同一文案', async () => {
  const rbDir = mkdtempSync(join(tmpdir(), 'dsh-wbecs-e2e-params-'))
  mkdirSync(join(rbDir, '.dsh', 'workbench-ecs', 'runbooks'), { recursive: true })
  writeFileSync(join(rbDir, '.dsh', 'workbench-ecs', 'runbooks', 'strict.json'), JSON.stringify({
    name: 'strict',
    description: '参数契约演示',
    params: {
      sha: { required: true, pattern: '^[0-9a-f]{7,40}$', hint: 'git rev-parse --short HEAD' },
      env: { default: 'prod', enum: ['prod', 'staging'] },
    },
    // 只用 sha(env 有默认值, 故意不引用以免 unused 提醒干扰断言)
    steps: [{ kind: 'assert', command: 'test "${sha}" != "" && echo sha-ok', expect: { stdout_contains: ['sha-ok'] } }],
  }))
  const ctxRb = makeCtx({ fs: nodeFsAdapter(rbDir), workspaceRoot: rbDir })
  const exec = { name: 'ecs_runbook', signal: new AbortController().signal, agent: { session: { header: { cwd: rbDir } } } }
  const def = ecsRunbookDefinition(ctxRb)

  // 缺必填 → validate 就报错(还没下发任何命令)
  const missing = await def.execute({ action: 'validate', runbook: 'strict' }, exec)
  assert.equal(missing.ok, false)
  assert.ok(missing.issues.some((i) => i.code === 'param_required'), JSON.stringify(missing.issues))
  assert.ok(missing.issues.find((i) => i.code === 'param_required').message.includes('git rev-parse'), '应带 hint')
  assert.ok(missing.param_specs.sha.required === true, '报告里应看到参数契约')
  const missingText = def.output.render({}, missing)[0].text
  assert.ok(missingText.includes('参数契约'), missingText.slice(0, 400))

  // pattern 不匹配 → 也拦住
  const bad = await def.execute({ action: 'validate', runbook: 'strict', runbook_params: { sha: 'NOT-HEX' } }, exec)
  assert.equal(bad.ok, false)
  assert.ok(bad.issues.some((i) => i.code === 'param_pattern'))

  // 合法参数 → 通过, 并能给出计划与重跑建议
  const okPlan = await def.execute({
    action: 'plan', runbook: 'strict', runbook_params: { sha: 'abc1234' }, instance_id: INSTANCE_ID, region: REGION,
  }, exec)
  assert.equal(okPlan.ok, true, JSON.stringify(okPlan.issues))
  assert.ok(okPlan.replay !== undefined, 'plan 应带重跑建议')
  assertLossless('ecs_runbook plan(v0.8.0)', okPlan)

  // 执行期同一套校验: 缺参数时 ecs_deploy 直接拒绝
  const deployDef = ecsDeployDefinition(ctxRb)
  await assert.rejects(
    () => deployDef.execute({ instance_id: INSTANCE_ID, runbook: 'strict' },
      { name: 'ecs_deploy', signal: new AbortController().signal, agent: { session: { header: { cwd: rbDir } } } }),
    /缺少参数|参数不合法/,
  )
  // 合法参数 → 真机跑通
  const deployed = await deployDef.execute(
    { instance_id: INSTANCE_ID, runbook: 'strict', runbook_params: { sha: 'abc1234' } },
    { name: 'ecs_deploy', signal: new AbortController().signal, agent: { session: { header: { cwd: rbDir } } } },
  )
  assert.equal(deployed.ok, true, JSON.stringify(deployed.stages))
  assert.equal(deployed.runbook.param_specs.sha.required, true)
  assertLossless('ecs_deploy runbook(param specs)', deployed)
})

await run('P2: raw: true 步骤的 ${VAR} 原样下发到远端', async () => {
  const def = ecsDeployDefinition(ctx)
  const value = await def.execute({
    instance_id: INSTANCE_ID,
    steps: [
      // raw: true → ${DSH_RAW_PROBE} 不被插件替换, 由远端 shell 展开
      { raw: true, description: 'e2e raw 步骤', command: 'DSH_RAW_PROBE=raw-ok; echo "value=${DSH_RAW_PROBE}"' },
      { kind: 'assert', command: 'echo placeholder-check', expect: { stdout_contains: ['placeholder-check'] } },
    ],
  }, makeExec('ecs_deploy'))
  assert.equal(value.ok, true, JSON.stringify(value.stages))
  assert.ok(String(value.stages[0].output).includes('value=raw-ok'), '远端应把 ${DSH_RAW_PROBE} 展开: ' + value.stages[0].output)
  assert.ok(!String(value.stages[0].output).includes('${DSH_RAW_PROBE}'), '不应残留未展开的占位符')
})

await run('P3: from_step 从指定步骤继续(真机只执行剩余步骤)', async () => {
  const def = ecsDeployDefinition(ctx)
  const marker = '/tmp/dsh-e2e-from-step'
  const value = await def.execute({
    instance_id: INSTANCE_ID,
    from_step: 2,
    steps: [
      { command: 'echo should-not-run > ' + marker },
      { command: 'echo should-not-run-2 > ' + marker + '2' },
      { command: 'echo from-step-ran > ' + marker + '-3' },
      { kind: 'assert', command: 'cat ' + marker + '-3', expect: { stdout_contains: ['from-step-ran'] } },
    ],
  }, makeExec('ecs_deploy'))
  assert.equal(value.ok, true, JSON.stringify(value.stages))
  assert.deepEqual(value.skipped_prefix, [0, 1])
  assert.equal(value.from_step, 2)
  assert.equal(value.stages[0].skipped, true)
  assert.equal(value.stages[0].skipped_prefix, true)
  const text = def.output.render({}, value)[0].text
  assert.ok(text.includes('已跳过 [0][1]'), text)
  // 远端核对: 被跳过的步骤确实没执行
  const check = await ecsExecDefinition(ctx).execute({
    instance_id: INSTANCE_ID,
    command: 'test -e ' + marker + ' && echo EXISTS || echo ABSENT; test -e ' + marker + '2 && echo EXISTS2 || echo ABSENT2',
  }, makeExec('ecs_exec'))
  assert.ok(String(check.output).includes('ABSENT'), '第 0 步不得执行: ' + check.output)
  assert.ok(String(check.output).includes('ABSENT2'), '第 1 步不得执行: ' + check.output)
})

await run('N1: ecs_snapshot create -> diff(真机采集, 工作区清单)', async () => {
  const snapRoot = mkdtempSync(join(tmpdir(), 'dsh-wbecs-e2e-snap-'))
  const ctxSnap = makeCtx({ fs: nodeFsAdapter(snapRoot), workspaceRoot: snapRoot })
  const exec = { name: 'ecs_snapshot', signal: new AbortController().signal, agent: { session: { header: { cwd: snapRoot } } } }
  const def = ecsSnapshotDefinition(ctxSnap)

  // 先放一个受控文件, 让快照有可核对的关键文件
  await ecsExecDefinition(ctx).execute({
    instance_id: INSTANCE_ID, command: 'mkdir -p /tmp/dsh-e2e-snap && echo v1 > /tmp/dsh-e2e-snap/config.txt',
  }, makeExec('ecs_exec'))

  const created = await def.execute({
    action: 'create',
    name: 'e2e-pre',
    instance_id: INSTANCE_ID,
    region: REGION,
    note: 'e2e 快照',
    paths: ['/tmp/dsh-e2e-snap/config.txt'],
    collectors: ['host'],
  }, exec)
  assert.equal(created.ok, true, JSON.stringify(created))
  assert.equal(created.file_count, 1)
  assert.equal(created.files_summary[0].status, 'file')
  assert.ok(String(created.files_summary[0].sha256).length === 64, '关键文件应有真实 sha256: ' + JSON.stringify(created.files_summary))
  assert.ok(created.path.replace(/\\/g, '/').includes('.dsh/workbench-ecs/snapshots/e2e-pre.json'))
  assertLossless('ecs_snapshot create(真机)', created)
  assertLossless('ecs_snapshot presentCall', def.presentCall({ action: 'create', name: 'e2e-pre', instance_id: INSTANCE_ID }))

  const listed = await def.execute({ action: 'list' }, exec)
  assert.equal(listed.count, 1)
  assert.ok(String(listed.command_line).includes('未调用任何 CLI 命令'), 'list 必须零远程调用')

  // 未改动 → clean
  const clean = await def.execute({ action: 'diff', name: 'e2e-pre' }, exec)
  assert.equal(clean.clean, true, JSON.stringify(clean.files))

  // 改动远端 → diff 必须检出
  await ecsExecDefinition(ctx).execute({
    instance_id: INSTANCE_ID, command: 'echo v2-changed > /tmp/dsh-e2e-snap/config.txt',
  }, makeExec('ecs_exec'))
  const changed = await def.execute({ action: 'diff', name: 'e2e-pre' }, exec)
  assert.equal(changed.clean, false)
  assert.equal(changed.files_changed, 1)
  assert.equal(changed.files[0].status, 'changed')
  const changedText = def.output.render({}, changed)[0].text
  assert.ok(changedText.includes('/tmp/dsh-e2e-snap/config.txt'), changedText)
  assertLossless('ecs_snapshot diff(真机)', changed)

  // 文件消失 → removed
  await ecsExecDefinition(ctx).execute({
    instance_id: INSTANCE_ID, command: 'rm -f /tmp/dsh-e2e-snap/config.txt',
  }, makeExec('ecs_exec'))
  const removed = await def.execute({ action: 'diff', name: 'e2e-pre' }, exec)
  assert.equal(removed.files[0].status, 'removed', JSON.stringify(removed.files))
})

console.log('')
console.log('== 结果: ' + passed + ' 通过, ' + failed + ' 失败 ==')
process.exit(failed > 0 ? 1 : 0)