// ============================================================================
// test/unit.mjs —— 不触达实例的单元回归(v0.4.0+)
// ----------------------------------------------------------------------------
// 覆盖: S1 脚本直送(base64/字节校验/两级投递)、S6 只读护栏(含诊断脚本零误杀)、
//       D1 超时默认值、输出清洗、sha256 本地/远端链路、路径与引用工具。
// 运行: node test/unit.mjs
// ============================================================================
import assert from 'node:assert'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, isAbsolute, normalize } from 'node:path'

import {
  base64Encode, utf8ByteLength, cleanOutput, shellQuote, baseName, remoteJoin,
  checkWriteCommand, guardReadOnly, resolveTimeout, buildScriptDelivery,
  localSha256, remoteSha256, SCRIPT_INLINE_LIMIT_BYTES, resolveWorkspaceRoot, sessionOf,
  buildLogReadCommand, parseLogRead, buildDetachLaunch, parseDetachPid, hasLocalTimer, delay,
  splitLocalPath, buildTarCreateArgv, buildArchiveExtractScript, parseArchiveEntries,
  runWithConcurrency,
  scanWriteCommands, inspectReadOnly, guardDestructiveCommand, remoteResultOf, timeoutAdvice,
  classifyTransientFailure, withRetry, resolveRetryOptions, looseOutcomeOf, uploadFailureAdvice,
  REMOTE_TIMEOUT_EXIT_CODE,
} from '../lib/common.js'
import {
  ECS_PUBLIC_REGIONS, parseRegionSpec, matchInstanceKeyword, buildListEcsArgv, listInstancesInRegion, searchInstances,
} from '../lib/regions.js'
import {
  INSTANCES_FILE, loadAnchors, resolveAnchorsInArgs, anchorInfoOf, anchorImplicitParams, isInstanceIdLike, isAnchorNameLike,
} from '../lib/anchors.js'
import { buildDiagnoseScript, resolveDiagnoseSections, DIAGNOSE_SECTIONS, ecsDiagnoseDefinition } from '../lib/tools/ecs-diagnose.js'
import { buildSessionScript, extractSessionCwd, ecsExecDefinition } from '../lib/tools/ecs-exec.js'
import { ecsUploadDefinition } from '../lib/tools/ecs-upload.js'
import { ecsListDefinition } from '../lib/tools/ecs-list.js'
import { ecsFindDefinition } from '../lib/tools/ecs-find.js'
import { ecsLogDefinition, buildMultiLogReadCommand, splitLogSegments, resolveLogPaths, resolveAfter } from '../lib/tools/ecs-log.js'
import { ecsDeployDefinition } from '../lib/tools/ecs-deploy.js'
import { createSettingsCore } from '../lib/settings-api.js'
import {
  isValidRunbookName, substituteParams, collectParamNames, parseRunbook, buildRunbookRun,
  loadRunbook, listRunbookNames, RUNBOOK_DIR, lintRunbook, parseParamDeclarations, validateParamValues,
} from '../lib/runbooks.js'
import { ecsRunbookDefinition } from '../lib/tools/ecs-runbook.js'
import { ecsSnapshotDefinition } from '../lib/tools/ecs-snapshot.js'
import {
  buildSnapshotScript, parseSnapshotOutput, diffFacts, DEFAULT_SNAPSHOT_COLLECTORS,
  SNAPSHOT_DIR, isValidSnapshotName,
} from '../lib/snapshots.js'
import { planSteps, stepTimeoutOf, replayAdvice, resolveFromStep, STEPS_MAX_STEP_TIMEOUT } from '../lib/steps-engine.js'

let passed = 0
let failed = 0
function run(name, fn) {
  try {
    fn()
    passed += 1
    console.log('  ✔ ' + name)
  } catch (err) {
    failed += 1
    console.log('  ✘ ' + name + ' — ' + (err && err.message ? err.message : String(err)))
  }
}
async function runAsync(name, fn) {
  try {
    await fn()
    passed += 1
    console.log('  ✔ ' + name)
  } catch (err) {
    failed += 1
    console.log('  ✘ ' + name + ' — ' + (err && err.message ? err.message : String(err)))
  }
}

console.log('== unit: 纯逻辑回归 ==')

// ---- base64 与 UTF-8 字节统计(动态挂载 body 无 Buffer, 必须自带实现) ----
run('base64Encode 与 Buffer 一致(ASCII/中文/emoji/空串)', () => {
  const cases = ['', 'a', 'ab', 'abc', 'print("hi")', 'echo 中文测试', 'a$b`c"d\'e\\f', '🚀 emoji 🎯', 'line1\nline2\ttab']
  for (const s of cases) {
    assert.equal(base64Encode(s), Buffer.from(s, 'utf8').toString('base64'), 'base64 不一致: ' + JSON.stringify(s))
    assert.equal(utf8ByteLength(s), Buffer.byteLength(s, 'utf8'), '字节数不一致: ' + JSON.stringify(s))
  }
})

// ---- S6: 只读护栏 ----
run('只读护栏: 放行只读命令(含 2>/dev/null 与 2>&1)', () => {
  const allowed = [
    'df -h',
    'free -m',
    'uptime',
    'tail -n 50 /var/log/nginx/error.log',
    'docker ps --format "table {{.Names}}\t{{.Status}}"',
    'docker logs --tail 100 nailong-server',
    'docker inspect nailong-server',
    'docker compose ps',
    'systemctl --no-pager list-units --type=service --state=running 2>/dev/null | head -25',
    'ps aux --sort=-%mem 2>/dev/null | head -15',
    'ss -tlnp 2>/dev/null | head -30',
    'cat /etc/os-release 2>/dev/null | head -3',
    'grep -c ERROR /var/log/app.log 2>/dev/null || echo 0',
    'sha256sum /opt/app/app.jar',
    'journalctl -u nginx -n 100 --no-pager 2>&1 | tail -20',
    'curl -fsS http://127.0.0.1/health 2>/dev/null',
    'git log --oneline -5',
    'git status --porcelain',
    'ls -la /root/nailonghub 2>/dev/null',
    'awk \'{print $1}\' /proc/loadavg',
  ]
  for (const cmd of allowed) {
    assert.equal(checkWriteCommand(cmd), undefined, '不应误杀: ' + cmd + ' -> ' + checkWriteCommand(cmd))
  }
})

run('只读护栏: 拦截写命令(18 例)', () => {
  const blocked = [
    'rm -rf /tmp/x',
    'sudo rm -f /etc/nginx/nginx.conf',
    'mv /tmp/a /tmp/b',
    'cp -r /tmp/a /tmp/b',
    'mkdir -p /tmp/newdir',
    'touch /tmp/marker',
    'chmod 777 /opt/app/start.sh',
    'chown nginx:nginx /var/log/nginx',
    'echo hello > /tmp/out.txt',
    'cat a.txt >> b.txt',
    'tee /etc/hosts',
    'sed -i "s/a/b/" /etc/nginx/nginx.conf',
    'truncate -s 0 /var/log/app.log',
    'docker restart nailong-server',
    'docker compose up -d --force-recreate',
    'docker exec nailong-server rm -rf /app/tmp',
    'systemctl restart nginx',
    'nohup bash deploy/release.sh abc > /tmp/r.log 2>&1 &',
    'git pull origin main',
    'apt-get install -y curl',
    'npm install --production',
    'curl -o /tmp/x.tar.gz https://example.com/x.tar.gz',
    'wget -O /tmp/x.tar.gz https://example.com/x.tar.gz',
    'kill -9 1234',
    'find /tmp -name "*.log" -delete',
    'crontab -r',
    'dd if=/dev/zero of=/dev/sda',
  ]
  for (const cmd of blocked) {
    assert.notEqual(checkWriteCommand(cmd), undefined, '应拦截: ' + cmd)
  }
})

run('只读护栏: 诊断预置脚本(含 extra)零误杀', () => {
  const script = buildDiagnoseScript('tail -n 20 /var/log/nginx/error.log 2>/dev/null; docker ps | head -5')
  assert.equal(checkWriteCommand(script), undefined, '诊断脚本被误杀: ' + checkWriteCommand(script))
  assert.throws(() => guardReadOnly('rm -rf /tmp/x', 'ecs_diagnose'), /read_only|写操作/)
  assert.doesNotThrow(() => guardReadOnly('df -h'))
})

// ---- D1: 超时默认值 ----
run('resolveTimeout: 显式值优先, 非法值回落默认', () => {
  assert.equal(resolveTimeout(undefined, 60), 60)
  assert.equal(resolveTimeout(180, 60), 180)
  assert.equal(resolveTimeout(0, 60), 60)
  assert.equal(resolveTimeout(-5, 60), 60)
  assert.equal(resolveTimeout('120', 60), 60, '字符串不视为有效超时(避免注入)')
})

// ---- 输出清洗 ----
run('cleanOutput: 去 ANSI/控制字符, 统一换行', () => {
  assert.equal(cleanOutput('\u001b[31mERROR\u001b[0m: boom'), 'ERROR: boom')
  assert.equal(cleanOutput('a\r\nb'), 'a\nb')
  assert.equal(cleanOutput('a\u0000b\u0007c'), 'abc')
  assert.equal(cleanOutput('\u001b[31mred\u001b[0m', false), '\u001b[31mred\u001b[0m', 'strip_ansi=false 时保留')
})

run('cleanOutput: 清除 upload 的进度帧(回车重绘)', () => {
  const raw = 'Uploading app.tar.gz (4.4 MB) to i-x:/tmp/\n' +
    '\r⠋ Preparing...\r⠙ Preparing...\r⠹ Preparing...' +
    '\r⠋ [###############---------------]  50% Uploading to OSS...' +
    '\r\u001b[KUpload complete: app.tar.gz → /tmp/app.tar.gz'
  const cleaned = cleanOutput(raw)
  assert.ok(cleaned.includes('Uploading app.tar.gz'), '应保留首行')
  assert.ok(cleaned.includes('Upload complete: app.tar.gz'), '应保留结论行')
  assert.ok(!cleaned.includes('⠋'), '不应残留 spinner')
  assert.ok(!cleaned.includes('50%'), '不应残留进度条')
  assert.ok(!cleaned.includes('\r'), '不应残留回车')
  // 普通多行输出(含空行)结构不受影响
  assert.equal(cleanOutput('a\n\nb'), 'a\n\nb')
})

// ---- 路径与引用 ----
run('shellQuote/baseName/remoteJoin', () => {
  assert.equal(shellQuote('/tmp/a b.sh'), "'/tmp/a b.sh'")
  assert.equal(shellQuote("it's"), "'it'\\''s'")
  assert.equal(baseName('/opt/app/app.jar'), 'app.jar')
  assert.equal(baseName('C:\\tmp\\a.txt'), 'a.txt')
  assert.equal(baseName('/opt/app/'), 'app')
  assert.equal(remoteJoin('/opt/app/', '/tmp/app.jar'), '/opt/app/app.jar', '目录语义应拼接文件名')
  assert.equal(remoteJoin('/opt/app/app.jar', '/tmp/other.jar'), '/opt/app/app.jar', '文件语义应原样')
})

// ---- S1: 脚本投递形状 ----
run('buildScriptDelivery: 小脚本内联投递', () => {
  const d = buildScriptDelivery('echo "hi" && echo 中文', { shell: 'bash' })
  assert.equal(d.inline, true)
  assert.equal(d.expected_bytes, utf8ByteLength('echo "hi" && echo 中文'))
  assert.equal(d.commands.length, 3, '应为 [写 b64, 解码, 执行]')
  assert.ok(d.commands[0].includes("printf '%s'"), '首条命令应为 base64 写入')
  assert.ok(d.commands[1].includes('base64 -d'), '第二条应为解码落盘')
  assert.ok(d.commands[2].includes('bash ' + d.script_path), '末条应执行脚本')
  assert.ok(d.commands[2].includes('exit $rc'), '末条应透传退出码')
  // 脚本正文不得出现在任何一条命令里(零转义的判据)
  assert.ok(!d.commands.join('\n').includes('echo 中文'), '脚本正文不应以明文出现在命令中')
})

run('buildScriptDelivery: 大脚本分片投递且每片 argv 受限', () => {
  const big = 'echo 中文\n'.repeat(4000) // ~ 4000 * 14 字节 ≈ 54KB > 16KB 阈值
  const d = buildScriptDelivery(big, { id: 'fixedid' })
  assert.equal(d.inline, false, '应走分片路径')
  assert.ok(d.base64_bytes > SCRIPT_INLINE_LIMIT_BYTES)
  assert.equal(d.commands.length, d.chunks + 1, '前置分片数应等于 chunks')
  assert.ok(d.chunks >= 5, '分片数应 > 5, 实际 ' + d.chunks)
  for (const cmd of d.commands) {
    const b64Part = cmd.includes("printf '%s'") ? cmd.replace(/^.*printf '%s' /, '').replace(/ >>? .*$/, '').replace(/^'|'$/g, '') : ''
    assert.ok(b64Part.length <= 8192, '单片 base64 不应超过 8KB, 实际 ' + b64Part.length)
  }
  assert.ok(d.commands[0].startsWith(': > '), '分片模式应先清空文件')
  assert.ok(d.commands[d.commands.length - 1].includes('wc -c'), '末条应含字节数校验')
})

run('buildScriptDelivery: keep_script 保留文件, 默认清理', () => {
  const kept = buildScriptDelivery('echo x', { keep: true })
  const auto = buildScriptDelivery('echo x')
  const lastOf = (d) => d.commands[d.commands.length - 1]
  assert.ok(!lastOf(kept).includes('rm -f ' + kept.script_path), 'keep=true 不应删除脚本: ' + lastOf(kept))
  assert.ok(lastOf(kept).includes('rm -f ' + kept.b64_path), 'keep=true 仍应清理 base64 中转文件')
  assert.ok(lastOf(auto).includes('rm -f ' + auto.b64_path + ' ' + auto.script_path), '默认应清理中转文件与脚本: ' + lastOf(auto))
})

// ---- sha256 链路(经 subprocess 调平台工具, 不依赖 node:crypto) ----
const tmpDir = mkdtempSync(join(tmpdir(), 'dsh-wbecs-unit-'))
const hashFile = join(tmpDir, 'payload.bin')
const payload = Buffer.from('dsh-workbench-ecs sha256 校验\n中文负载\n', 'utf8')
writeFileSync(hashFile, payload)
const expectedHash = createHash('sha256').update(payload).digest('hex')

