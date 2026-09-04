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
  const value = await def.execute({ region: REGION }, makeExec('ecs_list'))
  assert.ok(Array.isArray(value.instances), 'instances 应为数组')
  assert.ok(value.count >= 1, 'cn-shanghai 至少 1 台实例')
})

await run('ecs_exec 单实例(真实命令)', async () => {
  const def = ecsExecDefinition(ctx)
  const value = await def.execute(
    { instance_id: INSTANCE_ID, command: 'echo e2e-ok-123 && uname -s' },
    makeExec('ecs_exec'),
  )
  assert.equal(value.kind, 'single')
  assert.ok(value.output.includes('e2e-ok-123'), '输出应包含 e2e-ok-123')
  assert.equal(value.exit_code, 0)
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
  const done = await jobRun.done
  const out = jobRun.readOutput()
  assert.ok(out.includes('bg-ok'), '后台输出应包含 bg-ok')
  assert.equal(done.exitCode, 0)
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
})

await run('ecs_download(真实下载并校验内容)', async () => {
  const def = ecsDownloadDefinition(ctx)
  const value = await def.execute(
    { remote_path: '/tmp/dsh-e2e-upload.txt', local_path: tmpDir, instance_id: INSTANCE_ID, force: true },
    makeExec('ecs_download'),
  )
  assert.equal(value.exit_code, 0, '下载应成功')
  const saved = readFileSync(join(tmpDir, 'dsh-e2e-upload.txt'), 'utf8')
  assert.ok(saved.includes('hello-from-dsh-e2e'), '下载内容应一致')
})

await run('ecs_diagnose(一键体检)', async () => {
  const def = ecsDiagnoseDefinition(ctx)
  const value = await def.execute({ instance_id: INSTANCE_ID }, makeExec('ecs_diagnose'))
  assert.equal(value.exit_code, 0)
  assert.ok(value.output.includes('1/7') || value.output.includes('主机信息'), '体检输出应含分段标记')
  assert.ok(value.output.includes('docker') || value.output.includes('systemctl'), '体检输出应含服务段')
})

await run('ecs_session list', async () => {
  const def = ecsSessionDefinition(ctx)
  const value = await def.execute({ action: 'list' }, makeExec('ecs_session'))
  assert.equal(value.exit_code, 0)
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
})

console.log('')
console.log('== 结果: ' + passed + ' 通过, ' + failed + ' 失败 ==')
process.exit(failed > 0 ? 1 : 0)
