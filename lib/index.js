// ============================================================================
// dsh-workbench-ecs —— 阿里云 Workbench CLI 包装插件 (DeepSeek Harness / Cordis)
// ----------------------------------------------------------------------------
// 目标: 让 Harness Agent 通过工具调用, 在本机执行阿里云 Workbench CLI 命令,
//       从而控制远程 ECS 实例(列表查询 / 远程命令执行)。
//       典型场景: Agent 直接登录生产实例排查/修复线上 bug, 无需人工复制指令。
//
// 前置要求(在运行本插件前于本机完成):
//   Windows 安装:  irm https://workbench-cli.oss-cn-hangzhou.aliyuncs.com/install.ps1 | iex
//   Linux/macOS:    curl -fsSL https://workbench-cli.oss-cn-hangzhou.aliyuncs.com/install.sh | bash
//   前置检查:       workbench version
//   凭据配置:       ~/.workbench/config.json (AK / StsToken / RamRoleArn / CredentialsCmd / CredentialsURI 模式)
//
// 挂载测试命令(标准 Cordis 插件形态):
//   作为插件行加入 cordis.yml:   - name: dsh-workbench-ecs
//   或动态挂载: 用 scripts/to-body.mjs 把本文件转成 host body 后 cordis_define + cordis_run
//   挂载成功后即可让 Agent 调用:
//     ecs_list({ region: 'cn-hangzhou' })                                  -> 列出指定地域的 ECS 实例
//     ecs_exec({ instance_id: 'i-bp1xxxxx', command: 'df -h' })           -> 在指定实例上执行远程命令
//     ecs_exec({ instance_id: 'i-bp1xxxxx', command: 'uname -a', timeout: 10 })
//   CLI 本机自测命令:
//     workbench list ecs --region cn-hangzhou --output json
//     workbench exec --instance-id i-bp1xxxxx --command "df -h" --output json
// ============================================================================
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'dsh-workbench-ecs'

// 注入 tools 服务: 通过 ctx.tools.register 注册模型可见的工具
export const inject = ['tools']