// 真实 subprocess 适配器(本地进程): resolveExecutable 交给 PATH
const localSubprocess = {
  async resolveExecutable(name) {
    return name
  },
  spawn(spec) {
    const child = spawn(spec.argv[0], spec.argv.slice(1), { cwd: spec.cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    const out = []
    const err = []
    child.stdout.on('data', (c) => out.push(c))
    child.stderr.on('data', (c) => err.push(c))
    const reader = (chunks) => ({ readFrom() { const buf = Buffer.concat(chunks); return { text: buf.toString('utf8'), nextOffset: buf.length, lossy: false } } })
    return {
      pid: child.pid,
      collected: { stdout: reader(out), stderr: reader(err) },
      done: new Promise((resolve, reject) => {
        child.on('error', reject)
        child.on('close', (code, signal) => resolve({ exitCode: code, signal }))
      }),
      terminate() { child.kill() },
      async waitForExit() { return true },
    }
  },
}

await runAsync('localSha256: 本地哈希与 node:crypto 一致', async () => {
  const ctx = { get: (n) => (n === 'subprocess' ? localSubprocess : undefined) }
  const digest = await localSha256(ctx, hashFile)
  assert.ok(digest !== undefined, 'localSha256 应返回摘要(平台哈希工具不可用时为 undefined)')
  assert.equal(digest, expectedHash)
})

await runAsync('remoteSha256: 解析 CLI JSON 的输出并复用实例锁', async () => {
  const calls = []
  const fakeSubprocess = {
    async resolveExecutable() {
      return 'workbench'
    },
    spawn(spec) {
      calls.push(spec.argv)
      const body = JSON.stringify({ instance_id: 'i-fake', exit_code: 0, output: expectedHash + '  /tmp/payload.bin\n', stderr: '', request_id: 'r-1', session_id: 's-1' })
      return {
        pid: 1,
        collected: { stdout: { readFrom: () => ({ text: body, nextOffset: body.length, lossy: false }) }, stderr: { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) } },
        done: Promise.resolve({ exitCode: 0, signal: null }),
        terminate() {},
        async waitForExit() { return true },
      }
    },
  }
  const ctx = { get: (n) => (n === 'subprocess' ? fakeSubprocess : undefined) }
  const digest = await remoteSha256(ctx, 'i-fake', '/tmp/payload.bin')
  assert.equal(digest, expectedHash)
  assert.ok(calls[0].join(' ').includes('--timeout 60'), '应显式下发默认超时: ' + calls[0].join(' '))
  assert.ok(calls[0].join(' ').includes('sha256sum'), '应优先使用 sha256sum')
})

// ---- detach / 日志游标(S2) ----
run('buildLogReadCommand: 含 meta/游标/退出码探测, 且都是只读命令', () => {
  const cmd = buildLogReadCommand({ logPath: '/tmp/x/out.log', exitPath: '/tmp/x/exit', after: 100, maxBytes: 4096 })
  assert.ok(cmd.includes('wc -c <'), '应报告总字节数')
  assert.ok(cmd.includes('__DSH_ECS_META__'), '应有 meta 标记')
  assert.ok(cmd.includes('tail -c +101'), '游标应为 after+1(1-based), 实际: ' + cmd)
  assert.ok(cmd.includes('head -c 4096'), '应限制单次读取字节数')
  assert.ok(cmd.includes('__DSH_ECS_EXIT__'), '应探测退出码文件')
  assert.equal(checkWriteCommand(cmd), undefined, '游标读命令必须是只读命令')
  // 路径包含单引号/空格时仍应安全引用
  const tricky = buildLogReadCommand({ logPath: "/tmp/it's a log.log", after: 0 })
  assert.ok(tricky.includes("'/tmp/it'\\''s a log.log'"), '路径应经 shell 引用')
  assert.equal(checkWriteCommand(tricky), undefined, '引用后不应命中写模式')
})

run('parseLogRead: 提取增量/游标/总长/退出码', () => {
  const output = '__DSH_ECS_META__ 120\nline-a\nline-b\n__DSH_ECS_EXIT__ 7\n'
  const p = parseLogRead(output, 0, 4096)
  assert.equal(p.total_bytes, 120)
  assert.equal(p.text, 'line-a\nline-b')
  assert.equal(p.bytes, 120, '可用字节数应为 total-after')
  assert.equal(p.next_offset, 120)
  assert.equal(p.exit_code, 7)
  assert.equal(p.truncated, false)
  // 续读: 已到末尾则没有增量
  const p2 = parseLogRead('__DSH_ECS_META__ 120\n', 120, 4096)
  assert.equal(p2.text, '')
  assert.equal(p2.bytes, 0)
  assert.equal(p2.next_offset, 120)
  assert.equal(p2.exit_code, undefined)
  // 超过 max_bytes 时按上限推进游标并标记 truncated
  const p3 = parseLogRead('__DSH_ECS_META__ 1000\n' + 'x'.repeat(100), 0, 100)
  assert.equal(p3.bytes, 100)
  assert.equal(p3.next_offset, 100)
  assert.equal(p3.truncated, true)
})

run('buildDetachLaunch: 前置投递 + nohup 启动 + 日志/退出码路径', () => {
  const d = buildDetachLaunch('echo hello', { id: 'fixedid' })
  assert.ok(d.dir.includes('.dsh-ecs-fixedid'), '应有独立任务目录')
  assert.equal(d.log_path, d.dir + '/out.log')
  assert.equal(d.exit_path, d.dir + '/exit')
  assert.ok(d.prepare_commands[0].includes('mkdir -p '), '自定义目录应先建目录')
  assert.ok(d.prepare_commands.join('\n').includes('base64 -d'), '应先落盘脚本')
  assert.ok(d.prepare_commands.join('\n').includes('wc -c'), '应有字节数校验')
  assert.ok(d.launch_command.includes('nohup'), '应 nohup 启动')
  assert.ok(d.launch_command.includes('__DSH_ECS_PID__$!'), '应回报远端 pid')
  assert.ok(d.launch_command.includes(d.log_path), '应重定向到日志文件')
  assert.ok(d.launch_command.includes(d.exit_path), '应写退出码文件')
  assert.equal(parseDetachPid('__DSH_ECS_PID__4321\n'), 4321)
  assert.equal(parseDetachPid('no pid here'), undefined)
})

await runAsync('delay/hasLocalTimer: 本机 Node 环境可用', async () => {
  assert.equal(hasLocalTimer(undefined), true)
  const t0 = Date.now()
  await delay(undefined, 20)
  assert.ok(Date.now() - t0 >= 15, 'delay 应实际等待')
})

// ---- 伪会话(S3) ----
run('buildSessionScript: 继承 cwd/环境变量 + 回传 cwd 标记', () => {
  const s1 = buildSessionScript('echo hi', undefined, ['FOO=bar'])
  assert.ok(s1.script.includes("export FOO='bar'"), '应导出会话变量')
  assert.ok(s1.script.includes('echo hi'), '应包含原始 payload')
  assert.ok(s1.script.includes('__DSH_ECS_CWD__'), '应回传 cwd 标记')
  assert.ok(s1.script.includes('exit $rc'), '应透传退出码')
  assert.ok(!s1.script.includes('cd '), '无会话状态时不应 cd')
  assert.equal(s1.env.FOO, 'bar')

  const s2 = buildSessionScript('pwd', { cwd: '/opt/app', env: { FOO: 'bar' } }, ['BAZ=a b'])
  assert.ok(s2.script.startsWith("cd '/opt/app'"), '应继承上次 cwd, 实际: ' + s2.script.split('\n')[0])
  assert.ok(s2.script.includes("export FOO='bar'"), '应继承上次环境变量')
  assert.ok(s2.script.includes("export BAZ='a b'"), '新变量应经 shell 引用')
  assert.equal(s2.env.BAZ, 'a b')
  // 非法变量名应被忽略, 避免注入
  const s3 = buildSessionScript('echo x', undefined, ['BAD-NAME=v', "INJ=x'; rm -rf /; echo '"])
  assert.ok(!s3.script.includes('export BAD-NAME'), '非法变量名应被忽略')
  assert.ok(s3.script.includes("'\\''"), '变量值应被安全引用')
})

run('extractSessionCwd: 剥离标记并取回 cwd', () => {
  const r = extractSessionCwd('/opt/app\n__DSH_ECS_CWD__/opt/app\n')
  assert.equal(r.cwd, '/opt/app')
  assert.equal(r.text, '/opt/app')
  assert.ok(!r.text.includes('__DSH_ECS_CWD__'), '标记不应残留在输出里')
  const none = extractSessionCwd('no marker here')
  assert.equal(none.cwd, undefined)
  assert.equal(none.text, 'no marker here')
  // 标记在中间时也要能处理
  const mid = extractSessionCwd('a\n__DSH_ECS_CWD__/tmp\nb')
  assert.equal(mid.cwd, '/tmp')
  assert.equal(mid.text, 'a\nb')
})

// ---- S7: 并发闸门 ----
await runAsync('runWithConcurrency: 保序 + 真实并发 + 上限', async () => {
  const items = [1, 2, 3, 4, 5, 6, 7, 8, 9]
  let active = 0
  let peak = 0
  const out = await runWithConcurrency(items, 3, async (n) => {
    active += 1
    peak = Math.max(peak, active)
    await new Promise((resolve) => setTimeout(resolve, 5))
    active -= 1
    return n * 2
  })
  assert.deepEqual(out, [2, 4, 6, 8, 10, 12, 14, 16, 18], '结果必须按输入顺序')
  assert.ok(peak <= 3, '并发不应超过上限, 实际 ' + peak)
  assert.ok(peak >= 2, '应真正并发而不是串行, 实际 ' + peak)
  assert.deepEqual(await runWithConcurrency([], 4, async () => 1), [], '空输入应立即返回')
  assert.deepEqual(await runWithConcurrency([1], 8, async (n) => n + 1), [2], 'limit 大于条数时退化为串行')
})

// ---- S5b: 目录上传的归档/解包链路 ----
run('splitLocalPath: 目录归档的 (父目录, 名字)', () => {
  assert.deepEqual(splitLocalPath('deploy'), { parent: '.', base: 'deploy' })
  assert.deepEqual(splitLocalPath('build/dist/'), { parent: 'build', base: 'dist' })
  assert.deepEqual(splitLocalPath('a\\b\\c'), { parent: 'a/b', base: 'c' })
  assert.deepEqual(splitLocalPath('/opt/app'), { parent: '/opt', base: 'app' })
})

run('buildTarCreateArgv: tar -czf <归档> -C <父> <名字>', () => {
  assert.deepEqual(
    buildTarCreateArgv('tar', '.dsh-ecs-upload-x.tar.gz', 'build/dist'),
    ['tar', '-czf', '.dsh-ecs-upload-x.tar.gz', '-C', 'build', 'dist'],
  )
})

run('buildArchiveExtractScript: 建目录→计数→解包→清理→透传退出码', () => {
  const s = buildArchiveExtractScript({ archivePath: '/tmp/x.tar.gz', remoteDir: '/opt/app' })
  assert.ok(s.includes("mkdir -p '/opt/app'"), '应建远端目录')
  assert.ok(s.includes("tar -tzf '/tmp/x.tar.gz'"), '应先数条目')
  assert.ok(s.includes("tar -xzf '/tmp/x.tar.gz' -C '/opt/app'"), '应解包到目标目录')
  assert.ok(s.includes('--strip-components=1'), '默认应剥掉归档顶层目录')
  assert.ok(s.includes('__DSH_ECS_ENTRIES__'), '应回报条目数')
  assert.ok(s.includes("rm -f '/tmp/x.tar.gz'"), '默认应清理远端归档')
  assert.ok(s.includes('exit $rc'), '应透传解包退出码')
  assert.ok(s.includes('exit 95') && s.includes('exit 96'), '归档不可读/目录不可建应有独立退出码')
  assert.notEqual(checkWriteCommand(s), undefined, '解包含 mkdir/rm, 应被只读护栏识别为写操作')

  const keep = buildArchiveExtractScript({
    archivePath: '/tmp/x.tar.gz', remoteDir: '/opt/app', keepRootDir: true, keepArchive: true,
  })
  assert.ok(!keep.includes('--strip-components'), 'keep_root_dir=true 不应剥离')
  assert.ok(!keep.includes('rm -f'), 'keep_archive=true 不应删除归档')

  const tricky = buildArchiveExtractScript({ archivePath: "/tmp/it's.tar.gz", remoteDir: '/opt/my app' })
  assert.ok(tricky.includes("'/tmp/it'\\''s.tar.gz'"), '归档路径应经 shell 引用')
  assert.ok(tricky.includes("'/opt/my app'"), '目标目录含空格应经 shell 引用')
})

run('parseArchiveEntries: 取出条目数并剥离标记', () => {
  const r = parseArchiveEntries('__DSH_ECS_ENTRIES__42\n')
  assert.equal(r.entries, 42)
  assert.equal(r.text, '')
  const r2 = parseArchiveEntries('some warning\n__DSH_ECS_ENTRIES__7\nmore')
  assert.equal(r2.entries, 7)
  assert.equal(r2.text, 'some warning\nmore')
  assert.equal(parseArchiveEntries('no marker').entries, undefined)
})

await runAsync('ecs_upload: local_file/local_dir 二选一与目录前置校验', async () => {
  const def = ecsUploadDefinition({ get: () => undefined })
  const exec = { signal: { aborted: false } }
  await assert.rejects(
    () => def.execute({ remote_path: '/opt/app', instance_id: 'i-x' }, exec),
    /必须提供 local_file 或 local_dir/,
  )
  await assert.rejects(
    () => def.execute({ local_file: 'a.txt', local_dir: 'dist', remote_path: '/opt/app', instance_id: 'i-x' }, exec),
    /只能二选一/,
  )
  await assert.rejects(
    () => def.execute({ local_dir: '.', remote_path: '/opt/app', instance_id: 'i-x' }, exec),
    /具体目录/,
  )
  await assert.rejects(
    () => def.execute({ local_dir: 'dist', remote_path: '/opt/app', instance_id: 'i-x' }, exec),
    /tar/,
    '本机无 tar 时应给出可操作的报错',
  )
})

run('ecs_upload render: 目录成功 / 中止 / 本地清理失败三种文案', () => {
  const def = ecsUploadDefinition({ get: () => undefined })
  const base = {
    kind: 'upload', mode: 'dir', instance_id: 'i-x', local_dir: 'dist', remote_path: '/opt/app',
    archive_local: '.dsh-ecs-upload-x.tar.gz', archive_remote: '/tmp/x.tar.gz', message: '', exit_code: 0,
  }
  const ok = def.output.render({}, {
    ...base, verification: 'ok', sha256_local: 'a'.repeat(64), entries: 12, extracted: true,
    local_archive_cleanup: 'removed',
  })[0].text
  assert.ok(ok.includes('目录上传完成'))
  assert.ok(ok.includes('12 个归档条目'))
  assert.ok(ok.includes('校验通过'), '应展示 sha256 校验结果')
  assert.ok(!ok.includes('未清理'), '清理成功时不应提示残留')

  const aborted = def.output.render({}, {
    ...base, verification: 'mismatch', sha256_local: 'a'.repeat(64), sha256_remote: 'b'.repeat(64),
    extracted: false, aborted: true, abort_reason: 'sha256-mismatch', local_archive_cleanup: 'failed',
  })[0].text
  assert.ok(aborted.includes('目录上传已中止'))
  assert.ok(aborted.includes('未在远端解包'), '中止时应明确"远端目录未被改动"')
  assert.ok(aborted.includes('本地归档未清理') && aborted.includes('.dsh-ecs-upload-x.tar.gz'),
    '本地清理失败应给出残留路径')
})

// ---- S5b 不变式: 校验失败必须中止解包(坏包不落地) ----
await runAsync('ecs_upload 目录模式: sha256 不一致时中止解包, 不下发解包命令', async () => {
  const dirRoot = mkdtempSync(join(tmpdir(), 'dsh-wbecs-unit-dir-'))
  mkdirSync(join(dirRoot, 'src', 'sub'), { recursive: true })
  writeFileSync(join(dirRoot, 'src', 'a.txt'), 'alpha\n')
  writeFileSync(join(dirRoot, 'src', 'sub', 'b.txt'), 'beta\n')

  const issued = []
  // workbench 调用被替换为可编排应答; tar/sha256sum/rm/cmd 等本机程序走真实进程
  const hybrid = {
    async resolveExecutable(name) { return name },
    spawn(spec) {
      const exe = String(spec.argv[0])
      if (exe !== 'workbench') return localSubprocess.spawn(spec)
      const argv = spec.argv.slice(1)
      issued.push(argv)
      let body
      if (argv[0] === 'upload') {
        body = JSON.stringify({ instance_id: 'i-x', exit_code: 0, output: 'Upload complete', stderr: '', request_id: 'r-1', session_id: 's-1' })
      } else if (argv.join(' ').includes('sha256sum')) {
        // 远端摘要与本地必然不同 -> 模拟传输损坏
        body = JSON.stringify({ instance_id: 'i-x', exit_code: 0, output: 'f'.repeat(64) + '  /tmp/dsh-ecs-upload-x.tar.gz\n', stderr: '' })
      } else {
        body = JSON.stringify({ instance_id: 'i-x', exit_code: 0, output: '__DSH_ECS_ENTRIES__3\n', stderr: '' })
      }
      return {
        pid: 1,
        collected: {
          stdout: { readFrom: () => ({ text: body, nextOffset: body.length, lossy: false }) },
          stderr: { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) },
        },
        done: Promise.resolve({ exitCode: 0, signal: null }),
        terminate() {},
        async waitForExit() { return true },
      }
    },
  }

  const ctx2 = { get: (n) => (n === 'subprocess' ? hybrid : undefined) }
  const def = ecsUploadDefinition(ctx2)
  const value = await def.execute(
    { local_dir: join(dirRoot, 'src'), remote_path: '/opt/app', instance_id: 'i-x', force: true, verify_sha256: true },
    { signal: { aborted: false } },
  )
  assert.equal(value.verification, 'mismatch', '本地/远端摘要不同应判为 mismatch')
  assert.equal(value.aborted, true, '摘要不一致必须中止')
  assert.equal(value.abort_reason, 'sha256-mismatch')
  assert.equal(value.extracted, false, '中止时不得解包')
  assert.ok(issued.some((argv) => argv[0] === 'upload'), '上传应已发生')
  assert.ok(!issued.some((argv) => argv.join(' ').includes('tar -xzf')), '中止后不得下发解包命令: ' + JSON.stringify(issued))
})

// ---- S7: output_json 与批量渲染 ----
run('ecs_exec render: output_json 返回稳定 JSON, 默认仍为可读文本', () => {
  const def = ecsExecDefinition({ get: () => undefined })
  const value = {
    kind: 'batch', count: 1, failed_count: 0, concurrency: 2, command: 'df -h',
    batch: [{ instance_id: 'i-x', is_error: false, exit_code: 0, output: 'ok' }],
  }
  const text = def.output.render({ output_json: true }, value)[0].text
  assert.deepEqual(JSON.parse(text), value, 'output_json 应是 value 的稳定 JSON 序列化')
  assert.ok(text.includes('\n  "kind"'), '应带缩进便于阅读')
  const human = def.output.render({}, value)[0].text
  assert.ok(human.includes('批量执行完成'))
  assert.ok(human.includes('并发 2'), '并发度应出现在文本里: ' + human)

  const bg = def.output.render({}, {
    kind: 'batch_background', count: 2, failed_count: 1, concurrency: 2, command: 'uptime',
    job_ids: ['j-1'],
    batch: [{ instance_id: 'i-1', job_id: 'j-1', is_error: false }, { instance_id: 'i-2', is_error: true, error: 'boom' }],
  })[0].text
  assert.ok(bg.includes('批量后台任务已启动'))
  assert.ok(bg.includes('j-1'))
  assert.ok(bg.includes('i-2] 启动失败: boom'))
})

// ---- S7: ecs_list 过滤器与分页 ----
function stubSubprocess(body) {
  const calls = []
  return {
    calls,
    subprocess: {
      async resolveExecutable() { return 'workbench' },
      spawn(spec) {
        calls.push(spec.argv)
        return {
          pid: 1,
          collected: {
            stdout: { readFrom: () => ({ text: body, nextOffset: body.length, lossy: false }) },
            stderr: { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) },
          },
          done: Promise.resolve({ exitCode: 0, signal: null }),
          terminate() {},
          async waitForExit() { return true },
        }
      },
    },
  }
}

await runAsync('ecs_list: 新过滤器/limit/next_token 全部透传为显式 argv', async () => {
  const stub = stubSubprocess(JSON.stringify({ instances: [] }))
  const def = ecsListDefinition({ get: (n) => (n === 'subprocess' ? stub.subprocess : undefined) })
  const value = await def.execute({
    region: 'cn-shanghai', vpc_id: 'vpc-1', vswitch_id: 'vsw-1', zone_id: 'cn-shanghai-a',
    private_ip: ['10.0.0.1', '10.0.0.2'], image_id: 'img-1', next_token: 'tok', limit: 20,
  }, { signal: { aborted: false } })
  const argv = stub.calls[0].join(' ')
  for (const expected of ['--vpc-id vpc-1', '--vswitch-id vsw-1', '--zone-id cn-shanghai-a',
    '--private-ip 10.0.0.1,10.0.0.2', '--image-id img-1', '--next-token tok', '--limit 20', '--output json']) {
    assert.ok(argv.includes(expected), 'argv 应包含 ' + expected + ', 实际: ' + argv)
  }
  assert.equal(value.limit, 20)
  assert.equal(value.pagination_note, undefined, '未顶到 limit 时不应提示分页')
})

await runAsync('ecs_list: 顶到 limit 且 CLI 未给 token 时显式提示分页', async () => {
  const items = Array.from({ length: 10 }, (_, i) => ({ instance_id: 'i-' + i }))
  const stub = stubSubprocess(JSON.stringify({ instances: items }))
  const def = ecsListDefinition({ get: (n) => (n === 'subprocess' ? stub.subprocess : undefined) })
  const value = await def.execute({ region: 'cn-shanghai', limit: 10 }, { signal: { aborted: false } })
  assert.equal(value.count, 10)
  assert.ok(typeof value.pagination_note === 'string' && value.pagination_note.includes('NextToken'),
    '应提示 CLI 未返回 NextToken, 实际: ' + value.pagination_note)
  assert.ok(def.output.render({}, value)[0].text.includes('NextToken'), '提示应出现在可读输出里')

  const withToken = stubSubprocess(JSON.stringify({ instances: items, next_token: 'tok-2' }))
  const def2 = ecsListDefinition({ get: (n) => (n === 'subprocess' ? withToken.subprocess : undefined) })
  const v2 = await def2.execute({ region: 'cn-shanghai', limit: 10 }, { signal: { aborted: false } })
  assert.equal(v2.next_token, 'tok-2', 'CLI 给出 token 时应透出')
  assert.equal(v2.pagination_note, undefined, '有 token 时不应提示')
})

// ---- S4a: ecs_deploy steps 编排(v0.6.0) ----
function cannedHandle(body) {
  return {
    pid: 1,
    collected: {
      stdout: { readFrom: () => ({ text: body, nextOffset: body.length, lossy: false }) },
      stderr: { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) },
    },
    done: Promise.resolve({ exitCode: 0, signal: null }),
    terminate() {},
    async waitForExit() { return true },
  }
}

