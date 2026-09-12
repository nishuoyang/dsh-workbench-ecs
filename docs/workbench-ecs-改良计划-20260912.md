# dsh-workbench-ecs 反馈整理与改良计划(v0.4.0 → v0.6.0)

> 输入: `E:\AiProject\nailong\docs\workbench-ecs-反馈与改进建议-20260912.md`(奶龙生产运维 ~30 次真实调用)
> 核对基线: 插件源码 v0.3.7(commit `324d979`)+ 本机 Workbench CLI **v1.0.1**(commit `86c0aff`)
> 整理方式: 反馈的每条 F/S 都对回代码与 CLI 实测能力逐条核对,区分「已修」「描述有误」「真缺口」「不可行」四类,
> 再据此重排优先级。**本文件不是复述反馈,而是修正后的可执行计划。**
> 日期: 2026-09-12
>
> **实施状态(2026-09-12 更新)**:
> - **v0.4.0 已落地**(提交 `c720364`)—— `npm test`(19 项单元 + 冒烟/动态 body 一致性)全绿,
>   `npm run test:e2e` 对 `i-uf66ct2o35p7fjcd0sru` 25/25 通过(含 F1 原始场景: 容器内 `node -e` 零转义直通)。
> - **v0.5.0 已落地**(S2 detach + `ecs_log` 游标、S3 伪会话)—— 解掉 **D2**(长任务不再长期占锁)与
>   **D3**(远端日志文件成为唯一事实源, 轮询只搬运增量), e2e 25/25、unit 19/19 全绿。
> - 落地过程中又发现 3 个此前未知的缺陷(D5/D6/D7),见 §三 补充发现。

---

## 一、结论先行(给维护者的 3 条立即行动)

1. **反馈里最痛的 F1(嵌套引号)可以在一个迭代内彻底消灭**,而且不需要 CLI 上游配合:
   插件侧以 base64 投递脚本 → 远端落盘 → `bash <file>` 执行,命令内容全程不经过任何 shell 引用层。
2. **v0.3.7 的「同实例 FIFO 锁」在修掉串流的同时引入了新副作用**:长后台任务会**全程持有实例锁**,
   同实例的其它调用(含 `ecs_diagnose`)排队到工具调用超时(180s)后失败。
   这条反馈里没人提到,但它比 F2 更容易在生产上咬人 —— 必须与 F2 一起重构成「短锁 + detach」模型。
3. **反馈 §二 的两项历史缺陷都已在 v0.3.6/v0.3.7 修完**(见 §二 真相表),但**回归断言没写**,
   所以本次会议/反馈是靠"本会话未复现"推断的。先补断言(半小时),再谈新功能。

另有 1 个**真缺陷**是本次核对新发现的,反馈没提:多个工具**声明的 `timeout` 默认值根本没生效**(详见 §三 D1)。

---

## 二、历史项真相表(反馈 §二 核对结果)

| 反馈条目 | 反馈推断 | 代码事实 | 结论 |
|---|---|---|---|
| `value is not lossless JSON`(v0.3.6 前) | ✅ 已修 | `lib/index.js:toLossless()` 在 execute/presentCall/presentResult/render/presentationMeta **五个投影边界**统一剔除 undefined;`lib/common.js:omitUndefined()` 为单源实现 | **结案**,保留断言 |
| 0909 缺陷 1:后台任务结算后 `job_output` 报错、通知打出 `[status: undefined]` | ⚠️ 推断已修,建议确认 | 已修。根因是 `run(): done` 返回了 `{exitCode,signal}` 而非 dsh-jobs 契约的 `JobOutcome{status,detail}`(`dsh-jobs/lib/types/types.d.ts:26`),导致 `job.status=undefined`。v0.3.7 改为 `{status:'completed'|'failed'|'killed', detail:'exit code: N'}` | **结案**,但 `job_list`/`job_output` 无回归用例 |
| 0909 缺陷 2:同实例并发调用输出串流 | ⚠️ 未复测,高优先级未决 | 已修:`lib/common.js:withInstanceLock()`,同 `instance_id` FIFO 串行、跨实例并行,exec/diagnose/deploy/upload/download + 设置页 RPC 全部经过 | **结案,但语义变了**:从"request 级隔离"变成"实例级串行",见 §三 D2 |

> 因此反馈 S8 里的"加全局 undefined 剔除钩子,一劳永逸"**已经做完了**(v0.3.6)。
> 该条从计划中移除,替换为"补 `job_list`/`job_output`/通知文案的断言"。

