# 安装与凭据配置

> 中文 | [English](../en/getting-started.md) · 返回 [README](../../README.md)

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
- **与本插件同一台机器**上安装并配置好官方 Workbench CLI(见下文「使用前准备」)。

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

## 使用前准备: 安装 Workbench CLI 与配置凭据

> **官方文档（照着就能配通）**：阿里云 [安装并配置 Workbench CLI 凭证](https://help.aliyun.com/zh/ecs/user-guide/install-and-configure-workbench-cli-credentials) —— 安装、RAM 最小权限策略、5 种凭证模式、升级与卸载都在这一篇；连接实例见 [通过 Workbench CLI 连接实例](https://help.aliyun.com/zh/ecs/user-guide/connect-to-an-instance-through-workbench-cli/)，命令用法见 [使用 Workbench CLI 管理 ECS 实例](https://help.aliyun.com/zh/ecs/user-guide/use-workbench-cli-to-manage-ecs-instances)。
>
> 下面是与本插件配合的**最小操作集**（含非交互式写法，便于脚本化）；细节与官方原文有出入时以官方为准。


### 安装 Workbench CLI(必做)

| 平台 | 命令 |
|---|---|
| Windows (PowerShell) | `irm https://workbench-cli.oss-cn-hangzhou.aliyuncs.com/install.ps1 \| iex` |
| Linux / macOS | `curl -fsSL https://workbench-cli.oss-cn-hangzhou.aliyuncs.com/install.sh \| bash` |

安装后先自检:

```bash
workbench version     # 应输出版本号 / commit / build date
```

> ⚠️ **Windows 用户注意**: 如果你在 Harness 进程启动之后才安装 CLI, 宿主进程继承的 `PATH` 是旧环境, 直接运行 `workbench` 会找不到命令。插件已内置「常见安装位置回退」, 通常无需重启; 若仍失败, 请重启 Harness 会话, 或把安装目录(如 `C:\Program Files\workbench`)加入 PATH。

### 配置凭据

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

**一键配置脚本(Windows):** 仓库提供 [`scripts/workbench-setup.ps1`](../../scripts/workbench-setup.ps1), 支持全部 5 种模式与非交互式多 profile:

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

### RAM 最小权限策略(推荐)

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

### 手动安装(高级)

也可以直接把插件行写进 Cordis 组合(cordis.yml / cordis.patch.yml):

```yaml
- id: dsh-workbench-ecs
  name: dsh-workbench-ecs
```

注意: 设置面板只能由 `dsh` 命令接上(bundle 层 `dsh.bundle` + `dsh.client` 声明)。插件行要写进**你想用的那个 profile**: 浏览器端是 `%DSH_HOME%\profiles\web`, 桌面端是 `%DSH_HOME%\profiles\desktop`。

### 本地仓库开发

用 [`scripts/install-local.ps1`](../../scripts/install-local.ps1) 把仓库以 junction 链接进 `%DSH_HOME%` 并代写插件行。脚本幂等且可回退:

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