// workbench 调用走可编排应答; tar/mkdir/rm/cmd/sha256sum 等本机程序走真实进程
function deployStub(overrides = {}) {
  const calls = []
  const subprocess = {
    async resolveExecutable(name) { return name },
    spawn(spec) {
      const exe = String(spec.argv[0])
      if (exe !== 'workbench') return localSubprocess.spawn(spec)
      const argv = spec.argv.slice(1)
      calls.push(argv)
      const ci = argv.indexOf('--command')
      const command = ci >= 0 ? String(argv[ci + 1]) : ''
      if (typeof overrides.body === 'function') {
        const custom = overrides.body({ argv, command })
        if (custom !== undefined) return cannedHandle(custom)
      }
      const reply = (output, exitCode = 0, stderr = '') =>
        JSON.stringify({ instance_id: 'i-x', exit_code: exitCode, output, stderr, request_id: 'r-1', session_id: 's-1' })
      if (argv[0] === 'upload') return cannedHandle('Upload complete: x -> y')
      if (command.includes('__DSH_ECS_META__')) {
        return cannedHandle(reply('__DSH_ECS_META__ 24\nrelease log line\n__DSH_ECS_EXIT__ 0\n'))
      }
      if (command.includes('health')) return cannedHandle(reply('ready zz\n'))
      if (command.includes('boom')) return cannedHandle(reply('', 3, 'boom\n'))
      return cannedHandle(reply('ok\n'))
    },
  }
  return { calls, subprocess }
}

function deployDefWith(stub) {
  return ecsDeployDefinition({ get: (n) => (n === 'subprocess' ? stub.subprocess : undefined) })
}
const stubExec = () => ({ signal: { aborted: false } })

await runAsync('ecs_deploy steps: dry_run 只回显计划, 不下发任何命令', async () => {
  const stub = deployStub()
  const def = deployDefWith(stub)
  const value = await def.execute({
    instance_id: 'i-x',
    dry_run: true,
    steps: [
      { kind: 'upload', local_file: 'dist.tgz', remote_path: '/opt/app/' },
      { kind: 'exec', command: 'docker compose up -d' },
      { kind: 'assert', script: 'curl -fsS http://127.0.0.1/health', expect: { exit_code: 0, stdout_contains: ['ok'] } },
      { kind: 'tail', path: '/tmp/release.log' },
    ],
  }, stubExec())
  assert.equal(value.mode, 'steps')
  assert.equal(value.dry_run, true)
  assert.equal(value.plan.length, 4)
  assert.deepEqual(value.plan.map((p) => p.kind), ['upload', 'exec', 'assert', 'tail'])
  assert.equal(value.plan[0].verify_sha256, true, '上传步骤应默认校验 sha256')
  assert.ok(value.plan[2].command_line.includes('<script'), '计划里不应内联脚本正文: ' + value.plan[2].command_line)
  assert.ok(value.plan[1].command_line.includes('docker compose up -d'), '普通命令的计划应含命令正文')
  assert.equal(stub.calls.length, 0, 'dry_run 不得下发任何命令')
  const text = def.output.render({}, value)[0].text
  assert.ok(text.includes('未执行任何命令'))
  assert.ok(text.includes('去掉 dry_run'))
})

await runAsync('ecs_deploy steps: 结构校验(非法 kind / 缺字段 / 上限 / 缺 command)', async () => {
  const def = ecsDeployDefinition({ get: () => undefined })
  const exec = stubExec()
  await assert.rejects(() => def.execute({ instance_id: 'i-x', steps: [{ kind: 'rm', command: 'x' }] }, exec), /kind 非法/)
  await assert.rejects(() => def.execute({ instance_id: 'i-x', steps: [{ kind: 'upload', remote_path: '/a' }] }, exec), /缺少 local_file/)
  await assert.rejects(() => def.execute({ instance_id: 'i-x', steps: [{ kind: 'upload', local_file: 'a' }] }, exec), /缺少 remote_path/)
  await assert.rejects(() => def.execute({ instance_id: 'i-x', steps: [{ command: 'a', script: 'b' }] }, exec), /二选一/)
  await assert.rejects(() => def.execute({ instance_id: 'i-x', steps: [{ kind: 'exec' }] }, exec), /command 或 script/)
  await assert.rejects(() => def.execute({ instance_id: 'i-x', steps: [{ kind: 'tail' }] }, exec), /缺少 path/)
  await assert.rejects(
    () => def.execute({ instance_id: 'i-x', steps: Array.from({ length: 21 }, () => ({ command: 'echo x' })) }, exec),
    /上限为 20 步/,
  )
  await assert.rejects(() => def.execute({ instance_id: 'i-x' }, exec), /必须提供 command/, '无 steps 且无 command 应报错')
  await assert.rejects(
    () => def.execute({ instance_id: 'i-x', read_only: true, steps: [{ kind: 'exec', command: 'touch /tmp/x' }] }, exec),
    /写操作模式/,
    'read_only 应在预检阶段就拒绝写步骤',
  )
})

await runAsync('ecs_deploy steps: assert 通过时逐条给出断言结果', async () => {
  const stub = deployStub()
  const def = deployDefWith(stub)
  const value = await def.execute({
    instance_id: 'i-x',
    steps: [{
      kind: 'assert', command: 'curl -fsS http://127.0.0.1/health',
      expect: { exit_code: 0, stdout_contains: ['ready'], stdout_not_contains: ['ERROR'] },
    }],
  }, stubExec())
  assert.equal(value.ok, true)
  assert.equal(value.stopped_at, undefined)
  const assertions = value.stages[0].assertions
  assert.deepEqual(assertions.map((a) => a.check), ['exit_code', 'stdout_contains', 'stdout_not_contains'])
  assert.ok(assertions.every((a) => a.ok === true), JSON.stringify(assertions))
  assert.ok(def.output.render({}, value)[0].text.includes('✔ stdout_contains'), '渲染应展示每条断言')
})

await runAsync('ecs_deploy steps: 断言失败即中止, 后续步骤标记为跳过', async () => {
  const stub = deployStub()
  const def = deployDefWith(stub)
  const value = await def.execute({
    instance_id: 'i-x',
    steps: [
      { kind: 'exec', command: 'echo first' },
      { kind: 'assert', command: 'curl -fsS http://127.0.0.1/health', expect: { stdout_contains: ['healthy'] } },
      { kind: 'exec', command: 'echo never-runs' },
    ],
  }, stubExec())
  assert.equal(value.ok, false)
  assert.equal(value.done_stage, 2, '只执行到断言那一步')
  assert.equal(value.stopped_at, 1)
  assert.deepEqual(value.failed_steps, [1])
  assert.match(String(value.stopped_reason), /stdout_contains\(healthy\)/)
  assert.equal(value.stages[1].ok, false)
  assert.equal(value.stages[2].skipped, true, '未执行的步骤应显式标记 skipped')
  assert.ok(!stub.calls.some((argv) => argv.join(' ').includes('never-runs')), '中止后不得下发后续命令')
  const text = def.output.render({}, value)[0].text
  assert.ok(text.includes('中断于步骤 [1]'), text.slice(0, 400))
  assert.ok(text.includes('已跳过'), '渲染应标出被跳过的步骤')
})

await runAsync('ecs_deploy steps: continue_on_error 时失败不中断', async () => {
  const stub = deployStub()
  const def = deployDefWith(stub)
  const value = await def.execute({
    instance_id: 'i-x',
    continue_on_error: true,
    steps: [
      { kind: 'exec', command: 'echo boom', description: '会失败的一步' },
      { kind: 'exec', command: 'echo after-failure' },
    ],
  }, stubExec())
  assert.equal(value.ok, false, '有失败步骤整体结果应为失败')
  assert.equal(value.done_stage, 2, '两步都应执行')
  assert.equal(value.stopped_at, undefined)
  assert.deepEqual(value.failed_steps, [0])
  assert.equal(value.stages[1].skipped, undefined)
  assert.ok(stub.calls.some((argv) => argv.join(' ').includes('after-failure')), '开启后应继续执行后续步骤')
  assert.equal(value.stages[0].exit_code, 3, '远端退出码应透传')
  assert.ok(value.stages[0].stderr.includes('boom'), 'stderr 应带回')
})

await runAsync('ecs_deploy steps: tail 按字节游标读远端日志', async () => {
  const stub = deployStub()
  const def = deployDefWith(stub)
  const value = await def.execute({
    instance_id: 'i-x',
    steps: [{ kind: 'tail', path: '/tmp/release.log', exit_file: '/tmp/exit' }],
  }, stubExec())
  const stage = value.stages[0]
  assert.equal(stage.ok, true)
  assert.equal(stage.output, 'release log line')
  assert.equal(stage.total_bytes, 24)
  assert.equal(stage.next_offset, 24)
  assert.equal(stage.eof, true)
  assert.equal(stage.exit_code, 0)
  const readArgv = stub.calls[0].join(' ')
  assert.ok(readArgv.includes('wc -c <'), 'tail 步骤应报告总字节数')
  assert.ok(readArgv.includes('tail -c +1'), 'tail 步骤应按游标读取')
})

await runAsync('ecs_deploy steps: script 步骤零转义(正文不进 argv)', async () => {
  const stub = deployStub()
  const def = deployDefWith(stub)
  const payload = 'docker exec app node -e "console.log(\'hi\', $HOME)"'
  const value = await def.execute({
    instance_id: 'i-x',
    steps: [{ kind: 'exec', script: payload }],
  }, stubExec())
  assert.equal(value.stages[0].ok, true)
  assert.ok(!stub.calls.some((argv) => argv.join(' ').includes('console.log')), '脚本正文不得以明文出现在 argv 中')
  assert.ok(stub.calls.some((argv) => argv.join(' ').includes('base64 -d')), '脚本应经 base64 投递落盘')
})

await runAsync('ecs_deploy steps: 上传步骤 sha256 不一致时中止编排', async () => {
  const stub = deployStub({
    body: ({ command }) => (command.includes('sha256sum')
      ? JSON.stringify({ instance_id: 'i-x', exit_code: 0, output: 'f'.repeat(64) + '  /opt/dist.tgz\n', stderr: '' })
      : undefined),
  })
  const def = deployDefWith(stub)
  const value = await def.execute({
    instance_id: 'i-x',
    steps: [
      { kind: 'upload', local_file: hashFile, remote_path: '/opt/dist.bin', force: true },
      { kind: 'exec', command: 'docker compose restart nailong-server' },
    ],
  }, stubExec())
  assert.equal(value.aborted, true, 'sha256 不一致必须中止编排')
  assert.match(String(value.abort_reason), /sha256 不一致/)
  assert.equal(value.stages[0].ok, false)
  assert.equal(value.stages[1].skipped, true)
  assert.ok(!stub.calls.some((argv) => argv.join(' ').includes('docker compose restart')), '校验失败后不得下发重启命令')
})

// ---- S4b: Runbook 机制(v0.6.1) ----
run('runbook 名字白名单: 挡住路径穿越', () => {
  assert.equal(isValidRunbookName('release'), true)
  assert.equal(isValidRunbookName('nailong-release.v2'), true)
  assert.equal(isValidRunbookName('a_b-c'), true)
  for (const bad of ['../secret', 'a/b', 'a\\b', '.hidden', '', '-x', 'x'.repeat(65), 'a b']) {
    assert.equal(isValidRunbookName(bad), false, '应拒绝非法名字: ' + JSON.stringify(bad))
  }
})

run('substituteParams: 字符串/嵌套/数组/整串保留类型', () => {
  const params = { sha: 'abc123', t: 300, flag: true }
  assert.equal(substituteParams('img:${sha}', params), 'img:abc123')
  assert.equal(substituteParams('${sha}-${sha}', params), 'abc123-abc123')
  assert.equal(substituteParams('${t}', params), 300, '整串占位符应保留数字类型')
  assert.equal(substituteParams('${flag}', params), true, '整串占位符应保留布尔类型')
  assert.equal(substituteParams('timeout=${t}', params), 'timeout=300', '混合文本应转成字符串')
  const nested = substituteParams({ a: ['${sha}', { b: 'x-${sha}' }] }, params)
  assert.deepEqual(nested, { a: ['abc123', { b: 'x-abc123' }] })
  assert.deepEqual(substituteParams(5, params), 5, '非字符串原样返回')
  // 未知占位符: 收集进 missing, 且原文保留(不静默变空)
  const missing = new Set()
  assert.equal(substituteParams('v-${nope}', params, missing), 'v-${nope}')
  assert.deepEqual(Array.from(missing), ['nope'])
  // 非法占位符写法不参与替换(避免误伤 shell 的 ${...})
  assert.equal(substituteParams('${1bad}', params), '${1bad}')
  assert.deepEqual(Array.from(collectParamNames({ x: '${a}', y: ['${b}', '${a}'] })).sort(), ['a', 'b'])
})

run('parseRunbook: 形状校验', () => {
  assert.throws(() => parseRunbook('not json', 'rb'), /JSON 解析失败/)
  assert.throws(() => parseRunbook('[]', 'rb'), /顶层必须是对象/)
  assert.throws(() => parseRunbook('{"steps":[]}', 'rb'), /缺少非空的 steps/)
  assert.throws(() => parseRunbook('{"steps":{}}', 'rb'), /缺少非空的 steps/)
  assert.throws(() => parseRunbook(JSON.stringify({ steps: Array.from({ length: 21 }, () => ({ command: 'x' })) }), 'rb'), /上限为 20 步/)
  assert.throws(() => parseRunbook('{"steps":[{"command":"x"}],"params":[]}', 'rb'), /params 必须是对象/)
  const rb = parseRunbook('{"name":"release","description":"d","params":{"sha":"latest"},"steps":[{"command":"echo ${sha}"}]}', 'rb')
  assert.equal(rb.name, 'release')
  assert.deepEqual(rb.params, { sha: 'latest' })
  assert.equal(rb.steps.length, 1)
})

run('buildRunbookRun: 隐式 < 默认值 < 调用方; 缺参/多余参数都报告', () => {
  const rb = parseRunbook(JSON.stringify({
    params: { sha: 'latest', keep: 3 },
    steps: [{ kind: 'exec', command: 'deploy ${sha} on ${instance_id}', timeout: '${keep}' }],
  }), 'rb')
  const run = buildRunbookRun(rb, { sha: 'deadbeef' }, { instance_id: 'i-1', region: 'cn-shanghai' })
  assert.equal(run.steps[0].command, 'deploy deadbeef on i-1', '调用方参数应覆盖默认值, 隐式变量应可用')
  assert.equal(run.steps[0].timeout, 3, '整串占位符应保留数字类型')
  assert.deepEqual(run.missing, [])
  assert.deepEqual(run.declared, ['instance_id', 'keep', 'sha'])

  const noDefault = parseRunbook(JSON.stringify({ steps: [{ command: 'echo ${sha}' }] }), 'rb')
  const missingRun = buildRunbookRun(noDefault, {}, { instance_id: 'i-1' })
  assert.deepEqual(missingRun.missing, ['sha'], '既无默认值也未传入的参数应报缺失')
  const withDefault = buildRunbookRun(rb, {}, { instance_id: 'i-1' })
  assert.deepEqual(withDefault.missing, [], '有默认值的参数不应报缺失(sha 默认 latest, keep 默认 3)')
  assert.equal(withDefault.steps[0].command, 'deploy latest on i-1', '无入参时应使用默认值')
  const unusedRun = buildRunbookRun(rb, { sha: 'x', nope: 1 }, { instance_id: 'i-1' })
  assert.deepEqual(unusedRun.unused, ['nope'], '未使用的入参应被指出')
})

// 最小 fs 服务替身: 只实现 runbook 机制用到的 resolve/readText/listDir
function fakeFs(files) {
  const targets = new Map()
  const key = (p) => String(p).replace(/[\\/]+/g, '/').replace(/\/+$/, '')
  const make = (p) => {
    if (!targets.has(key(p))) targets.set(key(p), { targetKey: key(p), path: p })
    return targets.get(key(p))
  }
  return {
    async resolve(path) { return make(path) },
    async readText(target) {
      const p = targets.get(target.targetKey).targetKey
      if (!Object.prototype.hasOwnProperty.call(files, p)) {
        throw new Error('FS_NOT_FOUND: ' + p)
      }
      return files[p]
    },
    async listDir(target) {
      const dir = targets.get(target.targetKey).targetKey
      const prefix = dir + '/'
      const names = Object.keys(files)
        .filter((f) => f.startsWith(prefix) && !f.slice(prefix.length).includes('/'))
        .map((f) => f.slice(prefix.length))
      if (names.length === 0 && !Object.keys(files).some((f) => f.startsWith(prefix))) {
        throw new Error('FS_NOT_FOUND: ' + dir)
      }
      return names.map((name) => ({ name }))
    },
  }
}

// 真实文件系统适配器(v0.8.0 快照清单要真的落盘): 只实现快照机制用到的五个方法
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

// 轻量 lossless 检查(与 DSH 的 isJsonValue 同口径的关键点: 不含 undefined 值属性/非法数字)
function assertLosslessUnit(label, value) {
  const seen = new Set()
  const walk = (v, path) => {
    if (v === undefined) throw new Error(label + ': ' + path + ' 是 undefined')
    if (v === null) return
    if (typeof v === 'number' && (!Number.isFinite(v) || Object.is(v, -0))) throw new Error(label + ': ' + path + ' 非法数字')
    if (typeof v === 'function' || typeof v === 'symbol') throw new Error(label + ': ' + path + ' 不可序列化')
    if (typeof v !== 'object') return
    if (seen.has(v)) throw new Error(label + ': ' + path + ' 循环引用')
    seen.add(v)
    if (Array.isArray(v)) {
      v.forEach((item, i) => walk(item, path + '[' + i + ']'))
      return
    }
    for (const key of Object.keys(v)) walk(v[key], path + '.' + key)
  }
  walk(value, '$')
  assert.equal(typeof JSON.stringify(value), 'string')
}

await runAsync('loadRunbook: 从工作区读取 / 缺文件时列出可用名字 / 无 fs 时给出替代方案', async () => {
  const root = '/ws'
  const rbPath = root + '/' + RUNBOOK_DIR + '/release.json'
  const goodCtx = { get: (n) => (n === 'fs' ? fakeFs({ [rbPath]: '{"steps":[{"command":"echo hi"}]}' }) : undefined) }
  const loaded = await loadRunbook(goodCtx, 'release', { workspaceRoot: root })
  assert.ok(loaded.path.endsWith(RUNBOOK_DIR + '/release.json'), '路径应为工作区下的 runbook 目录: ' + loaded.path)
  assert.equal(parseRunbook(loaded.text, 'rb').steps.length, 1)

  const listingCtx = {
    get: (n) => (n === 'fs' ? fakeFs({
      [root + '/' + RUNBOOK_DIR + '/release.json']: '{}',
      [root + '/' + RUNBOOK_DIR + '/rollback.json']: '{}',
    }) : undefined),
  }
  assert.deepEqual(await listRunbookNames(listingCtx, { workspaceRoot: root }), ['release', 'rollback'])
  await assert.rejects(
    () => loadRunbook(listingCtx, 'nope', { workspaceRoot: root }),
    /可用的 runbook: release, rollback/,
    '读不到时应把可用名字告诉模型',
  )
  await assert.rejects(() => loadRunbook({ get: () => undefined }, 'release', {}), /未挂载 fs 服务/)
  await assert.rejects(() => loadRunbook(listingCtx, '../etc/passwd', { workspaceRoot: root }), /名字非法/)
})