---

## 三、核对新发现(反馈未覆盖)

### D1. 声明了却没生效的 `timeout` 默认值 —— 真缺陷

`ecs_diagnose` 参数说明写"默认 120"、`ecs_deploy` 写"默认 120",但两者都只在**用户显式传参时**才追加 `--timeout`:

```js
if (args.timeout !== undefined) argv.push('--timeout', String(args.timeout))   // ecs-diagnose.js:80, ecs-deploy.js:134/145
```

CLI 侧 `exec --timeout` 的默认值是 **30s**(`workbench exec --help`)。所以实际行为是:
**用户不写 timeout 时,体检/发布阶段都在 30s 被 CLI 掐断**,而工具描述告诉模型"默认 120"。
这直接放大了反馈 F2 的"软上限"体感 —— 模型以为有 120s,实际只有 30s。

另:`ecs_exec` 的 `timeoutMs: 180000`(工具调用超时策略)才是反馈所说"~180s 软上限"的真正来源,
它是 DSH `dsh-tool-call-timeout-policy` 按工具的 `timeoutMs` 协作式触发,不是 CLI 限制。

**修法**:工具侧显式解析出默认值并**总是**下发 `--timeout`;同时把 `timeoutMs` 提到与远程超时一致的量级。

### D2. 实例锁的"长持有效应" —— v0.3.7 引入的新摩擦

`lib/tools/ecs-exec.js:193` 注释明确写道:后台任务"锁在子进程结束后释放(而不是 start() 返回时)",
于是**一个 20 分钟的发布任务会让同实例的 `ecs_exec`/`ecs_diagnose`/`ecs_upload` 全部排队**,
排到 180s 工具超时后报 `TOOL_TIMEOUT`。这在"后台跑发布 + 同时想体检看一下"的常见组合下必然踩到。

**根因**是锁的粒度被绑定在"本地子进程生命周期"上,而真正需要互斥的只是**同一时刻在跑的 CLI 进程**。
v0.5.0 的 detach + 轮询模型(§四 S2)会让每次轮询只短暂持锁,自然解掉这个问题;

### D5. 远端退出码此前被本地退出码"覆盖" —— 已修

CLI 的 JSON 响应同时带 `exit_code`(远端)与进程自身退出码(实测两者通常一致,`exit 3` → 都返回 3),
但旧代码只读进程退出码。v0.4.0 改为**以 JSON 的 `exit_code` 为准**、进程退出码回退,
并顺带把 `request_id` / `session_id` 带回工具结果(排障时可直接核对是否复用同一会话)。
实测确认:同一实例的所有调用**复用同一个 session id**(如 `s-8or9sgn524lit3916`),
这正是 0909 缺陷 2 的物证,也是实例锁存在的根因。

### D6. `ecs_deploy` 的上传阶段一直是坏的 —— 已修(本次 e2e 新用例暴露)

`ecs_deploy` 的上传阶段复用了严格 JSON 解码(`decodeCliOutput`),而 `workbench upload`
**即使带 `--output json` 也只输出人类可读文本**(进度 + `Upload complete: ...`,且主要落在 stderr),
于是上传阶段恒为 `ok:false`("workbench 无输出 (exit 0)")。也就是说
**"带 `local_file` 的受控发布"自 v0.2.0 起从未真正可用**,只是没人用这条路径。
v0.4.0 改为宽容解码(`decodeLoose`),并把上传进度里的 spinner/百分比帧一并清洗掉。

### D7. 实例锁不可重入 → 嵌套取锁自我死锁 —— 已修

`ecs_deploy` 为了"上传→校验→重启"整段原子而持有实例锁,而 `remoteSha256` 内部又会去取同一把锁:
`withInstanceLock` 是普通 FIFO 链、**不可重入**,于是校验阶段永久等待(表现为工具调用挂住)。
v0.4.0 给 `remoteSha256` 增加 `locked: true`(调用方已持锁时不再重复取锁),
`ecs_upload` 也改为"上传 + 校验"同锁完成。

> **给动态挂载通道的约束**:`scripts/to-body.mjs` 把各模块拼进**同一作用域**,顶层 `const` 不能重名
> (本次 `DEFAULT_TIMEOUT` 在 exec/diagnose 之间撞名导致 body 直接语法错误,被冒烟测试拦下)。
> 新增模块级常量请带模块前缀(如 `EXEC_DEFAULT_TIMEOUT` / `DIAGNOSE_DEFAULT_TIMEOUT`)。
> 另外该脚本会剥掉所有 `import`,因此**新增能力不能依赖 `node:crypto` / `node:fs` / `Buffer`**
> (sha256 与 base64 都是据此实现的)。

