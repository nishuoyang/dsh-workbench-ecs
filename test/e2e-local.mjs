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
import { writeFileSync, readFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert'
import { isJsonValue } from '@deepseek-ai/dsh-session'

import { ecsListDefinition } from '../lib/tools/ecs-list.js'
import { ecsExecDefinition } from '../lib/tools/ecs-exec.js'
import { ecsUploadDefinition } from '../lib/tools/ecs-upload.js'
import { ecsDownloadDefinition } from '../lib/tools/ecs-download.js'
import { ecsDiagnoseDefinition } from '../lib/tools/ecs-diagnose.js'
import { ecsDeployDefinition } from '../lib/tools/ecs-deploy.js'
import { ecsSessionDefinition } from '../lib/tools/ecs-session.js'

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
    throw new Error('unresolved: ' + name)
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
      if (name === 'sandboxPolicy') return { workspaceRoot: process.cwd() }
      if (name === 'approval') return overrides.approval
      if (name === 'jobs') return overrides.jobs
      return undefined
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
  assertLossless('ecs_exec single value', value)
  assertLossless('ecs_exec single presentationMeta', def.output.presentationMeta(args, value))
  assertLossless('ecs_exec single presentCall', def.presentCall(args))
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

const tmpDir = mkdtempSync(join(tmpdir(), 'dsh-wbecs-e2e-'))
const localFile = join(tmpDir, 'e2e-upload.txt')
writeFileSync(localFile, 'hello-from-dsh-e2e\n')

await run('ecs_upload(真实上传)', async () => {
  const def = ecsUploadDefinition(ctx)
  const value = await def.execute(
    { local_file: localFile, remote_path: '/tmp/dsh-e2e-upload.txt', instance_id: INSTANCE_ID, force: true },
    makeExec('ecs_upload'),
  )
  assert.equal(value.exit_code, 0, '上传应成功')
  assertLossless('ecs_upload value', value)
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
  assertLossless('ecs_diagnose value', value)
  assertLossless('ecs_diagnose presentationMeta', def.output.presentationMeta({}, value))
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
  assertLossless('ecs_deploy value', value)
  assertLossless('ecs_deploy presentationMeta', def.output.presentationMeta({}, value))
  assertLossless('ecs_deploy presentCall', def.presentCall({ instance_id: INSTANCE_ID, command: 'echo x' }))
})

console.log('')
console.log('== 结果: ' + passed + ' 通过, ' + failed + ' 失败 ==')
process.exit(failed > 0 ? 1 : 0)
