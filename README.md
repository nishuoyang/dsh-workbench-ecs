# dsh-workbench-ecs

[![Listed on dsh-plugin.org](https://dsh-plugin.org/badges/listed.svg)](https://dsh-plugin.org/plugins/nishuoyang/dsh-workbench-ecs)

> v0.9.2 · MIT License

中文 | [English](README.en.md)

> 阿里云 Workbench CLI 包装插件 —— 让 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的 Agent 直接控制远程 ECS 实例。

它在本机驱动官方阿里云 [Workbench CLI](https://help.aliyun.com/zh/ecs/user-guide/use-workbench-cli-to-manage-ecs-instances)，内置 **11 个 Agent 原生工具**（`ecs_find` / `ecs_list` / `ecs_exec` / `ecs_log` / `ecs_upload` / `ecs_download` / `ecs_diagnose` / `ecs_deploy` / `ecs_runbook` / `ecs_snapshot` / `ecs_session`），覆盖「检索 → 列表 → 体检 → 执行 → 长任务 → 上传 → 重启 → 验证 → 快照核对」完整闭环，并附带可视化设置面板。实例经 Workbench 后端通道连接，**无需公网 IP**；破坏性命令走 Harness 审批守卫，未获明确放行一律拒绝（fail closed）。

## 特性

> 这里只列最值得先知道的几条；**完整清单**见 [完整特性清单](docs/zh/features.md)，参数级细节见 [工具参考](docs/zh/tools.md)。

- **两个宿主都能跑**（v0.9.0+）：浏览器端（`dsh web`）与 DeepSeek Harness 桌面应用（`dsh-desktop-host`）—— 同一个包、同一份 `lib/client.js`，设置页与 11 个工具在两端都出现；`test/compat.mjs` 把这条锁成回归项
- **无需公网 IP**：工具执行本机 `workbench` 命令，经阿里云 Workbench 后端连接实例；`upload` / `download` 走 OSS 中转
- **脚本零转义投递**（v0.4.0+）：`ecs_exec { script }` 把正文 base64 投递远端落盘后执行，不经过 shell 引用层 —— 三层引号、中文、`$`、反引号、heredoc 全部零转义；超 16KB 自动分片并按字节校验
- **受控发布**（v0.6.0+）：`ecs_deploy { steps }` 把「上传 → 执行 → 断言 → 读日志」写成一次调用；`assert` 明确报出哪条断言失败、期望什么、实际什么；`dry_run` 预演，`from_step` 断点续跑
- **发布快照**（v0.8.0+）：`ecs_snapshot` 把「动手前的回滚点 + 动手后的差异核对」做成工具 —— 只读采集写进工作区 `.dsh/workbench-ecs/snapshots/<name>.json`，可 diff、可提交、可 grep
- **失败可归因**（v0.7.0+）：远端超时统一结算为 `exit_code: 124`（CLI 的 JSON 会谎报 0）；护栏拒绝分「无审批服务 / 策略 never / 用户拒绝 / 无应答」四种情形分别说明；上传失败指明问题在「本机 → OSS」这一段而非目标实例
- **长任务与伪会话**（v0.5.0+）：`detach` 在远端 `nohup` 启动并立即返回 `job_id` / `log_path`，不长期占用实例；`session_id` 让 `cd`/`export` 跨调用继承
- **可视化设置面板**：CLI 状态、实例浏览、一键诊断（磁盘·内存仪表盘）、受控发布向导、会话、操作时间线，自动适配深/浅色

## 快速开始

三步，约 5 分钟。完整步骤（5 种凭据模式、RAM 最小权限、多 profile、Windows 的 PATH 坑）见 **[安装与凭据配置](docs/zh/getting-started.md)**。

### 1. 安装 Workbench CLI 并配置凭据

```bash
# Linux / macOS
curl -fsSL https://workbench-cli.oss-cn-hangzhou.aliyuncs.com/install.sh | bash
# Windows (PowerShell)
irm https://workbench-cli.oss-cn-hangzhou.aliyuncs.com/install.ps1 | iex

workbench version      # 自检：应输出版本号 / commit / build date
workbench config       # 按提示填 AccessKey ID / Secret，写入 ~/.workbench/config.json（0600）
```

> **官方教程**：阿里云 [安装并配置 Workbench CLI 凭证](https://help.aliyun.com/zh/ecs/user-guide/install-and-configure-workbench-cli-credentials)（安装、RAM 最小权限、全部凭证模式、升级卸载都在这一篇）。
> 生产环境建议用 RAM 角色（`RamRoleArn`）而非长期 AK；本仓库 [`scripts/workbench-setup.ps1`](./scripts/workbench-setup.ps1) 可把「写配置 + 权限 + 多 profile」一次性做完。

### 2. 安装插件

```bash
# 浏览器端
dsh plugin --profile web add dsh-workbench-ecs

# 桌面应用（另一条命令，两个 profile 互不通用）
dsh plugin --profile desktop add dsh-workbench-ecs
```

装完请重启对应宿主（桌面应用只在进程启动时读一次 profile）。

### 3. 验证

```bash
# 桌面端默认 19387，dsh web 默认 3080 —— 按你实际用的那个改端口
curl -s http://127.0.0.1:19387/dsh-workbench-ecs/health
# => {"ok":true,"plugin":"dsh-workbench-ecs","version":"0.9.2"}
```

然后在对话里让 Agent 调用：

```text
ecs_list { region: "cn-shanghai" }
ecs_exec { instance_id: "i-xxx", command: "df -h" }
```

## 工具一览

| 工具 | 作用 | 起始版本 |
|---|---|---|
| `ecs_find` | 跨地域检索实例（名称 / ID / 私网·公网 IP / 规格 / 标签），缺省并发扫 22 个公共地域 | v0.7.0+ |
| `ecs_list` | 列出指定地域的实例，支持状态 / 标签 / 规格 / 名称等过滤与分页 | — |
| `ecs_exec` | 远端执行命令：`script` 零转义、`instance_ids` 批处理、并发、`detach` 长任务、`session_id` 伪会话、`read_only` 护栏 | v0.5.0+ |
| `ecs_log` | 按字节游标续读远端任意文件（只读） | v0.5.0+ |
| `ecs_upload` | 上传文件或整个目录（`local_dir` 走 tar + sha256 校验 + 远端解包），瞬时失败自动重试 | — |
| `ecs_download` | 从实例下载文件到本地 | — |
| `ecs_diagnose` | 一键只读体检（主机 / 磁盘 / 内存 / 端口 / 容器），默认开只读护栏 | — |
| `ecs_deploy` | 受控发布与多步编排：`steps` / `assert` / `dry_run` / `from_step` / `runbook` | v0.6.0+ |
| `ecs_runbook` | 工作区跑书的只读清点与静态校验（`validate` / `plan`） | v0.6.3+ |
| `ecs_snapshot` | 发布快照：`create` / `list` / `diff` / `against` | v0.8.0+ |
| `ecs_session` | 伪会话管理（列出 / 重置） | v0.5.0+ |

## 文档

| 文档 | 内容 |
|---|---|
| [完整特性清单](docs/zh/features.md) | 30 条特性说明原文，含每条特性的版本与设计取舍 |
| [安装与凭据配置](docs/zh/getting-started.md) | Workbench CLI 安装、5 种凭据模式、RAM 最小权限、多 profile、手动安装、本地仓库开发 |
| [使用指南](docs/zh/usage-guide.md) | 设置面板、工作原理、项目级实例锚点 `instances.json`、生产修复闭环 |
| [工具参考](docs/zh/tools.md) | 11 个工具的参数与返回、内置跑书模板、快照与差异核对 |
| [安全与故障排查](docs/zh/safety-and-troubleshooting.md) | 审批守卫、只读护栏、退出码语义、常见问题 |
| [开发与发布](docs/zh/development.md) | 本地调试、测试矩阵、发布流程与踩过的坑 |

## 安全

- **破坏性命令 fail closed**：`rm -rf`、`shutdown`、`reboot`、`mkfs`、`dd`、`iptables -F/-X` 等走 Harness 审批服务，未拿到 `allowed-once` 一律拒绝，不做「猜你想要」的放行
- **只读护栏**：`read_only: true` 在执行前拦下重定向、`rm`/`mv`/`chmod`、`docker`/`systemctl` 变更类操作；`ecs_diagnose` 默认开启
- **凭据不出本机**：插件不读取也不转发 `~/.workbench/config.json`，只调用本机 `workbench` 命令；建议按 [官方最小权限策略](https://help.aliyun.com/zh/ecs/user-guide/install-and-configure-workbench-cli-credentials) 给 RAM 用户授权

## 环境要求

| 项 | 要求 |
|---|---|
| Node.js | ≥ 20 |
| 宿主 | `dsh web` 或 DeepSeek Harness 桌面应用，两者需**分别**安装插件 |
| Workbench CLI | 与本插件**同一台机器**，且已配置凭据 |
| 目标实例 | 仅 Linux（Workbench CLI 走 SSH，不支持 Windows 实例）；需有云助手 Agent |
| 网络 | 本机可访问 `*.aliyuncs.com` 与 Workbench 后端 WebSocket；上传下载需实例能访问所在地域的 OSS 内网端点 |

## License

[MIT](./LICENSE) © 2026 [nishuoyang](https://github.com/nishuoyang)