### D3. 长后台任务的日志会"丢头 + 重复"

`ecs_exec` 后台路径用 `spawnWorkbench(ctx, argv, undefined)` 的**默认上限**(stdout 内存尾 2MB / spill 32MB),
`readOutput` 用 `readFrom(offset)` 取增量。而 `SubprocessOutputReader` 的契约是:
**当请求的 offset 已滑出内存尾窗口时,返回整个保留尾段 + `lossy: true`** ——
即模型读得慢一点就会**重复收到已经读过的段落**,超过 32MB 后更早的段落永久丢失。

这正是反馈 F2 "日志大了看不到旧段"的机制级解释。**结论**:靠加大缓冲区治不了,
必须让**远端日志文件成为唯一事实源**、用 `tail -c +N` 按字节游标读(§四 S2)。

### D4. 反馈对 F1 根因的描述需要修正

反馈写"命令要穿透 本地 pwsh → workbench CLI → 远端 shell → docker exec 至少四层引用"。
实际上插件用 `subprocess.spawn({ argv })` **数组**投递,本地 pwsh 与 Node 都不参与 shell 解释,
`workbench.exe exec --command <单个字符串>` 也不改写内容。**真正的两层**是:

1. 远端 `sh -c '<你的命令>'`(CLI 在远端固定套一层);
2. 你的命令内部自己再套的一层(`docker exec ... node -e "..."`)。

只有两层,但足以炸 —— 所以 S1 的方案只需**让命令内容不进入第 1 层**,不必处理本地转义。

---

## 四、方案设计

优先级口径:**P0 = 消灭高频痛点且改动小**;P1 = 结构性能力;B = backlog/需上游。

### S1 [P0 / v0.4.0] 脚本直送 `script` 参数 —— 直接消灭 F1 整类问题

**形状**(`ecs_exec`,与 `command` 二选一):

| 参数 | 类型 | 说明 |
|---|---|---|
| `script` | string | 原样投递的脚本正文;与 `command` 互斥、二选一必填 |
| `shell` | string | `bash`(默认)`\| sh`;远端解释器 |
| `keep_script` | boolean | 保留远端临时脚本(默认 false,执行后删除) |

**实现要点**

1. 纯 JS base64 编码器放 `lib/common.js`(动态挂载 body **没有 `Buffer`**,不能用 `Buffer.from(...).toString('base64')`;
   `scripts/to-body.mjs` 还会剥掉一切 import,所以这 20 行必须自带)。
2. **两级投递**(规避 Windows `CreateProcess` ~32KB 命令行上限,base64 膨胀 4/3):
   - `script` ≤ **16KB** → 内联:`printf '%s' '<b64>' | base64 -d > /tmp/.dsh-ecs-<rand>.sh && bash /tmp/.dsh-ecs-<rand>.sh; rc=$?; rm -f /tmp/.dsh-ecs-<rand>.sh; exit $rc`
   - 更大 → 本地临时文件 → `workbench upload`(已有能力)→ 远端 `bash /tmp/x.sh`(**复用 S5 的 sha256 校验**)
3. `docker exec` 场景**不需要**插件特殊支持:脚本已成文件,用户可以自然地写 `docker exec -i nailong-server node -e "..."`,
   或者 `printf '%s' '<b64>' | base64 -d | docker exec -i nailong-server bash -s`。零转义。
4. 兼容性改动(容易漏):`parameters.command.required` 必须改成 `false` + 运行时校验"二选一";
   `renderExecValue`/`presentCall` 目前直接 `args.command.slice(...)`,script 模式下会抛异常,需回落到脚本首行预览;
   `test/smoke.mjs:EXPECTED.ecs_exec` 需同步。

**验收**:反馈 §七-4 的 10 例(含引号、中文、`$`、反引号、多行、`docker exec ... node -e`)全部直通;
`>16KB` 脚本走上传分支同样直通;`command` 与 `script` 同时给出时报错而非静默择一。

**工作量**:S~M(1 天,含测试)。

