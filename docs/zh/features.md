# 完整特性清单

> 中文 | [English](../en/features.md) · 返回 [README](../../README.md)

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