await runAsync('ecs_deploy runbook: 展开后执行 + 结果带回 runbook 元信息', async () => {
  const stub = deployStub({
    body: ({ command }) => (command.includes('${') ? JSON.stringify({
      instance_id: 'i-x', exit_code: 1, output: 'UNSUBSTITUTED', stderr: '',
    }) : undefined),
  })
  const fsStub = fakeFs({
    ['/ws/' + RUNBOOK_DIR + '/release.json']: JSON.stringify({
      name: 'release',
      description: '演示 runbook',
      params: { keep: 2 },
      steps: [
        { kind: 'exec', command: 'echo deploy ${sha}', description: '部署 ${sha}' },
        { kind: 'assert', command: 'curl -fsS http://127.0.0.1/health', expect: { stdout_contains: ['ready'] } },
      ],
    }),
  })
  const def = ecsDeployDefinition({
    get: (n) => {
      if (n === 'subprocess') return stub.subprocess
      if (n === 'fs') return fsStub
      if (n === 'sandboxPolicy') return { workspaceRoot: '/ws' }
      return undefined
    },
  })
  const value = await def.execute(
    { instance_id: 'i-x', runbook: 'release', runbook_params: { sha: 'deadbeef' } },
    stubExec(),
  )
  assert.equal(value.mode, 'steps')
  assert.equal(value.ok, true)
  assert.equal(value.total_stage, 2)
  assert.equal(value.stages.length, 2)
  assert.equal(value.runbook.name, 'release')
  assert.equal(value.runbook.source, 'workspace')
  assert.ok(String(value.runbook.path).endsWith('/release.json'))
  assert.deepEqual(value.runbook.param_keys, ['sha'])
  assert.equal(value.stages[0].name, '部署 deadbeef', '步骤描述里的占位符也应被替换')
  assert.ok(stub.calls.some((argv) => argv.join(' ').includes('echo deploy deadbeef')), '命令应已完成参数替换')
  assert.ok(!stub.calls.some((argv) => argv.join(' ').includes('${sha}')), '不得把未替换的占位符下发到远端')
  const text = def.output.render({}, value)[0].text
  assert.ok(text.includes('runbook: release'), '渲染应标注 runbook 来源')
})

await runAsync('ecs_deploy runbook: 缺参数 / 与 steps 同用 / 内联形式', async () => {
  const def = ecsDeployDefinition({ get: () => undefined })
  const exec = stubExec()
  await assert.rejects(
    () => def.execute({ instance_id: 'i-x', runbook: { steps: [{ command: 'echo ${sha}' }] } }, exec),
    /缺少参数: sha/,
  )
  await assert.rejects(
    () => def.execute({ instance_id: 'i-x', runbook: 'x', steps: [{ command: 'echo a' }] }, exec),
    /runbook 与 steps 不能同时使用/,
  )
  await assert.rejects(
    () => def.execute({ instance_id: 'i-x', runbook: 'x', local_file: 'a.tgz', remote_path: '/a' }, exec),
    /不要再传 local_file/,
  )
  await assert.rejects(() => def.execute({ instance_id: 'i-x', runbook: ['not', 'allowed'] }, exec), /runbook 必须是名字字符串/)

  // 内联 runbook + 隐式 instance_id + dry_run 预演
  const stub = deployStub()
  const def2 = deployDefWith(stub)
  const plan = await def2.execute({
    instance_id: 'i-x',
    dry_run: true,
    runbook: { name: 'inline-demo', steps: [{ kind: 'exec', command: 'echo on ${instance_id}' }] },
  }, stubExec())
  assert.equal(plan.dry_run, true)
  assert.equal(plan.runbook.source, 'inline')
  assert.equal(plan.runbook.name, 'inline-demo')
  assert.ok(plan.plan[0].command_line.includes('echo on i-x'), '隐式 instance_id 应可用: ' + plan.plan[0].command_line)
  assert.equal(stub.calls.length, 0, 'dry_run 不得下发命令')
})

// ---- v0.6.2: 设置页 RPC 的 runbook 操作(面板侧列出/预演/执行) ----
// 用与 lib/index.js 同形的装配: runCli 走 CLI 输出, makeStepsAdapter 复用它,
// 因此这里验证的就是面板真实路径(而不只是引擎本身)。
function panelRunCli(handler) {
  return async (argv) => {
    const argvList = argv.map((a) => String(a))
    const reply = handler(argvList)
    const text = typeof reply === 'string' ? reply : JSON.stringify(reply)
    return { exitCode: 0, stdout: text, stderr: '' }
  }
}

function settingsCoreWith(files, handler, opts = {}) {
  const runCli = panelRunCli(handler)
  return createSettingsCore(runCli, {
    runbookDir: '/ws/' + RUNBOOK_DIR,
    listRunbooks: async () => Object.keys(files),
    loadRunbook: async (name) => {
      if (!Object.prototype.hasOwnProperty.call(files, name)) throw new Error('FS_NOT_FOUND: ' + name)
      return { text: files[name], path: '/ws/' + RUNBOOK_DIR + '/' + name + '.json' }
    },
    makeStepsAdapter: opts.noAdapter === true ? undefined : () => ({
      run: (argv) => runCli(argv),
      localSha256: async () => undefined,
      remoteSha256: async () => undefined,
      sleep: async () => {},
      hasTimer: false,
    }),
  })
}

// 面板用的小 CLI 替身: exec 回显命令行(便于断言"下发的是什么"), 其余命令回 JSON
function panelCliEcho() {
  return panelRunCli((argv) => {
    const ci = argv.indexOf('--command')
    const command = ci >= 0 ? argv[ci + 1] : ''
    return { instance_id: 'i-x', exit_code: 0, output: 'ran: ' + command, stderr: '', request_id: 'r-1', session_id: 's-1' }
  })
}

const RB_FILES = {
  release: JSON.stringify({
    name: 'release',
    description: '演示发布跑书',
    params: { sha: 'latest' },
    steps: [
      { kind: 'exec', command: 'echo deploy ${sha}', description: '部署 ${sha}' },
      { kind: 'assert', command: 'curl -fsS http://127.0.0.1/health', expect: { stdout_contains: ['ran:'] } },
    ],
  }),
  broken: '{ this is not json }',
}

await runAsync('设置页 runbook-list: 列出名称/形状, 坏文件标为无效而不影响其它条目', async () => {
  const core = settingsCoreWith(RB_FILES, () => '{}')
  const res = await core.runbookList()
  assert.equal(res.ok, true)
  assert.ok(String(res.dir).endsWith(RUNBOOK_DIR), '应回报 runbook 目录: ' + res.dir)
  const release = res.runbooks.find((r) => r.name === 'release')
  assert.equal(release.valid, true)
  assert.equal(release.step_count, 2)
  assert.deepEqual(release.kinds.map((k) => k.kind + '×' + k.count), ['assert×1', 'exec×1'])
  assert.deepEqual(release.declared_params, ['sha'])
  assert.equal(release.description, '演示发布跑书')
  const broken = res.runbooks.find((r) => r.name === 'broken')
  assert.equal(broken.valid, false)
  assert.match(String(broken.error), /JSON 解析失败/)
})

await runAsync('设置页 runbook-plan: 预演给出计划; 缺参数显式报告而不是静默执行', async () => {
  const core = settingsCoreWith(RB_FILES, () => '{}')
  const plan = await core.runbookPlan({ instance_id: 'i-x', runbook: 'release' })
  assert.equal(plan.ok, true)
  assert.equal(plan.dry_run, true)
  assert.equal(plan.total_stage, 2)
  assert.equal(plan.runbook.name, 'release')
  assert.equal(plan.runbook.source, 'workspace')
  assert.ok(plan.plan[0].command_line.includes('echo deploy latest'), '应使用默认参数: ' + plan.plan[0].command_line)
  assert.equal(plan.valid, true)

  const missing = await core.runbookPlan({ instance_id: 'i-x', runbook: 'no-default', params: {} })
  assert.equal(missing.ok, false, '未知 runbook 应返回 ok:false 而不是抛错')
  assert.match(String(missing.error), /FS_NOT_FOUND|可用的 runbook|读取 runbook 失败/)

  const noDefault = settingsCoreWith({
    x: JSON.stringify({ steps: [{ command: 'echo ${sha}' }] }),
  }, () => '{}')
  const miss = await noDefault.runbookPlan({ instance_id: 'i-x', runbook: 'x' })
  assert.equal(miss.ok, false)
  assert.deepEqual(miss.missing, ['sha'])
  assert.ok(String(miss.error).includes('缺少参数: sha'))
})

await runAsync('设置页 runbook-plan: 单步 timeout 一路进入预演(v0.6.6)', async () => {
  const core = settingsCoreWith({
    timed: JSON.stringify({ steps: [{ kind: 'exec', command: 'bash /opt/release.sh', timeout: 300 }] }),
  }, () => '{}')
  const plan = await core.runbookPlan({ instance_id: 'i-x', runbook: 'timed' })
  assert.equal(plan.ok, true)
  assert.equal(plan.plan[0].timeout, 300, '预演应回报单步超时')
  assert.ok(plan.plan[0].command_line.includes('--timeout 300'), '预演命令行应带 300: ' + plan.plan[0].command_line)
  const fallback = await core.runbookPlan({ instance_id: 'i-x', runbook: 'timed', timeout: 60 })
  assert.equal(fallback.plan[0].timeout, 300, '单步值优先于面板选的全局超时')
})

await runAsync('设置页 runbook-plan 与 ecs_deploy 工具的计划逐字一致(两条通道不漂移)', async () => {
  const steps = [
    { kind: 'exec', command: 'echo deploy latest', description: '部署 latest' },
    { kind: 'assert', command: 'curl -fsS http://127.0.0.1/health', expect: { stdout_contains: ['ran:'] } },
  ]
  const toolPlan = await ecsDeployDefinition({ get: () => undefined }).execute(
    { instance_id: 'i-x', region: 'cn-shanghai', dry_run: true, timeout: 90, steps },
    stubExec(),
  )
  const core = settingsCoreWith(RB_FILES, () => '{}')
  const panelPlan = await core.runbookPlan({ instance_id: 'i-x', region: 'cn-shanghai', timeout: 90, runbook: 'release' })
  assert.equal(panelPlan.ok, true)
  assert.deepEqual(
    panelPlan.plan.map((p) => p.kind + ' ' + p.command_line),
    toolPlan.plan.map((p) => p.kind + ' ' + p.command_line),
    '面板预演与工具预演必须逐字一致',
  )
})

await runAsync('设置页 runbook-run: 真实执行(引擎+适配器), 断言逐条回报', async () => {
  const core = settingsCoreWith(RB_FILES, (argv) => {
    const ci = argv.indexOf('--command')
    return {
      instance_id: 'i-x', exit_code: 0,
      output: ci >= 0 ? 'ran: ' + argv[ci + 1] : '', stderr: '', request_id: 'r-1', session_id: 's-1',
    }
  })
  const res = await core.runbookRun({ instance_id: 'i-x', runbook: 'release', params: { sha: 'deadbeef' } })
  assert.equal(res.ok, true, JSON.stringify(res))
  assert.equal(res.mode, 'steps')
  assert.equal(res.total_stage, 2)
  assert.equal(res.stages.length, 2)
  assert.equal(res.stages[0].name, '部署 deadbeef', '参数应已替换')
  assert.ok(String(res.stages[0].output).includes('echo deploy deadbeef'))
  assert.ok(res.stages[1].assertions.every((a) => a.ok === true), JSON.stringify(res.stages[1].assertions))
  assert.equal(res.runbook.name, 'release')
  assert.equal(res.runbook.param_keys.join(','), 'sha')
})

await runAsync('设置页 runbook-run: 参数可直接传 JSON 文本(面板输入框), 非法 JSON 明确报错', async () => {
  const core = settingsCoreWith(RB_FILES, () => '{}', { noAdapter: true })
  const bad = await core.runbookRun({ instance_id: 'i-x', runbook: 'release', params: '{oops' })
  assert.equal(bad.ok, false)
  assert.match(String(bad.error), /不是合法 JSON/)
  const later = await core.runbookRun({ instance_id: 'i-x', runbook: 'release', params: '[1,2]' })
  assert.match(String(later.error), /必须是 JSON 对象/)
  const okText = await core.runbookRun({ instance_id: 'i-x', runbook: 'release', params: '{"sha":"abc"}' })
  assert.equal(okText.ok, false, '无执行适配器时应拒绝执行')
  assert.match(String(okText.error), /未提供本机执行适配器/)
})

await runAsync('设置页 runbook-run: 破坏性命令直接拒绝(面板无审批上下文)', async () => {
  const files = {
    danger: JSON.stringify({ steps: [{ kind: 'exec', command: 'echo prepare' }, { kind: 'exec', command: 'rm -rf /var/lib/x' }] }),
    readonly: JSON.stringify({ steps: [{ kind: 'exec', command: 'rm -rf /tmp/x', read_only: true }] }),
  }
  const core = settingsCoreWith(files, () => ({}))
  const danger = await core.runbookRun({ instance_id: 'i-x', runbook: 'danger' })
  assert.equal(danger.ok, false)
  assert.match(String(danger.error), /已拦截破坏性命令/)
  assert.ok(String(danger.error).includes('步骤 [1]'), '错误信息应定位到具体步骤: ' + danger.error)
  const ro = await core.runbookRun({ instance_id: 'i-x', runbook: 'readonly' })
  assert.equal(ro.ok, false)
  assert.match(String(ro.error), /写操作模式/)
})

await runAsync('设置页 runbook-run: 缺少 instance_id / 未知 runbook 都返回 ok:false', async () => {
  const core = settingsCoreWith(RB_FILES, () => '{}')
  const noInstance = await core.runbookRun({ runbook: 'release' })
  assert.equal(noInstance.ok, false)
  assert.match(String(noInstance.error), /需要 instance_id/)
  const badShape = await core.runbookRun({ instance_id: 'i-x', runbook: ['nope'] })
  assert.equal(badShape.ok, false)
  assert.match(String(badShape.error), /runbook 必须是名字字符串/)
})

// ---- v0.6.3: Runbook 静态校验(lint)与 ecs_runbook 工具 ----
run('$${name} 转义: shell 变量不再被当成 runbook 占位符', () => {
  assert.equal(substituteParams('echo $${HOME}', {}), 'echo ${HOME}', '转义后应原样保留 ${HOME}')
  assert.equal(substituteParams('echo $${HOME} && echo ${sha}', { sha: 'abc' }), 'echo ${HOME} && echo abc')
  assert.equal(substituteParams('$${sha}', { sha: 'abc' }), '${sha}', '转义优先于替换')
  assert.deepEqual(Array.from(collectParamNames('echo $${HOME} ${sha}')), ['sha'], '转义后的名字不计入声明参数')
  const missing = new Set()
  substituteParams('echo $${HOME}', {}, missing)
  assert.deepEqual(Array.from(missing), [], '转义不产生缺失参数')
  // 未转义的 shell 变量仍按占位符处理(并给出转义提示, 见 lint 用例)
  assert.equal(substituteParams('echo ${HOME}', {}), 'echo ${HOME}')
})

run('lintRunbook: 结构/字段/断言/护栏/参数五类问题一次报全', () => {
  const text = JSON.stringify({
    name: 'demo',
    params: { sha: 'latest', unused: 'x' },
    steps: [
      { kind: 'exec', command: 'echo ${sha}', commnad: 'typo' },              // 字段笔误
      { kind: 'assert', command: 'curl -fsS http://127.0.0.1/health', expect: {} }, // 断言无判据
      { kind: 'exec', command: 'rm -rf /tmp/x', read_only: true },            // 只读矛盾 + 破坏性
      { kind: 'tail', path: '/tmp/x.log' },                                    // 只读一次
      { kind: 'upload', local_file: 'a.tgz', remote_path: '/opt/', verify_sha256: false }, // 关闭校验
      { kind: 'exec', command: 'echo ${MISSING_ENV}' },                        // 缺参数(像 shell 变量)
    ],
  })
  const report = lintRunbook(text, { name: 'demo' })
  assert.equal(report.ok, false, '有 error 时 ok 应为 false')
  const codes = report.issues.map((i) => i.code)
  for (const code of ['unknown_field', 'weak_assert', 'read_only_conflict', 'destructive', 'tail_once', 'no_verify', 'missing_param', 'unused_default']) {
    assert.ok(codes.includes(code), '应报出 ' + code + ', 实际: ' + codes.join(','))
  }
  assert.equal(report.error_count, 2, '错误应为 2 条(只读矛盾 + 缺参数)')
  assert.ok(report.warn_count >= 5, '提醒应不少于 5 条, 实际 ' + report.warn_count)
  const typo = report.issues.find((i) => i.code === 'unknown_field')
  assert.equal(typo.step, 0)
  assert.match(typo.message, /是否想写 command/)
  const missing = report.issues.find((i) => i.code === 'missing_param')
  assert.match(missing.message, /缺少参数 MISSING_ENV/)
  assert.match(missing.message, /\$\$\{MISSING_ENV\} 转义/, '大写名字应给转义提示: ' + missing.message)
  assert.equal(report.summary.step_count, 6)
  assert.deepEqual(report.declared_params, ['MISSING_ENV', 'sha'])
})

run('lintRunbook: 结构错误与执行期报错同源(含 step 定位)', () => {
  const report = lintRunbook(JSON.stringify({
    steps: [
      { kind: 'exec', command: 'echo ok' },
      { kind: 'upload', remote_path: '/only-remote' },
      { kind: 'rm', command: 'x' },
      { command: 'a', script: 'b' },
    ],
  }), { name: 'bad' })
  assert.equal(report.ok, false)
  const stepErrors = report.issues.filter((i) => i.code === 'step_invalid')
  assert.equal(stepErrors.length, 3, '三步各自应报一条结构错误: ' + JSON.stringify(report.issues))
  assert.deepEqual(stepErrors.map((i) => i.step), [1, 2, 3])
  assert.match(stepErrors[0].message, /缺少 local_file/)
  assert.match(stepErrors[1].message, /kind 非法/)
  assert.match(stepErrors[2].message, /二选一/)
})

run('lintRunbook: 解析失败与干净 runbook', () => {
  const broken = lintRunbook('{ not json }', { name: 'broken' })
  assert.equal(broken.ok, false)
  assert.equal(broken.issues[0].code, 'parse')
  assert.equal(broken.summary, undefined)

  const clean = lintRunbook(JSON.stringify({
    name: 'clean',
    params: { sha: 'latest', log: '/tmp/r.log' },
    steps: [
      { kind: 'upload', local_file: 'dist.tgz', remote_path: '/opt/', description: '上传' },
      { kind: 'exec', command: 'bash /opt/deploy.sh ${sha}', description: '执行' },
      { kind: 'assert', command: 'curl -fsS http://127.0.0.1/health', expect: { stdout_contains: ['ok'] } },
      { kind: 'tail', path: '${log}', exit_file: '${log}.exit', wait_seconds: 60 },
    ],
  }), { name: 'clean' })
  assert.equal(clean.ok, true, JSON.stringify(clean.issues))
  assert.equal(clean.error_count, 0)
  assert.equal(clean.warn_count, 0)
  assert.deepEqual(clean.missing_params, undefined)
})