> **落地修正(v0.4.0 实际实现)**:大脚本分支没有走 `upload`,而是**同一条通道内分片追加**
> (每片 8KB base64,`printf '%s' '<chunk>' >> $f.b64`,最后统一 `base64 -d`),原因是:
> 分片同样能把单次 argv 控制在 ~11KB,却不需要本地临时文件(动态挂载 body 无 `node:fs`/`Buffer`),
> 也不需要 OSS 中继那一跳。落盘后用 `wc -c` 与本地 UTF-8 字节数比对,截断会以 `exit 97` 显式失败
> 而不是静默执行半截脚本。另外 `base64 -d` 带 `base64 -D` 回退(BSD/macOS 兼容)。

---

### S6 [P0 / v0.4.0] `read_only` 只读护栏 —— 防呆(F6)

**形状**:`ecs_exec` / `ecs_diagnose` 增加 `read_only: boolean`;`ecs_diagnose` **默认 `read_only: true`**
(其 `extra_command` 也受约束,与现有 `guardDestructiveCommand` 串联,两者是"防呆"与"审批"两道不同机制)。

**实现要点**:`DANGEROUS_PATTERNS` 之外新增 `WRITE_PATTERNS`(命中即拒绝,不做审批):
`>`/`>>` 重定向、`tee`、`sed -i`、`truncate`、`mv`、`rm`、`mkdir`、`touch`、`chmod`/`chown`、
`dd`、`mkfs`、`systemctl (start|stop|restart|enable|disable)`、`docker (rm|stop|kill|restart|exec)` 中的破坏子集、
`apt|yum|dnf install`、`git (pull|checkout|reset|clean)`、`curl -o`/`wget`、`kill`。

**注意**:护栏是"防手滑",不是权限边界,文档必须写清 —— 绕过方式(脚本内动态拼接)依然存在;
真正的强约束仍走 approval。**验收**:对 20 条只读命令零误杀、对 15 条写命令全部拒绝并给出命中正则来源。

**工作量**:S(半天)。

---

### S8' [P0 / v0.4.0] 小改进(重新整理后)

| 项 | 做法 |
|---|---|
| `description` 参数 | `ecs_exec`/`ecs_diagnose`/`ecs_deploy` 增加 `description`,用于 jobs label 与卡片标题(与本地 `pwsh` 工具对齐) |
| **D1 timeout 默认值** | 显式默认 **总是**下发:`ecs_exec` 60s、`ecs_diagnose` 120s、`ecs_deploy` 每阶段 180s、上传/下载不变;`ecs_exec.timeoutMs` 由 180s → **600s** |
| 长任务通知 | 后台任务完成通知里带 `detail`(已有)+ 实例 ID;去掉反馈提的"undefined 钩子"(v0.3.6 已做) |
| ANSI/控制字符 | 新增 `strip_ansi`(默认 true 用于 render)与 `env: { NO_COLOR: '1', TERM: 'dumb' }`(subprocess 支持显式 env) |
| jobs 输出上限 | 后台任务的 `jobs.start({ outputLimitBytes })` 显式设为 256KB,避免默认值下每次读被截 |

**工作量**:S(半天,含回归)。

---

### S2 [P1 / v0.5.0] detach 长任务 + 字节游标 —— 解决 F2 + D2 + D3

**形状**(`ecs_exec`,与 `run_in_background` 二选一,推荐用它取代 `run_in_background` 的远端场景):

| 参数 | 说明 |
|---|---|
| `detach` | `true`:远端 `nohup` 式启动,立即返回 `job_id` + `log_path` + `exit_path`,并把它注册成 dsh-jobs **流式任务** |
| `after`(新工具 `ecs_log` 上) | 字节游标:`ecs_log { instance_id, path, after, max_bytes }` → `{ text, next_offset, eof, exit_code? }` |
| `poll_interval` | 插件侧轮询间隔(默认 2s,退避到 10s) |

**远端契约**(每次执行都写这三件套,路径规范化为 `/tmp/.dsh-ecs/<job>/`):

```
mkdir -p /tmp/.dsh-ecs/<id>
printf '%s' '<b64>' | base64 -d > /tmp/.dsh-ecs/<id>/run.sh
nohup bash -c 'bash /tmp/.dsh-ecs/<id>/run.sh; echo $? > /tmp/.dsh-ecs/<id>/exit' \
      > /tmp/.dsh-ecs/<id>/out.log 2>&1 & echo $!
```

**插件侧 job 语义**:`run()` 先启动,**不持锁**;随后循环 `tail -c +<N>` 远端日志(每次轮询**短暂**取实例锁)→
把增量 append 进自己的缓冲,`readOutput()` 返回增量,**远端日志文件始终是唯一事实源**(D3 根治);
退出码文件出现即 `done({status, detail:'exit code: N'})`。

