# dsh-workbench-ecs

> v0.3.4 · MIT License

[English](./README.md) | 中文

阿里云 Workbench CLI 包装插件 —— 让 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的 Agent 直接控制远程 ECS 实例。它在本机驱动官方阿里云 [Workbench CLI](https://help.aliyun.com/zh/ecs/user-guide/use-workbench-cli-to-manage-ecs-instances), 内置 **7 个 Agent 原生工具** —— `ecs_list` / `ecs_exec` / `ecs_upload` / `ecs_download` / `ecs_diagnose` / `ecs_deploy` / `ecs_session`, 覆盖「列表 → 体检 → 执行 → 上传 → 重启 → 验证」完整闭环; 并附带**可视化设置面板**(CLI 状态、实例管理、受控发布向导、会话、操作时间线)。实例经 Workbench 后端通道连接, **无需公网 IP**; 破坏性命令走 Harness 审批守卫, 未获明确放行一律拒绝(fail closed)。

## 特性

- **7 个 Agent 原生工具**: `ecs_list` / `ecs_exec` / `ecs_upload` / `ecs_download` / `ecs_diagnose` / `ecs_deploy` / `ecs_session`, 与 Harness 工具体系无缝集成
- **可视化设置面板**(v0.3.0+): CLI 状态(20s Host 缓存 + 本地秒显)、实例浏览(搜索/批量/30s 自动刷新)、一键诊断(磁盘·内存仪表盘)、受控发布向导+模板、会话管理、操作时间线; 自动适配深/浅色主题
- **真实 API 调用**: 工具执行本机 `workbench` 命令, 经阿里云 Workbench 后端连接实例(支持无公网 IP 的实例)
- **JSON 解析 + 可读渲染**: 解析 CLI 的 JSON 输出, 渲染为表格/文本/终端卡片; CLI 层错误(`{code, message}`)转成可读报错
- **安全守卫**: 破坏性命令(`rm -rf`、`shutdown`、`reboot`、`mkfs`、`dd`、`iptables -F/-X` 等)自动接入 Harness 审批服务, 未获批准一律拒绝(fail closed)
- **后台任务**: `ecs_exec` 支持 `run_in_background` — 长命令注册到 jobs, 可 `job_output` 增量读取、`job_kill` 终止
- **批量执行**: `ecs_exec` 支持 `instance_ids` 数组(串行, 单台失败不中断), 适合集群排查
- **大输出 spill**: stdout 超限自动落盘并返回完整输出路径, 日志排查不再截断丢头
- **健壮二进制解析**: 按 PATH 解析 `workbench`, 失败时回退常见安装位置(如 `C:\Program Files\workbench\workbench.exe`), 解决宿主进程 PATH 过期问题
- **取消支持**: 工具调用被取消时自动终止进程树(SIGTERM → SIGKILL), 不留孤儿进程

## 安装

### 前置要求

- Node.js ≥ 20 且 DeepSeek Harness 的 `dsh web` 正在运行;
- **与本插件同一台机器**上安装并配置好官方 Workbench CLI(见下文 [使用前准备](#使用前准备))。

### 官方 dsh 命令一键安装

```bash
dsh plugin --profile web add dsh-workbench-ecs
```

就这一条 —— bundle 层会把插件行写入 web profile: 7 个工具对 Agent 立即可用, Harness 设置(齿轮图标)里出现 **「Workbench ECS」** 标签页。不支持热重载的部署请重启 `dsh web`。

> 本地从仓库开发时改用链接方式:
> `dsh plugin --profile web add link:<仓库绝对路径>` —— 之后修改 `lib/client.js` 刷新页面即生效(无需重启服务)。

### 验证安装

```bash
curl -s http://127.0.0.1:3080/dsh-workbench-ecs/health
# => {"ok":true,"plugin":"dsh-workbench-ecs","version":"0.3.4"}
```

然后让 Agent 调用:

```text
ecs_list { region: "cn-shanghai" }
ecs_exec { instance_id: "i-uf66ct2o35p7fjcd0sru", command: "df -h" }
ecs_diagnose { instance_id: "i-uf66ct2o35p7fjcd0sru" }
```

### 使用前准备: 安装 Workbench CLI 与配置凭据

#### 安装 Workbench CLI(必做)

| 平台 | 命令 |
|---|---|
| Windows (PowerShell) | `irm https://workbench-cli.oss-cn-hangzhou.aliyuncs.com/install.ps1 \| iex` |
| Linux / macOS | `curl -fsSL https://workbench-cli.oss-cn-hangzhou.aliyuncs.com/install.sh \| bash` |

安装后先自检:

```bash
workbench version     # 应输出版本号 / commit / build date
```

> ⚠️ **Windows 用户注意**: 如果你在 Harness 进程启动之后才安装 CLI, 宿主进程继承的 `PATH` 是旧环境, 直接运行 `workbench` 会找不到命令。插件已内置「常见安装位置回退」, 通常无需重启; 若仍失败, 请重启 Harness 会话, 或把安装目录(如 `C:\Program Files\workbench`)加入 PATH。

#### 配置凭据

Workbench CLI 的凭据存储在 `~/.workbench/config.json`(权限要求 `0600`)。支持 5 种认证模式, 直接编辑该文件即可(避免交互式 `workbench config`):

**AK 模式(开发/长期凭据, 默认):**

```json
{
  "current": "default",
  "profiles": {
    "default": {
      "mode": "AK",
      "access_key_id": "LTAIxxxxxxxxxxxxxxxx",
      "access_key_secret": "xxxxxxxxxxxxxxxxxxxxxxxx"
    }
  }
}
```

**StsToken 模式(临时安全凭据):**

```json
{
  "current": "default",
  "profiles": {
    "default": {
      "mode": "StsToken",
      "access_key_id": "LTAIxxxxxxxxxxxxxxxx",
      "access_key_secret": "xxxxxxxxxxxxxxxxxxxxxxxx",
      "security_token": "xxxxxxxxxxxxxxxxxxxxxxxx"
    }
  }
}
```

**RamRoleArn 模式(生产/跨账号/最小权限, 自动刷新 STS 令牌):**

```json
{
  "current": "default",
  "profiles": {
    "default": {
      "mode": "RamRoleArn",
      "access_key_id": "LTAIxxxxxxxxxxxxxxxx",
      "access_key_secret": "xxxxxxxxxxxxxxxxxxxxxxxx",
      "ram_role_arn": "acs:ram::123456789:role/WorkbenchRole",
      "role_session_name": "workbench-session"
    }
  }
}
```

**CredentialsCmd 模式(零信任 / Vault 集成, 外部命令输出凭据 JSON):**

```json
{
  "current": "default",
  "profiles": {
    "default": {
      "mode": "CredentialsCmd",
      "credentials_cmd": "vault read -format=json secret/aliyun-ecs"
    }
  }
}
```

**CredentialsURI 模式(元数据服务 / sidecar):**

```json
{
  "current": "default",
  "profiles": {
    "default": {
      "mode": "CredentialsURI",
      "credentials_uri": "http://localhost:8080/credentials"
    }
  }
}
```

设置文件权限(仅 Linux/macOS 需要; Windows 确保文件不被其他用户读取):

```bash
chmod 600 ~/.workbench/config.json
```

**一键配置脚本(Windows):** 仓库提供 [`scripts/workbench-setup.ps1`](./scripts/workbench-setup.ps1), 支持全部 5 种模式与非交互式多 profile:

```powershell
# AK 模式
./scripts/workbench-setup.ps1 -AccessKeyId LTAIxxx -AccessKeySecret xxx
# RamRoleArn 模式(生产推荐) + 多个 profile
./scripts/workbench-setup.ps1 -Mode RamRoleArn -Profile prod -AccessKeyId LTAIxxx -AccessKeySecret xxx -RamRoleArn acs:ram::123456789:role/WorkbenchRole -AutoSwitch
```

**多 profile 管理(非交互):**

```bash
workbench config list                     # 列出所有 profile(* 表示激活)
workbench config switch --profile prod    # 切换激活 profile
workbench config get                      # 查看当前 profile 详情(JSON)
workbench config delete --profile old     # 删除 profile(不能删除激活中的)
```

#### RAM 最小权限策略(推荐)

给运行 CLI 的 RAM 用户/角色绑定最小权限:

```json
{
  "Version": "1",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["ecs-workbench:LoginECSInstance", "ecs-workbench:ChatMessages"],
      "Resource": "*"
    },
    {
      "Effect": "Allow",
      "Action": ["ecs:DescribeInstances", "ecs:DescribeCloudAssistantStatus", "ecs:StartTerminalSession"],
      "Resource": "*"
    },
    {
      "Effect": "Allow",
      "Action": "ram:CreateServiceLinkedRole",
      "Resource": "*",
      "Condition": {
        "StringEquals": { "ram:ServiceName": "workbench.ecs.aliyuncs.com" }
      }
    }
  ]
}
```

限定到具体实例时, 把 `"Resource": "*"` 换成:

- `ecs-workbench:LoginECSInstance`: `acs:ecs:<region>:<account-id>:ecs/<instance-id>`
- `ecs` 相关 Action: `acs:ecs:<region>:<account-id>:instance/<instance-id>`

#### 手动安装(高级)

也可以直接把插件行写进 Cordis 组合(cordis.yml / cordis.patch.yml):

```yaml
- id: dsh-workbench-ecs
  name: dsh-workbench-ecs
```

注意: 浏览器设置面板只能由 `dsh` 命令接上(bundle 层 `dsh.bundle` + `dsh.client` 声明)。

#### 本地仓库开发

用 [`scripts/install-local.ps1`](./scripts/install-local.ps1) 把仓库以 junction 链接进 `%DSH_HOME%` 并代写插件行(`install` / `status` / `uninstall`), 修改后随下一次 patch 热重载或 `dsh web` 重启生效。

## 设置页面

| 区域 | 能力 |
|---|---|
| CLI 状态 | Workbench CLI 可用性 / 版本 / 凭据 Profile / Daemon; **20 秒缓存 + 本地秒显**(面板即时渲染, 后台静默刷新; [刷新] 强制重查) |
| ECS 实例 | 地域/状态筛选 + 名称/ID 搜索 + 状态分布条 + 复选框(批量执行) + **30s 自动刷新** |
| 实例行操作 | [执行] 选中目标 / [诊断] 一键体检(磁盘·内存仪表盘) / [发布] 受控发布向导 / [详情] 属性 + 最近日志 |
| 远程命令 | 命令历史(datalist)、破坏性命令两次点击确认(Host 端仍二次拦截); 批量执行逐台结果表 |
| 受控发布 | 上传本地文件(OSS 中继 ≤1GB) + 重启/生效命令 + 健康检查, 三阶段进度; 可保存/复用模板 |
| Workbench 会话 | 会话列表 / 关闭单会话 / 关闭全部(排障与资源回收) |
| 操作时间线 | 本次会话面板内所有操作留痕 |

面板直连**本机** Workbench CLI(同源路由 `/dsh-workbench-ecs/rpc`, 由 `lib/index.js` 注册), 不经过 Agent/LLM——因此远程命令的破坏性守卫为「拒绝优先」(要审批放行请走 Agent 的 `ecs_exec` 工具)。界面自动适配深/浅色主题。

## 工作原理

本包是 DSH **静态双半插件**, 以 **bundle 层** 编入 DSH web profile 组合:

| 半 | 文件 | 职责 |
|---|---|---|
| Host 半(Node) | `lib/index.js` | 通过 `tools` 注册 7 个模型工具; 通过 `webServer` 注册同源路由 `/dsh-workbench-ecs/health` 与 `/dsh-workbench-ecs/rpc`; 设置页 RPC 经 `subprocess` 执行本机 CLI(共享 `lib/common.js` / `lib/settings-api.js`) |
| 浏览器半 | `lib/client.js` | 单文件 client bundle(`window.__ModuleLoader__` 工厂形式): 注册「Workbench ECS」设置页标签, 经同源 RPC 路由与 Host 通信 |
| 组合层 | `cordis.patch.yml` | `dsh.bundle` patch: 把插件行插入 profile 组合 —— `dsh web` 启动即生效, 由 `dsh plugin --profile web add` 自动装载 |

两端零构建: `lib/client.js` 为手写单文件 bundle, 无需打包器; 同一套 `lib/` 源码也可临时挂载为动态 body(`npm run build:body`)。

## 工具参考

### `ecs_list` —— 列出指定地域的 ECS 实例

CLI 对应: `workbench list ecs --region <region> [过滤项...] --output json`

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `region` | string | ✅ | 阿里云地域, 例如 `cn-hangzhou` |
| `status` | string | | 实例状态过滤: `Running` / `Stopped` / `Starting` / `Stopping` |
| `tag` | array\<string\> | | 标签过滤, 每项 `key=value` 或 `key`, 可重复, 多个取交集 |
| `instance_type` | string | | 按实例规格过滤, 例如 `ecs.g7.large` |
| `instance_name` | string | | 按实例名称过滤, 支持 `*` 通配符 |
| `limit` | integer | | 每页数量 10–100, 默认 50(ECS API 页大小下限为 10) |

返回实例清单(实例ID为其它工具的输入), 渲染为文本表格。

### `ecs_exec` —— 在指定实例上执行远程命令(增强版)

CLI 对应: `workbench exec --instance-id <id> --command <cmd> [--timeout <s>] --output json`

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `instance_id` | string | | 目标实例 ID(与 `instance_ids` 二选一) |
| `instance_ids` | array\<string\> | | 批量目标(串行, 最多 20 台, 单台失败不中断) |
| `command` | string | ✅ | 远程命令; 需要共享上下文时用 `&&` 或 `;` 串联 |
| `timeout` | integer | | 命令超时(秒), 默认 30 |
| `region` | string | | 地域, 可缺省(CLI 从实例 ID 自动推断) |
| `run_in_background` | boolean | | 后台执行长命令: 立即返回 `job_id`, `job_output` 增量读取(不适用于批量) |

返回 `{ kind: single|batch|background, ... }`。

### `ecs_upload` —— 上传本地文件到实例

CLI 对应: `workbench upload <local-file> <remote-path> --instance-id <id> [--force]`

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `local_file` | string | ✅ | 本地文件路径(相对路径基于会话工作区) |
| `remote_path` | string | ✅ | 远端目标路径(文件或目录) |
| `instance_id` | string | ✅ | 目标实例 ID |
| `region` | string | | 地域, 可缺省 |
| `force` | boolean | | 覆盖远端已存在文件而不需确认(默认 false) |

经阿里云 OSS 中继传输(最大 1GB)。搭配 `ecs_deploy` / `ecs_exec` 完成发布。

### `ecs_download` —— 从实例下载文件到本地

CLI 对应: `workbench download <remote-path> [local-path] --instance-id <id> [--force]`

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `remote_path` | string | ✅ | 远端文件路径 |
| `local_path` | string | | 本地保存路径(文件或目录, 相对会话工作区; 省略=当前目录) |
| `instance_id` | string | ✅ | 目标实例 ID |
| `region` | string | | 地域, 可缺省 |
| `force` | boolean | | 覆盖本地已存在文件而不需确认(默认 false) |

**典型场景**: 把生产日志/配置文件拉回本地分析。

### `ecs_diagnose` —— 一键只读体检

CLI 对应: 一次远程 `exec`(分号串联的只读命令集)

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `instance_id` | string | ✅ | 目标实例 ID |
| `region` | string | | 地域, 可缺省 |
| `extra_command` | string | | 追加的自定义只读命令(会被安全守卫检查) |
| `timeout` | integer | | 超时(秒), 默认 120 |

内置 7 段: 主机信息 / 负载与运行时长 / 内存 / 磁盘 / 运行服务与容器(docker ps)/ 内存 TOP 进程 / 监听端口。**生产排障的起始动作** —— 一个工具代替一串命令。

### `ecs_deploy` —— 受控发布(上传 + 重启 + 健康检查)

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `instance_id` | string | ✅ | 目标实例 ID |
| `command` | string | ✅ | 重启/生效命令, 如 `docker compose restart` |
| `local_file` | string | | 可选: 要上传的本地文件 |
| `remote_path` | string | | 可选: 上传目标远端路径(local_file 提供时必填) |
| `health_check` | string | | 可选: 健康检查命令, 如 `curl -fsS http://127.0.0.1/health \|\| true` |
| `region` / `force` / `timeout` | | | 同前 |

三段流程结果全部返回(任一失败不中断后续阶段): 上传 → 重启 → 健康检查。**"改代码 → 上传 → 重启 → 验证"的完整修复闭环**。

### `ecs_session` —— 会话管理

CLI 对应: `workbench session list` / `workbench session close <id>` / `--all`

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `action` | string | ✅ | `list` 查看活动会话; `close` 关闭会话 |
| `session_id` | string | | 要关闭的会话 ID(close 时使用) |
| `all` | boolean | | 关闭全部会话(close 时使用) |

一般无需手动管理(会话自动管理), 用于排障与资源回收。

## 安全机制

- **破坏性命令守卫**: `ecs_exec` / `ecs_deploy`(重启命令与健康检查)执行前扫描命令, 命中 `rm -rf`、`shutdown`/`poweroff`/`reboot`/`halt`、`mkfs`、`dd`、`init 0/6`、`systemctl stop/disable/mask`、`service stop`、`iptables -F/-X`、`userdel`/`groupdel` 等模式时, 接入 Harness `approval` 服务请求确认; 未获 `allowed-once`(或无审批服务/政策为 never)一律拒绝执行(fail closed)。
- **只读体检**: `ecs_diagnose` 内置命令均为只读; 自定义命令同样过守卫。
- **文件传输确认**: `ecs_upload`/`ecs_download` 默认对已存在文件要求确认, `force=true` 才覆盖。
- **凭据安全**: 凭据只存在本机 `~/.workbench/config.json`(0600), 建议用 RamRoleArn/CredentialsCmd/CredentialsURI 模式而非长期 AK。

## 典型用法(生产修复闭环)

```text
# 1. 找到实例
ecs_list { region: "cn-shanghai", status: "Running" }

# 2. 一键体检定位问题
ecs_diagnose { instance_id: "i-uf66ct2o35p7fjcd0sru" }

# 3. 看日志
ecs_exec { instance_id: "i-uf66ct2o35p7fjcd0sru", command: "cd /var/log/nginx && tail -n 100 error.log" }

# 4. 修改代码后受控发布(上传 + 重启 + 健康检查)
ecs_deploy {
  instance_id: "i-uf66ct2o35p7fjcd0sru",
  local_file: "./app.jar", remote_path: "/opt/app/app.jar",
  command: "docker compose -f /opt/app/docker-compose.yml restart app",
  health_check: "curl -fsS http://127.0.0.1:3000/health || true"
}

# 5. 长任务后台执行
ecs_exec { instance_id: "i-uf66ct2o35p7fjcd0sru", command: "npm run build", run_in_background: true }
```

## 故障排查

### CLI 退出码

| 退出码 | 含义 |
|---|---|
| 0 | 成功 |
| 1 | 未分类运行时错误(实例不存在、API 错误等) |
| 2 | 参数错误(缺失/非法标志值) |
| 3 | 会话 ID 无效或过期 |
| 4 | 认证/授权失败 |
| 5 | 网络超时 / WebSocket 异常 |
| 6 | 本地 daemon 未运行或 socket 无效 |
| 7 | 会话被其他 TTY 占用 |

### 常见问题

| 报错 | 处理 |
|---|---|
| `InvalidAccessKeyId` / 认证错误 (code 4) | 检查 `~/.workbench/config.json` 的 AK/SK, 重跑 `workbench config` |
| `profile not found` (code 1) | `workbench config list` 检查 profile 名 |
| `insecure permissions` (code 2) | `chmod 600 ~/.workbench/config.json` |
| `workbench CLI 不可用` | 确认已安装 CLI; 若宿主进程启动早于安装, 重启 Harness 或把安装目录加入 PATH |
| `network timeout` (code 5) | 检查到 `*.aliyuncs.com` 的网络与安全组规则 |
| 找不到实例 (code 1) | 核对实例 ID 与地域, 用 `ecs_list` 确认 |
| 无公网 IP 的实例连不上 | 本插件走 Workbench 后端通道, 无需公网 IP; 确认实例安装了云助手(cloud assistant) |
| `破坏性命令未获批准` | 这是安全守卫的正常行为: 需要用户(或审批方)明确放行 |

### 插件报错格式示例

```text
ecs_exec: workbench CLI 错误 (code 1): session resolve: login instance: SDKError: ...
```

## 开发

```bash
npm install          # 安装 devDependencies(@deepseek-ai/dsh-tools)
npm test             # 冒烟测试: 模块导出 + 7 工具注册契约 + body 一致性
npm run test:e2e     # 真实 CLI 端到端测试(需要本机 Workbench CLI + 有效凭据 + 可达实例)
npm run build:body   # 生成动态挂载用 body(与 lib/ 同源)
```

- 源码结构: `lib/common.js`(共享层) · `lib/tools/*.js`(每工具一个模块) · `lib/index.js`(入口)
- 动态挂载(临时会话): `npm run build:body` 后把生成的 body 用于 `cordis_define` 的 `code.host`
- CI: [GitHub Actions](./.github/workflows/ci.yml) —— push/PR 跑测试, `v*` tag 自动发布 npm(需 `NPM_TOKEN` secret)
- 类型声明: [`lib/types/index.d.ts`](./lib/types/index.d.ts)
- 一键配置脚本: [`scripts/workbench-setup.ps1`](./scripts/workbench-setup.ps1)

## License

[MIT](./LICENSE) © 2026 [nishuoyang](https://github.com/nishuoyang)
