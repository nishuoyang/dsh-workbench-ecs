// ============================================================================
// dsh-workbench-ecs —— 阿里云 Workbench CLI 包装插件 (DeepSeek Harness / Cordis)
// ----------------------------------------------------------------------------
// 入口: 标准 Cordis 插件形态, 提供两部分能力:
//   A. 模型可见工具 (agent 会话):
//      ecs_list       列出指定地域的 ECS 实例
//      ecs_exec       在实例上执行远程命令(守卫/批量/后台/spill)
//      ecs_upload     上传本地文件到实例(OSS 中继, ≤1GB)
//      ecs_download   从实例下载文件到本地
//      ecs_diagnose   一键只读体检(主机/负载/内存/磁盘/服务/进程/端口)
//      ecs_deploy     受控发布(上传 + 重启 + 健康检查)
//      ecs_session    会话管理(list/close)
//   B. 设置页同源 RPC (web profile):
//      GET  /dsh-workbench-ecs/health         健康检查
//      POST /dsh-workbench-ecs/rpc            设置页 JSON RPC
//        op: status(20s缓存/force重查) | list | exec(守卫) | deploy |
//            session-list | session-close
//
// 前置要求: 本机安装并配置阿里云 Workbench CLI(见 README):
//   Windows: irm https://workbench-cli.oss-cn-hangzhou.aliyuncs.com/install.ps1 | iex
//   Linux/macOS: curl -fsSL https://workbench-cli.oss-cn-hangzhou.aliyuncs.com/install.sh | bash
//   凭据: ~/.workbench/config.json(支持 AK/StsToken/RamRoleArn/CredentialsCmd/CredentialsURI)
// ============================================================================
import { defineTool } from '@deepseek-ai/dsh-tools'
import { runWorkbench, PLUGIN_VERSION } from './common.js'
import { createSettingsCore } from './settings-api.js'
import { ecsListDefinition } from './tools/ecs-list.js'
import { ecsExecDefinition } from './tools/ecs-exec.js'
import { ecsUploadDefinition } from './tools/ecs-upload.js'
import { ecsDownloadDefinition } from './tools/ecs-download.js'
import { ecsDiagnoseDefinition } from './tools/ecs-diagnose.js'
import { ecsDeployDefinition } from './tools/ecs-deploy.js'
import { ecsSessionDefinition } from './tools/ecs-session.js'

export const name = 'dsh-workbench-ecs'

// 注入三项宿主服务:
//   tools       —— agent 会话的工具注册表 (A 部分)
//   webServer   —— web profile 的同源 HTTP 路由注册表 (B 部分)
//   subprocess  —— 本机进程执行服务; 设置页 RPC 与工具共用
// 面向部署: web profile 与 agent 会话均提供这三项服务。
export const inject = ['tools', 'webServer', 'subprocess']

// 工具工厂表: 每次 apply 生成定义并注册(注册随 fiber 自动清理)
const TOOL_FACTORIES = [
  ecsListDefinition,
  ecsExecDefinition,
  ecsUploadDefinition,
  ecsDownloadDefinition,
  ecsDiagnoseDefinition,
  ecsDeployDefinition,
  ecsSessionDefinition,
]

export function apply(ctx) {
  // ---- A. 注册模型可见工具 ----
  for (const factory of TOOL_FACTORIES) {
    ctx.tools.register(defineTool(factory(ctx)))
  }

  // ---- B. 设置页同源 RPC 路由 ----
  const webServer = ctx.webServer
  if (webServer === undefined || typeof webServer.register !== 'function') return

  // runCli 适配层: common.runWorkbench 需要 ctx(subprocess/sandboxPolicy);
  // 设置页 RPC 只关心退出码与输出文本。
  const runCli = async (argv) => {
    const r = await runWorkbench(ctx, argv, undefined)
    return { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr }
  }
  const core = createSettingsCore(runCli)

  // 请求体上限: 防御面板误发巨型载荷 (正常 RPC 请求仅 KB 级)
  const MAX_BODY = 512 * 1024

  function sendJson(res, code, obj) {
    try {
      res.writeHead(code, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      })
      res.end(JSON.stringify(obj))
    } catch {
      /* 连接已断开 */
    }
  }

  function readBody(req) {
    return new Promise((resolveBody) => {
      const chunks = []
      let size = 0
      req.on('data', (chunk) => {
        size += chunk.length
        if (size > MAX_BODY) {
          req.destroy()
          resolveBody(null)
          return
        }
        chunks.push(chunk)
      })
      req.on('end', () => resolveBody(Buffer.concat(chunks).toString('utf8')))
      req.on('error', () => resolveBody(null))
    })
  }

  ctx.effect(() => webServer.register({
    kind: 'prefix',
    path: '/dsh-workbench-ecs',
    handler: async (req, res) => {
      try {
        const url = new URL(req.url, 'http://localhost')
        const p = url.pathname
        if (p === '/dsh-workbench-ecs/health') {
          return sendJson(res, 200, { ok: true, plugin: 'dsh-workbench-ecs', version: PLUGIN_VERSION })
        }
        if (p !== '/dsh-workbench-ecs/rpc') {
          return sendJson(res, 404, { ok: false, error: '未知路由: ' + p })
        }
        if (req.method !== 'POST') {
          return sendJson(res, 405, { ok: false, error: 'rpc 仅接受 POST' })
        }
        const raw = await readBody(req)
        if (raw === null) return sendJson(res, 400, { ok: false, error: '请求体过大或已断开' })
        let payload
        try {
          payload = JSON.parse(raw)
        } catch (e) {
          return sendJson(res, 400, { ok: false, error: '请求体不是合法 JSON' })
        }
        const op = payload != null ? payload.op : undefined
        const args = payload != null && payload.args !== undefined ? payload.args : {}
        switch (op) {
          case 'status': return sendJson(res, 200, await core.status(args))
          case 'list': return sendJson(res, 200, await core.list(args))
          case 'exec': return sendJson(res, 200, await core.exec(args))
          case 'deploy': return sendJson(res, 200, await core.deploy(args))
          case 'session-list': return sendJson(res, 200, await core.sessionList())
          case 'session-close': return sendJson(res, 200, await core.sessionClose(args))
          default: {
            // 单个操作失败时返回 JSON 错误而非裸 500, 面板可直接展示
            const safe = String(op != null ? op : '(missing)').slice(0, 80)
            return sendJson(res, 400, { ok: false, error: '未知操作: ' + safe })
          }
        }
      } catch (err) {
        return sendJson(res, 500, {
          ok: false,
          error: String((err != null && err.message != null) ? err.message : err),
        })
      }
    },
  }))
}