**顺带解决**:D2(不再长持锁)、F2 的"轮询成本降到单请求"(模型不再自己 `tail` 循环)、
反馈 §七-5("超长日志按游标完整可翻")。

**风险与对策**:轮询间隔过密会打爆 SSH 会话 → 默认 2s + 退避 + 上限;本地定时器用
`ctx.get('timer').timeout(ms)`(cordis-plugin-timer,可随 fiber 释放),动态挂载环境无原生定时器时回落到
`ctx.timeout` 或远端 `sleep`。

**工作量**:M(2~3 天)。

---

### S3 [P1 / v0.5.0] 伪会话 `session_id` —— 缓解 F3

**事实核对**:CLI 只有 `session list|close`,`exec/upload/download` 有未文档化的 `--session-id`(标注 advanced),
**没有 create/attach 语义保证**;所以"让 CLI 帮我保持 cwd"这条路不可靠。

**因此插件侧自持状态**(可靠且不依赖 CLI 内部行为):

- 会话状态 `{ cwd, env }` 保存在插件内(`Map<session_id, state>`,随 fiber 释放);
- 每次执行包装为:`cd '<cwd>' 2>/dev/null; <script|command>; __rc=$?; printf '\n__DSH_CWD__%s\n' "$PWD"; exit $__rc`,
  从输出尾部解析并**剥离**标记行,更新 `cwd`;`env` 以 `export K=V;` 前缀注入;
- 与 D2/S2 的关系:隔离**已由实例锁提供**,不再依赖 CLI 会话,所以反馈担心的"会话化放大串流"不成立;
  但必须保证锁的**短持有**(S2)。

**验收**:同 `session_id` 下 `cd` 被下一条继承;不同 `session_id` 互不干扰;标记行不出现在模型可见输出中;
会话过期(默认 30min 空闲)后给出明确提示而非静默从 `/root` 开始。

**工作量**:M(1~2 天)。

---

### S7 [P1 / ✅ v0.5.1 已交付] 批量并行 + 结构化输出

- **批量并行** ✅:`ecs_exec` 增加 `concurrency`(默认 1 保持现状;`read_only: true` 时默认 4);
  由 `runWithConcurrency` 在插件侧限制并发, 结果**按输入顺序**返回;同实例仍由实例锁串行,跨实例才真正并行。上限仍 20 台。
- **批量后台** ✅:放开 `instance_ids` + `run_in_background`(此前被显式拒绝), 每台起一个 job,
  返回 `kind: 'batch_background'` + `job_ids` 数组(脚本模式的前置投递先按并发在前台完成)。
- **JSON 模式** ✅:`output_json: true` 时 `render` 直接输出稳定 JSON 文本(`ecs_exec` / `ecs_list`),schema 不变。
- **`ecs_list` 分页** ⚠️ **部分完成 / 受 CLI 限制**:
  - 输入侧 ✅ `next_token` 已透传为 `--next-token`;另补 `vpc_id`/`vswitch_id`/`zone_id`/`private_ip`/`image_id` 五个官方过滤器;
  - 输出侧 ❌ **实测 `workbench list ecs --output json` 只返回 `{ instances: [...] }`,不返回 `NextToken`/`TotalCount`**
    (用一个非法 token 复测同样静默返回首页),因此插件**无法自动翻页**;
  - 缓解 ✅:返回条数顶到 `limit` 且 CLI 未给 token 时, 结果带 `pagination_note` 显式提示"可能有下一页",
    避免模型误判为"就这么多";并提供收敛过滤条件的建议。

**工作量**:M(1 天)。**实际**:单迭代内完成(新增 unit 7 项 + e2e 5 项)。

---

### S4 [P1→P2 / v0.6.0] 发布编排:F4 的"跑书/宏"

反馈把 S4 定为"长期、单独排期"。核对后建议**拆两步**,先把 80% 收益用 20% 成本拿到:

**S4a [v0.6.0] `ecs_deploy` 泛化为 `steps` 编排(中工作量)**

```
ecs_deploy {
  instance_id, dry_run?,
  steps: [
    { kind: 'upload',   local_file, remote_path, force?, sha256? },
    { kind: 'exec',     script|command, timeout?, read_only? },
    { kind: 'assert',   script|command, expect: { exit_code: 0, stdout_contains: [...] } },
    { kind: 'tail',     path, after?, until: { exit_code_file: '/tmp/x/exit' } },
  ]
}
```
- 每步结果全量返回、`continue_on_error` 可选;断言失败即中止并标出失败步骤;
- 与现有三个阶段式 `ecs_deploy` **向后兼容**(无 `steps` 时走老路径)。

