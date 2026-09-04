// ============================================================================
// dsh-workbench-ecs —— 阿里云 Workbench CLI 包装插件 (DeepSeek Harness / Cordis)
// ----------------------------------------------------------------------------
// 入口: 标准 Cordis 插件形态, 注册以下模型可见工具:
//   ecs_list       列出指定地域的 ECS 实例
//   ecs_exec       在实例上执行远程命令(守卫/批量/后台/spill)
//   ecs_upload     上传本地文件到实例(OSS 中继, ≤1GB)
//   ecs_download   从实例下载文件到本地
//   ecs_diagnose   一键只读体检(主机/负载/内存/磁盘/服务/进程/端口)
//   ecs_deploy     受控发布(上传 + 重启 + 健康检查)
//   ecs_session    会话管理(list/close)
//
// 前置要求: 本机安装并配置阿里云 Workbench CLI(见 README):
//   Windows: irm https://workbench-cli.oss-cn-hangzhou.aliyuncs.com/install.ps1 | iex
//   Linux/macOS: curl -fsSL https://workbench-cli.oss-cn-hangzhou.aliyuncs.com/install.sh | bash
//   凭据: ~/.workbench/config.json(支持 AK/StsToken/RamRoleArn/CredentialsCmd/CredentialsURI)
// ============================================================================
import { defineTool } from '@deepseek-ai/dsh-tools'
import { ecsListDefinition } from './tools/ecs-list.js'
import { ecsExecDefinition } from './tools/ecs-exec.js'
import { ecsUploadDefinition } from './tools/ecs-upload.js'
import { ecsDownloadDefinition } from './tools/ecs-download.js'
import { ecsDiagnoseDefinition } from './tools/ecs-diagnose.js'
import { ecsDeployDefinition } from './tools/ecs-deploy.js'
import { ecsSessionDefinition } from './tools/ecs-session.js'

export const name = 'dsh-workbench-ecs'

// 注入 tools 服务: 通过 ctx.tools.register 注册模型可见的工具
export const inject = ['tools']

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
  for (const factory of TOOL_FACTORIES) {
    ctx.tools.register(defineTool(factory(ctx)))
  }
}