export function apply(ctx) {
  // ------------------------------------------------------------------------
  // 运行一条 workbench 子命令并收集输出。
  // 语义等价于 Node.js child_process.exec: 命令 + 收集 stdout/stderr + 退出码;
  // 这里通过 ctx 的 subprocess 服务(显式 argv, 不经 shell)执行, 避免转义问题,
  // 并让取消信号(signal)自动触发进程树的 SIGTERM -> SIGKILL 升级。
  // ------------------------------------------------------------------------
  async function runWorkbench(argv, signal) {
    const subprocess = ctx.get('subprocess')
    if (subprocess === undefined) {
      throw new Error('subprocess 服务不可用, 无法在本机执行 workbench 命令')
    }

    // 解析 workbench 可执行文件路径; 找不到时给出安装提示, 便于自修复
    let exe
    try {
      // 1) 先按 PATH 解析(安装脚本通常会把可执行文件加入用户级 PATH)
      exe = await subprocess.resolveExecutable('workbench')
    } catch (err) {
      exe = undefined
    }
    // 2) PATH 中找不到(常见原因: 宿主进程先于安装启动, 继承的 PATH 未刷新)。
    //    回退到 Windows 常见安装位置, 用绝对路径交给解析器验证; Linux/macOS 安装
    //    位置一般都在 PATH 内, 因此这里的回退仅在 Windows 上生效。
    if (exe === undefined) {
      const candidates = [
        'C:\\Program Files\\workbench\\workbench.exe',
        'C:\\Program Files (x86)\\workbench\\workbench.exe',
      ]
      for (const candidate of candidates) {
        try {
          exe = await subprocess.resolveExecutable(candidate)
          break
        } catch (err2) {
          exe = undefined /* 继续尝试下一个位置 */
        }
      }
    }
    if (exe === undefined) {
      throw new Error('workbench CLI 不可用: 已按 PATH 与常见安装位置 ' +
        '(C:\\Program Files\\workbench\\workbench.exe, C:\\Program Files (x86)\\workbench\\workbench.exe) ' +
        '查找均未命中。请确认已安装: irm https://workbench-cli.oss-cn-hangzhou.aliyuncs.com/install.ps1 | iex; ' +
        '若已安装, 请重启 Harness 会话使新增的 PATH 生效, 或把安装目录加入 PATH 后重试')
    }

    // 工作目录: 优先使用会话工作区根目录, 兜底使用进程当前目录
    const sandboxPolicy = ctx.get('sandboxPolicy')
    const cwd = (sandboxPolicy !== undefined && sandboxPolicy.workspaceRoot !== undefined && sandboxPolicy.workspaceRoot !== null)
      ? String(sandboxPolicy.workspaceRoot) : '.'

    // 显式声明 stdio 收集策略: 在内存上限内保留输出尾部, 超限置截断标记
    const handle = subprocess.spawn({
      argv: [exe, ...argv],
      cwd,
      stdio: {
        stdin: 'ignore',
        stdout: { maxBytes: 2 * 1024 * 1024 },
        stderr: { maxBytes: 512 * 1024 },
      },
      graceMs: 5000,
      signal,
    })

    // 等待进程退出(done 仅在 spawn 层失败时 reject)
    const outcome = await handle.done

    // 收集模式: 进程退出后仍可按 0 偏移读取完整保留的尾部
    const out = handle.collected.stdout !== undefined ? handle.collected.stdout.readFrom(0) : undefined
    const err = handle.collected.stderr !== undefined ? handle.collected.stderr.readFrom(0) : undefined

    return {
      exitCode: outcome.exitCode,
      signalName: outcome.signal,
      stdout: out !== undefined ? out.text : '',
      stdoutTruncated: out !== undefined ? out.lossy : false,
      stderr: err !== undefined ? err.text : '',
    }
  }

  // ------------------------------------------------------------------------
  // 解析 workbench 的 JSON 输出。
  // CLI 失败时返回 { code, message }(如 { "code": 4, "message": "InvalidAccessKeyId" }),
  // 这里统一识别并转成可读错误抛出, 让模型拿到明了的失败原因。
  // ------------------------------------------------------------------------
  function parseJsonOrThrow(text, label) {
    let data
    try {
      data = JSON.parse(text)
    } catch (err) {
      throw new Error(label + ': 未能把 workbench 输出解析为 JSON: ' + text.slice(0, 500))
    }
    if (data !== null && typeof data === 'object' && !Array.isArray(data) &&
        typeof data.code === 'number' && typeof data.message === 'string') {
      throw new Error(label + ': workbench CLI 错误 (code ' + data.code + '): ' + data.message)
    }
    return data
  }

  // 尝试从一段文本中解析 CLI 错误对象 { code, message }; 非 JSON 或结构不符时返回 undefined。
  // 实测 CLI 层错误(认证失败/实例不存在等)的 JSON 输出在 stderr 而非 stdout,
  // 因此 stdout 为空时需要回退到这里解析 stderr。
  function parseCliError(text) {
    if (text === undefined || text === null) return undefined
    const trimmed = String(text).trim()
    if (trimmed.length === 0) return undefined
    try {
      const data = JSON.parse(trimmed)
      if (data !== null && typeof data === 'object' && !Array.isArray(data) &&
          typeof data.code === 'number' && typeof data.message === 'string') {
        return data
      }
    } catch (err) { /* 不是 JSON, 视为普通 stderr 文本 */ }
    return undefined
  }

  // ------------------------------------------------------------------------
  // 把实例列表渲染成可读的文本表格
  // ------------------------------------------------------------------------
  function renderList(args, value) {
    const cols = [
      { key: 'instance_id', title: '实例ID', width: 22 },
      { key: 'instance_name', title: '名称', width: 18 },
      { key: 'instance_type', title: '规格', width: 16 },
      { key: 'status', title: '状态', width: 10 },
      { key: 'private_ip', title: '私网IP', width: 16 },
      { key: 'public_ip', title: '公网IP', width: 16 },
      { key: 'os_type', title: '系统', width: 8 },
    ]
    const lines = []
    lines.push('ECS 实例列表 — 地域: ' + value.region + ', 共 ' + value.count + ' 台')
    if (value.count > 0) {
      lines.push(cols.map((c) => c.title.padEnd(c.width)).join('  '))
      for (const inst of value.instances) {
        lines.push(cols.map((c) => String(inst[c.key] === undefined ? '' : inst[c.key]).padEnd(c.width)).join('  '))
      }
    } else {
      lines.push('(没有符合条件的实例)')
    }
    lines.push('命令: ' + value.command)
    return lines.join('\n')
  }

  // ------------------------------------------------------------------------
  // 把远程命令执行结果渲染成可读文本
  // ------------------------------------------------------------------------
  function renderExec(args, value) {
    const lines = []
    lines.push('远程命令执行结果 — 实例: ' + value.instance_id)
    lines.push('$ ' + value.command)
    if (value.output.length > 0) {
      lines.push(value.output.replace(/\n$/, ''))
    }
    if (value.stderr.length > 0) {
      if (value.output.length > 0) lines.push('')
      lines.push('[stderr]')
      lines.push(value.stderr.replace(/\n$/, ''))
    }
    if (value.output.length === 0 && value.stderr.length === 0) {
      lines.push('(无输出)')
    }
    lines.push('[exit code: ' + value.exit_code + ']')
    if (value.stdout_truncated) lines.push('[输出过长, 已截断]')
    return lines.join('\n')
  }

  // ========================================================================
  // 工具 1: ecs_list —— 列出指定地域的 ECS 实例
  // 对应 CLI: workbench list ecs --region <region> [过滤项...] --output json
  // ========================================================================
  ctx.tools.register(defineTool({
    name: 'ecs_list',
    description: '通过本机阿里云 Workbench CLI 列出指定地域的 ECS 实例, 支持状态/标签/规格/名称过滤, ' +
      '返回实例清单(实例ID为后续 ecs_exec 的输入)。适用于无公网 IP 的实例查询。',
    parameters: {
      region: { type: 'string', required: true, description: '阿里云地域, 例如 cn-hangzhou(必填)' },
      status: {
        type: 'string', enum: ['Running', 'Stopped', 'Starting', 'Stopping'],
        description: '按实例状态过滤',
      },
      tag: {
        type: 'array', items: { type: 'string' },
        description: '按标签过滤, 每项为 key=value 或 key, 可重复, 多个条件取交集',
      },
      instance_type: { type: 'string', description: '按实例规格过滤, 例如 ecs.g7.large' },
      instance_name: { type: 'string', description: '按实例名称过滤, 支持 * 通配符' },
      limit: { type: 'integer', description: '每页数量, 10-100, 默认 50(ECS API 页大小下限为 10)' },
    },
    timeoutMs: 60000,
    output: {
      schema: {
        type: 'object',
        properties: {
          command: { type: 'string' },
          region: { type: 'string' },
          count: { type: 'integer' },
          instances: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                instance_id: { type: 'string' },
                instance_name: { type: 'string' },
                instance_type: { type: 'string' },
                region_id: { type: 'string' },
                status: { type: 'string' },
                private_ip: { type: 'string' },
                public_ip: { type: 'string' },
                os_type: { type: 'string' },
                image_id: { type: 'string' },
                tags: { type: 'object', additionalProperties: true },
              },
              additionalProperties: true,
            },
          },
        },
        additionalProperties: false,
      },
      render: (args, value) => [{ type: 'text', text: renderList(args, value) }],
    },
    async execute(args, exec) {
      // 构造 CLI 参数(显式 argv, 不经 shell, 值无需转义)
      const argv = ['list', 'ecs', '--region', args.region, '--output', 'json']
      if (args.status !== undefined) argv.push('--status', args.status)
      if (args.tag !== undefined && args.tag.length > 0) {
        for (const t of args.tag) argv.push('--tag', t)
      }
      if (args.instance_type !== undefined) argv.push('--instance-type', args.instance_type)
      if (args.instance_name !== undefined) argv.push('--instance-name', args.instance_name)
      if (args.limit !== undefined) argv.push('--limit', String(args.limit))

      const r = await runWorkbench(argv, exec.signal)
      if (exec.signal.aborted) throw new Error('工具调用已被取消')

      const outText = r.stdout.trim()
      const errText = r.stderr.trim()
      if (outText.length > 0) {
        // 正常路径: stdout 上是规范 JSON
        const data = parseJsonOrThrow(outText, 'ecs_list')
        // 兼容两种返回结构: 官方文档为数组 [...], 实测 CLI 返回 { instances: [...] } 包装对象
        let instances
        if (Array.isArray(data)) {
          instances = data
        } else if (data !== null && typeof data === 'object' && Array.isArray(data.instances)) {
          instances = data.instances
        } else {
          throw new Error('ecs_list: 意外的输出结构: ' + outText.slice(0, 300))
        }
        return {
          command: 'workbench ' + argv.join(' '),
          region: args.region,
          count: instances.length,
          instances: instances.map((it) => ({
            instance_id: it.instance_id !== undefined ? String(it.instance_id) : '',
            instance_name: it.instance_name !== undefined ? String(it.instance_name) : '',
            instance_type: it.instance_type !== undefined ? String(it.instance_type) : '',
            region_id: it.region_id !== undefined ? String(it.region_id) : '',
            status: it.status !== undefined ? String(it.status) : '',
            private_ip: it.private_ip !== undefined ? String(it.private_ip) : '',
            public_ip: it.public_ip !== undefined ? String(it.public_ip) : '',
            os_type: it.os_type !== undefined ? String(it.os_type) : '',
            image_id: it.image_id !== undefined ? String(it.image_id) : '',
            tags: it.tags !== undefined ? it.tags : {},
          })),
        }
      }
      // stdout 为空: 回退解析 stderr 上的 CLI 错误 JSON(认证失败/实例不存在等)
      const errData = parseCliError(errText)
      if (errData !== undefined) {
        throw new Error('ecs_list: workbench CLI 错误 (code ' + errData.code + '): ' + errData.message)
      }
      throw new Error('ecs_list: workbench 无输出 (exit ' + r.exitCode + '): ' + errText.slice(0, 300))
    },
  }))

  // ========================================================================
  // 工具 2: ecs_exec —— 在指定实例上执行远程命令
  // 对应 CLI: workbench exec --instance-id <id> --command <cmd> [--timeout <s>] --output json
  // 说明: CLI 是非交互执行器, 每次调用独立 shell 上下文(状态不保留),
  //       需要共享上下文时用 && 或 ; 在单次调用内串联命令。
  // ========================================================================
  ctx.tools.register(defineTool({
    name: 'ecs_exec',
    description: '通过本机阿里云 Workbench CLI 在指定 ECS 实例上执行一条远程命令(非交互), ' +
      '返回标准输出/错误输出与退出码; 每次调用是独立 shell 上下文, 状态不跨调用保留。' +
      '破坏性命令(rm -rf、shutdown、reboot、mkfs、dd 等)执行前应先征得用户确认。',
    parameters: {
      instance_id: { type: 'string', required: true, description: '目标 ECS 实例 ID, 例如 i-bp1xxxxx(可由 ecs_list 取得)' },
      command: { type: 'string', required: true, description: '要执行的远程命令; 需要共享上下文时用 && 或 ; 串联, 例如 "cd /var/log && tail -n 50 app.log"' },
      timeout: { type: 'integer', description: '命令超时时间(秒), 默认 30' },
      region: { type: 'string', description: '地域, 可缺省: CLI 会从实例 ID 自动推断' },
    },
    timeoutMs: 180000,
    output: {
      schema: {
        type: 'object',
        properties: {
          instance_id: { type: 'string' },
          command: { type: 'string' },
          exit_code: { type: 'integer' },
          output: { type: 'string' },
          stderr: { type: 'string' },
          stdout_truncated: { type: 'boolean' },
          command_line: { type: 'string' },
        },
        additionalProperties: false,
      },
      render: (args, value) => [{ type: 'text', text: renderExec(args, value) }],
    },
    async execute(args, exec) {
      const argv = ['exec', '--instance-id', args.instance_id, '--command', args.command, '--output', 'json']
      if (args.timeout !== undefined) argv.push('--timeout', String(args.timeout))
      if (args.region !== undefined) argv.push('--region', args.region)

      const r = await runWorkbench(argv, exec.signal)
      if (exec.signal.aborted) throw new Error('工具调用已被取消')

      const outText = r.stdout.trim()
      const errText = r.stderr.trim()
      if (outText.length > 0) {
        // 正常路径: CLI 成功返回 { output, stderr, exit_code }; CLI 层错误也在 parseJsonOrThrow 中抛出
        const data = parseJsonOrThrow(outText, 'ecs_exec')
        if (data === null || typeof data !== 'object' || Array.isArray(data)) {
          throw new Error('ecs_exec: 意外的输出结构: ' + outText.slice(0, 300))
        }
        return {
          instance_id: args.instance_id,
          command: args.command,
          exit_code: r.exitCode !== null ? r.exitCode : 0,
          output: data.output !== undefined ? String(data.output) : '',
          stderr: data.stderr !== undefined ? String(data.stderr) : '',
          stdout_truncated: r.stdoutTruncated,
          command_line: 'workbench ' + argv.join(' '),
        }
      }
      // stdout 为空: 回退解析 stderr 上的 CLI 错误 JSON(认证失败/实例不存在等)
      const errData = parseCliError(errText)
      if (errData !== undefined) {
        throw new Error('ecs_exec: workbench CLI 错误 (code ' + errData.code + '): ' + errData.message)
      }
      throw new Error('ecs_exec: workbench 无输出 (exit ' + r.exitCode + '): ' + errText.slice(0, 300))
    },
  }))
}