**S4b [v0.6.0+] 命名 Runbook 模板(大工作量)**

- 模板**内联定义**(不引入 YAML 依赖 —— 动态 body 无法 import,加依赖会破坏双通道一致性),
  或从工作区读取 `.dsh/workbench-ecs/runbooks/*.json`(需要可选 `ctx.get('fs')`,不硬依赖);
- 奶龙发布闭环可作为**首个内置模板 `release`**:参数 `sha`;阶段 =
  guard(package.json/lock 变化 FATAL、schema 变化 WARN)→ `pre-<sha>` 镜像快照 → overlay 构建 →
  `compose up -d --force-recreate` → smoke(健康 + 边界 400 + 静态 404 + minio 200);
- 断言语义直接平移 `deploy/release.sh`,使 15 次调用收敛为 1 次。
- **决策点**:S4b 的"契约来源"应是仓库里的 `deploy/release.sh`(单一事实源),而不是插件内硬编码 —— 建议模板只声明**步骤与断言**,把脚本本体留在项目仓库,由 `steps` 上传执行。

**工作量**:S4a 2 天;S4b 3~5 天 + 每项目适配。

---

### S5 [P0 部分 / P2 部分] 传输增强(F5)

| 子项 | 可行性 | 计划 |
|---|---|---|
| **sha256 校验** | ✅ 已完成(v0.4.0) | 实现选择:**不依赖 `node:crypto`**(动态 body 会被 `to-body.mjs` 剥掉 import),改为经 subprocess 调用平台工具 `sha256sum` → `shasum -a 256` → `certutil -hashfile`,三通道兜底;远端 `sha256sum \|\| shasum -a 256` 比对。`ecs_deploy` 校验失败会**中止发布**,不再用坏包重启 |
| **目录递归上传** | ✅ 已完成(v0.5.1) | 插件侧本地 `tar`(Windows 10+ 自带)→ 上传 → 远端解包 → **校验 → 解包**顺序保证不落地坏包。实现:归档/清理都经 subprocess 调平台工具(`tar`、`rm`/`cmd /c del`),不依赖 Node 模块;默认 `--strip-components=1` 把目录**内容**放到 `remote_path`(`keep_root_dir` 可保留顶层);sha256 不一致时**不下发解包命令**;本地归档在会话工作区根目录暂存并自动清理 |
| **公网直连传输** | ❌ 本轮不可做 | CLI **没有**直连传输子命令(`upload/download` 固定走 OSS 中继,`connect` 是交互式终端),且插件侧拿不到 SSH 私钥/证书。**应从插件计划中移出,作为 CLI 上游需求单独立项**(反馈 §五 S5 的这一条建议改口径) |
| 中继加速 | ⚠️ 待评估 | 同地域 OSS 中继的瓶颈通常在 CLI 分段策略,非插件可控;先做 sha256 + 并发分片上传的可行性调研 |

---

## 五、优先级与版本排期

| 版本 | 主题 | 内容 | 判据 |
|---|---|---|---|
| **v0.4.0** ✅ **已完成** | 投递与护栏(快赢) | S1 script 直送 / S6 read_only / S8' 小改进(含 **D1** timeout 修复)/ S5a sha256 / 补 0912+0909 回归断言;顺带修掉 **D5、D6、D7** | 已达成:e2e 20/20 通过,F1 的容器内 `node -e` 零转义直通 |
| **v0.5.0** ✅ **已完成** | 长任务与会话 | S2 detach + `ecs_log` 游标 / S3 伪会话 / 解 **D2、D3** | 已达成:e2e 25/25(含 10s 长任务期间前台调用 < 6s 返回) |
| **v0.5.1** ✅ **已完成** | 批量与会话补完 | S7 并行批量 + 后台批量 + JSON 模式 / S5b 目录递归上传 / `ecs_list` 补 5 个过滤器 + 分页提示;顺带修掉 **D8** | 已达成:unit 30/30、e2e 33/33(含目录上传远端 `find` 核对、坏包中止解包、批量并发与 `job_ids`) |
| **v0.6.0** | 编排 | S4a `steps` 编排 → S4b 命名 Runbook(`release` 模板) | 15 次调用 → 1 次;发布契约离开人的记忆 |
| **backlog** | 上游依赖 | S5c 直连传输(需 CLI)、`list ecs` 的 `NextToken`/`TotalCount` 透出(需 CLI,见 §七-7)、`--session-id` 语义确认、CLI stdin 转发确认 | 需与 Workbench CLI 团队对齐 |

