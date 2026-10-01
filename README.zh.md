# dsh-workbench-ecs

> v0.9.0 · MIT License

[English](./README.md) | 中文

> 阿里云 Workbench CLI 包装插件 —— 让 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的 Agent 直接控制远程 ECS 实例。

它在本机驱动官方阿里云 [Workbench CLI](https://help.aliyun.com/zh/ecs/user-guide/use-workbench-cli-to-manage-ecs-instances), 内置 **11 个 Agent 原生工具** —— `ecs_find` / `ecs_list` / `ecs_exec` / `ecs_log` / `ecs_upload` / `ecs_download` / `ecs_diagnose` / `ecs_deploy` / `ecs_runbook` / `ecs_snapshot` / `ecs_session`, 覆盖「跨地域检索 → 列表 → 体检 → 执行 → 长任务 → 上传 → 重启 → 验证 → 快照核对」完整闭环; 并附带**可视化设置面板**(CLI 状态、实例管理、受控发布向导、会话、操作时间线)。实例经 Workbench 后端通道连接, **无需公网 IP**; 破坏性命令走 Harness 审批守卫, 未获明确放行一律拒绝(fail closed)。

## 特性

- **两个宿主都能跑**(v0.9.0+): 浏览器端(`dsh web`, DSH 0.1.x)**与** DeepSeek Harness 桌面应用(`dsh-desktop-host`, DSH 0.2.x)—— 同一个包、同一份 `lib/client.js`, 两端可用。桌面端就是同一个 web 面, 因此设置页标签与 11 个工具在桌面端同样出现; `peerDependencies` 区间同时覆盖两个运行时, 所以**哪一端都不会静默跳过**该 bundle, 并由 `test/compat.mjs` 把这条锁死
- **11 个 Agent 原生工具**(v0.8.0+ 新增 `ecs_snapshot`, v0.7.0+ 新增 `ecs_find`): `ecs_find` / `ecs_list` / `ecs_exec` / `ecs_log` / `ecs_upload` / `ecs_download` / `ecs_diagnose` / `ecs_deploy` / `ecs_runbook` / `ecs_snapshot` / `ecs_session`, 与 Harness 工具体系无缝集成
- **发布快照 `ecs_snapshot`**(v0.8.0+): 把「动手前的**回滚点** + 动手后的**差异核对**」做成一等公民, 不必每次由 agent 手写 `docker tag` + `docker cp` + `docker images/ps` 的拼装脚本 —— `create` 一次**只读**采集(默认采集器: 主机信息 / `docker images --digests` / `docker ps` / `ss -tln`, 外加 `paths` 的文件·目录指纹与 `commands` 自定义采集器)并把清单写进工作区 `.dsh/workbench-ecs/snapshots/<name>.json`(**可 diff、可提交、可 grep**); `list` 零远程调用; `diff` 按清单里记录的采集器重采一次并逐项对差异(文件 `added`/`removed`/`changed`/`metadata-only`, 采集输出给出**首个差异行**), 还可用 `against` 与另一份快照对比
- **runbook 参数契约**(v0.8.0+): `params` 从"默认值"升级为**参数描述符** `{ required, pattern, enum, default, description, hint }`(标量写法向后兼容), 并覆盖隐式参数(含实例锚点字段)—— 缺必填 / 正则不匹配 / 枚举不匹配在 `validate` / `plan` **下发任何命令之前**就被拦住; 设置面板的「校验」按钮与执行前检查共用**同一套实现**, 因此不会出现"面板说通过、执行时炸"
- **重跑建议与 `from_step`**(v0.8.0+): `ecs_runbook validate/plan`、`ecs_deploy dry_run` 与**失败结果**里都会带一段逐步判定幂等性的「重跑建议」(`safe_prefix` + 一句可直接照做的结论, 如"前 2 步可重复执行; 第 3 步起可能产生副作用 —— 可直接重跑整条跑书, 或用 from_step: 2 从该步继续"); `ecs_deploy { from_step: N }` 跳过计划里 `[i] < N` 的步骤, 预演与真实结果都显式列出 `skipped_prefix` 并提醒"这些步骤的前置效果不会被重建"
- **跨地域检索 `ecs_find`**(v0.7.0+): 回答"我的实例到底在哪个地域", 不必先猜地域 —— `keyword` 子串匹配 实例名/实例ID/私网·公网IP/规格/标签值(大小写不敏感), `region` 缺省(或 `"all"`)即并发检索内置的 **22 个公共地域**, 也可写单个或逗号分隔的多个; **不做"命中即停"**(少列几台比多列几台危险), 结果按地域分组并如实回报 `regions_tried` / `regions_ok` / `regions_failed`(某个地域查询失败不影响其它地域)/ `scanned`, 同时把工作区实例锚点一并列出。`ecs_list` 仍是"必填单地域", 该地域返回 0 台时会带一条 `empty_hint` 提示改用 `ecs_find`
- **项目级实例锚点**(v0.7.0+): 把常用机器记进工作区 `.dsh/workbench-ecs/instances.json`(**插件定义格式、项目填内容**), 之后**所有接受 `instance_id` / `instance_ids` 的工具**(`ecs_exec` / `ecs_upload` / `ecs_download` / `ecs_diagnose` / `ecs_deploy` / `ecs_log` / `ecs_runbook` …)都可以直接写锚点名(如 `"prod"`) —— 插件在工具注册边界统一解析成真实实例 ID, 并在 `region` 未显式给出时用锚点的 region 补齐, 各工具零改动; 锚点里除 `instance_id`/`region` 之外的字段(如 `repo`)会成为 runbook 的**隐式参数**, 跑书里可直接写 `${repo}`。没有该文件时行为与从前完全一致
- **上传自动重试 + 失败归属**(v0.7.0+): `ecs_upload` 新增 `retries`(默认 2, 即最多 3 次尝试)/ `retry_delay`(默认 1 秒, 指数退避), **只对瞬时网络类失败重试**, 语义类失败(远端已存在、无权限、参数错)立刻失败不重试; 失败信息明确指出问题出在"本机 → OSS 中继"这一段而**不是目标 ECS 实例**, 并提示稍后重跑同一条命令即可(上传幂等)。`verify_sha256` 的默认值在 `ecs_upload` / `ecs_deploy`(老三阶段)/ `steps[].upload` 三处**统一为 true**
- **远端超时正确结算 + 拒绝信息可调试**(v0.7.0+): CLI 在远端命令超时时 JSON 会谎报 `exit_code: 0` + `timed_out: true`(进程退出码其实是 124) —— 此前"以 JSON 为准"会把**被掐断的命令渲染成"成功且无输出"**; v0.7.0 起一律结算为 **`exit_code: 124` + `timed_out: true`** 并附 `duration` 与超时原因, 编排里超时的步骤明确 FAIL。只读护栏命中时**逐条**列出规则名/命中文本/位置并附"只读等价写法建议"; 破坏性命令被拒绝时按**四种情形**分开说明(审批服务未挂载 / 本会话策略为 `never` / 用户拒绝 / 请求被取消或无应答者), 不再撞成同一句"未获批准", 并明确写出"这不是命令写错, 重试同一条命令不会有不同结果"
- **detach 长任务 + 日志游标**(v0.5.0+): `ecs_exec { detach: true }` 在远端 `nohup` 启动并写日志文件, 立即返回 `job_id`/`log_path`/`exit_path`; 插件按间隔轮询增量, **不长期占用实例**(期间同实例其它调用可正常插空执行), 远端日志文件是唯一事实源, 模型读得慢也不会丢段或重复。配套 `ecs_log` 用**字节游标**从头续读任意远端文件(发布日志轮询不再需要反复整段 tail)
- **伪会话**(v0.5.0+): `ecs_exec { session_id: "deploy" }` 在同一会话内保留工作目录与环境变量(`cd`/`export` 跨调用继承), 不同 session_id 互不影响; 状态由插件持有, 空闲 30 分钟自动重置并显式提示
- **可视化设置面板**(v0.3.0+): CLI 状态(20s Host 缓存 + 本地秒显)、实例浏览(搜索/批量/30s 自动刷新)、一键诊断(磁盘·内存仪表盘)、受控发布向导+模板、会话管理、操作时间线; 自动适配深/浅色主题
- **真实 API 调用**: 工具执行本机 `workbench` 命令, 经阿里云 Workbench 后端连接实例(支持无公网 IP 的实例)
- **JSON 解析 + 可读渲染**: 解析 CLI 的 JSON 输出, 渲染为表格/文本/终端卡片; CLI 层错误(`{code, message}`)转成可读报错
- **安全守卫**: 破坏性命令(`rm -rf`、`shutdown`、`reboot`、`mkfs`、`dd`、`iptables -F/-X` 等)自动接入 Harness 审批服务, 未获批准一律拒绝(fail closed)
- **脚本直送**(v0.4.0+): `ecs_exec` 的 `script` 参数把脚本正文 base64 投递远端落盘后执行, 内容不经过任何 shell 引用层 —— `docker exec ... node -e "..."` 这类多层引号组合、中文、`$`、反引号、heredoc、多行全部**零转义**; 超过 16KB 自动分片投递, 并按字节数校验落盘完整性
- **只读护栏**(v0.4.0+): `ecs_exec` / `ecs_diagnose` 的 `read_only` 在命令进入 shell 之前拒绝写操作(重定向、`rm`/`mv`/`cp`/`chmod`、`docker` 变更、`systemctl` 变更、`nohup` 等); `ecs_diagnose` **默认开启**, 且预置诊断脚本零误杀
- **传输完整性**(v0.4.0+): `ecs_upload.verify_sha256` 上传后比对本地/远端 sha256(v0.7.0+ 起默认开启, 与 `ecs_deploy` 口径统一), 校验不一致时**中止发布**(不会拿损坏的发布物去重启), 本地哈希经 `sha256sum`/`shasum`/`certutil` 计算, 不依赖额外运行时
- **后台任务**: `ecs_exec` 支持 `run_in_background` — 长命令注册到 jobs, 可 `job_output` 增量读取、`job_kill` 终止; 批量时每台实例各起一个 job 并返回 `job_ids`(v0.5.1+)
- **Runbook / 跑书**(v0.6.1+ 机制, v0.6.2+ 面板, v0.6.3+ 静态校验): 把编排存成**纯数据**放在工作区 `.dsh/workbench-ecs/runbooks/*.json`,`ecs_deploy { runbook: "release", runbook_params: { sha } }` 一次调用跑完;插件只做机制(读取/校验/`${参数}` 替换/展开),**内容与脚本本体留在项目仓库** —— 发布契约可评审、可版本化, 插件里没有项目逻辑。设置面板里也能**列出 / 校验 / 预演 / 执行**同一份跑书(与 Agent 共用同一引擎, 预演的命令行逐字一致);`ecs_runbook` 工具可只读地先查错(字段笔误、缺参数、断言无判据、护栏矛盾), shell 变量用 `$${NAME}` 转义;随包另带 **5 份通用跑书模板**(v0.6.7+:`host-check` / `compose-redeploy` / `disk-cleanup` / `tls-cert-check` / `log-dig`),拷进任意项目即用
- **多步编排**(v0.6.0+): `ecs_deploy { steps: [...] }` 把「上传 → 执行 → 断言 → 读日志」写成一次调用, `assert` 用 `expect` 逐条判定并在失败时**精确标出是哪一条断言、期望什么、实际什么**; `dry_run` 可先预演命令而不执行。一次发布从十余次调用收敛为一次
- **批量执行**: `ecs_exec` 支持 `instance_ids` 数组(单台失败不中断), 适合集群排查; `concurrency` 控制并发(默认只读 4 / 写 1 串行), 同实例仍由实例锁串行 —— 集群排查不再逐台排队(v0.5.1+)
- **目录递归上传**(v0.5.1+): `ecs_upload { local_dir: "dist" }` 一次调用完成「本机 `tar` 归档 → 上传 → sha256 校验 → 远端解包」, 省掉手工打包; 校验失败**中止解包**, 坏包不会改写远端目录
- **结构化输出**(v0.5.1+): `output_json: true` 直接返回稳定 JSON 文本, 便于下游自动化接线(`ecs_exec` / `ecs_list`)
- **同实例串行化**: 同一实例上的操作按 FIFO 逐个执行, 并发调用不会经由共享的 Workbench 会话互相串流; 不同实例仍可并行。detach 任务只在每次轮询期间短暂持锁, 不再长期占用实例名额(v0.5.0+)
- **大输出 spill**: stdout 超限自动落盘并返回完整输出路径, 日志排查不再截断丢头
- **输出清洗**: 默认剔除 ANSI 转义、控制字符与 CLI 进度帧(spinner/百分比条), 日志与上传结果直接可读(`strip_ansi: false` 可关闭)
- **可靠退出码**: 以 CLI JSON 中的远端 `exit_code` 为准(而非本地进程退出码), 并带回 `request_id`/`session_id` 便于事后核对隔离性; **远端超时优先结算为 `124` + `timed_out: true`**(v0.7.0+ —— CLI 超时时 JSON 会谎报 `exit_code: 0`, 详见下文「远端超时的新语义」)
- **健壮二进制解析**: 按 PATH 解析 `workbench`, 失败时回退常见安装位置(如 `C:\Program Files\workbench\workbench.exe`), 解决宿主进程 PATH 过期问题
- **取消支持**: 工具调用被取消时自动终止进程树(SIGTERM → SIGKILL), 不留孤儿进程

## 安装

> **两个宿主, 两个 profile(v0.9.0+)** —— DSH 现在同时有**浏览器端**和**桌面端**, 它们是两个独立的宿主进程, 各自加载一个 profile, 因此**要分别安装**:
>
> | 你用哪个 | 宿主进程 | profile 目录 | 安装命令 |
> |---|---|---|---|
> | 浏览器(`dsh web`) | `dsh web`(npm 全局安装的 CLI) | `%DSH_HOME%\profiles\web` | `dsh plugin --profile web add dsh-workbench-ecs` |
> | **桌面应用** | `dsh-desktop-host`(Electron 内置运行时) | `%DSH_HOME%\profiles\desktop` | `dsh plugin --profile desktop add dsh-workbench-ecs` |
>
> 两个都装就两条命令都执行。桌面端仍是 **web 面**(内置 `dsh-web-app`, 客户端模块系统只收 `dsh.client.platform === "web"`), 所以同一个包、同一份 `lib/client.js` 在两端都工作 —— 但**配置文件不通用**: 只在 web profile 里装过的话, 桌面端不会加载这个插件(11 个工具与设置页都不会出现)。

### 前置要求

- Node.js ≥ 20, 且目标宿主正在运行(`dsh web`, 或 DeepSeek Harness 桌面应用);
- **与本插件同一台机器**上安装并配置好官方 Workbench CLI(见下文 [使用前准备](#使用前准备))。

### 版本兼容(v0.9.0+)

DSH 宿主在加载 bundle 时会做一次**版本闸门**检查: 把包的 `peerDependencies` 里每个 `@deepseek-ai/dsh-*` 与运行时版本比对, 不满足就**把整个 bundle 静默跳过**(插件一行都不加载, 也不报错)。因此本包的 peer 区间必须同时覆盖两个运行时:

| 宿主 | 实测 DSH 运行时 | 本包 peer 声明 |
|---|---|---|
| 浏览器 `dsh web` | `0.1.1-rc.2` | `@deepseek-ai/dsh-tools: ^0.1.1-rc.2 \|\| ^0.2.0-rc.2` |
| 桌面应用 | `0.2.0-rc.2` | 同上(`@deepseek-ai/cordis: >=4.0.1 <5.0.0`) |

> v0.8.0 只知道 `^0.1.1-rc.2`, 而它在 semver 下等于 `>=0.1.1-rc.2 <0.2.0-0` —— **0.2.0-rc.2 不满足**, 于是桌面端会静默跳过整个 bundle。v0.9.0 修掉了这一点, 并用 `test/compat.mjs` 把这条闸门变成回归项(任何一端不被覆盖, `npm test` 就会红)。

### 官方 dsh 命令一键安装

```bash
# 浏览器端
dsh plugin --profile web add dsh-workbench-ecs

# 桌面应用(另开一条)
dsh plugin --profile desktop add dsh-workbench-ecs
```

完成后: 11 个工具对 Agent 立即可用, Harness 设置(齿轮图标)里出现 **「Workbench ECS」** 标签页。

- **`dsh web`**: 不支持热重载的部署请重启 `dsh web`;
- **桌面应用**: profile 只在**进程启动时**读一次 —— 请**退出并重新打开 DeepSeek Harness**。

> 本地从仓库开发时改用链接方式:
> `dsh plugin --profile <web|desktop> add link:<仓库绝对路径>` —— 之后修改 `lib/client.js` 刷新页面即生效(无需重启服务)。

### 验证安装

```bash
# 桌面端默认 19387, dsh web 默认 3080 —— 按你实际用的那个改端口
curl -s http://127.0.0.1:19387/dsh-workbench-ecs/health
# => {"ok":true,"plugin":"dsh-workbench-ecs","version":"0.9.0"}
```

> 桌面端/鉴权开启的宿主上, 直接 curl 可能返回 `401 unauthorized`(宿主用启动令牌 + 会话 Cookie 保护整站)。这不代表插件没装 —— 在**已登录的页面**里访问同一个地址即可看到 `health` JSON。

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

注意: 设置面板只能由 `dsh` 命令接上(bundle 层 `dsh.bundle` + `dsh.client` 声明)。插件行要写进**你想用的那个 profile**: 浏览器端是 `%DSH_HOME%\profiles\web`, 桌面端是 `%DSH_HOME%\profiles\desktop`。

#### 本地仓库开发

用 [`scripts/install-local.ps1`](./scripts/install-local.ps1) 把仓库以 junction 链接进 `%DSH_HOME%` 并代写插件行。脚本幂等且可回退:

```powershell
# 写进所有已存在的 profile(web + desktop)
powershell -ExecutionPolicy Bypass -File .\scripts\install-local.ps1
# 只写其中一个
powershell -ExecutionPolicy Bypass -File .\scripts\install-local.ps1 -Profile desktop
# 查看 / 卸载
powershell -ExecutionPolicy Bypass -File .\scripts\install-local.ps1 status
powershell -ExecutionPolicy Bypass -File .\scripts\install-local.ps1 uninstall
```

profile 目录要在该宿主**启动过一次**之后才会存在(浏览器端靠 `dsh web` 生成, 桌面端靠桌面应用生成)。改动随下一次 patch 热重载、页面刷新或对应宿主重启生效 —— 桌面应用只在进程启动时读一次 profile, 因此需要重启。

## 设置页面

| 区域 | 能力 |
|---|---|
| CLI 状态 | Workbench CLI 可用性 / 版本 / 凭据 Profile / Daemon; **20 秒缓存 + 本地秒显**(面板即时渲染, 后台静默刷新; [刷新] 强制重查) |
| ECS 实例 | 地域/状态筛选 + 名称/ID 搜索 + 状态分布条 + 复选框(批量执行) + **30s 自动刷新** |
| 实例行操作 | [执行] 选中目标 / [诊断] 一键体检(磁盘·内存仪表盘) / [发布] 受控发布向导 / [详情] 属性 + 最近日志 |
| 远程命令 | 命令历史(datalist)、破坏性命令两次点击确认(Host 端仍二次拦截); 批量执行逐台结果表 |
| 受控发布 | 上传本地文件(OSS 中继 ≤1GB) + 重启/生效命令 + 健康检查, 三阶段进度; 可保存/复用模板; **模式可切换为「Runbook」**(直接跑工作区跑书, 带预演)(v0.6.2+) |
| Runbook(发布跑书) | 扫描 `<工作区>/.dsh/workbench-ecs/runbooks/*.json`, 列出名称/说明/步数/类型/参数占位与**静态校验结论**(坏文件标为无效而不影响其它条目); 逐条 **校验**(只读, 逐条列出 error/warn 与步骤定位)/ **预演**(零副作用) / **执行**; 结果按步骤渲染(含 `skipped` 标记与断言逐条 ✔/✘)(v0.6.2+, 校验 v0.6.3+, **参数契约与重跑建议 v0.8.0+** —— 面板与执行前检查共用同一套实现) |
| Workbench 会话 | 会话列表 / 关闭单会话 / 关闭全部(排障与资源回收) |
| 操作时间线 | 本次会话面板内所有操作留痕 |

面板直连**本机** Workbench CLI(同源路由 `/dsh-workbench-ecs/rpc`, 由 `lib/index.js` 注册), 不经过 Agent/LLM——因此远程命令的破坏性守卫为「拒绝优先」(要审批放行请走 Agent 的 `ecs_exec` 工具)。设置页 RPC 与工具侧口径一致: 远端命令超时同样结算为 **`exit_code 124` + `timed_out: true`**(v0.7.0+), 不会把被掐断的命令显示成成功。界面自动适配深/浅色主题。

## 工作原理

本包是 DSH **静态双半插件**, 以 **bundle 层** 编入 DSH profile 组合。它**两个宿主都能跑** —— 浏览器端(`dsh web`, DSH 0.1.x)与桌面应用(`dsh-desktop-host`, DSH 0.2.x): 桌面端服务的仍是同一个 web 面, 客户端半的筛选规则也一样(`dsh.client.platform === "web"`)。

| 半 | 文件 | 职责 |
|---|---|---|
| Host 半(Node) | `lib/index.js` | 通过 `tools` 注册 11 个模型工具; 通过 `webServer` 注册同源路由 `/dsh-workbench-ecs/health` 与 `/dsh-workbench-ecs/rpc`; 设置页 RPC 经 `subprocess` 执行本机 CLI(共享 `lib/common.js` / `lib/settings-api.js` / `lib/steps-engine.js`; runbook 机制在 `lib/runbooks.js`, 跨地域检索在 `lib/regions.js`, 实例锚点在 `lib/anchors.js`, 发布快照在 `lib/snapshots.js`(v0.8.0+)) |
| 浏览器半 | `lib/client.js` | 单文件 client bundle(`window.__ModuleLoader__` 工厂形式): 注册「Workbench ECS」设置页标签, 经同源 RPC 路由与 Host 通信 |
| 组合层 | `cordis.patch.yml` | `dsh.bundle` patch: 把插件行插入 profile 组合 —— 任一宿主启动该 profile 即生效, 由 `dsh plugin --profile <web\|desktop> add` 自动装载 |
| 兼容性守卫 | `test/compat.mjs` | 断言 `peerDependencies` 区间覆盖**每一个**已实测的运行时(浏览器 0.1.x + 桌面 0.2.x)—— 不被覆盖的运行时会让宿主**静默跳过整个 bundle**; 随后用真 `@deepseek-ai/dsh-tools` 内核复核全部 11 个工具定义(v0.9.0+) |

两端零构建: `lib/client.js` 为手写单文件 bundle, 无需打包器; 同一套 `lib/` 源码也可临时挂载为动态 body(`npm run build:body`)。

## 项目级实例锚点 `instances.json`(v0.7.0+)

目标机的 `instance_id` / `region` 此前只存在于会话记录里 —— 换个会话就得重新"猜地域"。v0.7.0 起约定一个**项目级文件**, 同样遵循「**插件定义格式、项目填内容**」这条原则(与 runbook 一致):

```jsonc
{
  "//1": "以 // 或 _ 开头的键会被当作注释忽略(JSON 里写注释的常见约定)",
  "prod":    { "instance_id": "i-uf66ct2o35p7fjcd0sru", "region": "cn-shanghai", "repo": "/root/app" },
  "staging": { "instance_id": "i-bp1xxxxxxxxxxxxxxxxx", "region": "cn-hangzhou", "repo": "/root/app-staging" }
}
```

随包提供模板 [`templates/instances.json`](./templates/instances.json)(连同 `templates/runbooks/` 一起拷进项目即可用):

```bash
cp node_modules/dsh-workbench-ecs/templates/instances.json  .dsh/workbench-ecs/
```

**作用一 —— 所有工具都可以写锚点名**: **凡是接受 `instance_id` / `instance_ids` 的工具**(`ecs_exec` / `ecs_upload` / `ecs_download` / `ecs_diagnose` / `ecs_deploy` / `ecs_log`, 以及 `ecs_runbook` 的 `instance_id` 等)都可以直接写锚点名:

```text
ecs_exec { instance_id: "prod", command: "df -h" }        # 等价于 i-uf66ct2o35p7fjcd0sru @ cn-shanghai
ecs_exec { instance_ids: ["prod", "staging"], command: "uptime" }
```

插件在**工具注册边界**统一解析成真实 `instance_id`, 并在 `region` 未显式给出时用锚点的 region 补齐 —— 因此**各工具零改动**, 参数表里也没有新增字段。

**作用二 —— 锚点字段成为 runbook 的隐式参数**: 锚点里除 `instance_id` / `region` 之外的字段(如 `repo` / `note`)会作为**隐式参数**注入跑书, 于是 `${repo}` 不必每次手传。参数优先级不变:

```text
隐式参数(含锚点字段 / ${instance_id} / ${region}) < runbook 的 params 默认值 < 调用方 runbook_params
```

**向后兼容与失败姿态**:

| 情形 | 行为 |
|---|---|
| 没有该文件 | 与从前**完全一致**(锚点名会原样下发给 CLI 报错, 不额外拦截) |
| 文件损坏(非法 JSON / 顶层不是对象) | 降级为"**按原值下发**", 不阻断工具调用 |
| 锚点名写错 | 报错并**列出可用锚点**(比交给 CLI 报"实例不存在"有用得多) |
| 环境未挂载 `fs` 服务 | 同上降级, 并按原值下发 |

`ecs_find` 会在结果末尾同时列出工作区锚点(命中哪些锚点、各自指向哪个实例与地域), 一次查询就能回答"机器在哪 + 项目里有没有记过这台机器"。

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

> **0 台时的下一步(v0.7.0+)**: `ecs_list` 返回 0 台时结果里会多一条 `empty_hint`, 直接提示"实例可能在别的地域 —— 用 `ecs_find { keyword: "<实例名或IP>" }` 跨地域查找"。

### `ecs_find` —— 跨地域检索实例(v0.7.0+)

CLI 对应: `workbench list ecs --region <region> ... --output json`(逐地域并发执行; **没有**单条 CLI 命令能一次查多地域)

回答的问题是 **"我的实例在哪个地域"** —— 不需要先猜地域。`ecs_list` 与它的分工很明确:

| 工具 | 回答的问题 | `region` |
|---|---|---|
| `ecs_list` | 这个地域里有哪些实例 | **必填**, 单地域 |
| `ecs_find` | 我的实例在哪个地域 | 可缺省(= 全地域检索), 或单个 / 逗号分隔多个 |

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `keyword` | string | | 关键词: 子串匹配 **实例名 / 实例ID / 私网IP / 公网IP / 规格 / 标签值**, 大小写不敏感 |
| `region` | string | | 缺省或 `"all"` = 检索内置**公共地域清单(22 个)**; 也可写单个(如 `cn-shanghai`)或逗号分隔多个(如 `cn-shanghai,cn-hangzhou`) |
| `status` | string | | 按实例状态过滤: `Running` / `Stopped` / `Starting` / `Stopping` |
| `instance_name` | string | | 按实例名称过滤(**CLI 侧**, 支持 `*` 通配); 与 `keyword` 可同用 |
| `tag` | array\<string\> | | 按标签过滤, 每项 `key=value` 或 `key`, 可重复 |
| `instance_type` | string | | 按规格过滤, 例如 `ecs.g7.large` |
| `limit` | integer | | **每个地域**的页大小, 10–100, 默认 50 |
| `concurrency` | integer | | 地域并发度, 默认 4(上限 8) |
| `output_json` | boolean | | 以稳定 JSON 文本返回结果(默认 false 返回可读文本) |

**行为(有意如此)**:

- **不做"命中即停"** —— 即使前面几个地域已经查到实例, 仍会把清单里所有候选地域查完。少列几台比多列几台危险得多;
- 结果**按地域分组**, 并如实回报 `regions_tried`(查过哪些地域)/ `regions_ok` / `regions_failed`(每个失败地域的 `{region, error}` —— **某个地域查询失败不影响其它地域的结果**)/ `scanned`(共扫了多少台);
- 单地域返回条数顶到 `limit` 时给 `regions_maxed` 提示(CLI 的 JSON 不含 `NextToken`, 无法自动翻页), 建议收紧过滤或提高 `limit`(≤100);
- 同时列出**工作区实例锚点**(见上节), 一次查询同时回答"机器在哪"和"项目里有没有记过它"。

```text
# 只记得实例名或私网 IP
ecs_find { keyword: "nailong" }
ecs_find { keyword: "10.0.1.23" }

# 只查两个地域(比全地域快得多)
ecs_find { keyword: "prod", region: "cn-shanghai,cn-hangzhou" }

# 想看某规格在各大地域都有哪些(不限关键词)
ecs_find { instance_type: "ecs.g7.large", status: "Running" }
```

> **为什么必须由插件提供(实测背景)**: CLI 侧 `--region all` **不可用**(报 `invalid region "all": region does not exist or is not recognized`), 也**没有"列地域"的子命令**; profile 里同样**存不下默认地域**(`workbench config set` 只支持 `language` / `log_level`, 缺省恒为 `cn-hangzhou`) —— 这正是"在 cn-hangzhou 查 0 台"的机制解释。因此跨地域能力只能在插件侧实现: 内置一份公共地域清单, 逐地域并发查询, 并如实回报查过哪些、哪些失败了。

### `ecs_exec` —— 在指定实例上执行远程命令(增强版)

CLI 对应: `workbench exec --instance-id <id> --command <cmd> [--timeout <s>] --output json`

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `instance_id` | string | | 目标实例 ID(与 `instance_ids` 二选一; 也可直接写工作区锚点名, v0.7.0+) |
| `instance_ids` | array\<string\> | | 批量目标(最多 20 台, 单台失败不中断; 可选 `concurrency` 并发; 每项也可写锚点名, v0.7.0+) |
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

#### 远端超时的新语义(v0.7.0+, **最值得注意的一处修正**)

`workbench exec` 在远端命令超时时的 JSON 是这样的:

```json
{ "exit_code": 0, "timed_out": true, "duration": "3.002s" }
```

而 CLI 进程自身的退出码是 **124**, 真正的原因只出现在 stderr 里: `{"code":124,"message":"command timed out after 3s"}`。

插件此前"以 JSON 的 `exit_code` 为准"(这条规则本身是对的, 见[可靠退出码](#特性)), 于是**被掐断的命令会显示成"成功 + 无输出"** —— 一个长命令被超时掐断, 结果看起来像"跑完了什么都没打印", 这是最危险的一类误导。

v0.7.0 起, **`ecs_exec` / `ecs_diagnose` / `ecs_log` / `ecs_deploy`(含 `steps` 编排)/ 设置页 RPC 一律把 `timed_out` 结算为 `exit_code 124` + `timed_out: true`**, 结果里还带 `duration` 与超时原因; 超时提示会直接给出下一步:

- 长任务改用 `detach: true`(远端 `nohup` + 日志文件, 再用 `ecs_log` 按**字节游标**续读);
- 或调大 `timeout`(单步上限 3600s; 超出截断)。

编排里超时的步骤会**明确 FAIL**(不再可能被当成成功), 见下文 `ecs_deploy`。

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
| `instance_id` | string | ✅ | 目标实例 ID(也可直接写工作区锚点名, v0.7.0+) |
| `path` | string | ✅ | 单个远端文件路径, 如 `/tmp/.dsh-ecs-xxx/out.log`(与 `paths` 二选一) |
| `paths` | array\<string\> | | **一次读多个文件**(v0.7.0+, 与 `path` 二选一, 最多 8 个): 单次远程调用内按文件分段, **每个文件各自维护 `after` / `next_offset`** |
| `after` | integer \| object | | 起始字节偏移(上次返回的 `next_offset`; 首次为 0)。多文件时可以是数字(所有文件同一游标)或对象, 如 `{"/var/log/app.log": 12}`(v0.7.0+) |
| `max_bytes` | integer | | 单次最多读取字节数, 默认 262144; `truncated=true` 时应立即续读 |
| `exit_file` | string | | 可选: 远端退出码文件, 存在时返回 `exit_code` |
| `region` / `timeout` | | | 地域 / 超时(秒, 默认 60; 超时结算为 `124` + `timed_out`, 游标不推进) |

**用法**: 发布/构建日志轮询的标准动作是 `ecs_log { path: "<log>", after: <上次 next_offset> }`,
不再需要"整段 tail 再肉眼找增量";配合 `detach` 的 `log_path` 可从头完整翻阅任意长度的日志。

**一次读多个文件**(v0.7.0+)把"看 app 日志再看 access 日志"收敛成一次远程调用 —— 排障时最常同时看的两个文件不必再来回两次:

```text
ecs_log { paths: ["/root/app/logs/app.log", "/root/app/logs/access.log"] }
ecs_log { paths: ["/var/log/app.log", "/var/log/nginx/error.log"], after: {"/var/log/app.log": 4096} }
```

返回 `files: [{ path, text, next_offset, total_bytes, eof, truncated, exit_code }]`(`exit_file` 存在时每个文件都带自己的 `exit_code`); **单文件时保持既有的扁平字段**(`text` / `next_offset` / `total_bytes` / `eof` / `truncated`), 老用法与老脚本完全不受影响。超时时游标**不推进**, 重试同一 `after` 即可。

### `ecs_upload` —— 上传本地文件到实例

CLI 对应: `workbench upload <local-file> <remote-path> --instance-id <id> [--force]`

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `local_file` | string | | 本地文件路径(相对路径基于会话工作区); 与 `local_dir` 二选一 |
| `local_dir` | string | | 本地目录路径(**递归上传**, v0.5.1+): 本机 `tar` 归档 → 上传 → 远端解包; 与 `local_file` 二选一 |
| `remote_path` | string | ✅ | 远端目标路径(`local_file` 时以分隔符结尾视为目录, 自动拼接文件名; `local_dir` 时为**目标目录**) |
| `instance_id` | string | ✅ | 目标实例 ID(也可直接写工作区锚点名, 如 `"prod"`, v0.7.0+) |
| `region` | string | | 地域, 可缺省 |
| `force` | boolean | | 覆盖远端已存在文件而不需确认(默认 false) |
| `retries` | integer | | **瞬时网络类失败的重试次数**(v0.7.0+; 默认 2, 即最多 3 次尝试; 上限 8)。语义类失败不重试 |
| `retry_delay` | integer | | 首次重试前的等待秒数(v0.7.0+; 默认 1, 之后**指数退避**) |
| `verify_sha256` | boolean | | 上传后比对本地/远端 sha256(**默认 true**, v0.7.0+ 起与 `ecs_deploy` 统一; 要关闭必须显式写 `false`, lint 会提醒。**目录模式校验失败会中止解包**) |
| `keep_root_dir` | boolean | | 目录模式: 保留归档顶层的目录名(默认 false, 即只上传目录内容) |
| `keep_archive` | boolean | | 目录模式: 远端解包后保留归档文件(默认 false, 解包后删除) |
| `timeout` | integer | | 目录模式远端解包命令超时(秒), 默认 120 |

经阿里云 OSS 中继传输(最大 1GB)。返回 `verification`(`ok` / `mismatch` / `remote-unavailable` / `local-tool-unavailable`)与两侧摘要。搭配 `ecs_deploy` / `ecs_exec` 完成发布。

**瞬时失败自动重试 + 失败归属**(v0.7.0+)—— 抖动一次不再废掉整条发布:

| 类别 | 例子 | 行为 |
|---|---|---|
| 瞬时网络类 | `i/o timeout` / `dial tcp` / `connection reset` / `TLS handshake` / `context deadline exceeded` / `operation error` | **重试**(默认 2 次重试 / 最多 3 次尝试, 指数退避; `retry_delay` 控制首延迟) |
| 语义类 | `remote file ... already exists; use --force to overwrite` / 无权限 / 参数错 | **立刻失败, 不重试**(重试不会有不同结果) |

最终失败时的报错会写明**归属**: upload/download 固定走**阿里云 OSS 中继**, 这类网络问题出在"**本机 → OSS**"这一段, **不是目标 ECS 实例的问题** —— 不必先去查实例、安全组或云助手; 并提示"稍后重跑同一条命令/跑书即可(**upload 幂等**)"。

**`verify_sha256` 默认值三处统一为 `true`**(v0.7.0+): `ecs_upload` / `ecs_deploy`(老三阶段)/ `steps[].upload`。要关闭必须**显式**写 `verify_sha256: false`(lint 会提醒); 目录模式下摘要不一致仍然**中止解包**, 坏包不落地。

> **顺带修正**: `workbench upload` 失败时 stdout 仍会打印 "Upload complete" 行, 真正的错误在 stderr 的 `{code,message}` 里。插件此前只看 stdout, 会把失败读成成功 —— v0.7.0 起**两者一起判定**, 上传阶段失败会**中止发布**, 绝不会用旧文件(或不存在的文件)去重启服务。

**目录递归上传**(v0.5.1+)把"本地打包 → 上传 → 远端解包"收敛成一次调用, 顺序固定为 **归档 → 上传 → 校验 → 解包**: sha256 不一致时**不下发解包命令**, 远端目录不会被损坏的包改写; 返回 `entries`(归档条目数)/`extracted`/`local_archive_cleanup`。本地归档暂存在会话工作区根目录并在结束后自动清理(`.dsh-ecs-upload-*.tar.gz`)。需要本机 `tar`(Windows 10+ / Linux 自带)。

### `ecs_download` —— 从实例下载文件到本地

CLI 对应: `workbench download <remote-path> [local-path] --instance-id <id> [--force]`

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `remote_path` | string | ✅ | 远端文件路径 |
| `local_path` | string | | 本地保存路径(文件或目录, 相对会话工作区; 省略=当前目录) |
| `instance_id` | string | ✅ | 目标实例 ID(也可直接写工作区锚点名, 如 `"prod"`, v0.7.0+) |
| `region` | string | | 地域, 可缺省 |
| `force` | boolean | | 覆盖本地已存在文件而不需确认(默认 false) |

**典型场景**: 把生产日志/配置文件拉回本地分析。

### `ecs_diagnose` —— 一键只读体检

CLI 对应: 一次远程 `exec`(分号串联的只读命令集)

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `instance_id` | string | ✅ | 目标实例 ID(也可直接写工作区锚点名, v0.7.0+) |
| `region` | string | | 地域, 可缺省 |
| `sections` | array\<string\> | | **按需点选采集段落**(v0.7.0+): `host` / `load` / `mem` / `disk` / `services` / `processes` / `ports` / `extra`; 缺省 = 全部 7 段。非法值会报错并列出合法值; `extra` 表示**只跑** `extra_command` |
| `extra_command` | string | | 追加的自定义只读命令 |
| `echo_command` | boolean | | 是否回显完整的采集命令(v0.7.0+; **默认 false** —— 输出里已含各段标题; 见下) |
| `read_only` | boolean | | 只读护栏, **默认 true**; 传 `false` 才允许 `extra_command` 中写入 |
| `description` | string | | 本次体检用途简述 |
| `strip_ansi` | boolean | | 清洗 ANSI/控制字符/进度帧(默认 true) |
| `timeout` | integer | | 超时(秒), 默认 120(显式下发; 超时结算为 `124` + `timed_out`, v0.7.0+) |

内置 7 段: 主机信息 / 负载与运行时长 / 内存 / 磁盘 / 运行服务与容器(docker ps)/ 内存 TOP 进程 / 监听端口。**生产排障的起始动作** —— 一个工具代替一串命令。

#### `sections` 与 `echo_command`(v0.7.0+)

只关心磁盘和端口时不必再拉回整份体检输出:

```text
ecs_diagnose { instance_id: "i-xxx", sections: ["disk", "ports"] }      # 只跑两段
ecs_diagnose { instance_id: "i-xxx", sections: ["extra"], extra_command: "tail -n 50 /var/log/nginx/error.log" }
```

- `sections` 的合法取值就是上面 7 段的名字加 `extra`; 写错会**报错并列出合法值**, 不会静默忽略; `extra` 单独出现时只跑 `extra_command`(否则 `extra_command` 会随所选段落一起跑)。
- **`echo_command` 默认 false**: 7 段命令全文此前占了输出的一大半, 现在不再回显。结果里**始终**带 `sections` 摘要与 `extra_command`(哪几段 + 有没有自定义命令一目了然), 需要原文时才传 `echo_command: true`。
- 只读护栏仍然对**实际下发**的脚本生效(`sections` 只影响拼进去的段落, 不改变护栏口径)。

### `ecs_deploy` —— 受控发布 / 多步编排

两种用法:**(A) 老三阶段**(上传 → 校验 → 重启 → 健康检查)与 **(B) `steps` 编排**(v0.6.0+)。

**(A) 老三阶段**

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `instance_id` | string | ✅ | 目标实例 ID(也可直接写工作区锚点名, 如 `"prod"`, v0.7.0+) |
| `command` | string | | 重启/生效命令, 如 `docker compose restart`(用 `steps` 时不需要) |
| `local_file` | string | | 可选: 要上传的本地文件 |
| `remote_path` | string | | 可选: 上传目标远端路径(local_file 提供时必填) |
| `health_check` | string | | 可选: 健康检查命令, 如 `curl -fsS http://127.0.0.1/health \|\| true` |
| `verify_sha256` | boolean | | 上传后校验 sha256, **默认 true**; 不一致即中止发布(不执行重启) |
| `region` / `force` / `timeout` | | | 地域 / 覆盖确认 / 每阶段超时(秒, 默认 180) |

四段流程结果全部返回(阶段内失败不中断后续阶段): 上传 → sha256 校验 → 重启 → 健康检查; 唯一例外是**校验失败会中止**(见 `aborted` / `abort_reason`), 避免用损坏的发布物重启服务。v0.7.0+ 补充: **上传阶段同样带自动重试**(`retries` / `retry_delay`, 默认值同 `ecs_upload`), 且**上传失败即中止** —— 不会继续往下走校验/重启(否则会拿旧文件或不存在的文件去重启)。

**(B) `steps` 编排(v0.6.0+)** —— 把同一实例上的一串动作写成**一次调用**:

| 步骤 | 字段 | 说明 |
|---|---|---|
| `upload` | `local_file`, `remote_path`, `force?`, `verify_sha256?`, `retries?`, `retry_delay?` | 上传; 默认 `verify_sha256: true`, 校验失败**中止整个编排**; `retries`/`retry_delay` 默认值同 `ecs_upload`(v0.7.0+, 只重试瞬时网络类失败) |
| `exec` | `command` \| `script`, `timeout?`, `read_only?`, `description?` | 执行命令或脚本(`script` 走 base64 零转义投递) |
| `assert` | `command` \| `script`, `expect` | 断言: `expect: { exit_code?, stdout_contains?, stdout_not_contains?, stderr_contains? }` |
| `tail` | `path`, `after?`, `max_bytes?`, `exit_file?`, `wait_seconds?` | 按**字节游标**读远端日志; `wait_seconds` 可等待 `exit_file` 出现 |

编排级参数:`dry_run`(只回显计划不执行, **不请求审批**)、`continue_on_error`(默认 false:任一步失败即中止并把余下步骤标记为 `skipped`)、`read_only`(对所有 exec/assert 步骤开只读护栏)、`timeout`(全局默认 180s)、`retries` / `retry_delay`(v0.7.0+: 作为**所有 `upload` 步骤**的默认值, 单步写了自己的值则以单步为准)、`from_step`(v0.8.0+: 跳过 `index < N` 的步骤, 从中途继续 —— 见下文「重跑建议与 `from_step`」)。上限 20 步。

**上传重试的可观测性(v0.7.0+)**: `dry_run` 预演会直接写明「上传瞬时失败自动重试: 最多 N 次尝试」(不必执行一次上传才知道会重试几次); 真实结果里每个步骤带 `attempts`(实际尝试次数)/ `retry_errors`(每次重试前记录的错误)/ `timed_out` / `duration`。

**单步超时(v0.6.6)**:步骤里的 `timeout` **覆盖**全局值 —— 此前只认全局值, 于是工具文档承诺的「本步骤命令超时」被静默忽略:长步骤(如发布脚本)仍会在全局 180s 处被 CLI 掐断, 预演里看到的也不是你写的那个数。上限 3600s(超出截断)、非正数忽略, 两种"写了却不按你写的执行"lint 都会提前提醒;预演与 `ecs_runbook plan` 逐条回报**实际生效**的 `timeout`。

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

返回 `mode`(`legacy` / `steps`)、`ok`、`done_stage`/`total_stage`、`stopped_at`/`stopped_reason`/`failed_steps`,以及逐步的 `stages`(断言步骤带 `assertions` 逐条结果,tail 步骤带 `next_offset`/`total_bytes`/`eof`)。**失败定位到具体步骤与具体断言**,不再靠人肉翻日志。v0.7.0+ 起, **超时的步骤一律明确标为 FAIL**(带 `timed_out` / `duration`, 见「远端超时的新语义」), 不再可能被当成成功。

**(C) Runbook(跑书,v0.6.1+)** —— 把编排存成**纯数据**,插件只做机制:

| 参数 | 说明 |
|---|---|
| `runbook` | `"名字"` → 读工作区 `.dsh/workbench-ecs/runbooks/<name>.json`;或直接内联对象 `{ name?, description?, params?, steps }` |
| `runbook_params` | 参数对象:覆盖 runbook 的 `params` 默认值,替换 `${name}` 占位符;隐式可用 `${instance_id}` / `${region}`,以及**实例锚点**里的字段(v0.7.0+,如 `${repo}` —— 见「项目级实例锚点」)。runbook 的 `params` 支持**参数描述符**(v0.8.0+,见下文「runbook 参数契约」) |
| `from_step` | **从中途继续**(v0.8.0+,仅配合 `steps`/`runbook`):跳过 `index < N` 的步骤, 索引用计划里显示的 `[i]`(0 起);见下文「重跑建议与 `from_step`」 |

runbook 文件形状:

```jsonc
{
  "name": "release",
  "description": "奶龙发布",
  "params": { "sha": "latest", "log": "/tmp/release.log" },   // 标量 = 默认值(可被 runbook_params 覆盖); 也可写参数描述符(v0.8.0+,见下)
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

**边界(有意为之)**:插件只提供**机制** —— 读取 / 校验 / 参数替换 / 展开成 `steps`;**内容**(步骤与断言、脚本本体)留在项目仓库,插件不硬编码任何项目逻辑。占位符 `${name}` 在任意字符串里替换;整串恰好是一个占位符时**保留原始类型**(`"timeout": "${t}"` + `t=300` → 数字 300),因此单步超时也能由参数驱动;缺少参数会直接报错并列出该 runbook 声明的占位符;多余的入参会在结果里以 `unused_params` 提示。runbook 名字只允许 `[A-Za-z0-9._-]`(挡住路径穿越)。需要 `fs` 服务;未挂载时请改用内联 `runbook` 对象。

- **跑书目录 = 会话工作区**:插件按 `exec.agent.session.header.cwd` 解析 `<工作区>/.dsh/workbench-ecs/runbooks/`(与 DSH 内置工具同源),因此放在**项目仓库**里的跑书能被直接看见;相对路径的 `local_file` 也以该目录为 cwd。设置页没有会话上下文,默认**跟随最近一次 Agent 会话的工作区**,卡片里可手动指定目录(留空即跟随)。

**(D) 面板里跑同一份 runbook(v0.6.2+)** —— 设置页的「Runbook（发布跑书）」卡片会扫描工作区 runbook 目录,列出名称/说明/步数/类型/参数占位,逐条提供 **预演**(只回显命令行,零副作用)与 **执行**;发布向导也可直接切换为「Runbook」模式。

- 面板与 Agent **共用同一个编排引擎**(`lib/steps-engine.js`),因此预演出来的命令行与 Agent 真正下发的逐字一致 —— 不会出现"面板能跑、工具跑不通"的漂移;
- **守卫口径差异(有意)**:面板没有审批上下文,命中破坏性命令模式**直接拒绝**并把错误定位到具体步骤(要审批放行请走 Agent 的 `ecs_deploy`);`read_only` 步骤按只读护栏预检;
- 面板侧 RPC 操作:`runbook-list` / `runbook-validate` / `runbook-plan` / `runbook-run`(同源路由 `/dsh-workbench-ecs/rpc`),均可传 `dir` 指定跑书目录;

#### runbook 参数契约: 必填 / 正则 / 枚举(v0.8.0+)

`params` 此前只能写"默认值", 于是"这个参数必须给"只能靠哨兵默认值 + 第 0 步断言来近似表达。v0.8.0 起 `params` 支持**参数描述符** —— 标量写法仍然表示默认值, 完全向后兼容:

```jsonc
"params": {
  "sha": { "required": true, "pattern": "^[0-9a-f]{7,40}$", "hint": "git rev-parse --short HEAD" },
  "env": { "default": "prod", "enum": ["prod", "staging"], "description": "部署环境" }
}
```

| 字段 | 作用 |
|---|---|
| `required` | 必填:没有默认值又没人传入 → 报错 |
| `pattern` | 值必须匹配的正则(顺带校验正则本身是否合法) |
| `enum` | 值必须是其中之一 |
| `default` | 默认值(与标量写法的含义相同) |
| `description` | 这个参数是什么(缺必填时会一并显示) |
| `hint` | 提示该怎么取值(缺必填 / 不匹配 `pattern` 时显示) |

- **未知字段会提醒**:描述符里写错成 `patern` 这类笔误, lint 给出「是否想写 `pattern`?」—— 与步骤字段笔误是同一套提醒机制;
- **校验时机在"下发任何命令之前"**:`ecs_runbook validate` / `plan` 会拦住缺必填、`pattern` 不匹配、`enum` 不匹配,并在结果里给出 `missing_required` / `param_issues`;设置面板的「校验」按钮与执行前检查用**同一套实现**,因此不会出现"面板说通过、执行时炸";
- **隐式参数同样受约束**:`${instance_id}` / `${region}` / 实例锚点的自定义字段(如 `${repo}`)都在校验范围内 —— 锚点里写错的 `repo` 不会因为"它是隐式参数"而绕过去;
- **报告里能看到"参数契约"**:`validate` / `plan` 的文本结果会列出每个参数的**必填标记 + 默认值 + pattern + 枚举 + hint**,一眼看清"缺什么 / 该是什么格式"。

#### step 级 `raw: true`: 整步关闭占位符替换(v0.8.0+)

`$${NAME}` 转义仍然有效(已有跑书不受影响), 但"整段就是 shell 脚本、`${VAR}` 全部留给远端展开"时逐个转义很啰嗦:

```jsonc
{ "raw": true, "script": "echo \"$HOME\" > /tmp/x" }
```

- **语义**:该步的**整步**不做占位符替换 —— 里面的 `${...}` 既不算 runbook 参数, 也不会因为"缺参数"而报错;非 `raw` 步骤里 `$${}` 转义的行为完全不变;
- **lint 会兜住反直觉**:若这一步其实想用 runbook 参数, `raw: true` 会让它原样保持 —— lint 给出 `raw_placeholders` 提醒(列出这步里出现的 `${...}`),并提示"若想用 runbook 参数请去掉 `raw`"。

#### 重跑建议与 `from_step`(v0.8.0+)

**"失败了能不能直接重跑整条跑书"** 此前只能靠人判断。v0.8.0 起 `ecs_runbook` 的 `validate` / `plan`、`ecs_deploy` 的 `dry_run` 预演与**失败结果**里都会带一段「重跑建议」: 逐步判定幂等性, 给出 `safe_prefix` 与一句可直接照做的结论。

| 步骤 | 幂等性判定 |
|---|---|
| `upload` | **只有 `force: true` 才算幂等**(`--force` 覆盖, 内容相同则结果相同);无 `--force` 时远端已存在就会失败 |
| `exec`(且 `read_only: true`) | 幂等(只读) |
| `assert` | 幂等(只读判据) |
| `tail` | 幂等(只读日志读取) |
| 其它写命令 | **未知** —— 重跑会再执行一次 |

结论长这样: "前 2 步(索引 `[0]..[1]`)可重复执行; 第 3 步(docker compose up -d)起可能产生副作用 —— 可直接重跑整条跑书, 或用 `from_step: 2` 从该步继续。"

**`from_step`: 从中途继续(v0.8.0+)**

```text
ecs_deploy { instance_id: "i-xxx", runbook: "release", runbook_params: { sha: "abc123" }, from_step: 2 }
```

- 跳过 `index < N` 的步骤, **索引用计划里显示的 `[i]`(0 起)** —— 因此 `from_step: 2` 表示跳过 `[0][1]`, 与 `ecs_runbook plan` / `dry_run` 里的编号完全一致;
- **预演与真实结果都会显式列出被跳过的段**(`skipped_prefix`), 并提醒"**这些步骤的前置效果不会被重建**" —— 跳过了上传却指望远端是新的, 正是这类操作最典型的翻车方式;
- 跳过的步骤在结果里标为「已跳过(按 from_step 跳过)」, 且**不影响整体 `ok: true`**(与前序失败导致的 `skipped` 明确区分);
- 越界(`N < 0` 或 `N ≥ 步数`)直接报错, 并给出合法区间;
- `from_step` **仅配合 `steps` / `runbook`** 使用 —— 老三阶段只有固定四个阶段, 没有可跳过的编号。

### 内置通用跑书模板(v0.6.7+)

随包分发 **5 份不绑定具体项目的跑书**(`templates/runbooks/*.json`):拷进任意项目的 `<工作区>/.dsh/workbench-ecs/runbooks/` 即可用,也可以直接当内联 `runbook` 对象传给 `ecs_deploy`/`ecs_runbook`。它们和项目自己的跑书(如奶龙的 `release.json`)是同一套机制 —— 纯数据、可 lint、可预演。

| 模板 | 用途 | 关键参数(都有默认值) | 备注 |
|---|---|---|---|
| `host-check` | 主机体检:**只读** | `disk_max=90` `mem_max=90` `mount=/` `port=""` `process_name=""` | 断言磁盘/内存水位、端口在听、进程在跑,并留档负载/时间同步;可随时对任意实例跑 |
| `compose-redeploy` | 通用容器重部署 | `app_dir`(需显式传) `compose_file=docker-compose.yml` `service=""` `container_name=""` `health_url=""` `git_ref=""` `step_timeout=300` | 给了 `service` 才 `--force-recreate --no-deps`,否则只 `up -d`;`git_ref`/`health_url`/`container_name` 留空即跳过对应检查 |
| `disk-cleanup` | 磁盘回收 | `confirm=no` `cache_keep=2GB` `disk_max=90` `container_name=""` | **默认只报告不删**(`confirm` 必须是 `yes`);清理已退出容器/悬空镜像/构建缓存,再断言水位与容器仍在 |
| `tls-cert-check` | 域名与证书体检:**只读** | `host`(需显式传) `port=443` `path=/` `min_days=14` | HTTPS 可达 + 状态码 2xx、证书剩余天数 ≥ 阈值(需远端有 `openssl`) |
| `log-dig` | 日志排查:**只读** | `log_path`(需显式传) `lines=500` `pattern=ERROR` `max_hits=0` | 统计最近 N 行命中数,超过阈值即失败;默认口径是"最近 500 行不出现 ERROR 才算过" |

```bash
# 拷进项目(拷贝后即可 ecs_runbook validate / ecs_deploy runbook 使用)
cp -r node_modules/dsh-workbench-ecs/templates/runbooks/*.json  .dsh/workbench-ecs/runbooks/

# 例:只读体检,先校验再预演,确认后执行
#   ecs_runbook  { action: "validate", runbook: "host-check" }
#   ecs_runbook  { action: "plan",     runbook: "host-check", instance_id: "i-xxx" }
#   ecs_deploy   { instance_id: "i-xxx", runbook: "host-check", runbook_params: { disk_max: 85, port: "443" } }
```

约定(模板自己就是这么写的,照着改就行):

- **必需参数用哨兵默认值**:`"app_dir": "<app_dir>"`,第 0 步断言会带中文提示拒绝哨兵值,避免"忘了传参数→在远端做了一半才失败";
- **可选/有格式的参数用参数描述符**(v0.8.0+):模板里的阈值、端口、路径这类参数已写成 `{ "default": …, "description": …, "hint": …, "pattern": … }`(如 `disk_max` 必须是 1–3 位数字、`mount` 必须是绝对路径、`port` 留空或 1–5 位数字,`disk-cleanup` 的 `confirm` 用 `enum: ["no","yes"]`)—— 传错值在**下发任何命令之前**就被拦住,而不是在远端跑到一半才失败;真正"必须传"的参数仍用哨兵默认值 + 第 0 步断言(两种写法并存,见上文「runbook 参数契约」);
- **可选参数默认空串**:脚本里 `if [ -n "${param}" ]` 判断,留空即跳过该检查,而不是给个假默认值;
- **危险动作加确认闸门**:`disk-cleanup` 的 `confirm=no` 默认只报告,`confirm=yes` 才动手;
- 模板在 CI 里受**回归守卫**(`test/smoke.mjs`):每份模板必须 lint 0 错误 0 提醒、占位符都有默认值、替换后无残留、能完整展开成计划 —— 模板坏了 CI 直接红。

### `ecs_runbook` —— 工作区跑书的只读清点与静态校验(v0.6.3+)

CLI 对应: **无** —— 本工具不调用任何 CLI 命令, 也不触达 ECS 实例(纯本地文件 + 纯逻辑)

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `action` | string | ✅ | `list` 列出全部 runbook 及校验结论; `validate` 对某一份逐条给出静态校验问题; `plan` 按参数展开成计划并回显命令(不执行) |
| `runbook` | string \| object | validate / plan | `"名字"` → 读工作区 `.dsh/workbench-ecs/runbooks/<name>.json`; 或内联对象 |
| `runbook_params` | object | | 参数对象(覆盖默认值并替换 `${占位符}`); 隐式可用 `instance_id` / `region`,以及实例锚点里的字段(v0.7.0+)。runbook 的 `params` 支持**参数描述符** `{ required, pattern, enum, default, description, hint }`(v0.8.0+,标量仍表示默认值) |
| `instance_id` / `region` | string | | 可选: 仅供 `plan` 展示目标(缺省显示 `<instance_id>`) |
| `read_only` | boolean | | 可选: `plan` 时按只读护栏口径预检(与 `ecs_deploy read_only` 一致) |
| `from_step` | integer | | 可选(v0.8.0+): 跳步起点(索引用计划里显示的 `[i]`, 0 起)—— `validate` / `plan` 会据此标注**将被跳过**的段并给出 `skipped_prefix` |

**为什么值得先跑一遍**: runbook 是**纯数据**, 因此"哪里写错了"完全可以在下发任何命令之前查清。校验覆盖:

| 类别 | 例子 |
|---|---|
| 结构(与执行期**同一份**校验, 文案逐字一致) | 非法 `kind`、upload 缺 `local_file`/`remote_path`、`command` 与 `script` 同给、超过 20 步 |
| 字段笔误(最隐蔽: 多余字段会被静默忽略) | `commnad` → `是否想写 command?` |
| 断言太弱 | `assert` 的 `expect` 为空 → 实际只校验了 `exit_code=0` |
| 护栏矛盾 | `read_only: true` 的命令命中写操作模式 → 执行时必被拒(报 error) |
| 破坏性命令 | 命中 `rm -rf` / `systemctl stop` 等 → 提醒 Agent 侧需审批、面板侧会被直接拒绝 |
| 参数 | 缺参数(报 error; 大写名字会提示用 `$${NAME}` 转义)、多余入参、`params` 里从未使用的默认值 |
| 参数契约(v0.8.0+) | 缺必填(`required` 且无默认值)、值不匹配 `pattern` / `enum`、描述符字段笔误(`是否想写 pattern?`)、`raw: true` 的步骤里其实想用参数(`raw_placeholders`) |
| tail 语义 | 既无 `wait_seconds` 又无 `exit_file` → 只读一次(文件还在写就会读到半截) |

```
# 建议顺序: 先只读校验, 再预演, 最后才执行
ecs_runbook { action: "validate", runbook: "release", runbook_params: { sha: "abc123" } }   # 读 <会话工作区>/.dsh/workbench-ecs/runbooks/
ecs_runbook { action: "plan",     runbook: "release", instance_id: "i-xxx", runbook_params: { sha: "abc123" } }
ecs_deploy  { instance_id: "i-xxx", runbook: "release", runbook_params: { sha: "abc123" } }
```

> **shell 变量要转义**: `${NAME}` 会被当成 runbook 占位符; 想留给远端 shell 展开请写 `$${NAME}`
> (插件原样保留 `${NAME}`, 不参与替换也不参与"声明参数"统计)。
> **整段就是脚本时**可以用 **step 级 `raw: true`**(v0.8.0+)一次关闭该步的占位符替换, 比逐个写 `$${NAME}` 直观 —— 两种写法并存, `$${NAME}` 转义不受影响(见上文「step 级 `raw: true`」)。
> `plan` 的结果里还带**重跑建议**(逐步幂等性 + `safe_prefix`), 以及 `from_step` 标注的将被跳过的段。
> 设置页的 Runbook 卡片同样有「校验」按钮(等价于 `validate`, 不触达实例)。

### `ecs_snapshot` —— 发布快照: 回滚点 + 差异核对(v0.8.0+)

CLI 对应: `workbench exec`(一条只读采集脚本, 单次调用完成全部采集)

一次受控发布的"最后一公里"其实是两件事: **动手前的回滚点**与**动手后的差异核对**。此前每个 agent 都要自己手写 `docker tag` + `docker cp` + 采集 `docker images` / `docker ps` 的拼装脚本(二十多行, 而且每次重写)。`ecs_snapshot` 把它做成一等公民:

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `action` | string | ✅ | `create` 采集并写清单; `list` 列出工作区快照; `diff` 重采一次并逐项对差异 |
| `name` | string | create / diff | 快照名(只允许字母、数字与 `.` `_` `-`, 首字符为字母或数字, ≤64 字符), 例如 `pre-abc1234` |
| `instance_id` | string | create 必填 / diff 可缺省 | 目标实例(也可直接写工作区锚点名, 如 `"prod"`); diff 缺省沿用清单里记录的实例 |
| `region` | string | | 地域, 可缺省(CLI 从实例 ID 自动推断) |
| `note` | string | | create: 备注(如"发布前回滚点"), 写进清单 |
| `profile` | string | | create: 项目侧**具名 profile**(见下), 提供 `paths` / `commands` / `collectors` |
| `paths` | array\<string\> | | create: 要留指纹的远端**文件或目录**(一次最多 50 个) |
| `commands` | object | | create: 自定义只读采集器 `{ "<标签>": "<命令>" }` |
| `collectors` | array\<string\> | | create: 只取这些**默认采集器**的子集 |
| `against` | string | | diff: 与**另一份快照**对比(缺省 = 与实时状态对比) |
| `timeout` | integer | | 采集命令超时(秒), 默认 180 |

**三个动作**:

- **`create`** —— 一次**只读**采集并写入工作区清单 `.dsh/workbench-ecs/snapshots/<name>.json`:
  - 默认采集器 `host`(`hostname` + 内核)、`images`(`docker images --digests`)、`containers`(`docker ps`)、`ports`(`ss -tln`); docker 缺失时该采集器记为 `exit_code != 0` 的空输出, **不影响其它采集器**(快照在没装 docker 的机器上同样可用);
  - `paths` 对每个远端文件/目录留指纹: **文件** = 远端 `sha256sum` + 大小 + mtime;**目录** = 文件清单摘要 + 条目数 + mtime;
  - `commands` = 自定义只读采集器 `{ "<标签>": "<命令>" }`, 只存**输出摘要、行数与前 12 行**(完整输出不进清单);
  - `collectors` 可只取默认采集器的子集。
- **`list`** —— 列出工作区快照(名字/时间/目标实例/备注/采集器), **零远程调用**(清单就在工作区里, 所以连 CLI 都不碰)。
- **`diff`** —— 按清单里记录的采集器**重采一次**, 与基线逐项对差异:
  - 文件: `added` / `removed` / `changed` / `metadata-only`(**内容一致, 仅 mtime 变**)/ `unchanged`;
  - 采集输出: `changed` / `exit-changed` / `unchanged`, 并给出**首个差异行**(第几行, 以及前后的值各是什么);
  - 返回 `clean` / `changed_count` / `files_changed` / `commands_changed`, 渲染结果直接给一句核对结论;
  - `against` 可与**另一份快照**对比(缺省 = 与实时状态对比)。

**设计原则: 机制在插件、内容留在项目仓库**(与 runbook 同一条原则)。快照哪些路径、采集什么命令, 写在项目里的具名 profile 文件 `.dsh/workbench-ecs/snapshot-profiles.json`:

```jsonc
{
  "web": {
    "paths": ["/opt/app/app.jar", "/opt/app/docker-compose.yml", "/opt/app/logs"],
    "commands": { "nginx-version": "nginx -v", "compose-ps": "docker compose -f /opt/app/docker-compose.yml ps" },
    "collectors": ["host", "images", "containers", "ports"]
  }
}
```

用 `ecs_snapshot { action: "create", profile: "web" }` 引用;profile 不存在时会报错并**列出可用名字**(空文件也会明说),profile 文件本身损坏也会指出路径与原因 —— 不会静默忽略。

**其它要点**:

- **采集脚本恒过只读护栏**:采集内容只由 sha256/`stat`/`find`/`docker images|ps`/`ss` 与自定义只读命令组成, 且**总是**过一遍护栏才下发 —— **快照流程不可能改动远端**, 不依赖"我们写得对";
- **清单落在工作区**:因此可 diff、可提交、可 grep,`list` 也是零远程调用;
- **默认采集刻意不放易变内容**(如 `uptime`、磁盘精确数值):快照用于"发布前后对差异", 噪声会淹掉真正的变化 —— 确实需要这类指标时, 在**项目 profile** 里按需加采集器。

**典型用法(发布前后一键核对)**:

```text
# 发布前: 留一个回滚点(只读采集, 清单进工作区)
ecs_snapshot { action: "create", instance_id: "prod", name: "pre-<sha>", profile: "web" }

# ... 执行发布 ...

# 发布后: 按清单里的采集器重采一次并逐项对差异
ecs_snapshot { action: "diff", name: "pre-<sha>" }

# 想知道"这两次发布之间远端到底变了什么": 两份快照互比
ecs_snapshot { action: "diff", name: "pre-<sha>", against: "pre-<sha2>" }
```

### `ecs_session` —— 会话管理

CLI 对应: `workbench session list` / `workbench session close <id>` / `--all`

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `action` | string | ✅ | `list` 查看活动会话; `close` 关闭会话 |
| `session_id` | string | | 要关闭的会话 ID(close 时使用) |
| `all` | boolean | | 关闭全部会话(close 时使用) |

一般无需手动管理(会话自动管理), 用于排障与资源回收。

## 安全机制

- **破坏性命令守卫**: `ecs_exec` / `ecs_deploy`(重启命令与健康检查)执行前扫描命令, 命中 `rm -rf`、`shutdown`/`poweroff`/`reboot`/`halt`、`mkfs`、`dd`、`init 0/6`、`systemctl stop/disable/mask`、`service stop`、`iptables -F/-X`、`userdel`/`groupdel` 等模式时, 接入 Harness `approval` 服务请求确认; 未获 `allowed-once`(或无审批服务/政策为 never)一律拒绝执行(fail closed)。**四种"没获批"的情形在 v0.7.0+ 分开说明**(见下表)。
- **只读护栏**(v0.4.0+): `read_only=true` 时在命令进入 shell 之前拒绝写操作 —— 非 `/dev/null` 重定向、`rm`/`mv`/`cp`/`mkdir`/`touch`/`chmod`/`chown`/`truncate`、`tee`、`sed -i`、`docker`/`docker compose` 变更、`systemctl`/`service` 状态变更、包管理与 `git` 写操作、`kill`/`nohup`、`crontab`/用户管理、`find -delete/-exec` 等。这是**防呆**, 不是权限边界(动态拼接仍可绕过), 强约束仍走审批。**拒绝信息在 v0.7.0+ 可调试**(见下文)。
- **只读体检**: `ecs_diagnose` 内置命令均为只读并默认开启护栏; 自定义命令同样过守卫。
- **快照恒只读**(v0.8.0+): `ecs_snapshot` 的采集脚本(`sha256sum`/`stat`/`find`/`docker images|ps`/`ss` 与自定义只读命令)在投递前**总是**过一遍只读护栏 —— 快照流程**不可能**改动远端。
- **传输完整性**: `ecs_upload.verify_sha256` / `ecs_deploy.verify_sha256`(默认开启; v0.7.0+ 起 `ecs_upload` / `ecs_deploy` 老三阶段 / `steps[].upload` **三处默认值统一为 true**)比对本地与远端 sha256, 损坏的发布物在重启前就会被拦下。
- **文件传输确认**: `ecs_upload`/`ecs_download` 默认对已存在文件要求确认, `force=true` 才覆盖。
- **凭据安全**: 凭据只存在本机 `~/.workbench/config.json`(0600), 建议用 RamRoleArn/CredentialsCmd/CredentialsURI 模式而非长期 AK。

### 破坏性命令被拒绝: 四种情形分开说清(v0.7.0+)

此前这四种情况都会得到同一句"未获批准 (rejected)", 模型很容易**误判成命令语法写错了**而反复重试同一条命令, 白烧好几轮。现在每种情形都写清原因与**下一步**:

| 情形 | 插件行为与提示 |
|---|---|
| **审批服务未挂载**(环境里没有 `approval`) | fail closed: 直接拒绝, 明确说明"当前环境未挂载审批服务" |
| **本会话审批策略为 `never`**(审批已被禁用) | **直接拒绝, 不发起任何审批请求**(发出去也必然被判 rejected); 明确写出「这不是命令写错, 重试同一条命令不会有不同结果」, 并给出两条下一步: (a) 请用户把审批策略切回 `ask` 后重试; (b) 改写成不需要审批的等价做法(例如先备份、只删除具体路径, 而不是 `rm -rf` 整个目录) |
| **用户在审批中拒绝** | 明确说明"用户在审批中拒绝了该命令"(并带上当时的审批策略), 提示**不要原样重试** —— 改成用户能接受的更小动作, 或让用户重新审批 |
| **审批请求被取消 / 无审批应答者**(`cancelled` / `unavailable`) | 分别说明"请求被取消(工具调用已取消或用户撤回)"与"没有应答者(如无人应答的执行环境)"; 后者提示在可交互会话里执行, 或改写成不需要审批的等价做法 |

### 只读护栏的拒绝信息可调试(v0.7.0+)

`read_only: true` 命中时, 反馈里最有用的不是规则本身, 而是"命中之后该怎么改写"。所以现在会**逐条**列出**所有**命中的规则:

- 命中的**规则名**、**命中文本**、**在命令里的位置**(同一规则最多列 3 处, 单条文本截断到 80 字符);
- 此前**只报第一条** —— 一个脚本里同时有 `mkdir` / `>` / `cp` / `curl -o` 时只能看到一条, 改完一条又撞下一条, 来回好几轮;
- 并附「**只读等价写法建议**」:

| 你的意图 | 建议写法 |
|---|---|
| 不需要落盘 | 直接把结果写到 stdout(`echo`/`printf`, 不要 `>` 到文件), 护栏放行 |
| 确实需要写入 | **显式**传 `read_only: false`(写操作必须显式声明, 不会静默放行) |
| 长任务 / 大输出 | 用 `detach: true` 在远端 `nohup` 启动, 再用 `ecs_log` 按**字节游标**读日志 |
| 属于误伤(命令本身只读) | 同样用 `read_only: false`, 并把该写法反馈给维护者以收紧规则 |

## 典型用法(生产修复闭环)

```text
# 1. 找到实例(不知道在哪个地域时, 先用 ecs_find 跨地域检索 —— 不必猜地域)
ecs_find { keyword: "nailong" }
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

# 4b. 发布前后各留一份快照(回滚点), 再用 diff 一键核对差异
ecs_snapshot { action: "create", instance_id: "i-uf66ct2o35p7fjcd0sru", name: "pre-abc1234", profile: "web" }
#   ... 发布 ...
ecs_snapshot { action: "diff",   name: "pre-abc1234" }

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
| 124 | **远端命令超时**(`--timeout` 到期): CLI 进程退出码是 124, 而 JSON 里的 `exit_code` 会是 0 —— 插件据 `timed_out` 结算为 124(v0.7.0+) |

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
| `破坏性命令未获批准` | 这是安全守卫的正常行为: 需要用户(或审批方)明确放行。先看清是哪种情形 —— 若提示"本会话审批策略为 never(审批已禁用)", 那是**审批被禁用**而不是命令写错(v0.7.0+ 会直接写明), 重试同一条命令不会有不同结果: 请用户切回 `ask`, 或改写成不需要审批的等价做法 |
| 命令明明被超时掐断, 却像是"成功且没有输出" | v0.7.0 前的已知缺陷(CLI 超时时 JSON 谎报 `exit_code: 0`)。v0.7.0+ 一律结算为 `exit_code 124` + `timed_out: true`; 请升级插件, 长任务改用 `detach: true` + 在远端写日志文件, 再用 `ecs_log` 续读 |
| 上传失败, 报错提到 OSS / `i/o timeout` | 这是"**本机 → OSS 中继**"那一段的网络抖动, **不是目标实例的问题**(不必先查实例、安全组、云助手)。`ecs_upload` 已对瞬时类失败自动重试(默认 2 次); 仍失败时稍后重跑同一条命令/跑书即可 —— 上传是幂等的 |
| `未找到实例锚点 "xxx"` | 锚点名写错了。报错里会**列出可用锚点**; 或该工作区还没有 `.dsh/workbench-ecs/instances.json`(可从 `templates/instances.json` 拷一份) |
| 不知道实例在哪个地域 | 用 `ecs_find { keyword: "<实例名或IP>" }` 跨地域检索; `ecs_list` 必须给地域, 返回 0 台时也会提示改用 `ecs_find` |
| `ecs_snapshot: profile "xxx" 不存在` | 项目里的 `.dsh/workbench-ecs/snapshot-profiles.json` 没有这个名字 —— 报错会**列出可用 profile**(文件里一份都没有时也会明说) |
| 跑书报"缺少必填参数" / "不符合 pattern" | runbook 的 `params` 用了**参数描述符**(v0.8.0+)。`ecs_runbook { action: "validate" }` 会在下发任何命令之前就拦住, 并按 `hint` 提示该怎么取值; 隐式参数(含实例锚点字段)也受同样的约束 |
| 发布失败了, 跑书能不能直接重跑? | 看结果里的「重跑建议」: 它已逐步判定幂等性并给出 `safe_prefix`。只想从中途继续时用 `ecs_deploy { from_step: N }`(索引取计划里显示的 `[i]`, 0 起) —— 但要注意结果里 `skipped_prefix` 那段的前置效果**不会被重建** |

### 插件报错格式示例

```text
ecs_exec: workbench CLI 错误 (code 1): session resolve: login instance: SDKError: ...
```

## 开发

```bash
npm install          # 安装 devDependencies(@deepseek-ai/dsh-tools)
npm test             # 单元回归(不触达实例) + 冒烟测试(模块导出 + 11 工具注册契约 + body 一致性)
npm run test:unit    # 只跑单元回归: base64/只读护栏/超时默认/输出清洗/sha256 链路/runbook/lint
npm run test:ui      # 设置页 RPC 真机测试(内存 fake ctx + 真实 CLI, 含 runbook-list/validate/plan/run)
npm run test:e2e     # 真实 CLI 端到端测试(需要本机 Workbench CLI + 有效凭据 + 可达实例)
npm run build:body   # 生成动态挂载用 body(与 lib/ 同源, 共享模块递归自动发现)
```

- 源码结构: `lib/common.js`(共享层) · `lib/steps-engine.js`(编排引擎, 工具与面板共用) · `lib/runbooks.js`(跑书机制 + 静态校验) · `lib/snapshots.js`(发布快照机制, v0.8.0+) · `lib/regions.js`(公共地域清单与跨地域检索, v0.7.0+) · `lib/anchors.js`(项目级实例锚点, v0.7.0+) · `lib/settings-api.js`(设置页 RPC) · `lib/tools/*.js`(每工具一个模块) · `lib/index.js`(入口)
- 动态挂载(临时会话): `npm run build:body` 后把生成的 body 用于 `cordis_define` 的 `code.host`
- CI: [GitHub Actions](./.github/workflows/ci.yml) —— push/PR 跑测试, `v*` tag 自动发布 npm
- 发版前请读下面的「发布流程(踩过的坑)」
- 类型声明: [`lib/types/index.d.ts`](./lib/types/index.d.ts)
- 一键配置脚本: [`scripts/workbench-setup.ps1`](./scripts/workbench-setup.ps1)

### 发布流程(踩过的坑)

1. **CI 发布需要 `NPM_TOKEN` secret**(Settings → Secrets and variables → Actions;值用 npm Automation token)。
   未配置时工作流会打一条 warning 并**优雅跳过**发布(tag 仍然有效), 不会让流水线变红;
   此时可本机 `npm login` 后直接 `npm publish`(两条路径产出的包一致)。
2. **一次推送不超过 3 个 tag**:GitHub 对"单次推送超过 3 个 tag"的 push **完全不触发** workflow
   (既不报错也不排队) —— 补推历史 tag 时要分批, 每次 ≤3 个。
3. **回填老版本别把 `latest` 拽回去**:补发历史版本用 `npm publish --tag backfill`,
   否则 `latest` 会被指到刚发布的旧版本上(清理该临时 tag 用 `npm dist-tag rm dsh-workbench-ecs backfill`)。

## License

[MIT](./LICENSE) © 2026 [nishuoyang](https://github.com/nishuoyang)