// ---- v0.6.6: 单步超时(timeout)此前被静默忽略 ----
run('steps: 单步 timeout 覆盖全局, 非法值退回全局, 超大值截断', () => {
  const plan = planSteps([
    { kind: 'exec', command: 'echo a' },
    { kind: 'exec', command: 'echo b', timeout: 300 },
    { kind: 'assert', command: 'echo c', expect: { stdout_contains: ['c'] }, timeout: '120' },
    { kind: 'exec', command: 'echo d', timeout: 0 },
    { kind: 'exec', command: 'echo e', timeout: 'soon' },
    { kind: 'exec', command: 'echo f', timeout: 999999 },
  ], { instance_id: 'i-x', timeout: 90 })
  assert.equal(plan[0].timeout, '90', '未写 timeout 时用全局值')
  assert.equal(plan[1].timeout, '300', '单步 timeout 必须覆盖全局值')
  assert.equal(plan[2].timeout, '120', '数字字符串同样有效')
  assert.equal(plan[3].timeout, '90', 'timeout=0 非法, 退回全局')
  assert.equal(plan[4].timeout, '90', '非数字非法, 退回全局')
  assert.equal(plan[5].timeout, String(STEPS_MAX_STEP_TIMEOUT), '超大值截断到上限')
  const at = plan[1].argv.indexOf('--timeout')
  assert.ok(at >= 0, '应显式下发 --timeout: ' + plan[1].argv.join(' '))
  assert.equal(plan[1].argv[at + 1], '300', 'argv 里下发的必须是单步值')
  assert.ok(plan[1].command_line.includes('--timeout 300'), '预演命令行应带单步值: ' + plan[1].command_line)
  assert.equal(stepTimeoutOf({ timeout: 45 }, 180), '45')
  assert.equal(stepTimeoutOf(undefined, 180), '180', 'step 不是对象时退回兜底值')
})

run('lintRunbook: timeout 写了却不生效的两种情形都要报出来', () => {
  const report = lintRunbook(JSON.stringify({
    steps: [
      { kind: 'exec', command: 'echo a', timeout: -5 },
      { kind: 'exec', command: 'echo b', timeout: 999999 },
      { kind: 'exec', command: 'echo c', timeout: 300 },
    ],
  }), { name: 'to' })
  assert.equal(report.error_count, 0, JSON.stringify(report.issues))
  assert.equal(report.warn_count, 2, '合法 timeout 不应产生提醒: ' + JSON.stringify(report.issues))
  const bad = report.issues.find((i) => i.code === 'bad_timeout')
  assert.equal(bad.step, 0)
  assert.match(bad.message, /不是正数/)
  const clamped = report.issues.find((i) => i.code === 'timeout_clamped')
  assert.equal(clamped.step, 1)
  assert.match(clamped.message, /3600/)
})

run('lintRunbook: timeout 写成占位符不算非法(v0.6.7 —— 只看替换后的值)', () => {
  const text = JSON.stringify({
    params: { t: 300, bad: 'soon' },
    steps: [
      { kind: 'exec', command: 'bash /opt/release.sh', timeout: '${t}' },
      { kind: 'exec', command: 'echo b', timeout: '${bad}' },
    ],
  })
  const report = lintRunbook(text, { name: 'tpl' })
  assert.equal(report.error_count, 0, JSON.stringify(report.issues))
  const warns = report.issues.filter((i) => i.code === 'bad_timeout')
  assert.equal(warns.length, 1, '只有替换后真的非法的那个才该报: ' + JSON.stringify(report.issues))
  assert.equal(warns[0].step, 1)
  const run = buildRunbookRun(parseRunbook(text, 'tpl'), {}, { instance_id: 'i-x' })
  const plan = planSteps(run.steps, { instance_id: 'i-x' })
  assert.equal(plan[0].timeout, '300', '合法占位符应替换成单步超时')
  assert.equal(plan[1].timeout, '180', '非法值退回全局默认')
})

await runAsync('ecs_runbook 工具: list / validate / plan(纯只读, 零远程调用)', async () => {
  const files = {
    ['/ws/' + RUNBOOK_DIR + '/demo.json']: JSON.stringify({
      name: 'demo', description: '演示', params: { sha: 'latest' },
      steps: [{ kind: 'exec', command: 'echo ${sha}' }],
    }),
    ['/ws/' + RUNBOOK_DIR + '/broken.json']: '{ broken',
  }
  const ctx = {
    get: (n) => {
      if (n === 'fs') return fakeFs(files)
      if (n === 'sandboxPolicy') return { workspaceRoot: '/ws' }
      return undefined
    },
  }
  const def = ecsRunbookDefinition(ctx)
  const exec = { name: 'ecs_runbook', signal: { aborted: false } }

  const list = await def.execute({ action: 'list' }, exec)
  assert.equal(list.action, 'list')
  assert.equal(list.count, 2)
  assert.ok(String(list.dir).endsWith(RUNBOOK_DIR))
  const demo = list.runbooks.find((r) => r.name === 'demo')
  assert.equal(demo.ok, true)
  assert.equal(demo.step_count, 1)
  assert.deepEqual(demo.declared_params, ['sha'])
  const broken = list.runbooks.find((r) => r.name === 'broken')
  assert.equal(broken.ok, false)
  assert.ok(broken.error_count >= 1)

  const report = await def.execute({ action: 'validate', runbook: 'demo' }, exec)
  assert.equal(report.action, 'validate')
  assert.equal(report.ok, true)
  assert.equal(report.error_count, 0)
  const reportText = def.output.render({}, report)[0].text
  assert.ok(reportText.includes('Runbook 校验'), reportText.slice(0, 120))
  assert.ok(reportText.includes('未发现问题'), reportText.slice(0, 200))

  const plan = await def.execute({ action: 'plan', runbook: 'demo', instance_id: 'i-x', runbook_params: { sha: 'deadbeef' } }, exec)
  assert.equal(plan.action, 'plan')
  assert.equal(plan.ok, true)
  assert.equal(plan.total_stage, 1)
  assert.ok(plan.plan[0].command_line.includes('echo deadbeef'), plan.plan[0].command_line)
  const planText = def.output.render({}, plan)[0].text
  assert.ok(planText.includes('未执行任何命令'), planText.slice(0, 300))

  // 缺参数: plan 明确拒绝而不是下发未替换的占位符
  const missing = await def.execute({ action: 'plan', runbook: { steps: [{ command: 'echo ${nope}' }] } }, exec)
  assert.equal(missing.ok, false)
  assert.deepEqual(missing.missing_params, ['nope'])
  // 动作白名单
  await assert.rejects(() => def.execute({ action: 'run' }, exec), /action 非法/)
  assert.ok(def.presentCall({ action: 'list' }).title.includes('list'))
})

await runAsync('设置页 runbook-validate: 单份静态校验(含参数齐备性), 列表带校验计数', async () => {
  const files = {
    good: JSON.stringify({ name: 'good', steps: [{ command: 'echo hi' }] }),
    needparam: JSON.stringify({ steps: [{ command: 'echo ${sha}' }] }),
    typo: JSON.stringify({ steps: [{ kind: 'exec', commnad: 'echo x', command: 'echo y' }] }),
  }
  const core = settingsCoreWith(files, () => '{}')
  const list = await core.runbookList()
  const good = list.runbooks.find((r) => r.name === 'good')
  assert.equal(good.lint_ok, true)
  assert.equal(good.error_count, 0)
  const need = list.runbooks.find((r) => r.name === 'needparam')
  assert.equal(need.lint_ok, true, '列表视图里"缺参数"不计为错误(是否缺取决于本次入参)')
  assert.deepEqual(need.required_params, ['sha'], '应给出必填参数(无默认值且非隐式)')
  const typo = list.runbooks.find((r) => r.name === 'typo')
  assert.equal(typo.error_count, 0)
  assert.ok(typo.warn_count >= 1)
  assert.match(String(typo.first_issue), /不被 exec 步骤识别/)

  const okReport = await core.runbookValidate({ runbook: 'good' })
  assert.equal(okReport.ok, true)
  assert.equal(okReport.error_count, 0)
  assert.equal(okReport.source, 'workspace')
  const missingReport = await core.runbookValidate({ runbook: 'needparam' })
  assert.equal(missingReport.ok, false)
  assert.deepEqual(missingReport.missing_params, ['sha'])
  const withParams = await core.runbookValidate({ runbook: 'needparam', params: '{"sha":"x"}' })
  assert.equal(withParams.ok, true, '传入参数后应通过(参数可用 JSON 文本)')
  const badJson = await core.runbookValidate({ runbook: 'needparam', params: '{oops' })
  assert.equal(badJson.ok, false)
  assert.match(String(badJson.error), /不是合法 JSON/)
  const inline = await core.runbookValidate({ runbook: { name: 'inline', steps: [{ path: '/x' }] } })
  assert.equal(inline.source, 'inline')
  assert.equal(inline.ok, false)
})

// ---- D11(v0.6.4): 工作目录 / 跑书目录必须取**会话工作区**, 而不是部署兜底 ----
run('resolveWorkspaceRoot: 会话 cwd 优先于部署兜底(两条来源)', () => {
  const session = { header: { cwd: 'E:/proj' } }
  const execWith = { agent: { session } }
  // 1. policy.resolve 给出会话 cwd(与 DSH 内置工具同源的做法)
  const policyCtx = {
    get: (n) => (n === 'sandboxPolicy'
      ? { workspaceRoot: 'C:/fallback', resolve: (req) => ({ workspaceRoot: req.session !== undefined ? req.session.header.cwd : 'C:/fallback' }) }
      : undefined),
  }
  assert.equal(resolveWorkspaceRoot(policyCtx, execWith), 'E:/proj', '有会话时应取会话 cwd')
  assert.equal(resolveWorkspaceRoot(policyCtx, undefined), 'C:/fallback', '无会话时应回落部署兜底')
  // 2. policy 只有裸属性(无 resolve)时, 用 session.header.cwd
  const bareCtx = { get: (n) => (n === 'sandboxPolicy' ? { workspaceRoot: 'C:/fallback' } : undefined) }
  assert.equal(resolveWorkspaceRoot(bareCtx, execWith), 'E:/proj')
  assert.equal(resolveWorkspaceRoot(bareCtx, undefined), 'C:/fallback')
  // 3. 完全没有 policy 时: 有会话用会话, 无会话返回 undefined(调用方兜底 '.')
  assert.equal(resolveWorkspaceRoot({ get: () => undefined }, execWith), 'E:/proj')
  assert.equal(resolveWorkspaceRoot({ get: () => undefined }, undefined), undefined)
  assert.equal(sessionOf(execWith), session)
  assert.equal(sessionOf(undefined), undefined)
  assert.equal(sessionOf({ agent: {} }), undefined)
})

await runAsync('D11: 工具子进程的工作目录取会话工作区(CLI 相对路径不再落到 $HOME)', async () => {
  const seen = []
  const subprocess = {
    async resolveExecutable(name) { return name },
    spawn(spec) { seen.push({ cwd: spec.cwd }); return cannedHandle(JSON.stringify({ instances: [] })) },
  }
  const ctx = {
    get: (n) => {
      if (n === 'subprocess') return subprocess
      if (n === 'sandboxPolicy') {
        return {
          workspaceRoot: 'C:/deploy-fallback',
          resolve: (req) => ({ workspaceRoot: req.session !== undefined ? req.session.header.cwd : 'C:/deploy-fallback' }),
        }
      }
      return undefined
    },
  }
  const def = ecsListDefinition(ctx)
  const exec = { name: 'ecs_list', signal: { aborted: false }, agent: { session: { header: { cwd: 'E:/proj' } } } }
  await def.execute({ region: 'cn-shanghai' }, exec)
  assert.equal(seen.length, 1)
  assert.equal(seen[0].cwd, 'E:/proj', '有会话时应以会话工作区为 cwd, 实际 ' + seen[0].cwd)
  seen.length = 0
  await def.execute({ region: 'cn-shanghai' }, { name: 'ecs_list', signal: { aborted: false } })
  assert.equal(seen[0].cwd, 'C:/deploy-fallback', '无会话时回落部署兜底')
})

await runAsync('D11: ecs_runbook 按会话工作区找跑书(不再去 $HOME)', async () => {
  const files = {
    ['E:/proj/' + RUNBOOK_DIR + '/release.json']: JSON.stringify({ name: 'release', steps: [{ command: 'echo hi' }] }),
    ['C:/home/' + RUNBOOK_DIR + '/other.json']: JSON.stringify({ name: 'other', steps: [{ command: 'echo other' }] }),
  }
  const ctx = {
    get: (n) => {
      if (n === 'fs') return fakeFs(files)
      if (n === 'sandboxPolicy') return { workspaceRoot: 'C:/home' }
      return undefined
    },
  }
  const def = ecsRunbookDefinition(ctx)
  const withSession = await def.execute({ action: 'list' }, {
    name: 'ecs_runbook', signal: { aborted: false }, agent: { session: { header: { cwd: 'E:/proj' } } },
  })
  assert.equal(withSession.count, 1, '应只在会话工作区里找: ' + JSON.stringify(withSession.runbooks.map((r) => r.name)))
  assert.equal(withSession.runbooks[0].name, 'release')
  assert.ok(String(withSession.dir).replace(/\\/g, '/').startsWith('E:/proj/'), '目录应来自会话工作区: ' + withSession.dir)
  const fallback = await def.execute({ action: 'list' }, { name: 'ecs_runbook', signal: { aborted: false } })
  assert.equal(fallback.runbooks[0].name, 'other')
  assert.ok(String(fallback.dir).replace(/\\/g, '/').startsWith('C:/home/'), fallback.dir)
})

await runAsync('D11: 设置页 runbook 目录可显式覆盖(dir 参数), 且优先于跟随值', async () => {
  const core = createSettingsCore(async () => ({ exitCode: 0, stdout: '{}', stderr: '' }), {
    runbookDirOf: (args) => (args.dir !== undefined ? String(args.dir) : '/followed/' + RUNBOOK_DIR),
    listRunbooks: async (args) => (args.dir !== undefined ? ['from-override'] : ['from-followed']),
    loadRunbook: async (name, args) => ({ text: JSON.stringify({ steps: [{ command: 'echo ' + name }] }), path: args.dir + '/' + name + '.json' }),
  })
  const followed = await core.runbookList()
  assert.equal(followed.dir, '/followed/' + RUNBOOK_DIR)
  assert.deepEqual(followed.runbooks.map((r) => r.name), ['from-followed'])
  const override = await core.runbookList({ dir: 'E:/AiProject/nailong/' + RUNBOOK_DIR })
  assert.equal(override.dir, 'E:/AiProject/nailong/' + RUNBOOK_DIR)
  assert.deepEqual(override.runbooks.map((r) => r.name), ['from-override'])
  const plan = await core.runbookPlan({ instance_id: 'i-x', runbook: 'release', dir: 'E:/proj/' + RUNBOOK_DIR })
  assert.equal(plan.ok, true)
  assert.ok(String(plan.runbook.path).startsWith('E:/proj/'), 'loadRunbook 应拿到同一目录: ' + plan.runbook.path)
})

// ============================================================================
// v0.7.0 —— G1 护栏拒绝信息 / G2 审批策略 / D14 超时结算 / R1 上传重试 /
//          S1 校验默认值 / F1 跨地域 / A1 实例锚点 / D1 sections / L1 多路径
// ============================================================================
console.log('')
console.log('== v0.7.0 新增能力 ==')

// ---- G1: 只读护栏逐条列出命中(反馈 §三.4/§三.6) ----
run('G1: scanWriteCommands 逐条给出 rule/命中文本/位置', () => {
  const script = 'mkdir -p /tmp/snap && docker images > /tmp/snap/images.txt && cp -r /data /data.bak && curl -o /tmp/x.tar.gz https://x/y'
  const hits = scanWriteCommands(script)
  assert.ok(hits.length >= 4, '反馈里那种脚本的多个写动作都要报出来, 实际: ' + JSON.stringify(hits.map((h) => h.rule)))
  for (const hit of hits) {
    assert.equal(typeof hit.rule, 'string')
    assert.ok(hit.rule.length > 0)
    assert.ok(hit.matched_text.length > 0, '必须给出命中文本')
    assert.ok(hit.span.start >= 0 && hit.span.end > hit.span.start, '必须给出位置区间: ' + JSON.stringify(hit.span))
    assert.equal(script.slice(hit.span.start, hit.span.end).includes(hit.matched_text.replace(/…$/, '')), true,
      '位置区间应对得上命中文本: ' + JSON.stringify(hit))
  }
  const matched = hits.map((h) => h.matched_text).join('|')
  assert.ok(matched.includes('mkdir'), '应能看见 mkdir: ' + matched)
  assert.ok(matched.includes('cp'), '同一规则的第二处(cp)也要列出来: ' + matched)
  assert.ok(matched.includes('>'), '重定向要列出来: ' + matched)
  assert.ok(matched.includes('curl -o'), '下载落盘要列出来: ' + matched)
  const rules = hits.map((h) => h.rule).join('|')
  assert.ok(rules.includes('文件增删改'), 'mkdir/cp 应命中文件增删改: ' + rules)
  assert.ok(rules.includes('输出重定向'), '> 应命中输出重定向: ' + rules)
  assert.ok(rules.includes('下载落盘'), 'curl -o 应命中下载落盘: ' + rules)
})

run('G1: guardReadOnly 报错含全部命中 + 只读等价写法; 只读命令零误杀', () => {
  let err
  try {
    guardReadOnly('mkdir -p /tmp/a && echo hi > /tmp/a/f', 'ecs_exec')
  } catch (e) {
    err = e
  }
  assert.ok(err !== undefined, '写操作必须被拒绝')
  const text = String(err.message)
  assert.ok(text.includes('[1]') && text.includes('[2]'), '应逐条列出(不再只报第一条): ' + text)
  assert.ok(text.includes('位置'), '应给出命中位置: ' + text)
  assert.ok(text.includes('只读等价写法建议'), '应给出"下一步怎么办": ' + text)
  assert.ok(text.includes('detach'), '只读等价写法里应包含 detach + ecs_log 的路径: ' + text)
  assert.doesNotThrow(() => guardReadOnly('df -h; docker ps; tail -n 20 /var/log/app.log'))
  const info = inspectReadOnly('echo hi > /tmp/x')
  assert.equal(info.ok, false)
  assert.equal(info.hits.length, 1)
  assert.ok(info.advice.length > 0)
})

// ---- G2: 审批四方情形分开报(反馈 §三.5) ----
function approvalFixture(policy, outcome) {
  const calls = []
  return {
    calls,
    approval: {
      effectivePolicy: () => policy,
      async request(req) {
        calls.push(req)
        return outcome
      },
    },
  }
}
const destructiveExec = { name: 'ecs_exec', callId: 'c-1', signal: { aborted: false }, agent: { session: { events: [] } } }

await runAsync('G2: 无审批服务 → fail closed 并说明原因', async () => {
  const ctx = { get: () => undefined }
  await assert.rejects(
    () => guardDestructiveCommand(ctx, destructiveExec, 'rm -rf /tmp/x'),
    (err) => {
      assert.ok(String(err.message).includes('未挂载审批服务'), err.message)
      assert.ok(String(err.message).includes('rm -rf / -fr'), '应给出命中规则: ' + err.message)
      return true
    },
  )
})