**为什么把 S1 放在最前**:反馈 §五 的排序本身没错,但 S1 与 S6 是可以同期完成的 S 级改动,
而 S2/S3 都在 M 级且相互耦合(锁语义)。先拿下确定收益,再动结构。

---

## 六、回归与验收清单(交付前全跑)

**A. 现有回归(必须保持全绿,来自反馈 §七 1/2/6)**
1. 前台 `ecs_exec` / `ecs_diagnose` 7 段 / `ecs_upload` / `ecs_download` / `ecs_session list` / 批量串行;
2. `job_output` / `job_list` 在结算后可用,`status` 取值 ∈ {completed, failed, killed},通知文案**不含 `undefined`**;
   → 新增 `test/e2e-local.mjs` 断言(目前缺,反馈 §二 只能靠"未复现"推断);
3. 中文输出、ANSI/控制字符、空输出、多行自由文本、超长单行均健壮。

**B. 新增回归**
4. **S1** ✅ *已覆盖*:10 例脚本(引号 / 中文 / `$` / 反引号 / 多行 / heredoc / `docker exec ... node -e`)零转义直通;
   `>16KB` 走分片分支;`command`+`script` 同时给出报错;
5. **S6** ✅ *已覆盖*:unit 里 27 条写命令全部拒绝、20 条只读命令零误杀(含 `2>/dev/null`);e2e 验证 `ecs_diagnose` 默认只读且预置脚本零误杀;
6. **D1** ✅ *已覆盖*:断言 `command_line` 中默认超时为 exec 60 / diagnose 120 / deploy 180,显式值原样透传;
7. **D2** ✅ *已解决(v0.5.0)*:detach 任务只在每次轮询期间短暂持锁;e2e 断言"10s detach 期间同实例前台调用 < 6s 返回";
8. **D3/S2** ✅ *已覆盖(v0.5.0)*:远端日志文件是唯一事实源,`ecs_log` 按字节游标续读(重复读返回空、`max_bytes` 截断推进游标、`exit_file` 回报退出码);
9. **S3** ✅ *已覆盖(v0.5.0)*:同 `session_id` 继承 `cd`/`export`,不同 `session_id` 隔离,标记行不出现在输出里,退出码仍透传;空闲 30 分钟重置并提示;
10. **S7** ✅ *已覆盖(v0.5.1)*:`concurrency` 生效且结果按输入顺序、只读批量默认并发 4、批量后台每台一个 job(`job_ids` + 每个 `done.status` 为终态枚举)、`output_json` 与 value 精确等价;`ecs_list` 新过滤器/`limit`/`next_token` 全部落到显式 argv,顶到 limit 且无 token 时给出 `pagination_note`;
11. **S5a** ✅ *已覆盖*:`ecs_upload.verify_sha256` 与 `ecs_deploy` 默认校验在 e2e 中通过;不同内容摘要不同已断言;
12. **S5b** ✅ *已覆盖(v0.5.1)*:目录上传 e2e 走通"归档→上传→校验→解包"(远端 `find` 核对顶层剥离与子目录保留)、`keep_root_dir` 保留顶层、目录不存在时报错;**损坏注入用例**在 unit 中以可编排 subprocess 构造"远端摘要不一致",断言 `aborted`/`extracted:false` 且**不再下发解包命令**(坏包不落地);
13. **lossless** ✅ *已覆盖*:新增分支的 value / presentationMeta / presentCall 均过 `isJsonValue`;
14. **D5/D6/D7**(v0.4.0 新增缺陷)✅ *已覆盖*:`request_id` 带回;`ecs_deploy` 带 `local_file` 的三阶段全绿(此前恒失败);`ecs_deploy` 上传+校验+重启不再死锁;
15. **D8**(v0.5.1 新增缺陷)✅ *已覆盖*:`ecs_upload` 目录模式的解包结果曾取自 `decodeLoose().text` —— 而该字段在 stdout 是合法 JSON 时为**空串**(内容在 `.json.output`),导致 `entries` 恒为 undefined;已改为优先读 JSON 的 `output`/`exit_code`(与 D5 同类)。

