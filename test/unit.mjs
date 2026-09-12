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
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  base64Encode, utf8ByteLength, cleanOutput, shellQuote, baseName, remoteJoin,
  checkWriteCommand, guardReadOnly, resolveTimeout, buildScriptDelivery,
  localSha256, remoteSha256, SCRIPT_INLINE_LIMIT_BYTES,
  buildLogReadCommand, parseLogRead, buildDetachLaunch, parseDetachPid, hasLocalTimer, delay,
  splitLocalPath, buildTarCreateArgv, buildArchiveExtractScript, parseArchiveEntries,
  runWithConcurrency,
} from '../lib/common.js'
import { buildDiagnoseScript } from '../lib/tools/ecs-diagnose.js'
import { buildSessionScript, extractSessionCwd, ecsExecDefinition } from '../lib/tools/ecs-exec.js'
import { ecsUploadDefinition } from '../lib/tools/ecs-upload.js'
import { ecsListDefinition } from '../lib/tools/ecs-list.js'
import { ecsDeployDefinition } from '../lib/tools/ecs-deploy.js'
import { createSettingsCore } from '../lib/settings-api.js'
import {
  isValidRunbookName, substituteParams, collectParamNames, parseRunbook, buildRunbookRun,
  loadRunbook, listRunbookNames, RUNBOOK_DIR,
} from '../lib/runbooks.js'

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

console.log('')
console.log('== unit 结果: ' + passed + ' 通过, ' + failed + ' 失败 ==')
process.exit(failed > 0 ? 1 : 0)