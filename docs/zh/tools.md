# 工具参考（11 个 Agent 原生工具）

> 中文 | [English](../en/tools.md) · 返回 [README](../../README.md)

## `ecs_list` —— 列出指定地域的 ECS 实例

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

> **分页现状(v0.5.1 实测)**: CLI 的 `list ecs --output json` **只返回 `instances`**, 不含 `NextToken`/`TotalCount` —— 因此插件无法自动翻页。当返回条数顶到 `limit` 且 CLI 未给 token 时, 结果里会出现 `pagination_note` 明确提示(避免误以为"就这么多"); 缓解办法是收紧过滤条件(`instance_name`/`tag`/`status`/`vpc_id`/`zone_id`)。彻底解决需要 CLI 侧在 JSON 输出中透出 `NextToken`(已记入 `docs/internal/workbench-ecs-改良计划-20260912.md` 的上游需求)。

> **0 台时的下一步(v0.7.0+)**: `ecs_list` 返回 0 台时结果里会多一条 `empty_hint`, 直接提示"实例可能在别的地域 —— 用 `ecs_find { keyword: "<实例名或IP>" }` 跨地域查找"。

## `ecs_find` —— 跨地域检索实例(v0.7.0+)

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

## `ecs_exec` —— 在指定实例上执行远程命令(增强版)

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

### 远端超时的新语义(v0.7.0+, **最值得注意的一处修正**)

`workbench exec` 在远端命令超时时的 JSON 是这样的:

```json
{ "exit_code": 0, "timed_out": true, "duration": "3.002s" }
```

而 CLI 进程自身的退出码是 **124**, 真正的原因只出现在 stderr 里: `{"code":124,"message":"command timed out after 3s"}`。

插件此前"以 JSON 的 `exit_code` 为准"(这条规则本身是对的, 见[可靠退出码](../../README.md#特性)), 于是**被掐断的命令会显示成"成功 + 无输出"** —— 一个长命令被超时掐断, 结果看起来像"跑完了什么都没打印", 这是最危险的一类误导。

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

## `ecs_log` —— 远端文件按字节游标续读(只读)

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

## `ecs_upload` —— 上传本地文件到实例

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

## `ecs_download` —— 从实例下载文件到本地

CLI 对应: `workbench download <remote-path> [local-path] --instance-id <id> [--force]`

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `remote_path` | string | ✅ | 远端文件路径 |
| `local_path` | string | | 本地保存路径(文件或目录, 相对会话工作区; 省略=当前目录) |
| `instance_id` | string | ✅ | 目标实例 ID(也可直接写工作区锚点名, 如 `"prod"`, v0.7.0+) |
| `region` | string | | 地域, 可缺省 |
| `force` | boolean | | 覆盖本地已存在文件而不需确认(默认 false) |

**典型场景**: 把生产日志/配置文件拉回本地分析。

## `ecs_diagnose` —— 一键只读体检

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

### `sections` 与 `echo_command`(v0.7.0+)

只关心磁盘和端口时不必再拉回整份体检输出:

```text
ecs_diagnose { instance_id: "i-xxx", sections: ["disk", "ports"] }      # 只跑两段
ecs_diagnose { instance_id: "i-xxx", sections: ["extra"], extra_command: "tail -n 50 /var/log/nginx/error.log" }
```

- `sections` 的合法取值就是上面 7 段的名字加 `extra`; 写错会**报错并列出合法值**, 不会静默忽略; `extra` 单独出现时只跑 `extra_command`(否则 `extra_command` 会随所选段落一起跑)。
- **`echo_command` 默认 false**: 7 段命令全文此前占了输出的一大半, 现在不再回显。结果里**始终**带 `sections` 摘要与 `extra_command`(哪几段 + 有没有自定义命令一目了然), 需要原文时才传 `echo_command: true`。
- 只读护栏仍然对**实际下发**的脚本生效(`sections` 只影响拼进去的段落, 不改变护栏口径)。

## `ecs_deploy` —— 受控发布 / 多步编排

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

### runbook 参数契约: 必填 / 正则 / 枚举(v0.8.0+)

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

### step 级 `raw: true`: 整步关闭占位符替换(v0.8.0+)

`$${NAME}` 转义仍然有效(已有跑书不受影响), 但"整段就是 shell 脚本、`${VAR}` 全部留给远端展开"时逐个转义很啰嗦:

```jsonc
{ "raw": true, "script": "echo \"$HOME\" > /tmp/x" }
```

- **语义**:该步的**整步**不做占位符替换 —— 里面的 `${...}` 既不算 runbook 参数, 也不会因为"缺参数"而报错;非 `raw` 步骤里 `$${}` 转义的行为完全不变;
- **lint 会兜住反直觉**:若这一步其实想用 runbook 参数, `raw: true` 会让它原样保持 —— lint 给出 `raw_placeholders` 提醒(列出这步里出现的 `${...}`),并提示"若想用 runbook 参数请去掉 `raw`"。

### 重跑建议与 `from_step`(v0.8.0+)

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

## 内置通用跑书模板(v0.6.7+)

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

## `ecs_runbook` —— 工作区跑书的只读清点与静态校验(v0.6.3+)

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

## `ecs_snapshot` —— 发布快照: 回滚点 + 差异核对(v0.8.0+)

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

## `ecs_session` —— 会话管理

CLI 对应: `workbench session list` / `workbench session close <id>` / `--all`

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `action` | string | ✅ | `list` 查看活动会话; `close` 关闭会话 |
| `session_id` | string | | 要关闭的会话 ID(close 时使用) |
| `all` | boolean | | 关闭全部会话(close 时使用) |

一般无需手动管理(会话自动管理), 用于排障与资源回收。