> 当前实际测试资产:`test/unit.mjs` **30 项**(不触达实例:护栏 47 条样例、base64/字节校验、sha256 链路、并发闸门、归档/解包、output_json 渲染、分页提示、坏包中止);
> `test/e2e-local.mjs` **33 项**(真实实例,只读命令 + `/tmp` 临时文件)。`npm test` = unit + 冒烟 + 动态 body 一致性。

---

## 七、需要决策 / 需上游确认的事项

1. **CLI `--session-id` 语义**(未文档化、标注 advanced):是否支持"调用方指定即新建/复用"?若支持,S3 可从伪会话升级为真会话(不是阻塞项)。
2. **CLI 是否转发 stdin**:若转发,`bash -s` 可去掉 base64 与临时文件(更干净);需要 Workbench CLI 侧确认或实测。
3. **直连传输**:建议作为 CLI 上游需求(插件侧无凭据来源,不应承诺)。
4. **动态挂载 body 的哈希能力**:**已绕过** —— sha256 改为经 subprocess 调平台工具,不再依赖 `node:crypto`;
   但 `to-body.mjs` "同作用域 + 剥 import" 的约束仍在,新增模块级常量必须带模块前缀(见 D7 提示)。
5. **奶龙 `deploy/release.sh` 作为模板契约来源**:是否同意"模板声明步骤与断言、脚本留在项目仓库"的分工(S4b 前提)。
6. **是否保留 `run_in_background`**:S2 落地后建议保留为"本地 CLI 进程级后台",把远端长任务一律导向 `detach`;文档需明确二选一的使用判据。
7. **CLI 应透出分页 token**(v0.5.1 实测新增):`workbench list ecs --output json` 只返回 `instances`,
   不返回 `NextToken`/`TotalCount`,插件因此无法自动翻页(只能用 `pagination_note` 提示用户收紧过滤条件)。
   需要 CLI 侧在 JSON 输出中包含 `NextToken`(建议同时给 `TotalCount`),否则 100 台以上的地域无法完整枚举。

---

## 八、映射总表(反馈 → 方案 → 版本)

| 反馈条目 | 现状核对 | 方案 | 版本 |
|---|---|---|---|
| F1 嵌套引号必炸 | 真缺口,根因修正为"远端两层"(D4) | S1 | ✅ **v0.4.0 已交付** |
| F2 长命令软上限 + 日志不可续读 | 真缺口;机制解释见 D3,另发现 D1 | S2 + D1 | D1 ✅ v0.4.0 / S2 ✅ v0.5.0 |
| F3 每次独立 shell | 真缺口,但 CLI 无可靠会话创建 | S3(伪会话) | ✅ v0.5.0 |
| F4 多步流水线零编排 | 真缺口,建议拆 S4a/S4b | S4 | v0.6.0 |
| F5 传输无校验/无目录语义 | 部分真缺口;直连不可做 | S5a / S5b / S5c | S5a ✅ v0.4.0 / S5b ✅ v0.5.1 / S5c 上游 |
| F6 无只读护栏 | 真缺口 | S6 | ✅ **v0.4.0 已交付** |
| F7 小项(批量串行/无 description/timeout 偏短) | 真缺口 + D1 | S7 + S8' | S8' ✅ v0.4.0 / S7 ✅ v0.5.1(分页受 CLI 限制) |
| 0909-1 undefined / 通知 | **已修**(v0.3.6+0.3.7) | 仅补断言 | ✅ v0.4.0(断言已加) |
| 0909-2 并发串流 | **已修**(实例锁),但引入 D2 | S2 重构为短锁 | v0.5.0 |
| §七-6 中文/ANSI/空输出健壮性 | 基本满足,发现进度帧污染(D6 关联) | strip_ansi + 用例 | ✅ **v0.4.0 已交付** |
| (新)D5 远端退出码被覆盖 | 真缺陷 | 以 JSON `exit_code` 为准 | ✅ v0.4.0 |
| (新)D6 `ecs_deploy` 上传阶段恒失败 | 真缺陷(自 v0.2.0) | 上传阶段改宽容解码 | ✅ v0.4.0 |
| (新)D7 实例锁不可重入 → 死锁 | 真缺陷(v0.4.0 开发中暴露) | `locked: true` 复用锁 | ✅ v0.4.0 |
| (新)D8 目录上传 `entries` 恒为 undefined | 真缺陷(`decodeLoose().text` 在 JSON 成功时为空串) | 改读 JSON 的 `output`/`exit_code` | ✅ v0.5.1 |

---

*本文件位于插件仓库 `docs/`,随代码演进维护;反馈原文仍保留在 `E:\AiProject\nailong\docs\`。*