await runAsync('G2: 审批策略 never → 直接拒绝且不发起审批请求', async () => {
  const fx = approvalFixture('never', 'rejected')
  const ctx = { get: (n) => (n === 'approval' ? fx.approval : undefined) }
  await assert.rejects(
    () => guardDestructiveCommand(ctx, destructiveExec, 'reboot'),
    (err) => {
      assert.ok(String(err.message).includes('审批策略为 never'), err.message)
      assert.ok(String(err.message).includes('审批已禁用'), err.message)
      assert.ok(String(err.message).includes('重试同一条命令不会有不同结果'), '必须点明"不是命令写错": ' + err.message)
      return true
    },
  )
  assert.equal(fx.calls.length, 0, 'never 策略下不应发起审批请求')
})

await runAsync('G2: 用户拒绝 / 取消 / 无应答者 三种情形文案不同', async () => {
  const messages = {}
  for (const outcome of ['rejected', 'cancelled', 'unavailable']) {
    const fx = approvalFixture('ask', outcome)
    const ctx = { get: (n) => (n === 'approval' ? fx.approval : undefined) }
    let err
    try {
      await guardDestructiveCommand(ctx, destructiveExec, 'mkfs.ext4 /dev/sdb')
    } catch (e) {
      err = e
    }
    assert.ok(err !== undefined, outcome + ' 必须拒绝')
    messages[outcome] = String(err.message)
    assert.equal(fx.calls.length, 1, outcome + ' 应发起一次审批请求')
  }
  assert.ok(messages.rejected.includes('用户在审批中拒绝'), messages.rejected)
  assert.ok(messages.cancelled.includes('审批请求被取消'), messages.cancelled)
  assert.ok(messages.unavailable.includes('无审批应答者'), messages.unavailable)
  assert.notEqual(messages.rejected, messages.cancelled)
  assert.notEqual(messages.rejected, messages.unavailable)
})

await runAsync('G2: 获批(allowed-once)时放行; 无 agent/callId 上下文时拒绝', async () => {
  const fx = approvalFixture('ask', 'allowed-once')
  const ctx = { get: (n) => (n === 'approval' ? fx.approval : undefined) }
  await guardDestructiveCommand(ctx, destructiveExec, 'systemctl stop nginx')
  assert.equal(fx.calls.length, 1)
  await assert.rejects(
    () => guardDestructiveCommand(ctx, { name: 'ecs_exec', signal: { aborted: false } }, 'reboot'),
    /缺少审批上下文/,
  )
})

// ---- D14: 远端超时不能当成成功 ----
run('D14: remoteResultOf 把 timed_out 结算成 exit 124(否则会显示成功 + 无输出)', () => {
  const timeoutJson = { exit_code: 0, stdout: '', output: '', stderr: '', timed_out: true, duration: '3.002s' }
  const r = remoteResultOf(timeoutJson, { exitCode: 124, stderr: '{"code":124,"message":"command timed out after 3s"}', stdout: '' })
  assert.equal(r.exit_code, 124, '超时必须报 124, 不能沿用 JSON 里的 0')
  assert.equal(r.timed_out, true)
  assert.equal(r.duration, '3.002s')
  assert.equal(r.timeout_message, 'command timed out after 3s', '应带上 CLI 的超时原因')

  const normal = remoteResultOf({ exit_code: 0, stdout: 'ok\n', output: 'ok\n', stderr: '', duration: '80ms' }, { exitCode: 0, stderr: '' })
  assert.equal(normal.exit_code, 0)
  assert.equal(normal.timed_out, undefined, '正常命令不应被标记超时')
  assert.equal(normal.output, 'ok\n')

  // 远端自身退出码仍以 JSON 为准; JSON 缺 output 时回落 stdout
  const failed = remoteResultOf({ exit_code: 3, stdout: 'x\n', stderr: 'err\n' }, { exitCode: 3, stderr: '' })
  assert.equal(failed.exit_code, 3)
  assert.equal(failed.output, 'x\n')
  assert.equal(failed.stderr, 'err\n')
  // CLI 进程 124 但 JSON 说 0(CLI 自己在本地掐断): 同样按超时处理
  assert.equal(remoteResultOf({ exit_code: 0, output: '' }, { exitCode: 124 }).exit_code, 124)
})

await runAsync('D14: ecs_exec 超时返回 exit 124 + detach 指引(不再显示成功)', async () => {
  const timeoutJson = JSON.stringify({ instance_id: 'i-x', exit_code: 0, output: '', stderr: '', timed_out: true, duration: '3.002s' })
  const stub = {
    async resolveExecutable() { return 'workbench' },
    spawn() {
      return {
        pid: 1,
        collected: {
          stdout: { readFrom: () => ({ text: timeoutJson, nextOffset: timeoutJson.length, lossy: false }) },
          stderr: { readFrom: () => ({ text: '{"code":124,"message":"command timed out after 3s"}', nextOffset: 0, lossy: false }) },
        },
        done: Promise.resolve({ exitCode: 124, signal: null }),
        terminate() {},
        async waitForExit() { return true },
      }
    },
  }
  const def = ecsExecDefinition({ get: (n) => (n === 'subprocess' ? stub : undefined) })
  const value = await def.execute({ instance_id: 'i-x', command: 'sleep 8; echo done', timeout: 3 }, { name: 'ecs_exec', signal: { aborted: false } })
  assert.equal(value.exit_code, 124, '超时应结算为 124')
  assert.equal(value.timed_out, true)
  const text = def.output.render({}, value)[0].text
  assert.ok(text.includes('[exit code: 124]'), text)
  assert.ok(text.includes('远端命令被 CLI 掐断'), text)
  assert.ok(text.includes('detach=true'), '超时提示必须给出 detach 这条下一步: ' + text)
})

// ---- R1: 上传重试只针对瞬时网络类失败 ----
run('R1: classifyTransientFailure 区分瞬时网络与语义类失败', () => {
  const transient = [
    'upload failed: upload to OSS: put object: operation error PutObject: Put "https://x": dial tcp 47.101.94.154:443: i/o timeout',
    'read tcp 10.0.0.2:55321->47.101.94.154:443: connection reset by peer',
    'command timed out after 60s',
    'context deadline exceeded',
    'unexpected EOF',
  ]
  for (const text of transient) assert.equal(classifyTransientFailure(text), true, '应判为瞬时: ' + text)
  const semantic = [
    'remote file "/tmp/x" already exists (7 B, modified Sep 27 19:59); use --force to overwrite',
    'permission denied',
    'no such file or directory',
    'invalid region "all": region does not exist or is not recognized',
  ]
  for (const text of semantic) assert.equal(classifyTransientFailure(text), false, '不应重试: ' + text)
  assert.equal(classifyTransientFailure(''), false)
})

await runAsync('R1: withRetry 瞬时失败重试, 语义失败立刻停', async () => {
  const opts = { attempts: 3, baseDelayMs: 0, maxDelayMs: 0 }
  let calls = 0
  const transient = await withRetry({ get: () => undefined }, opts, async (i) => {
    calls = i
    return i < 2 ? { ok: false, failureText: 'dial tcp 1.2.3.4:443: i/o timeout' } : { ok: true, value: 'ok' }
  })
  assert.equal(transient.ok, true)
  assert.equal(transient.attempts, 2, '第 2 次应成功')
  assert.equal(calls, 2)
  assert.equal(transient.failures.length, 1)

  let semanticCalls = 0
  const semantic = await withRetry({ get: () => undefined }, opts, async () => {
    semanticCalls += 1
    return { ok: false, failureText: 'remote file "/tmp/x" already exists; use --force to overwrite' }
  })
  assert.equal(semantic.ok, false)
  assert.equal(semantic.attempts, 1, '语义类失败不得重试')
  assert.equal(semanticCalls, 1)
  assert.equal(semantic.failures[0].transient, false)

  const ro = resolveRetryOptions({})
  assert.deepEqual({ retries: ro.retries, attempts: ro.attempts }, { retries: 2, attempts: 3 })
  assert.equal(resolveRetryOptions({ retries: 0 }).attempts, 1, 'retries: 0 表示不重试')
  assert.equal(resolveRetryOptions({ retries: 99 }).retries, 8, '重试次数有上限')
})

await runAsync('R1: ecs_upload 首次 OSS 抖动 → 自动重试并成功(attempts=2)', async () => {
  let uploadCalls = 0
  const hash = expectedHash
  const stub = {
    async resolveExecutable(name) { return name },
    spawn(spec) {
      const exe = String(spec.argv[0])
      if (exe !== 'workbench') return localSubprocess.spawn(spec)
      const argv = spec.argv.slice(1)
      let body
      let stderr = ''
      let exitCode = 0
      if (argv[0] === 'upload') {
        uploadCalls += 1
        if (uploadCalls === 1) {
          body = 'Uploading x (7 B) to i-x:/tmp/x\n'
          stderr = '{"code":1,"message":"upload failed: upload to OSS: put object: operation error PutObject: Put \\"https://oss-x\\": dial tcp 47.101.94.154:443: i/o timeout"}'
          exitCode = 1
        } else {
          body = 'Upload complete: x -> /tmp/x\n'
        }
      } else {
        body = JSON.stringify({ instance_id: 'i-x', exit_code: 0, output: hash + '  /tmp/x\n', stderr: '' })
      }
      return {
        pid: 1,
        collected: {
          stdout: { readFrom: () => ({ text: body, nextOffset: body.length, lossy: false }) },
          stderr: { readFrom: () => ({ text: stderr, nextOffset: stderr.length, lossy: false }) },
        },
        done: Promise.resolve({ exitCode, signal: null }),
        terminate() {},
        async waitForExit() { return true },
      }
    },
  }
  const def = ecsUploadDefinition({ get: (n) => (n === 'subprocess' ? stub : undefined) })
  const value = await def.execute(
    { local_file: hashFile, remote_path: '/tmp/x', instance_id: 'i-x', retries: 2, retry_delay: 0 },
    { signal: { aborted: false } },
  )
  assert.equal(uploadCalls, 2, '应重试一次后成功')
  assert.equal(value.attempts, 2)
  assert.equal(value.exit_code, 0)
  assert.equal(value.retry_errors.length, 1)
  assert.ok(value.retry_errors[0].message.includes('i/o timeout'))
  assert.equal(value.verification, 'ok', 'S1: 不传 verify_sha256 时也默认校验')
  assert.equal(value.verify_sha256, true)
  const text = def.output.render({}, value)[0].text
  assert.ok(text.includes('上传重试: 共尝试 2 次后成功'), text)
})

await runAsync('R1: 语义类失败(远端已存在)不重试, 报错点明归属', async () => {
  let uploadCalls = 0
  const stub = {
    async resolveExecutable(name) { return name },
    spawn(spec) {
      if (String(spec.argv[0]) !== 'workbench') return localSubprocess.spawn(spec)
      uploadCalls += 1
      const body = 'Uploading probe (7 B) to i-x:/tmp/x\nUpload complete: probe -> /tmp/x\n'
      const stderr = '{"code":1,"message":"remote file \\"/tmp/x\\" already exists (7 B, modified Sep 27 19:59); use --force to overwrite"}'
      return {
        pid: 1,
        collected: {
          stdout: { readFrom: () => ({ text: body, nextOffset: body.length, lossy: false }) },
          stderr: { readFrom: () => ({ text: stderr, nextOffset: stderr.length, lossy: false }) },
        },
        done: Promise.resolve({ exitCode: 1, signal: null }),
        terminate() {},
        async waitForExit() { return true },
      }
    },
  }
  const def = ecsUploadDefinition({ get: (n) => (n === 'subprocess' ? stub : undefined) })
  let err
  try {
    await def.execute({ local_file: hashFile, remote_path: '/tmp/x', instance_id: 'i-x' }, { signal: { aborted: false } })
  } catch (e) {
    err = e
  }
  assert.ok(err !== undefined, '上传失败必须报错(stdout 里有 "Upload complete" 也不能当成成功)')
  const text = String(err.message)
  assert.ok(text.includes('already exists'), text)
  assert.ok(!text.includes('已尝试'), '语义类失败不应出现重试次数: ' + text)
  assert.equal(uploadCalls, 1, '不得重试')
})

// ---- S1: verify_sha256 三处默认值统一为 true ----
run('S1: 三个入口的 verify 默认值一致(不传即校验)', () => {
  const plan = planSteps([{ kind: 'upload', local_file: 'a.jar', remote_path: '/opt/a.jar' }], { instance_id: 'i-x' })
  assert.equal(plan[0].verify, true, 'steps[].upload 默认校验')
  assert.equal(planSteps([{ kind: 'upload', local_file: 'a.jar', remote_path: '/opt/a.jar', verify_sha256: false }], { instance_id: 'i-x' })[0].verify,
    false, '显式 false 才关闭')
  const desc = ecsUploadDefinition({ get: () => undefined }).parameters.verify_sha256.description
  assert.ok(desc.includes('默认 true'), 'ecs_upload 的参数说明应写"默认 true": ' + desc)
  const deployDesc = ecsDeployDefinition({ get: () => undefined }).parameters.verify_sha256.description
  assert.ok(deployDesc.includes('默认 true'), 'ecs_deploy 的参数说明应写"默认 true": ' + deployDesc)
})

await runAsync('S1: ecs_upload 显式 verify_sha256:false 时不校验', async () => {
  const stub = {
    async resolveExecutable(name) { return name },
    spawn(spec) {
      if (String(spec.argv[0]) !== 'workbench') return localSubprocess.spawn(spec)
      const body = 'Upload complete: x -> /tmp/x\n'
      return {
        pid: 1,
        collected: {
          stdout: { readFrom: () => ({ text: body, nextOffset: body.length, lossy: false }) },
          stderr: { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) },
        },
        done: Promise.resolve({ exitCode: 0, signal: null }),
        terminate() {},
        async waitForExit() { return true },
      }
    },
  }
  const def = ecsUploadDefinition({ get: (n) => (n === 'subprocess' ? stub : undefined) })
  const value = await def.execute(
    { local_file: hashFile, remote_path: '/tmp/x', instance_id: 'i-x', verify_sha256: false },
    { signal: { aborted: false } },
  )
  assert.equal(value.verification, undefined, '显式关闭时不应有校验结论')
  assert.equal(value.verify_sha256, undefined)
})

// ---- F1: 跨地域检索 ----
run('F1: parseRegionSpec / 关键词匹配 / argv 构造', () => {
  assert.equal(parseRegionSpec(undefined).mode, 'all')
  assert.equal(parseRegionSpec('all').regions.length, ECS_PUBLIC_REGIONS.length)
  assert.deepEqual(parseRegionSpec('cn-shanghai').regions, ['cn-shanghai'])
  assert.deepEqual(parseRegionSpec('cn-shanghai, cn-hangzhou').regions, ['cn-shanghai', 'cn-hangzhou'])
  assert.equal(parseRegionSpec('CN-Shanghai').regions[0], 'cn-shanghai', '地域名应归一为小写')

  const inst = { instance_id: 'i-uf66ct2o35p7fjcd0sru', instance_name: 'iZuf66ct2o35p7fjcd0sruZ', public_ip: '47.103.38.58', tags: { env: 'prod' } }
  assert.equal(matchInstanceKeyword(inst, 'uf66'), true, '实例 ID 子串应命中')
  assert.equal(matchInstanceKeyword(inst, '47.103'), true, '公网 IP 子串应命中')
  assert.equal(matchInstanceKeyword(inst, 'PROD'), true, '标签值应命中且大小写不敏感')
  assert.equal(matchInstanceKeyword(inst, 'nailonghub'), false)
  assert.equal(matchInstanceKeyword(inst, ''), true, '空关键词 = 不过滤')

  const argv = buildListEcsArgv({ region: 'cn-shanghai', status: 'Running', tag: ['env=prod'], limit: 20 })
  assert.deepEqual(argv, ['list', 'ecs', '--region', 'cn-shanghai', '--output', 'json', '--status', 'Running', '--tag', 'env=prod', '--limit', '20'])
})

await runAsync('F1: ecs_find 跨地域检索命中并汇报检索范围', async () => {
  const calls = []
  const stub = {
    async resolveExecutable() { return 'workbench' },
    spawn(spec) {
      const argv = spec.argv.slice(1)
      calls.push(argv)
      const region = argv[argv.indexOf('--region') + 1]
      // cn-hangzhou 空(裸数组, 实测形状) / cn-beijing 报错 / 其它地域返回实例
      let body
      let exitCode = 0
      if (region === 'cn-hangzhou') body = '[]'
      else if (region === 'cn-beijing') {
        body = ''
        exitCode = 1
      } else {
        body = JSON.stringify({ instances: [{ instance_id: 'i-uf66ct2o35p7fjcd0sru', instance_name: 'prod-web', public_ip: '47.103.38.58', status: 'Running' }] })
      }
      const stderr = exitCode === 0 ? '' : '{"code":2,"message":"invalid region \\"cn-beijing\\""}'
      const text = body
      return {
        pid: 1,
        collected: {
          stdout: { readFrom: () => ({ text, nextOffset: text.length, lossy: false }) },
          stderr: { readFrom: () => ({ text: stderr, nextOffset: stderr.length, lossy: false }) },
        },
        done: Promise.resolve({ exitCode, signal: null }),
        terminate() {},
        async waitForExit() { return true },
      }
    },
  }
  const ctx = { get: (n) => (n === 'subprocess' ? stub : undefined) }
  const def = ecsFindDefinition(ctx)
  const value = await def.execute({ keyword: 'uf66', region: 'cn-shanghai,cn-hangzhou,cn-beijing' },
    { signal: { aborted: false }, name: 'ecs_find' })
  assert.equal(value.total, 1, '应命中 1 台: ' + JSON.stringify(value.hits))
  assert.equal(value.regions_tried.length, 3)
  assert.equal(value.regions_ok, 2)
  assert.equal(value.regions_failed.length, 1, '某地域失败要如实回报')
  assert.equal(value.regions_failed[0].region, 'cn-beijing')
  assert.equal(value.hits[0].instances[0].instance_id, 'i-uf66ct2o35p7fjcd0sru')
  assert.equal(calls.length, 3, '每个地域一次查询')
  const text = def.output.render({}, value)[0].text
  assert.ok(text.includes('跨地域实例检索'), text)
  assert.ok(text.includes('部分地域查询失败'), '失败地域要出现在可读输出里: ' + text)
  assert.ok(text.includes(INSTANCES_FILE), '应提示实例锚点约定: ' + text)
})

await runAsync('F1: ecs_list 0 台时提示改用 ecs_find', async () => {
  const stub = stubSubprocess('[]')
  const def = ecsListDefinition({ get: (n) => (n === 'subprocess' ? stub.subprocess : undefined) })
  const value = await def.execute({ region: 'cn-hangzhou' }, { signal: { aborted: false } })
  assert.equal(value.count, 0)
  assert.ok(String(value.empty_hint).includes('ecs_find'), '0 台时应指向 ecs_find: ' + value.empty_hint)
  assert.ok(def.output.render({}, value)[0].text.includes('ecs_find'))
})

