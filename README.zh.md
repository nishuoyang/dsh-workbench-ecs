# dsh-workbench-ecs

> v0.6.2 · MIT License

[English](./README.md) | 中文

> 阿里云 Workbench CLI 包装插件 —— 让 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的 Agent 直接控制远程 ECS 实例。

它在本机驱动官方阿里云 [Workbench CLI](https://help.aliyun.com/zh/ecs/user-guide/use-workbench-cli-to-manage-ecs-instances), 内置 **8 个 Agent 原生工具** —— `ecs_list` / `ecs_exec` / `ecs_log` / `ecs_upload` / `ecs_download` / `ecs_diagnose` / `ecs_deploy` / `ecs_session`, 覆盖「列表 → 体检 → 执行 → 长任务 → 上传 → 重启 → 验证」完整闭环; 并附带**可视化设置面板**(CLI 状态、实例管理、受控发布向导、会话、操作时间线)。实例经 Workbench 后端通道连接, **无需公网 IP**; 破坏性命令走 Harness 审批守卫, 未获明确放行一律拒绝(fail closed)。

## 特性

- **8 个 Agent 原生工具**: `ecs_list` / `ecs_exec` / `ecs_log` / `ecs_upload` / `ecs_download` / `ecs_diagnose` / `ecs_deploy` / `ecs_session`, 与 Harness 工具体系无缝集成
- **detach 长任务 + 日志游标**(v0.5.0+): `ecs_exec { detach: true }` 在远端 `nohup` 启动并写日志文件, 立即返回 `job_id`/`log_path`/`exit_path`; 插件按间隔轮询增量, **不长期占用实例**(期间同实例其它调用可正常插空执行), 远端日志文件是唯一事实源, 模型读得慢也不会丢段或重复。配套 `ecs_log` 用**字节游标**从头续读任意远端文件(发布日志轮询不再需要反复整段 tail)
- **伪会话**(v0.5.0+): `ecs_exec { session_id: "deploy" }` 在同一会话内保留工作目录与环境变量(`cd`/`export` 跨调用继承), 不同 session_id 互不影响; 状态由插件持有, 空闲 30 分钟自动重置并显式提示
- **可视化设置面板**(v0.3.0+): CLI 状态(20s Host 缓存 + 本地秒显)、实例浏览(搜索/批量/30s 自动刷新)、一键诊断(磁盘·内存仪表盘)、受控发布向导+模板、会话管理、操作时间线; 自动适配深/浅色主题
- **真实 API 调用**: 工具执行本机 `workbench` 命令, 经阿里云 Workbench 后端连接实例(支持无公网 IP 的实例)
- **JSON 解析 + 可读渲染**: 解析 CLI 的 JSON 输出, 渲染为表格/文本/终端卡片; CLI 层错误(`{code, message}`)转成可读报错
- **安全守卫**: 破坏性命令(`rm -rf`、`shutdown`、`reboot`、`mkfs`、`dd`、`iptables -F/-X` 等)自动接入 Harness 审批服务, 未获批准一律拒绝(fail closed)
- **脚本直送**(v0.4.0+): `ecs_exec` 的 `script` 参数把脚本正文 base64 投递远端落盘后执行, 内容不经过任何 shell 引用层 —— `docker exec ... node -e "..."` 这类多层引号组合、中文、`$`、反引号、heredoc、多行全部**零转义**; 超过 16KB 自动分片投递, 并按字节数校验落盘完整性
- **只读护栏**(v0.4.0+): `ecs_exec` / `ecs_diagnose` 的 `read_only` 在命令进入 shell 之前拒绝写操作(重定向、`rm`/`mv`/`cp`/`chmod`、`docker` 变更、`systemctl` 变更、`nohup` 等); `ecs_diagnose` **默认开启**, 且预置诊断脚本零误杀
- **传输完整性**(v0.4.0+): `ecs_upload.verify_sha256` 上传后比对本地/远端 sha256; `ecs_deploy` 默认开启, 校验不一致时**中止发布**(不会拿损坏的发布物去重启), 本地哈希经 `sha256sum`/`shasum`/`certutil` 计算, 不依赖额外运行时
- **后台任务**: `ecs_exec` 支持 `run_in_background` — 长命令注册到 jobs, 可 `job_output` 增量读取、`job_kill` 终止; 批量时每台实例各起一个 job 并返回 `job_ids`(v0.5.1+)
- **Runbook / 跑书**(v0.6.1+ 机制, v0.6.2+ 面板): 把编排存成**纯数据**放在工作区 `.dsh/workbench-ecs/runbooks/*.json`,`ecs_deploy { runbook: "release", runbook_params: { sha } }` 一次调用跑完;插件只做机制(读取/校验/`${参数}` 替换/展开),**内容与脚本本体留在项目仓库** —— 发布契约可评审、可版本化, 插件里没有项目逻辑。设置面板里也能**列出 / 预演 / 执行**同一份跑书(与 Agent 共用同一引擎, 预演的命令行逐字一致)
- **多步编排**(v0.6.0+): `ecs_deploy { steps: [...] }` 把「上传 → 执行 → 断言 → 读日志」写成一次调用, `assert` 用 `expect` 逐条判定并在失败时**精确标出是哪一条断言、期望什么、实际什么**; `dry_run` 可先预演命令而不执行。一次发布从十余次调用收敛为一次
- **批量执行**: `ecs_exec` 支持 `instance_ids` 数组(单台失败不中断), 适合集群排查; `concurrency` 控制并发(默认只读 4 / 写 1 串行), 同实例仍由实例锁串行 —— 集群排查不再逐台排队(v0.5.1+)
- **目录递归上传**(v0.5.1+): `ecs_upload { local_dir: "dist" }` 一次调用完成「本机 `tar` 归档 → 上传 → sha256 校验 → 远端解包」, 省掉手工打包; 校验失败**中止解包**, 坏包不会改写远端目录
- **结构化输出**(v0.5.1+): `output_json: true` 直接返回稳定 JSON 文本, 便于下游自动化接线(`ecs_exec` / `ecs_list`)
- **同实例串行化**: 同一实例上的操作按 FIFO 逐个执行, 并发调用不会经由共享的 Workbench 会话互相串流; 不同实例仍可并行。detach 任务只在每次轮询期间短暂持锁, 不再长期占用实例名额(v0.5.0+)
- **大输出 spill**: stdout 超限自动落盘并返回完整输出路径, 日志排查不再截断丢头
- **输出清洗**: 默认剔除 ANSI 转义、控制字符与 CLI 进度帧(spinner/百分比条), 日志与上传结果直接可读(`strip_ansi: false` 可关闭)
- **可靠退出码**: 以 CLI JSON 中的远端 `exit_code` 为准(而非本地进程退出码), 并带回 `request_id`/`session_id` 便于事后核对隔离性
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

就这一条 —— bundle 层会把插件行写入 web profile: 8 个工具对 Agent 立即可用, Harness 设置(齿轮图标)里出现 **「Workbench ECS」** 标签页。不支持热重载的部署请重启 `dsh web`。

> 本地从仓库开发时改用链接方式:
> `dsh plugin --profile web add link:<仓库绝对路径>` —— 之后修改 `lib/client.js` 刷新页面即生效(无需重启服务)。

### 验证安装

```bash
curl -s http://127.0.0.1:3080/dsh-workbench-ecs/health
# => {"ok":true,"plugin":"dsh-workbench-ecs","version":"0.6.2"}
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
| 受控发布 | 上传本地文件(OSS 中继 ≤1GB) + 重启/生效命令 + 健康检查, 三阶段进度; 可保存/复用模板; **模式可切换为「Runbook」**(直接跑工作区跑书, 带预演)(v0.6.2+) |
| Runbook(发布跑书) | 扫描 `<工作区>/.dsh/workbench-ecs/runbooks/*.json`, 列出名称/说明/步数/类型/参数占位(坏文件标为无效而不影响其它条目); 填目标实例与参数 JSON 后可 **预演**(零副作用)或 **执行**; 结果按步骤渲染(含 `skipped` 标记与断言逐条 ✔/✘)(v0.6.2+) |
| Workbench 会话 | 会话列表 / 关闭单会话 / 关闭全部(排障与资源回收) |
| 操作时间线 | 本次会话面板内所有操作留痕 |

面板直连**本机** Workbench CLI(同源路由 `/dsh-workbench-ecs/rpc`, 由 `lib/index.js` 注册), 不经过 Agent/LLM——因此远程命令的破坏性守卫为「拒绝优先」(要审批放行请走 Agent 的 `ecs_exec` 工具)。界面自动适配深/浅色主题。

## 工作原理

本包是 DSH **静态双半插件**, 以 **bundle 层** 编入 DSH web profile 组合:

| 半 | 文件 | 职责 |
|---|---|---|
| Host 半(Node) | `lib/index.js` | 通过 `tools` 注册 8 个模型工具; 通过 `webServer` 注册同源路由 `/dsh-workbench-ecs/health` 与 `/dsh-workbench-ecs/rpc`; 设置页 RPC 经 `subprocess` 执行本机 CLI(共享 `lib/common.js` / `lib/settings-api.js` / `lib/steps-engine.js`; runbook 机制在 `lib/runbooks.js`) |
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
| `vpc_id` | string | | 按 VPC ID 过滤(v0.5.1+) |
| `vswitch_id` | string | | 按交换机(VSwitch) ID 过滤(v0.5.1+) |
| `zone_id` | string | | 按可用区过滤(v0.5.1+), 例如 `cn-shanghai-a` |
| `private_ip` | array\<string\> | | 按私网 IP 过滤(v0.5.1+), 可多个 |
| `image_id` | string | | 按镜像 ID 过滤(v0.5.1+) |
| `limit` | integer | | 每页数量 10–100, 默认 50(ECS API 页大小下限为 10) |
| `next_token` | string | | 上一页返回的 token(v0.5.1+, 透传给 CLI) |
| `output_json` | boolean | | 以稳定 JSON 文本返回结果(v0.5.1+) |

返回实例清单(实例ID为其它工具的输入), 渲染为文本表格。

> **分页现状(v0.5.1 实测)**: CLI 的 `list ecs --output json` **只返回 `instances`**, 不含 `NextToken`/`TotalCount` —— 因此插件无法自动翻页。当返回条数顶到 `limit` 且 CLI 未给 token 时, 结果里会出现 `pagination_note` 明确提示(避免误以为"就这么多"); 缓解办法是收紧过滤条件(`instance_name`/`tag`/`status`/`vpc_id`/`zone_id`)。彻底解决需要 CLI 侧在 JSON 输出中透出 `NextToken`(已记入 `docs/workbench-ecs-改良计划-20260912.md` 的上游需求)。

### `ecs_exec` —— 在指定实例上执行远程命令(增强版)

CLI 对应: `workbench exec --instance-id <id> --command <cmd> [--timeout <s>] --output json`

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `instance_id` | string | | 目标实例 ID(与 `instance_ids` 二选一) |
| `instance_ids` | array\<string\> | | 批量目标(最多 20 台, 单台失败不中断; 可选 `concurrency` 并发) |
| `concurrency` | integer | | 批量并发度(v0.5.1+; 默认 `read_only=true` 时 4, 否则 1 串行)。同实例仍由实例锁串行, 跨实例才真正并行 |
| `command` | string | | 远程命令(与 `script` 二选一); 需要共享上下文时用 `&&` 或 `;` 串联 |
| `script` | string | | 脚本正文(与 `command` 二选一)。**零转义**: base64 投递远端落盘后执行, 引号/中文/`$`/反引号/多行/heredoc 都不需要处理 |
| `shell` | `bash`\|`sh` | | `script` 模式的远端解释器, 默认 `bash` |
| `keep_script` | boolean | | 保留远端临时脚本文件(默认 false, 执行后删除) |
| `read_only` | boolean | | 只读护栏: 命中写操作模式直接拒绝(默认 false) |
| `description` | string | | 本次用途简述(展示在任务列表与卡片标题) |
| `strip_ansi` | boolean | | 清洗 ANSI/控制字符/进度帧(默认 true) |
| `timeout` | integer | | 远端命令超时(秒), 默认 60(显式下发; CLI 自身默认仅 30) |
| `region` | string | | 地域, 可缺省(CLI 从实例 ID 自动推断) |
| `run_in_background` | boolean | | 后台执行长命令: 立即返回 `job_id`, `job_output` 增量读取; 与 `instance_ids` 同用时每台一个 job, 返回 `job_ids` 数组(v0.5.1+) |
| `detach` | boolean | | **远端 detach 长任务**(发布/构建等分钟~小时级操作推荐): 远端 `nohup` + 日志文件, 立即返回 `job_id`/`log_path`/`exit_path`; 轮询增量且不长期占锁 |
| `poll_interval` | integer | | detach 轮询间隔(秒), 默认 2 |
| `max_duration` | integer | | detach 最长跟踪时长(秒), 默认 3600; 超时停止跟踪(远端任务继续跑) |
| `session_id` | string | | **伪会话**: 同一 id 下保留 cwd/环境变量; 仅单实例前台(不能与批量/detach/后台同用) |
| `session_reset` | boolean | | 先清空该会话的 cwd/环境变量再执行 |
| `env` | array\<string\> | | 会话内持久环境变量, 每项 `K=V`, 与已有会话变量合并 |
| `output_json` | boolean | | 以稳定 JSON 文本返回结果(v0.5.1+; 便于下游自动化解析), 默认 false 返回可读文本 |

返回 `{ kind: single|batch|batch_background|background|detached, ... }`(含 `exit_code` / `request_id` / `cli_session_id`, 会话模式下还有 `session_cwd` / `env_keys`, 批量时还有 `concurrency`)。

**什么时候用 `script`**: 命令里出现任何嵌套引号就一律用它。典型对比 ——

```text
# 容易碎(要穿透远端 sh -c + docker exec + node -e 三层引号)
ecs_exec { instance_id: "i-xxx", command: "docker exec app node -e \"console.log('hi')\"" }

# 零转义(推荐)
ecs_exec { instance_id: "i-xxx", script: "docker exec app node -e \"console.log('hi')\"" }
```

### `ecs_log` —— 远端文件按字节游标续读(只读)

CLI 对应: `workbench exec`(仅 `wc -c` / `tail -c` / `head -c` / `cat`, 全程只读)

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `instance_id` | string | ✅ | 目标实例 ID |
| `path` | string | ✅ | 远端文件路径, 如 `/tmp/.dsh-ecs-xxx/out.log` |
| `after` | integer | | 起始字节偏移(上次返回的 `next_offset`; 首次为 0) |
| `max_bytes` | integer | | 单次最多读取字节数, 默认 262144; `truncated=true` 时应立即续读 |
| `exit_file` | string | | 可选: 远端退出码文件, 存在时返回 `exit_code` |
| `region` / `timeout` | | | 地域 / 超时(秒, 默认 60) |

**用法**: 发布/构建日志轮询的标准动作是 `ecs_log { path: "<log>", after: <上次 next_offset> }`,
不再需要"整段 tail 再肉眼找增量";配合 `detach` 的 `log_path` 可从头完整翻阅任意长度的日志。

### `ecs_upload` —— 上传本地文件到实例

CLI 对应: `workbench upload <local-file> <remote-path> --instance-id <id> [--force]`

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `local_file` | string | | 本地文件路径(相对路径基于会话工作区); 与 `local_dir` 二选一 |
| `local_dir` | string | | 本地目录路径(**递归上传**, v0.5.1+): 本机 `tar` 归档 → 上传 → 远端解包; 与 `local_file` 二选一 |
| `remote_path` | string | ✅ | 远端目标路径(`local_file` 时以分隔符结尾视为目录, 自动拼接文件名; `local_dir` 时为**目标目录**) |
| `instance_id` | string | ✅ | 目标实例 ID |
| `region` | string | | 地域, 可缺省 |
| `force` | boolean | | 覆盖远端已存在文件而不需确认(默认 false) |
| `verify_sha256` | boolean | | 上传后比对本地/远端 sha256(默认 false; 发布关键路径建议开启。**目录模式校验失败会中止解包**) |
| `keep_root_dir` | boolean | | 目录模式: 保留归档顶层的目录名(默认 false, 即只上传目录内容) |
| `keep_archive` | boolean | | 目录模式: 远端解包后保留归档文件(默认 false, 解包后删除) |
| `timeout` | integer | | 目录模式远端解包命令超时(秒), 默认 120 |

经阿里云 OSS 中继传输(最大 1GB)。返回 `verification`(`ok` / `mismatch` / `remote-unavailable` / `local-tool-unavailable`)与两侧摘要。搭配 `ecs_deploy` / `ecs_exec` 完成发布。

**目录递归上传**(v0.5.1+)把"本地打包 → 上传 → 远端解包"收敛成一次调用, 顺序固定为 **归档 → 上传 → 校验 → 解包**: sha256 不一致时**不下发解包命令**, 远端目录不会被损坏的包改写; 返回 `entries`(归档条目数)/`extracted`/`local_archive_cleanup`。本地归档暂存在会话工作区根目录并在结束后自动清理(`.dsh-ecs-upload-*.tar.gz`)。需要本机 `tar`(Windows 10+ / Linux 自带)。

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
| `extra_command` | string | | 追加的自定义只读命令 |
| `read_only` | boolean | | 只读护栏, **默认 true**; 传 `false` 才允许 `extra_command` 中写入 |
| `description` | string | | 本次体检用途简述 |
| `strip_ansi` | boolean | | 清洗 ANSI/控制字符/进度帧(默认 true) |
| `timeout` | integer | | 超时(秒), 默认 120(显式下发) |

内置 7 段: 主机信息 / 负载与运行时长 / 内存 / 磁盘 / 运行服务与容器(docker ps)/ 内存 TOP 进程 / 监听端口。**生产排障的起始动作** —— 一个工具代替一串命令。

### `ecs_deploy` —— 受控发布 / 多步编排

两种用法:**(A) 老三阶段**(上传 → 校验 → 重启 → 健康检查)与 **(B) `steps` 编排**(v0.6.0+)。

**(A) 老三阶段**

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `instance_id` | string | ✅ | 目标实例 ID |
| `command` | string | | 重启/生效命令, 如 `docker compose restart`(用 `steps` 时不需要) |
| `local_file` | string | | 可选: 要上传的本地文件 |
| `remote_path` | string | | 可选: 上传目标远端路径(local_file 提供时必填) |
| `health_check` | string | | 可选: 健康检查命令, 如 `curl -fsS http://127.0.0.1/health \|\| true` |
| `verify_sha256` | boolean | | 上传后校验 sha256, **默认 true**; 不一致即中止发布(不执行重启) |
| `region` / `force` / `timeout` | | | 地域 / 覆盖确认 / 每阶段超时(秒, 默认 180) |

四段流程结果全部返回(阶段内失败不中断后续阶段): 上传 → sha256 校验 → 重启 → 健康检查; 唯一例外是**校验失败会中止**(见 `aborted` / `abort_reason`), 避免用损坏的发布物重启服务。

**(B) `steps` 编排(v0.6.0+)** —— 把同一实例上的一串动作写成**一次调用**:

| 步骤 | 字段 | 说明 |
|---|---|---|
| `upload` | `local_file`, `remote_path`, `force?`, `verify_sha256?` | 上传; 默认 `verify_sha256: true`, 校验失败**中止整个编排** |
| `exec` | `command` \| `script`, `timeout?`, `read_only?`, `description?` | 执行命令或脚本(`script` 走 base64 零转义投递) |
| `assert` | `command` \| `script`, `expect` | 断言: `expect: { exit_code?, stdout_contains?, stdout_not_contains?, stderr_contains? }` |
| `tail` | `path`, `after?`, `max_bytes?`, `exit_file?`, `wait_seconds?` | 按**字节游标**读远端日志; `wait_seconds` 可等待 `exit_file` 出现 |

编排级参数:`dry_run`(只回显计划不执行, **不请求审批**)、`continue_on_error`(默认 false:任一步失败即中止并把余下步骤标记为 `skipped`)、`read_only`(对所有 exec/assert 步骤开只读护栏)、`timeout`(每步默认 180s)。上限 20 步。

```jsonc
// 一次调用完成"上传 → 断言 → 重启 → 断言 → 读日志"
{
  "instance_id": "i-xxx",
  "steps": [
    { "kind": "upload", "local_file": "dist/app.jar", "remote_path": "/opt/app/app.jar", "force": true },
    { "kind": "assert", "command": "test -s /opt/app/app.jar && echo size-ok",
      "expect": { "exit_code": 0, "stdout_contains": ["size-ok"] } },
    { "kind": "exec", "command": "docker compose up -d --force-recreate", "timeout": 300 },
    { "kind": "assert", "script": "curl -fsS http://127.0.0.1/health", "expect": { "stdout_contains": ["\"ok\":true"] } },
    { "kind": "tail", "path": "/tmp/release.log", "exit_file": "/tmp/release.exit", "wait_seconds": 60 }
  ]
}
```

返回 `mode`(`legacy` / `steps`)、`ok`、`done_stage`/`total_stage`、`stopped_at`/`stopped_reason`/`failed_steps`,以及逐步的 `stages`(断言步骤带 `assertions` 逐条结果,tail 步骤带 `next_offset`/`total_bytes`/`eof`)。**失败定位到具体步骤与具体断言**,不再靠人肉翻日志。

**(C) Runbook(跑书,v0.6.1+)** —— 把编排存成**纯数据**,插件只做机制:

| 参数 | 说明 |
|---|---|
| `runbook` | `"名字"` → 读工作区 `.dsh/workbench-ecs/runbooks/<name>.json`;或直接内联对象 `{ name?, description?, params?, steps }` |
| `runbook_params` | 参数对象:覆盖 runbook 的 `params` 默认值,替换 `${name}` 占位符;隐式可用 `${instance_id}` / `${region}` |

runbook 文件形状:

```jsonc
{
  "name": "release",
  "description": "奶龙发布",
  "params": { "sha": "latest", "log": "/tmp/release.log" },   // 默认值, 可被 runbook_params 覆盖
  "steps": [
    { "kind": "upload", "local_file": "dist/app.jar", "remote_path": "/opt/app/app.jar", "force": true },
    { "kind": "exec", "script": "bash /opt/app/deploy/release.sh ${sha} > ${log} 2>&1; echo $? > ${log}.exit",
      "timeout": 600, "description": "执行仓库里的发布脚本 ${sha}" },
    { "kind": "assert", "command": "curl -fsS http://127.0.0.1/health",
      "expect": { "stdout_contains": ["\"ok\":true"] } },
    { "kind": "tail", "path": "${log}", "exit_file": "${log}.exit", "wait_seconds": 300 }
  ]
}
```

**边界(有意为之)**:插件只提供**机制** —— 读取 / 校验 / 参数替换 / 展开成 `steps`;**内容**(步骤与断言、脚本本体)留在项目仓库,插件不硬编码任何项目逻辑。占位符 `${name}` 在任意字符串里替换;整串恰好是一个占位符时**保留原始类型**(`"timeout": "${t}"` + `t=300` → 数字 300);缺少参数会直接报错并列出该 runbook 声明的占位符;多余的入参会在结果里以 `unused_params` 提示。runbook 名字只允许 `[A-Za-z0-9._-]`(挡住路径穿越)。需要 `fs` 服务;未挂载时请改用内联 `runbook` 对象。

**(D) 面板里跑同一份 runbook(v0.6.2+)** —— 设置页的「Runbook（发布跑书）」卡片会扫描工作区 runbook 目录,列出名称/说明/步数/类型/参数占位,逐条提供 **预演**(只回显命令行,零副作用)与 **执行**;发布向导也可直接切换为「Runbook」模式。

- 面板与 Agent **共用同一个编排引擎**(`lib/steps-engine.js`),因此预演出来的命令行与 Agent 真正下发的逐字一致 —— 不会出现"面板能跑、工具跑不通"的漂移;
- **守卫口径差异(有意)**:面板没有审批上下文,命中破坏性命令模式**直接拒绝**并把错误定位到具体步骤(要审批放行请走 Agent 的 `ecs_deploy`);`read_only` 步骤按只读护栏预检;
- 面板侧 RPC 操作:`runbook-list` / `runbook-plan` / `runbook-run`(同源路由 `/dsh-workbench-ecs/rpc`)。

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
- **只读护栏**(v0.4.0+): `read_only=true` 时在命令进入 shell 之前拒绝写操作 —— 非 `/dev/null` 重定向、`rm`/`mv`/`cp`/`mkdir`/`touch`/`chmod`/`chown`/`truncate`、`tee`、`sed -i`、`docker`/`docker compose` 变更、`systemctl`/`service` 状态变更、包管理与 `git` 写操作、`kill`/`nohup`、`crontab`/用户管理、`find -delete/-exec` 等。这是**防呆**, 不是权限边界(动态拼接仍可绕过), 强约束仍走审批。
- **只读体检**: `ecs_diagnose` 内置命令均为只读并默认开启护栏; 自定义命令同样过守卫。
- **传输完整性**: `ecs_upload.verify_sha256` / `ecs_deploy.verify_sha256`(默认开启)比对本地与远端 sha256, 损坏的发布物在重启前就会被拦下。
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

# 3b. 复杂命令一律用 script(零转义, 含容器内验证)
ecs_exec {
  instance_id: "i-uf66ct2o35p7fjcd0sru",
  script: "docker exec nailong-server node -e \"fetch('http://127.0.0.1/health').then(r=>console.log(r.status))\""
}

# 4. 修改代码后受控发布(上传 + sha256 校验 + 重启 + 健康检查)
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
npm test             # 单元回归(不触达实例) + 冒烟测试(模块导出 + 7 工具注册契约 + body 一致性)
npm run test:unit    # 只跑单元回归: base64/只读护栏/超时默认/输出清洗/sha256 链路
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
