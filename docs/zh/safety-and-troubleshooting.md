# 安全机制与故障排查

> 中文 | [English](../en/safety-and-troubleshooting.md) · 返回 [README](../../README.md)

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