// ---- A1: 实例锚点 ----
function anchorCtx(anchorJson, workspaceRoot) {
  return {
    get: (n) => {
      if (n === 'fs') return fakeFs({ [workspaceRoot + '/' + INSTANCES_FILE]: JSON.stringify(anchorJson) })
      if (n === 'sandboxPolicy') return { workspaceRoot }
      return undefined
    },
  }
}
const anchorRoot = 'E:/proj'
const anchorExec = { name: 'ecs_exec', signal: { aborted: false }, agent: { session: { header: { cwd: anchorRoot } } } }

await runAsync('A1: 锚点名 → instance_id, 且 region 自动补齐', async () => {
  const ctx = anchorCtx({ prod: { instance_id: 'i-uf66ct2o35p7fjcd0sru', region: 'cn-shanghai', repo: '/root/nailonghub' } }, anchorRoot)
  const resolved = await resolveAnchorsInArgs(ctx, { instance_id: 'prod', command: 'dfs' }, anchorExec)
  assert.equal(resolved.args.instance_id, 'i-uf66ct2o35p7fjcd0sru')
  assert.equal(resolved.args.region, 'cn-shanghai', 'region 应自动补齐')
  const info = anchorInfoOf(resolved.args)
  assert.equal(info.name, 'prod')
  assert.deepEqual(anchorImplicitParams(info), { repo: '/root/nailonghub' }, '锚点自定义字段应成为隐式参数')

  // 显式 region 优先于锚点
  const explicit = await resolveAnchorsInArgs(ctx, { instance_id: 'prod', region: 'cn-beijing' }, anchorExec)
  assert.equal(explicit.args.region, 'cn-beijing')
  // 真实 instance_id 原样透传(不受锚点影响)
  const raw = await resolveAnchorsInArgs(ctx, { instance_id: 'i-bp1abc' }, anchorExec)
  assert.equal(raw.args.instance_id, 'i-bp1abc')
  assert.equal(raw.anchor, undefined)
  // 批量: 锚点与真实 ID 混用
  const batch = await resolveAnchorsInArgs(ctx, { instance_ids: ['prod', 'i-bp1abc'] }, anchorExec)
  assert.deepEqual(batch.args.instance_ids, ['i-uf66ct2o35p7fjcd0sru', 'i-bp1abc'])
})

await runAsync('A1: 锚点文件缺失时按原值下发(向后兼容); 名字写错时列出可用锚点', async () => {
  const noFile = { get: (n) => (n === 'fs' ? fakeFs({}) : (n === 'sandboxPolicy' ? { workspaceRoot: anchorRoot } : undefined)) }
  const passthrough = await resolveAnchorsInArgs(noFile, { instance_id: 'prod' }, anchorExec)
  assert.equal(passthrough.args.instance_id, 'prod', '没有锚点文件时应原样下发(交给 CLI 报错)')

  const ctx = anchorCtx({
    prod: { instance_id: 'i-uf66ct2o35p7fjcd0sru', region: 'cn-shanghai' },
    staging: { instance_id: 'i-bp1staging', region: 'cn-hangzhou' },
  }, anchorRoot)
  let err
  try {
    await resolveAnchorsInArgs(ctx, { instance_id: 'prodd' }, anchorExec)
  } catch (e) {
    err = e
  }
  assert.ok(err !== undefined, '锚点名写错必须报错')
  assert.ok(String(err.message).includes('prod, staging'), '应列出可用锚点: ' + err.message)

  const loaded = await loadAnchors(ctx, { workspaceRoot: anchorRoot })
  assert.equal(loaded.ok, true)
  assert.deepEqual(loaded.names, ['prod', 'staging'])
})

await runAsync('A1: 坏锚点文件 → 降级为原值下发, 不阻断工具', async () => {
  const ctx = {
    get: (n) => {
      if (n === 'fs') return fakeFs({ [anchorRoot + '/' + INSTANCES_FILE]: '{ not json' })
      if (n === 'sandboxPolicy') return { workspaceRoot: anchorRoot }
      return undefined
    },
  }
  const resolved = await resolveAnchorsInArgs(ctx, { instance_id: 'prod' }, anchorExec)
  assert.equal(resolved.args.instance_id, 'prod')
  const loaded = await loadAnchors(ctx, { workspaceRoot: anchorRoot })
  assert.equal(loaded.ok, false)
  assert.equal(loaded.reason, 'invalid-json')
})

// ---- D1: ecs_diagnose sections / echo_command ----
run('D1: sections 子集只拼接选定段; 非法段名报错', () => {
  const all = buildDiagnoseScript('echo extra')
  for (const section of DIAGNOSE_SECTIONS) assert.ok(all.includes(section.title), '默认应采集全部段落: ' + section.title)
  const subset = buildDiagnoseScript(undefined, { sections: ['disk', 'ports'] })
  assert.ok(subset.includes('4/7 磁盘') && subset.includes('7/7 监听端口'))
  assert.ok(!subset.includes('1/7 主机信息') && !subset.includes('3/7 内存'), '未选段落不得出现在脚本里: ' + subset)
  assert.equal(checkWriteCommand(subset), undefined, 'sections 子集仍须零误杀')

  const resolved = resolveDiagnoseSections(['extra'])
  assert.deepEqual(resolved.ids, [])
  assert.equal(resolved.extra, true)
  assert.throws(() => resolveDiagnoseSections(['nope']), /未知段落/)
  assert.throws(() => resolveDiagnoseSections([]), /不能为空/)
  assert.throws(() => resolveDiagnoseSections('disk'), /必须是数组/)
})

await runAsync('D1: echo_command 默认不回显命令全文; true 时回显', async () => {
  const calls = []
  const stub = {
    async resolveExecutable() { return 'workbench' },
    spawn(spec) {
      calls.push(spec.argv.slice(1))
      const body = JSON.stringify({ instance_id: 'i-x', exit_code: 0, output: '==== 4/7 磁盘 ====\n/dev/vda1 40G\n', stderr: '' })
      return {
        pid: 1,
        collected: {
          stdout: { readFrom: () => ({ text: body, nextOffset: body.length, lossy: false }) },
          stderr: { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) },
        },
        done: Promise.resolve({ exitCode: 0, signal: null }),
        terminate() {},
        async waitForExit() { return true },
      }
    },
  }
  const def = ecsDiagnoseDefinition({ get: (n) => (n === 'subprocess' ? stub : undefined) })
  const value = await def.execute({ instance_id: 'i-x', sections: ['disk'] }, { name: 'ecs_diagnose', signal: { aborted: false } })
  assert.deepEqual(value.sections, ['disk'])
  assert.equal(value.echo_command, undefined)
  const short = def.output.render({}, value)[0].text
  assert.ok(!short.includes('$ ' + value.command), '默认不回显整段命令: ' + short)
  assert.ok(short.includes('[采集段落: disk]'), short)
  assert.ok(calls[0][calls[0].indexOf('--command') + 1].includes('df -h'), '实际下发的是子集脚本')

  const loud = def.output.render({ echo_command: true }, Object.assign({}, value, { echo_command: true }))[0].text
  assert.ok(loud.includes('$ ' + value.command), 'echo_command=true 时应回显')
})

// ---- L1: ecs_log 多路径 ----
run('L1: 多文件读取命令与分段解析', () => {
  const entries = [
    { path: '/var/log/app.log', after: 0, maxBytes: 1024 },
    { path: '/var/log/access.log', after: 5, maxBytes: 1024 },
  ]
  const command = buildMultiLogReadCommand(entries, { exitPath: '/tmp/job/exit' })
  assert.ok(command.includes("printf \"__DSH_ECS_FILE__%s\\n\" '/var/log/app.log'"), command)
  assert.ok(command.includes("tail -c +1 '/var/log/app.log'"), command)
  assert.ok(command.includes("tail -c +6 '/var/log/access.log'"), '第二个文件应按自己的游标: ' + command)
  assert.equal(checkWriteCommand(command), undefined, '多文件读命令必须仍是只读')

  const output = '__DSH_ECS_FILE__/var/log/app.log\n__DSH_ECS_META__ 7\nhello\n' +
    '__DSH_ECS_FILE__/var/log/access.log\n__DSH_ECS_META__ 12\nworld\n__DSH_ECS_EXIT__ 0\n'
  const segments = splitLogSegments(output, ['/var/log/app.log', '/var/log/access.log'])
  assert.equal(segments.length, 2)
  const first = parseLogRead(segments[0].raw, 0, 1024)
  const second = parseLogRead(segments[1].raw, 5, 1024)
  assert.equal(first.text, 'hello')
  assert.equal(first.total_bytes, 7)
  assert.equal(first.next_offset, 7)
  assert.equal(second.text, 'world')
  assert.equal(second.exit_code, 0)
  assert.equal(second.next_offset, 12)

  assert.throws(() => resolveLogPaths({ path: 'a', paths: ['b'] }), /二选一/)
  assert.throws(() => resolveLogPaths({}), /必须提供/)
  assert.throws(() => resolveLogPaths({ paths: Array.from({ length: 9 }, (_, i) => 'f' + i) }), /最多 8 个/)
  assert.equal(resolveAfter({ after: 12 }, '/a'), 12)
  assert.equal(resolveAfter({ after: { '/a': 7, '/b': 3 } }, '/b'), 3)
  assert.equal(resolveAfter({ after: { '/a': 7 } }, '/c'), 0)
})

await runAsync('L1: ecs_log paths 一次读多文件(各自游标), 且超时不推进游标', async () => {
  const seen = []
  const stub = {
    async resolveExecutable() { return 'workbench' },
    spawn(spec) {
      const argv = spec.argv.slice(1)
      seen.push(argv)
      const body = JSON.stringify({
        instance_id: 'i-x', exit_code: 0, stderr: '',
        output: '__DSH_ECS_FILE__/var/log/a.log\n__DSH_ECS_META__ 4\naaa\n' +
          '__DSH_ECS_FILE__/var/log/b.log\n__DSH_ECS_META__ 9\nbbb\n',
      })
      return {
        pid: 1,
        collected: {
          stdout: { readFrom: () => ({ text: body, nextOffset: body.length, lossy: false }) },
          stderr: { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) },
        },
        done: Promise.resolve({ exitCode: 0, signal: null }),
        terminate() {},
        async waitForExit() { return true },
      }
    },
  }
  const logDef = ecsLogDefinition({ get: (n) => (n === 'subprocess' ? stub : undefined) })
  const value = await logDef.execute(
    { instance_id: 'i-x', paths: ['/var/log/a.log', '/var/log/b.log'], after: { '/var/log/a.log': 0, '/var/log/b.log': 4 } },
    { name: 'ecs_log', signal: { aborted: false } },
  )
  assert.equal(seen.length, 1, '多文件应只发一次远程调用')
  assert.equal(value.files.length, 2)
  assert.equal(value.files[0].text, 'aaa')
  assert.equal(value.files[0].next_offset, 4)
  assert.equal(value.files[1].after, 4, '第二个文件应按对象里的游标')
  assert.equal(value.files[1].text, 'bbb')
  assert.equal(value.files[1].next_offset, 9, '游标推进到远端总长(4 + 剩余 5 字节)')
  const text = logDef.output.render({}, value)[0].text
  assert.ok(text.includes('多文件日志读取'), text)
  assert.ok(text.includes('/var/log/b.log'), text)
})

// ============================================================================
// v0.8.0 —— P1 参数契约 / P2 raw: true / P3 重跑建议 + from_step / N1 快照
// ============================================================================
console.log('')
console.log('== v0.8.0 新增能力 ==')

run('P1: parseParamDeclarations 区分"标量默认值"与"参数描述符"', () => {
  const decl = parseParamDeclarations({
    delay: 5,
    sha: { required: true, pattern: '^[0-9a-f]{7,40}$', hint: 'git rev-parse --short HEAD' },
    env: { default: 'prod', enum: ['prod', 'staging'], description: '部署环境' },
    empty: {},
  })
  assert.equal(decl.defaults.delay, 5, '标量仍是默认值')
  assert.equal(decl.defaults.empty !== undefined, true, '空对象不是描述符(当作对象默认值)')
  assert.equal(decl.specs.sha.required, true)
  assert.equal(decl.specs.sha.pattern, '^[0-9a-f]{7,40}$')
  assert.equal(decl.specs.env.default, 'prod')
  assert.deepEqual(decl.specs.env.enum, ['prod', 'staging'])
  assert.equal(decl.specs.sha.hasDefault, false)
  assert.equal(decl.specs.env.hasDefault, true)

  const typo = parseParamDeclarations({ a: { requred: true } })
  assert.equal(typo.unknownKeys.length, 0, 'requred 不是已知键 → 整个对象被视为默认值(不误判为描述符)')
  const typo2 = parseParamDeclarations({ a: { required: true, patern: '^x$' } })
  assert.deepEqual(typo2.unknownKeys, [{ param: 'a', key: 'patern' }], '已知键+笔误键 → 报出笔误字段')
})

run('P1: 必填/pattern/enum 校验(含隐式参数)', () => {
  const specs = parseParamDeclarations({
    sha: { required: true, pattern: '^[0-9a-f]{7,40}$' },
    env: { default: 'prod', enum: ['prod', 'staging'] },
  }).specs
  const ok = validateParamValues(specs, { sha: 'abc1234', env: 'staging' })
  assert.deepEqual(ok, [])
  const missing = validateParamValues(specs, {})
  assert.equal(missing.length, 1)
  assert.equal(missing[0].code, 'param_required')
  assert.ok(missing[0].message.includes('必填'))
  const badPattern = validateParamValues(specs, { sha: 'XYZ', env: 'prod' })
  assert.equal(badPattern[0].code, 'param_pattern')
  assert.ok(badPattern[0].message.includes('^[0-9a-f]{7,40}$'))
  const badEnum = validateParamValues(specs, { sha: 'abc1234', env: 'dev' })
  assert.equal(badEnum[0].code, 'param_enum')
  assert.ok(badEnum[0].message.includes('prod / staging'))
  const brokenRegex = validateParamValues(parseParamDeclarations({ a: { pattern: '(' } }).specs, { a: 'x' })
  assert.equal(brokenRegex[0].code, 'param_pattern_invalid')
  // 隐式参数同样受约束(instance_id 由调用侧注入)
  const implicit = buildRunbookRun(
    parseRunbook(JSON.stringify({ params: { instance_id: { pattern: '^i-[0-9a-z]+$' } }, steps: [{ command: 'echo ${instance_id}' }] })),
    {},
    { instance_id: 'i-uf66ct2o35p7fjcd0sru' },
  )
  assert.deepEqual(implicit.param_issues, [])
  const badImplicit = buildRunbookRun(
    parseRunbook(JSON.stringify({ params: { instance_id: { pattern: '^i-[0-9a-z]+$' } }, steps: [{ command: 'echo ${instance_id}' }] })),
    {},
    { instance_id: 'prod-typo' },
  )
  assert.equal(badImplicit.param_issues[0].code, 'param_pattern')
})

await runAsync('P1: lint 在 validate 阶段就拦住缺必填/不匹配(与执行期同一文案)', async () => {
  const text = JSON.stringify({
    name: 'strict',
    params: { sha: { required: true, pattern: '^[0-9a-f]{7,40}$', hint: 'git rev-parse --short HEAD' } },
    steps: [{ command: 'echo deploying ${sha}' }],
  })
  const lint = lintRunbook(text, { name: 'strict' })
  assert.equal(lint.ok, false, '缺必填参数应在 lint 阶段就失败')
  const codes = lint.issues.map((i) => i.code)
  assert.ok(codes.includes('param_required'), codes.join(','))
  assert.ok(lint.issues.find((i) => i.code === 'param_required').message.includes('git rev-parse'), '应带上 hint')
  assert.ok(lint.missing_required.includes('sha'))

  const lintBad = lintRunbook(text, { name: 'strict', params: { sha: 'NOT-HEX' } })
  assert.equal(lintBad.ok, false)
  assert.ok(lintBad.issues.some((i) => i.code === 'param_pattern'))
  const lintOk = lintRunbook(text, { name: 'strict', params: { sha: 'abc1234' } })
  assert.equal(lintOk.ok, true, JSON.stringify(lintOk.issues))
  assert.equal(lintOk.param_specs.sha.required, true, '报告里应能看到参数契约')

  // 执行期同一套校验(工具侧)
  const def = ecsDeployDefinition({ get: () => undefined })
  await assert.rejects(
    () => def.execute({ instance_id: 'i-x', runbook: JSON.parse(text) }, { name: 'ecs_deploy', signal: { aborted: false } }),
    /参数不合法|缺少参数/,
  )
})

run('P1: 描述符笔误与"声明了却没用到"都要报出来', () => {
  const lint = lintRunbook(JSON.stringify({
    params: { sha: { required: true, patern: '^x$' }, ghost: 'v1' },
    steps: [{ command: 'echo ${sha}' }],
  }), { name: 'x' })
  const codes = lint.issues.map((i) => i.code)
  assert.ok(codes.includes('unknown_param_field'), '描述符字段笔误: ' + codes.join(','))
  assert.ok(lint.issues.find((i) => i.code === 'unknown_param_field').message.includes('pattern'), '应提示是否想写 pattern')
  assert.ok(codes.includes('unused_default'), 'ghost 没被用到: ' + codes.join(','))
})

run('P2: step 级 raw: true 整步不替换, 且其占位符不计入已声明参数', () => {
  const runbook = parseRunbook(JSON.stringify({
    params: { tag: 'v1' },
    steps: [
      { command: 'echo ${tag}' },
      { raw: true, script: 'echo "${HOME}" "${tag}" > /tmp/x' },
    ],
  }))
  const run = buildRunbookRun(runbook, {}, {})
  assert.equal(run.steps[0].command, 'echo v1', '普通步骤照常替换')
  assert.equal(run.steps[1].script, 'echo "${HOME}" "${tag}" > /tmp/x', 'raw 步骤原样保留')
  assert.deepEqual(run.declared, ['tag'], 'raw 步骤里的 ${tag}/${HOME} 不计入声明')
  assert.deepEqual(run.missing, [], 'raw 步骤不应报缺参数')
})

run('P2: raw 步骤里有占位符时 lint 提醒(不是静默忽略)', () => {
  const lint = lintRunbook(JSON.stringify({
    steps: [{ raw: true, command: 'echo ${TAG}' }],
  }), { name: 'x' })
  const codes = lint.issues.map((i) => i.code)
  assert.ok(codes.includes('raw_placeholders'), codes.join(','))
  assert.ok(!codes.includes('unknown_field'), 'raw 应在字段白名单里: ' + codes.join(','))
})

