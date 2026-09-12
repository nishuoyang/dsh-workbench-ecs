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
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  base64Encode, utf8ByteLength, cleanOutput, shellQuote, baseName, remoteJoin,
  checkWriteCommand, guardReadOnly, resolveTimeout, buildScriptDelivery,
  localSha256, remoteSha256, SCRIPT_INLINE_LIMIT_BYTES,
  buildLogReadCommand, parseLogRead, buildDetachLaunch, parseDetachPid, hasLocalTimer, delay,
} from '../lib/common.js'
import { buildDiagnoseScript } from '../lib/tools/ecs-diagnose.js'
import { buildSessionScript, extractSessionCwd } from '../lib/tools/ecs-exec.js'

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

console.log('')
console.log('== unit 结果: ' + passed + ' 通过, ' + failed + ' 失败 ==')
process.exit(failed > 0 ? 1 : 0)