run('P3: replayAdvice 逐步幂等性 + 重跑建议', () => {
  const plan = planSteps([
    { kind: 'upload', local_file: 'a.jar', remote_path: '/opt/a.jar', force: true },
    { kind: 'assert', command: 'test -f /opt/a.jar', expect: {} },
    { command: 'docker compose up -d' },
    { kind: 'tail', path: '/tmp/x.log' },
  ], { instance_id: 'i-x' })
  const replay = replayAdvice(plan)
  assert.deepEqual(replay.steps.map((s) => s.idempotent), [true, true, false, true])
  assert.equal(replay.safe_prefix, 2)
  assert.equal(replay.replayable, false)
  assert.ok(replay.note.includes('from_step: 2'), replay.note)

  const allSafe = replayAdvice(planSteps([
    { command: 'df -h', read_only: true },
    { kind: 'tail', path: '/tmp/x.log' },
  ], { instance_id: 'i-x' }))
  assert.equal(allSafe.replayable, true)
  assert.ok(allSafe.note.includes('直接重跑整条跑书'))

  // 无 --force 的上传不算幂等(远端已存在时会失败)
  const noForce = replayAdvice(planSteps([{ kind: 'upload', local_file: 'a', remote_path: '/opt/a' }], { instance_id: 'i-x' }))
  assert.equal(noForce.steps[0].idempotent, false)
})

await runAsync('P3: from_step 跳过前置步骤且结果显式可见', async () => {
  const issued = []
  const stub = {
    async resolveExecutable() { return 'workbench' },
    spawn(spec) {
      issued.push(spec.argv.slice(1).join(' '))
      const body = JSON.stringify({ instance_id: 'i-x', exit_code: 0, output: 'ok', stderr: '' })
      return {
        pid: 1,
        collected: {
          stdout: { readFrom: () => ({ text: body, nextOffset: body.length, lossy: false }) },
          stderr: { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) },
        },
        done: Promise.resolve({ exitCode: 0, signal: null }),
        terminate() {},
        async waitForExit() { return true },
      }
    },
  }
  const def = ecsDeployDefinition({ get: (n) => (n === 'subprocess' ? stub : undefined) })
  const steps = [
    { command: 'echo step-zero' },
    { command: 'echo step-one' },
    { command: 'echo step-two' },
  ]
  const value = await def.execute({ instance_id: 'i-x', steps, from_step: 2 }, { name: 'ecs_deploy', signal: { aborted: false } })
  assert.equal(value.ok, true, JSON.stringify(value.stages))
  assert.deepEqual(value.skipped_prefix, [0, 1])
  assert.equal(value.from_step, 2)
  assert.equal(value.stages[0].skipped, true)
  assert.equal(value.stages[0].skipped_prefix, true)
  assert.equal(value.stages[2].ok, true)
  assert.ok(!issued.join('\n').includes('step-zero'), '被跳过的步骤不得下发: ' + issued.join('\n'))
  assert.ok(issued.join('\n').includes('step-two'))

  // 预演同样标注跳过段
  const preview = await def.execute({ instance_id: 'i-x', steps, from_step: 1, dry_run: true }, { name: 'ecs_deploy', signal: { aborted: false } })
  assert.deepEqual(preview.skipped_prefix, [0])
  assert.equal(preview.plan[0].skipped, true)
  assert.equal(preview.plan[1].skipped, undefined)
  const previewText = def.output.render({}, preview)[0].text
  assert.ok(previewText.includes('将跳过 [0]'), previewText)
  assert.ok(previewText.includes('[重跑建议]'), '预演里应给出重跑建议')

  // 越界直接报错
  await assert.rejects(
    () => def.execute({ instance_id: 'i-x', steps, from_step: 9 }, { name: 'ecs_deploy', signal: { aborted: false } }),
    /from_step/,
  )
  // 老三阶段不支持 from_step(没有可跳过的编号, 明确报错而不是静默忽略)
  await assert.rejects(
    () => def.execute({ instance_id: 'i-x', command: 'echo x', from_step: 1 }, { name: 'ecs_deploy', signal: { aborted: false } }),
    /from_step 仅配合 steps/,
  )
})

await runAsync('P3: 失败后的结果里带重跑建议; ecs_runbook plan 也带 replay', async () => {
  const stub = {
    async resolveExecutable() { return 'workbench' },
    spawn() {
      const body = JSON.stringify({ instance_id: 'i-x', exit_code: 0, output: '', stderr: '' })
      return {
        pid: 1,
        collected: {
          stdout: { readFrom: () => ({ text: body, nextOffset: body.length, lossy: false }) },
          stderr: { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) },
        },
        done: Promise.resolve({ exitCode: 0, signal: null }),
        terminate() {},
        async waitForExit() { return true },
      }
    },
  }
  const def = ecsDeployDefinition({ get: (n) => (n === 'subprocess' ? stub : undefined) })
  const value = await def.execute({
    instance_id: 'i-x',
    steps: [{ command: 'echo a' }, { kind: 'assert', command: 'echo b', expect: { stdout_contains: ['definitely-absent'] } }],
  }, { name: 'ecs_deploy', signal: { aborted: false } })
  assert.equal(value.ok, false)
  assert.ok(value.replay !== undefined, '失败结果应带 replay')
  const text = def.output.render({}, value)[0].text
  assert.ok(text.includes('[重跑建议]'), text)

  // ecs_runbook plan: 只读且带 replay
  const files = {}
  files['E:/proj/' + RUNBOOK_DIR + '/rel.json'] = JSON.stringify({
    params: { tag: 'v1' },
    steps: [{ command: 'echo ${tag}', read_only: true }],
  })
  const ctx2 = { get: (n) => (n === 'fs' ? fakeFs(files) : (n === 'sandboxPolicy' ? { workspaceRoot: 'E:/proj' } : undefined)) }
  const rbDef = ecsRunbookDefinition(ctx2)
  const plan = await rbDef.execute({ action: 'plan', runbook: 'rel', instance_id: 'i-x' },
    { name: 'ecs_runbook', signal: { aborted: false }, agent: { session: { header: { cwd: 'E:/proj' } } } })
  assert.equal(plan.ok, true, JSON.stringify(plan.issues))
  assert.equal(plan.replay.replayable, true)
  const planText = rbDef.output.render({}, plan)[0].text
  assert.ok(planText.includes('[重跑建议]'), planText)

  const lint = await rbDef.execute({ action: 'validate', runbook: 'rel' },
    { name: 'ecs_runbook', signal: { aborted: false }, agent: { session: { header: { cwd: 'E:/proj' } } } })
  assert.ok(lint.replay !== undefined, 'validate 也应给出重跑建议')
})

// ---- N1: 快照 ----
run('N1: 采集脚本只读且含三段标记(采集器 / 退出码 / 路径指纹)', () => {
  const script = buildSnapshotScript({
    collectors: DEFAULT_SNAPSHOT_COLLECTORS,
    paths: ["/root/app/config.yml", '/opt/data'],
  })
  assert.equal(checkWriteCommand(script), undefined, '采集脚本必须零写操作: ' + checkWriteCommand(script))
  assert.ok(script.includes('__DSH_SNAP_CMD__%s'), script.slice(0, 120))
  assert.ok(script.includes('__DSH_SNAP_RC__%s %s'), '要记录采集器退出码')
  assert.ok(script.includes('sha256sum'), '文件指纹用远端 sha256sum')
  assert.ok(script.includes("-printf '%P %s"), '目录记文件清单摘要')
  assert.ok(script.includes("'/root/app/config.yml'"), '路径要经 shell 引用')
  assert.ok(!script.includes('rm -f') && !script.includes('docker run'), '不得混入任何写操作')
})

run('N1: parseSnapshotOutput 解析采集器与文件指纹', () => {
  const spec = { collectors: [{ label: 'images', command: 'docker images' }], paths: ['/a', '/b'] }
  const output = [
    '__DSH_SNAP_CMD__images', 'img:v1 abc123', '__DSH_SNAP_RC__images 0',
    '__DSH_SNAP_PATH__/a', 'file aaaa 12 1700000000',
    '__DSH_SNAP_PATH__/b', 'missing',
  ].join('\n')
  const parsed = parseSnapshotOutput(output, spec)
  assert.equal(parsed.commands.images.exit_code, 0)
  assert.equal(parsed.commands.images.lines, 1)
  assert.deepEqual(parsed.commands.images.head, ['img:v1 abc123'])
  assert.equal(parsed.files['/a'].status, 'file')
  assert.equal(parsed.files['/a'].sha256, 'aaaa')
  assert.equal(parsed.files['/a'].size, 12)
  assert.equal(parsed.files['/b'].status, 'missing')

  const dirOut = ['__DSH_SNAP_PATH__/d', 'dir dddd 7 1700000000'].join('\n')
  const parsedDir = parseSnapshotOutput(dirOut, { collectors: [], paths: ['/d'] })
  assert.equal(parsedDir.files['/d'].status, 'dir')
  assert.equal(parsedDir.files['/d'].entries, 7)
})

run('N1: diffFacts 逐项给出 unchanged/changed/added/removed/metadata-only', () => {
  const before = {
    files: {
      '/same': { status: 'file', sha256: 'aa', size: 1, mtime: 10 },
      '/content': { status: 'file', sha256: 'aa', size: 1, mtime: 10 },
      '/meta': { status: 'file', sha256: 'bb', size: 1, mtime: 10 },
      '/gone': { status: 'file', sha256: 'cc', size: 1, mtime: 10 },
      '/dir': { status: 'dir', digest: 'dd', entries: 3, mtime: 10 },
    },
    commands: {
      images: { exit_code: 0, lines: 2, digest: 'x1', head: ['a', 'b'] },
      ports: { exit_code: 0, lines: 1, digest: 'y1', head: ['80'] },
    },
  }
  const after = {
    files: {
      '/same': { status: 'file', sha256: 'aa', size: 1, mtime: 10 },
      '/content': { status: 'file', sha256: 'zz', size: 9, mtime: 11 },
      '/meta': { status: 'file', sha256: 'bb', size: 1, mtime: 99 },
      '/new': { status: 'file', sha256: 'ee', size: 2, mtime: 12 },
      '/dir': { status: 'dir', digest: 'ff', entries: 4, mtime: 12 },
    },
    commands: {
      images: { exit_code: 0, lines: 3, digest: 'x2', head: ['a', 'c'] },
      ports: { exit_code: 0, lines: 1, digest: 'y1', head: ['80'] },
    },
  }
  const result = diffFacts(before, after)
  const byPath = {}
  for (const item of result.files) byPath[item.path] = item.status
  assert.equal(byPath['/same'], 'unchanged')
  assert.equal(byPath['/content'], 'changed')
  assert.equal(byPath['/meta'], 'metadata-only')
  assert.equal(byPath['/gone'], 'removed')
  assert.equal(byPath['/new'], 'added')
  assert.equal(byPath['/dir'], 'changed')
  const byLabel = {}
  for (const item of result.commands) byLabel[item.label] = item
  assert.equal(byLabel.images.status, 'changed')
  assert.equal(byLabel.images.first_difference.line, 2)
  assert.equal(byLabel.ports.status, 'unchanged')
  assert.equal(result.clean, false)
  assert.equal(result.changed_count, 6, JSON.stringify(byPath))
  assert.equal(result.files_changed, 4)
  assert.equal(result.commands_changed, 1)

  const same = diffFacts(before, before)
  assert.equal(same.clean, true)
  assert.equal(same.changed_count, 0)

  // 基线里是文件、现在采集到 missing → 应报 removed(而不是"类型变化")
  const vanished = diffFacts(
    { files: { '/x': { status: 'file', sha256: 'aa', size: 1, mtime: 1 } }, commands: {} },
    { files: { '/x': { status: 'missing' } }, commands: {} },
  )
  assert.equal(vanished.files[0].status, 'removed')
  const appeared = diffFacts(
    { files: { '/y': { status: 'missing' } }, commands: {} },
    { files: { '/y': { status: 'file', sha256: 'aa', size: 1, mtime: 1 } }, commands: {} },
  )
  assert.equal(appeared.files[0].status, 'added')
})

await runAsync('N1: ecs_snapshot create -> list -> diff(工作区清单, 远端可编排)', async () => {
  const dirRoot = mkdtempSync(join(tmpdir(), 'dsh-wbecs-unit-snap-'))
  const remoteOutput = (sha) => [
    '__DSH_SNAP_CMD__containers', 'app web:1 Up 2 hours', '__DSH_SNAP_RC__containers 0',
    '__DSH_SNAP_PATH__/root/app/config.yml', 'file ' + sha + ' 42 1700000000',
  ].join('\n')
  let sha = 'aa'.repeat(32)
  const issued = []
  const stub = {
    async resolveExecutable(name) { return name },
    spawn(spec) {
      const exe = String(spec.argv[0])
      if (exe !== 'workbench') return localSubprocess.spawn(spec)
      const argv = spec.argv.slice(1)
      issued.push(argv.join(' '))
      // base64 投递的前置命令回空, 执行脚本的那条返回采集结果
      const isRunner = argv.join(' ').includes('.dsh-ecs-')
      const body = isRunner
        ? JSON.stringify({ instance_id: 'i-x', exit_code: 0, output: remoteOutput(sha), stderr: '', duration: '120ms' })
        : JSON.stringify({ instance_id: 'i-x', exit_code: 0, output: '', stderr: '' })
      return {
        pid: 1,
        collected: {
          stdout: { readFrom: () => ({ text: body, nextOffset: body.length, lossy: false }) },
          stderr: { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) },
        },
        done: Promise.resolve({ exitCode: 0, signal: null }),
        terminate() {},
        async waitForExit() { return true },
      }
    },
  }
  const ctx = {
    get: (n) => {
      if (n === 'subprocess') return stub
      if (n === 'fs') return nodeFsAdapter(dirRoot)
      if (n === 'sandboxPolicy') return { workspaceRoot: dirRoot }
      return undefined
    },
  }
  const exec = { name: 'ecs_snapshot', signal: new AbortController().signal, agent: { session: { header: { cwd: dirRoot } } } }
  const def = ecsSnapshotDefinition(ctx)

  const created = await def.execute({
    action: 'create', name: 'pre-abc1234', instance_id: 'i-x', region: 'cn-shanghai',
    note: '发布前回滚点', collectors: ['containers'], paths: ['/root/app/config.yml'],
  }, exec)
  assert.equal(created.ok, true, JSON.stringify(created))
  assert.equal(created.file_count, 1)
  assert.equal(created.files_summary[0].status, 'file')
  assert.ok(created.path.replace(/\\/g, '/').endsWith('.dsh/workbench-ecs/snapshots/pre-abc1234.json'), created.path)
  assert.ok(issued.some((line) => line.includes('exec --instance-id i-x')), '应真的下发采集命令')
  assertLosslessUnit('ecs_snapshot create', created)
  assertLosslessUnit('ecs_snapshot create meta', def.output.presentationMeta({}, created))

  const listed = await def.execute({ action: 'list' }, exec)
  assert.equal(listed.count, 1)
  assert.equal(listed.snapshots[0].name, 'pre-abc1234')
  assert.equal(listed.snapshots[0].note, '发布前回滚点')
  assert.ok(String(listed.command_line).includes('未调用任何 CLI 命令'), 'list 必须零远程调用')

  // 未改动 → clean
  const cleanDiff = await def.execute({ action: 'diff', name: 'pre-abc1234' }, exec)
  assert.equal(cleanDiff.clean, true, JSON.stringify(cleanDiff))
  assert.equal(cleanDiff.changed_count, 0)
  const cleanText = def.output.render({}, cleanDiff)[0].text
  assert.ok(cleanText.includes('无差异'), cleanText)

  // 远端变化 → diff 检出(文件 sha256 变了)
  sha = 'bb'.repeat(32)
  const changedDiff = await def.execute({ action: 'diff', name: 'pre-abc1234' }, exec)
  assert.equal(changedDiff.clean, false)
  assert.equal(changedDiff.files_changed, 1)
  assert.equal(changedDiff.files[0].status, 'changed')
  const changedText = def.output.render({}, changedDiff)[0].text
  assert.ok(changedText.includes('变化'), changedText)

  // 名字非法 / 快照不存在都要有可操作的报错
  await assert.rejects(() => def.execute({ action: 'create', name: '../etc/passwd', instance_id: 'i-x' }, exec), /非法/)
  await assert.rejects(() => def.execute({ action: 'create', instance_id: 'i-x' }, exec), /name 非法/)
  await assert.rejects(() => def.execute({ action: 'diff', name: 'nope' }, exec), /读取快照失败|可用快照/)
  await assert.rejects(() => def.execute({ action: 'nope' }, exec), /action 非法/)
})

await runAsync('N1: profile 提供采集内容; profile 不存在时列出可用名字', async () => {
  const dirRoot = mkdtempSync(join(tmpdir(), 'dsh-wbecs-unit-snap2-'))
  mkdirSync(join(dirRoot, '.dsh', 'workbench-ecs'), { recursive: true })
  writeFileSync(join(dirRoot, '.dsh', 'workbench-ecs', 'snapshot-profiles.json'), JSON.stringify({
    web: { paths: ['/root/app/config.yml'], commands: { health: 'curl -fsS http://127.0.0.1/health' }, collectors: ['containers'] },
    db: { paths: ['/var/lib/db.sqlite'] },
  }))
  const body = JSON.stringify({
    instance_id: 'i-x', exit_code: 0, duration: '90ms', stderr: '',
    output: [
      '__DSH_SNAP_CMD__containers', 'app web:1 Up', '__DSH_SNAP_RC__containers 0',
      '__DSH_SNAP_CMD__health', 'ok', '__DSH_SNAP_RC__health 0',
      '__DSH_SNAP_PATH__/root/app/config.yml', 'file cccc 10 1700000000',
    ].join('\n'),
  })
  const stub = {
    async resolveExecutable(name) { return name },
    spawn(spec) {
      if (String(spec.argv[0]) !== 'workbench') return localSubprocess.spawn(spec)
      const isRunner = spec.argv.slice(1).join(' ').includes('.dsh-ecs-')
      const text = isRunner ? body : JSON.stringify({ instance_id: 'i-x', exit_code: 0, output: '', stderr: '' })
      return {
        pid: 1,
        collected: {
          stdout: { readFrom: () => ({ text, nextOffset: text.length, lossy: false }) },
          stderr: { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) },
        },
        done: Promise.resolve({ exitCode: 0, signal: null }),
        terminate() {},
        async waitForExit() { return true },
      }
    },
  }
  const ctx = {
    get: (n) => {
      if (n === 'subprocess') return stub
      if (n === 'fs') return nodeFsAdapter(dirRoot)
      if (n === 'sandboxPolicy') return { workspaceRoot: dirRoot }
      return undefined
    },
  }
  const exec = { name: 'ecs_snapshot', signal: new AbortController().signal, agent: { session: { header: { cwd: dirRoot } } } }
  const def = ecsSnapshotDefinition(ctx)
  const created = await def.execute({ action: 'create', name: 'pre-1', instance_id: 'i-x', profile: 'web' }, exec)
  assert.equal(created.profile, 'web')
  assert.deepEqual(created.collectors, ['containers', 'health'], 'profile 的 collectors + commands 都要生效')
  assert.deepEqual(created.paths, ['/root/app/config.yml'], 'profile 的 paths 生效')
  await assert.rejects(
    () => def.execute({ action: 'create', name: 'pre-2', instance_id: 'i-x', profile: 'nope' }, exec),
    /可用 profile: web, db/,
  )
})

console.log('')
console.log('== unit 结果: ' + passed + ' 通过, ' + failed + ' 失败 ==')
process.exit(failed > 0 ? 1 : 0)
