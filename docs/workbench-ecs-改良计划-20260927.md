# dsh-workbench-ecs 反馈整理与改良计划(v0.6.7 → v0.8.0)

> 输入: `E:\AiProject\nailong\docs\workbench-ecs-反馈与改进建议-20260927.md`(奶龙生产运维, 单机 Docker 受控发布全流程)
> 核对基线: 插件源码 **v0.6.7**(commit `b9eaf28`)+ 本机 Workbench CLI **v1.0.1**(commit `86c0aff`)
> 核对实例: `i-uf66ct2o35p7fjcd0sru` @ `cn-shanghai`(反馈里那台; 本次实测可取)
> 上一份同类文档: `workbench-ecs-改良计划-20260912.md`(v0.4.0 → v0.6.7)
> 日期: 2026-09-27
> 整理方式: 反馈每条建议都对回**代码与 CLI 实测**逐条核对, 分「真缺口 / 描述需修正 / 不可行(上游) / 已满足」四类,
> 再据此定方案与版本。**本文件不是复述反馈, 而是修正后的可执行计划。**
>
> **实施状态(2026-09-27 更新)**: 计划内的 P0/P1 项**全部落地**, 一次性发布为 **v0.8.0**
> (v0.7.0 与 v0.8.0 两批在同一工作会话内完成, 因此合并为一次提交与一个 tag; 版本号从 0.6.7 直接到 0.8.0)。
> - 回归: `unit` **104/104**、`smoke`(含动态挂载 body 一致性与完整性守卫、跑书模板守卫、**源文件编码守卫**)、
>   `ui-rpc` **26/26**(真机 CLI)、`e2e-local` **59/59**(真机 `i-uf66ct2o35p7fjcd0sru`)。
> - 本轮核对**新发现的真缺陷 D14** 已修: 远端命令超时(timed_out)此前被当成"成功 + 无输出"(见 §二 D14)。
> - 反馈 10 条清单: 9 条真缺口已交付, 1 条(持久分页 token)确认受 CLI 上游限制(见 §一 #3)。
> - 另有 2 条**核对新增**的缺口一并交付: 实例锚点字段进 runbook 隐式参数(§一 #2)、
>   `ecs_deploy` 老三阶段"上传失败仍会继续重启"的隐患(见 §四 R1)。
> - 收尾时又补掉 **D18**(目录上传: 本机归档失败会在工作区留下半个归档, 实测攒了 23 个)与
>   **D19**(`ensureLocalDir` 在"目录已存在"时的误判), 见 §二。

---

## 〇、结论先行

1. 反馈的 10 条清单里 **9 条是真缺口, 1 条受 CLI 上游限制**(`ecs_list` 分页 token 仍无法透出)。
2. 核对过程中**发现一个反馈没提到的真缺陷(D14, 比反馈任何一条都危险)**:
   CLI 侧命令超时(`timed_out: true`)时, JSON 里的 `exit_code` 是 **0**, 而插件以 JSON 的 `exit_code` 为准 ——
   于是**一次被掐断的命令在插件看来是"成功且无输出"**。反馈 §四.13 说"失败信息目前只说超时", 实际上连失败都没报。
3. 反馈里最痛的两条(实例定位、发布快照)都需要**新机制**, 但都可以做到"插件只给机制、内容留在项目仓库":
   - 实例定位: 新增 `ecs_find`(跨地域检索)+ `.dsh/workbench-ecs/instances.json` 实例锚点约定;
   - 发布快照: 新增 `ecs_snapshot create/list/diff`, 快照内容由**项目的 profile 数据**描述(默认含镜像/容器/关键文件)。
4. 反馈 §三 的两条(拒绝信息要有命中规则、审批禁用要说明原因)可以一次做完, 且**对全体工具一次性生效** ——
   因为护栏与审批闸门都收敛在 `lib/common.js` 的两个守卫函数里。

---

## 一、反馈清单逐条核对(修订版)

> 「版本」列里的条目**均已交付并回归**(合并发布为 v0.8.0); 唯一未交付的是 #3(受 CLI 上游限制)。

| # | 反馈条目 | 代码/CLI 事实 | 分类 | 方案 | 版本 |
|---|---|---|---|---|---|
| 1 | `ecs_find` / `ecs_list --region all` | CLI **没有** `region all`(实测 `invalid region "all"`); 也没有"列地域"子命令; profile 里**无法配置默认地域**(`config set` 只支持 language/log_level, 缺省恒为 `cn-hangzhou`) —— 这正是反馈"猜 4 个地域"的机制解释 | 真缺口 | **F1** 新增 `ecs_find`(跨地域, 内置 22 个公共地域 + 并发检索 + **不做命中即停**, 并回报 `regions_tried/ok/failed`); `ecs_list` 0 台时提示改用 `ecs_find` | v0.7.0 |
| 2 | `.dsh/workbench-ecs/instances.json` 实例锚点 | 无此机制; 仓库里也确实没有 instance_id 记录 | 真缺口 | **A1** 锚点文件 + 全工具 `instance_id` 可写锚点名(含 `region` 自动补齐, 锚点自定义字段成为 runbook 隐式参数) | v0.7.0 |
| 3 | `ecs_list` JSON 不含分页 token | **实测 v1.0.1 仍不含**(`--next-token` 只作输入, 输出无 `NextToken`/`TotalCount`) | 不可行(上游) | 保留现有 `pagination_note`; 细化文案(指向 `ecs_find` 与收紧过滤) | v0.7.0(文案) |
| 4 | 拒绝信息不含「命中哪条规则」 | `guardReadOnly` 只抛一句 `read_only=true 下检测到写操作模式 (<rule>)` —— 其实**有**规则名, 但**没有命中文本/位置**, 且只报第一条(反馈脚本里 4 个写动作只看到 1 条) | 描述需修正 + 真缺口 | **G1** 结构化拒绝信息: 逐条列出 `{rule, matched_text, span}`, 并给"只读等价写法"提示 | v0.7.0 |
| 5 | 审批禁用时破坏性命令的拒绝要写明原因 | 代码把一切非 `allowed-once` 都写成 `破坏性命令未获批准 (rejected)`。审批服务实际会区分 `allowed-once/rejected/cancelled/unavailable`, 且**策略为 `never` 时返回的是 `rejected`**(`dsh-user-approval/lib/index.js:188`) —— 与"用户真的点了拒绝"撞成同一句话 | 真缺口 | **G2** 四种情形分开报: 无审批服务 / **审批策略为 never(已禁用)** / 用户拒绝 / 取消; 并明确"这不是命令写错了, 重试无效" | v0.7.0 |
| 6 | `ecs_exec` 加"只读等价写法"提示 | 无 | 真缺口 | **G1**(同一条: 护栏拒绝时附只读替代写法) | v0.7.0 |
| 7 | runbook 参数缺"必填"语义 | `params` 只支持"默认值"一种形状, `required`/`pattern` 无处可写; 缺参数只在**执行期**由占位符未替换暴露 | 真缺口 | **P1** `params` 支持 `{required, pattern, enum, default, description, hint}` 描述符, `validate/plan` 在执行前拦住 | v0.8.0 |
| 8 | `$${NAME}` 转义易踩坑 | 转义本身工作正常; 缺的是"显式关闭替换"与 lint 的反向检查 | 真缺口(小) | **P2** step 级 `raw: true`(明确不替换); lint 补"只在 raw 步骤出现的占位符不计入声明"的口径说明 | v0.8.0 |
| 9 | `verify_sha256` 三处默认值不一致 | 实测: `ecs_upload`=false / `ecs_deploy` 老三阶段=true / `steps[].upload`=true —— 反馈描述**完全准确** | 真缺口 | **S1** 三处统一为 **true(默认校验)**, 关闭需显式 `verify_sha256: false`(lint 继续提醒) | v0.7.0 |
| 10 | 缺「发布前后状态差异」原语 | 无快照机制; 只能自己写 `docker tag` + `docker cp` + 采集脚本 | 真缺口 | **N1** `ecs_snapshot create/list/diff`(快照内容由项目 profile 描述, 插件只给机制) | v0.8.0 |
| 11 | 上传失败没有重试(本次真实踩到) | `ecs_upload` / `steps[].upload` 都是"一次失败即中止整条跑书"; 失败信息里 OSS 中继的归属未点明 | 真缺口 | **R1** 上传自动重试(默认 3 次, 指数退避, 可配 `retries`/`retry_delay`), 仅对**瞬时网络类**错误重试; 失败信息标注"本机 → OSS 中继" | v0.7.0 |
| 12 | `ecs_runbook` 加"重跑建议" + `from_step` | 无 | 真缺口 | **P3** validate/plan 输出附**幂等性分析 + 重跑建议**; `ecs_deploy { from_step }` 跳过已成功的前置步骤 | v0.8.0 |
| 13 | `detach` 与 `timeout` 缺指引; 超时只说超时 | 反馈**低估了**: 见 §二 D14 —— 超时根本没被当成失败。因此要先修 D14, 再补指引 | 真缺口(含新缺陷) | **D14 + T1** 超时按 124/`timed_out` 正确结算, 并直接给"改 detach / 提高 timeout / 用 ecs_log 续读"的下一步 | v0.7.0 |
| 14 | `ecs_diagnose` 加 `sections` / 不回显命令 | 7 段固定全采, 命令全文回显占了输出大头 | 真缺口(小) | **D1** `sections`(按需取段, 支持 `extra`) + `echo_command`(默认不回显全文) | v0.7.0 |
| 15 | `ecs_log` 多路径一次读(app.log + access.log) | 单路径; 多文件要多次工具调用 | 真缺口(低) | **L1** `paths: []` 一次读多文件(每个文件独立游标), 单次远程调用 | v0.7.0 |

> 反馈 §五「做得好的地方」6 条经核对**全部属实**, 本轮都保持不变式(尤其: 同实例锁、`script` 零转义、
> 纯数据 runbook、`ecs_log` 字节游标、`region` 可推断、`ecs_diagnose` 七段形态)。

---

## 二、核对新发现(反馈未覆盖)

### D14. 远端命令超时被当成「成功 + 无输出」 —— 真缺陷(本轮最高优先级)

实测(`workbench exec --command 'sleep 8; echo done' --timeout 3 --output json`):

```json
{ "exit_code": 0, "stdout": "", "output": "", "stderr": "", "timed_out": true, "duration": "3.002s" }
```

- CLI 的**进程退出码是 124**, 但它同时在 stdout 打了一份 `exit_code: 0` 的 JSON;
- 插件一律"以 JSON 的 `exit_code` 为准", 于是拿到 **0 = 成功**;
- 反馈 §四.13 以为"失败信息只说超时", 实际是**连失败都没有**: 一次被掐断的发布脚本会在编排里显示 `OK`。

**影响面**: `ecs_exec`(单/批量)、`ecs_diagnose`、`ecs_log`、`ecs_deploy`/steps 引擎(`decodeStageRun`)、
`ecs_upload` 的远端解包阶段、设置页 RPC 的 `execOnce`(它用进程退出码, 侥幸正确但没有把 `timed_out` 语义带出来)。

**修法**: 在 `common.js` 收敛一个"远端结果归一"函数(`remoteResultOf(data, processExitCode)`):
`timed_out === true` → `exit_code = 124` + `timed_out` 标记 + `duration`; 所有工具与 steps 引擎改用同一函数;
render 里对 `timed_out` 明确写"🔴 远端命令被 CLI 掐断(超时 Ns)", 并附 detach 指引。

### D15. `ecs_list` 的 JSON 形状有两种 —— 事实记录(代码已兼容)

实测: 有实例时 `{"instances": [...]}`; **无实例时是裸数组 `[]`**。现有代码两种都兼容(`Array.isArray(data)` 分支),
本计划只在此记录, 并为此补一条回归断言(避免后人"顺手简化"掉)。

### D16. 审批策略 `never` 与"用户拒绝"在插件侧不可区分 —— 真缺陷(见 §一 #5)

`dsh-user-approval` 的 `ApprovalService.decide()` 在 `effectivePolicy(session) === 'never'` 时直接返回 `'rejected'`;
服务同时暴露 `effectivePolicy(session)` / `overrideOf(session)`。插件只要读一次策略, 就能把
"审批已禁用"与"用户拒绝"分开报 —— 这正是反馈 §三.5 想要的。

### D18. 目录上传: 本机归档失败会在工作区留下半个归档 —— 真缺陷(收尾时发现)

`ecs_upload` 的目录模式先在本地 `tar -czf <归档>` 再上传。`tar` **失败时也会先建出输出文件**
(实测留下 29 字节的半个 `.tar.gz`), 而当时的清理逻辑(`try/catch` 里的 `removeLocalFile`)只覆盖
"上传/校验/解包"阶段 —— **归档失败发生在 try 之外**, 于是残留文件一直堆在工作区。
本仓库根目录实测攒了 **23 个** `.dsh-ecs-upload-*.tar.gz`(最早 09-12, 最新就是本次 e2e 跑出来的)。
虽然 `.gitignore` 挡住了它们不进提交, 但"跑一次留一个垃圾"显然是缺陷。
修法: 把归档步骤并入同一个 try/catch(清理范围覆盖整段), 并在 e2e 里加一条"归档失败后工作区**零残留**"的断言。

### D19. `ensureLocalDir` 在"目录已存在"时可能误判失败(收尾时发现, 仅影响无 fs 场景)

Windows 下 `cmd /c mkdir <已存在目录>` 返回非零, 而判定"已存在"依赖 fs 服务; 无 fs 时会把
"其实已存在"报成 `failed`。快照路径本身要求 fs(读写清单), 因此不影响功能; 已顺手把
cmd 的"已存在"输出识别为成功(以及 cmd 分支的路径分隔符归一, 见 §二 D14 之后的实现说明)。

### D17. `workbench upload` 的失败信息里已经有归属线索, 但插件没有用

实测两种失败:
- 瞬时网络: `upload failed: upload to OSS: put object: ... dial tcp 47.101.94.154:443: i/o timeout`(反馈原文);
- 远端已存在: `remote file "/tmp/x" already exists (7 B, modified ...); use --force to overwrite`。

二者都带可判定的特征串。因此**重试必须按特征区分**: 网络类重试, 语义类(已存在/无权限)立刻失败 ——
否则 `--force` 缺失时会把重试次数白白烧在必然失败的路径上。

---

## 三、方案设计

优先级口径: **P0 = 高频痛点且改动小**; P1 = 结构性能力; B = backlog(需上游)。

### G1 [P0 / v0.7.0] 护栏与审批的拒绝信息结构化(反馈 §三.4 / §三.6)

`common.js` 的 `checkWriteCommand` / `guardReadOnly` / `guardDestructiveCommand` 改为返回/抛出**结构化 + 人话**两层信息:

```
read_only=true 命中 3 条写操作模式, 已拒绝执行:
  ✘ [1] 文件增删改(rm/mv/cp/mkdir/rmdir/touch/ln/install/truncate)  命中 "mkdir"      位置 1
  ✘ [2] 输出重定向(非 /dev/null)                                   命中 "> /tmp/x/a" 位置 23
  ✘ [3] 下载落盘(curl -o / wget -O)                               命中 "curl -o"    位置 61
只读等价写法: (a) 不经文件的命令直接输出到 stdout;
  (b) 需要落盘才能分析的场景改用 read_only=false(写操作需显式声明);
  (c) 长任务改用 detach=true + ecs_log 按字节游标读取输出。
```

- 新增 `scanWriteCommands(text)` → `[{rule, matched_text, span:{start,end}}]`(全量, 不再只报第一条);
- 保留 `checkWriteCommand(text)` 作为"第一个规则名"的兼容壳(单测/面板仍在用);
- `guardReadOnly(text, label)` 抛出的错误含上面整段; 面板侧 precheck 复用同一实现;
- `guardDestructiveCommand` 的错误文案按四种情形分支(策略 never / 用户拒绝 / 取消 / 无审批服务或上下文),
  并且**只在确有审批服务时才去请求**; 任一分支都写明"重试无效, 应改写命令或让用户切回 ask 策略"。

### G2 [P0 / v0.7.0] 审批策略感知(反馈 §三.5)

`guardDestructiveCommand` 读 `approval.effectivePolicy(exec.agent.session)`, 在拒绝信息里带
`审批策略: never(本会话已禁用审批)`; 请求前若策略已是 `never`, **直接拒绝、不发请求**(省一次无意义的审批日志)。

### T1 / D14 [P0 / v0.7.0] 超时结算与 detach 指引(反馈 §四.13 + 新缺陷 D14)

- `remoteResultOf()` 统一归一(C 见 §二 D14); `ecs_exec`/`ecs_diagnose`/`ecs_log`/steps 引擎/`ecs_upload` 全部改用它;
- 结果里新增 `timed_out` / `duration`;
- render 与 `error` 文案在超时时附:
  `本步骤跑了 Ns 被 CLI 掐断; 若确实需要更久, 用 detach=true(远端 nohup + ecs_log 续读)或提高 timeout(当前 Ns)`。

### R1 [P0 / v0.7.0] 上传自动重试 + 失败归属(反馈 §四.11)

- `ecs_upload` 与 `steps[].upload` 新增 `retries`(默认 3, 即最多 3 次尝试)与 `retry_delay`(默认 1s, 指数退避);
- 只对**瞬时特征**重试: `i/o timeout` / `dial tcp` / `connection reset|refused` / `TLS handshake` /
  `operation error` / `context deadline exceeded` / `EOF` / `network is unreachable` / `temporary failure`;
- 语义类错误(`already exists` / 权限 / 参数)立刻失败, 不烧重试;
- 最终失败时明确: `已重试 N 次仍失败` + `这是本机 → OSS 中继(upload/download 必走的中转)的网络问题,
  不是目标 ECS 实例的问题; 可先在别的网络下重跑同一条跑书`;
- 结果字段新增 `attempts` / `retry_errors`(每次失败的摘要)。

### S1 [P0 / v0.7.0] `verify_sha256` 三处默认统一为 true(反馈 §四.9)

- `ecs_upload`: `args.verify_sha256 !== false`(此前 `=== true`);
- 老三阶段 `ecs_deploy` 与 `steps[].upload` 保持 true(不变);
- 文档/schema 一律写"默认 true; 显式 `verify_sha256: false` 才关闭(会在 lint 里被提醒)";
- 目录模式语义不变(不一致则**中止解包**, 坏包不落地)。

### F1 [P0 / v0.7.0] `ecs_find`: 跨地域实例检索(反馈 §二.1 / §二.3)

- 新工具 `ecs_find`, 参数: `name?`/`keyword?`(子串, 大小写不敏感, 匹配 实例名/ID/IP/tag)、`region?`
  (单个地域 | `all`(默认) | 逗号分隔多个)、`status?`、`concurrency?`(默认 4)、`limit?`;
- 内置**地域清单**(`lib/regions.js`, 中国区 + 国际公共地域, 可被 `region` 参数收窄), 逐地域 `list ecs --output json`,
  命中即回报; 返回按地域分组的命中 + `regions_tried` + `regions_failed`(某地域查询失败不影响其它地域);
- 输出同时带 `anchors`(工作区 `instances.json` 里的锚点, 有则列出)——"我要的机器在哪"一条查询答完;
- `ecs_list` 返回 0 台时, 追加提示: `该地域没有实例; 用 ecs_find { keyword } 跨地域查找(或检查地域拼写)`;
- 分页: 每地域仍受 CLI `limit`(≤100)限制; 顶到上限时沿用 `pagination_note` 文案(CLI 不透出 token, 已核实)。

### A1 [P0 / v0.7.0] 实例锚点 `.dsh/workbench-ecs/instances.json`(反馈 §二.2)

文件格式(由插件定义, 由项目填内容):

```json
{
  "prod":   { "instance_id": "i-uf66ct2o35p7fjcd0sru", "region": "cn-shanghai", "repo": "/root/nailonghub" },
  "staging":{ "instance_id": "i-xxxx",                 "region": "cn-hangzhou",  "note": "预发" }
}
```

- **所有**接受 `instance_id` 的工具(以及 `instance_ids` 批量、`ecs_deploy`/`ecs_runbook` 的 `instance_id`)
  都接受**锚点名**: 在 `lib/index.js` 的工具注册包装层统一解析(单点实现, 各工具零改动);
- 解析规则: 值不匹配 `i-*` 形状 + 工作区存在 `instances.json` + 名字命中 → 替换为 `instance_id`;
  `region` 未显式给出时用锚点的 `region` 补齐; 名字**不命中**时报错并列出可用锚点(而不是把错名字丢给 CLI);
- 锚点里除 `instance_id`/`region` 之外的字段(如 `repo`)**成为 runbook 的隐式参数**:
  `implicit(instance_id, region, ...锚点字段) < params 默认值 < 调用方`(优先级不变);
- 无锚点文件时行为与今天完全一致(向后兼容); 锚点解析失败(文件坏了)只降级为"按原值下发", 不阻断工具;
- 随包提供 `templates/instances.json` 模板, README 说明约定。

### D1 [P1 / v0.7.0] `ecs_diagnose` 的 `sections` 与 `echo_command`(反馈 §五.1)

- `sections`: 数组, 取 `host/os/load/mem/disk/services/processes/ports/extra` 子集(缺省=全部);
  非法段名报错并列出合法值; `extra_command` 保留;
- `echo_command`: 默认 **false**(不再全文回显 7 段脚本); 结果为 `true` 时保留全文;
  无论哪种, 都回显 `extra_command` 与 `command_line`(审计需要), 且片段标题已在输出里;
- 只读护栏仍对**实际下发**的拼接脚本生效(不能靠 `sections` 绕过)。

### L1 [P1 / v0.7.0] `ecs_log` 多路径(反馈 §六.10)

- 新增 `paths: [...]`(与 `path` 二选一); `after` 支持数字(所有文件同一游标)或对象(`{"/a.log": 12}`);
- 实现: 单次远程调用内按文件分段(每段前打 `__DSH_ECS_FILE__<i> <path>` 标记), 逐段复用现有
  `buildLogReadCommand`/`parseLogRead` 语义 —— 不新增解析器, 字节游标语义逐字不变;
- 返回 `files: [{path, text, next_offset, total_bytes, truncate, exit_code}]`; 单文件时保持既有扁平字段(兼容)。

### P1 [P1 / v0.8.0] runbook 参数契约(反馈 §四.7)

`params` 兼容两种写法(向后兼容: 标量 = 默认值):

```json
"params": {
  "sha":   { "required": true, "pattern": "^[0-9a-f]{7,40}$", "hint": "git rev-parse --short HEAD" },
  "env":   { "default": "prod", "enum": ["prod", "staging"] },
  "delay": 5
}
```

- 校验时机: `ecs_runbook validate/plan`(**下发任何命令之前**)与面板「校验」按钮; 判据:
  `required` 且缺 → error; `pattern`/`enum` 不匹配 → error(报出实际值); 描述符字段未知 → warn(疑似笔误);
- 运行时同一套校验(与 v0.6.3 的做法一致: lint 与执行期共用实现, 文案逐字一致);
- 隐式参数(instance_id/region/锚点字段)同样受 `pattern` 约束。

### P2 [P1 / v0.8.0] step `raw: true`(反馈 §四.8)

- `raw: true` 的步骤**不做占位符替换**(比 `$${NAME}` 直观), 其内部的 `${...}` 不计入"已声明参数";
- lint 白名单加 `raw`; `summarizeRunbook` 的占位符统计口径同步;
- 保留 `$${NAME}` 转义(已有跑书不受影响)。

### P3 [P1 / v0.8.0] 重跑建议与 `from_step`(反馈 §四.12)

- `ecs_runbook validate/plan` 与 `ecs_deploy` 的 dry_run 输出新增 `replay` 段:
  逐步判定 `idempotent: true|false|unknown`(upload=幂等(force+校验)、tail/只读 exec/assert=幂等、
  其它写命令=unknown)并给一句结论: **"本跑书的第 1..k 步是幂等的, 失败后可直接重跑整条跑书"**;
- `ecs_deploy { from_step: N }`: 跳过 `index < N` 的步骤(索引用计划里显示的 `[i]`, 0 起),
  预演/结果里显式列出 `skipped_prefix: [0,1,...]`, 并在有跳过时提醒"跳过步骤的前置效果不会被重建";
- 与 `continue_on_error` 正交; 与 `dry_run` 同用时预演也标注跳过段。

### N1 [P1 / v0.8.0] `ecs_snapshot create/list/diff`(反馈 §四.10)

机制在插件, 内容在项目:

- 存储: 快照清单落在**工作区** `.dsh/workbench-ecs/snapshots/<name>.json`(可 diff、可提交、可 grep;
  `list` 因此零远程调用), 采集内容来自实例;
- `create { instance_id, name, profile?, paths?, commands?, note? }`:
  - 默认采集(**通用、只读**): 主机(uname/hostname/uptime)、磁盘 `df -h`、监听端口 `ss -tlnp`、
    容器清单 `docker ps`、镜像清单 `docker images --digests`(docker 缺失时记为 `unavailable`, 不失败);
  - `paths`: 逐个文件/目录采集 `sha256 + size + mtime`(缺失记为 `absent`);
  - `commands`: `{label: cmd}` 自定义采集器, 记 `exit_code + 输出 sha256 + 行数 + 前若干行`;
  - `profile`: 从工作区 `.dsh/workbench-ecs/snapshot-profiles.json` 读具名 profile(`{paths, commands}`),
    项目自留内容; 命中不到的 profile 报错并列出可用名字;
  - 全部采集在**一次远程脚本**内完成(单次实例锁, 一条 CLI 调用), 落盘后写清单;
- `list`: 列出工作区快照(名字/时间/目标实例/采集器摘要);
- `diff { name, instance_id?, with? }`: 按**清单里记录的采集器**重采一次并逐项对比, 输出
  `files: added/removed/changed`(含 sha256 前后)、`commands: changed/unchanged`(含首处差异行)、
  容器/镜像的增删改; `changed_count` 与 `clean: true|false` 便于断言;
- 边界: 快照只读采集, 不改远端; 快照文件写在工作区(不写远端), 因此不需要远端保留策略。

---

## 四、版本排期

| 版本 | 主题 | 内容 | 判据 |
|---|---|---|---|
| **v0.7.0 + v0.8.0 ✅ 已交付(合并发布)** | 定位 · 护栏 · 上传 / 跑书参数契约 · 发布快照 | **D14**+**T1** 超时结算与 detach 指引 / **G1** 结构化拒绝信息 / **G2** 审批策略感知 / **R1** 上传重试+归属 / **S1** verify 默认统一 / **F1** `ecs_find` / **A1** 实例锚点 / **D1** diagnose sections+echo / **L1** log 多路径 / **P1** 参数契约 / **P2** `raw: true` / **P3** 重跑建议+`from_step` / **N1** `ecs_snapshot` | 已达成: unit 104/104(含护栏四情形/D14/重试语义/锚点/参数契约/from_step/快照 diff)、smoke(11 工具 + body 一致性与完整性守卫 + v0.7/v0.8 不变量守卫)、ui-rpc 26/26(真机, 含面板侧超时结算)、e2e 59/59(真机, 含 ecs_find 跨地域命中、锚点跑通 runbook、超时 124、快照 create→改动→diff 检出 changed/removed) |
| backlog | 上游 | `list ecs` 的 `NextToken`/`TotalCount` 透出(已确认 v1.0.1 仍缺)→ 自动翻页; 直连传输 | 需 Workbench CLI 侧支持 |

### 实施期的两个额外发现(已记入代码注释与本节)

1. **`ecs_deploy` 老三阶段的"上传失败仍会继续"**: 上传阶段失败时, 若本机没有哈希工具,
   `verify` 分支会走"跳过校验(ok:true)"分支, 于是**重启照样执行** —— 拿旧文件去重启。
   本轮把它收紧为"上传失败即中止"(与 steps 编排的 abort 语义一致)。
2. **`workbench upload` 失败时 stdout 仍打印 "Upload complete"**: 真正的错误只在 stderr 的
   `{code,message}` 里。此前只看 stdout 会把失败读成成功(exit_code 1 但 message 写着"完成"),
   重试判定也会失效。现已按"退出码 + stderr CLI 错误 + stdout 文本"三者合成 failure_text。

---

## 五、验收清单(交付前全跑)

**A. 回归基线(必须保持全绿)**
1. `npm test` = `unit.mjs` + `smoke.mjs`(含动态 body 一致性与完整性守卫、跑书模板守卫);
2. `npm run test:ui`(`ui-rpc.mjs`, 真 CLI + 内存 ctx);
3. `npm run test:e2e`(`e2e-local.mjs`, 真机 `i-uf66ct2o35p7fjcd0sru`);
4. 现有全部断言不得放宽; 每条新行为都要有正例 + 反例(误杀/漏杀两侧)。

**B. 本轮新增回归**
5. **D14/T1**: 真机 `sleep 8` + `timeout 3` → `exit_code: 124`、`timed_out: true`、`ok: false`, 且文案含 detach 指引(反例: 正常命令 `timed_out` 为空、exit 0 仍为成功);
6. **G1**: 反馈原文那种"一个脚本里 4 个写动作"必须**逐条列出**(规则名 + 命中文本 + 位置); 只读命令 20 例零误杀(既有断言保持);
7. **G2**: 无审批服务 / 策略 `never` / 用户拒绝 / 取消 四种情形文案各不相同, 且 never 情形**不发起审批请求**;
8. **R1**: 单元里注入"第 1 次失败、第 2 次成功"的 adapter → 断言 `attempts: 2` 且最终成功; 注入 `already exists` → 断言**不重试**、`attempts: 1`; 断言失败文案含 OSS 中继归属;
9. **S1**: 三个入口的默认值断言(不传 `verify_sha256` 时均执行校验); 显式 false 时不校验;
10. **F1/A1**: `ecs_find { keyword }` 真机命中 `i-uf66ct2o35p7fjcd0sru` 且带 `regions_tried`; 锚点文件存在时 `instance_id: "prod"` 全链路解析(含 region 补齐与 runbook 隐式参数); 锚点不存在时报错列出可用名字;
11. **D1/L1**: `sections` 子集只采选定段(真机核对输出里不含未选段标题); `echo_command` 默认短、true 时长; `paths` 多文件各自 `next_offset` 正确续读;
12. **P1/P2/P3**: 参数契约的缺参/不匹配在 validate 阶段就拦住(执行期同一文案); `raw: true` 步骤的 `${X}` 原样下发; `from_step` 只执行剩余步骤且跳过段显式可见;
13. **N1**: 真机 `create` → 改动远端(写一个文件/改一个标记)→ `diff` 检出 `changed`; 未改动时 `clean: true`; `list` 零远程调用; profile 命中不到时报错;
14. **lossless**: 所有新分支的 value / presentationMeta / presentCall 均过 `isJsonValue`。

> **验收结果(2026-09-27)**: `unit` 104/104、`smoke` 全绿、`ui-rpc` 26/26、`e2e-local` 59/59。
> 新增回归共 **38 项 unit + 12 项 e2e + 1 项 ui-rpc**, 覆盖上面第 5–14 条的全部正例与反例。
> 其中 3 条是**真机核对才发现的偏差**, 已按实际行为修正实现而不是放宽断言:
> ① `diff` 把"基线是文件、现在不存在"报成"类型变化"(应报 removed);
> ② 默认采集器带 `uptime` 导致每次 diff 都"有变化"(噪声淹掉真变化, 已改为稳定采集项);
> ③ Windows 下 `cmd /c mkdir` 不接受混用分隔符的路径(快照目录建不出来, 已归一为 `\`)。

---

## 六、需决策 / 需上游确认

1. **地域清单的来源**: 插件内置静态清单(中国区 8 + 国际 15 左右)。若账号有未列出的地域, 用户可用
   `ecs_find { region: "a,b,c" }` 显式收窄 —— 无需 CLI 支持。
2. **`list ecs` 的 `NextToken`/`TotalCount`**(v1.0.1 实测仍缺): 仍建议作为 CLI 上游需求;
   插件侧在"顶到 limit"时给提示, 但无法自动翻页。
3. **`from_step` 的语义**: 本计划定为"计划里显示的索引(0 起)", 与 `stages[].index` 一致;
   ✅ **已按此实现**(预演与结果都会显式列出 `skipped_prefix`, 越界直接报错)。
4. **快照存储位置**: 本计划定为**工作区**(可 diff/可提交/可 grep), 不含远端清理策略;
   ✅ **已按此实现**(`.dsh/workbench-ecs/snapshots/<name>.json`, `list` 零远程调用);
   若希望快照同时留在实例上(`/root/.dsh-ecs-snapshots/`), 需要再定保留策略。

---

## 七、发版记录(2026-09-27)

| 版本 | commit | npm | 说明 |
|---|---|---|---|
| v0.8.0 | `c485efc`(+ `110c31a` 文档回填) | ✅ **0.8.0(latest)** | v0.7.0 + v0.8.0 两批同期完成, **合并为一次提交与一个 tag**(轻量 tag, 与 v0.6.x 一致); 版本号 0.6.7 → 0.8.0 |

**发布方式与结果(2026-09-27)**:
- npm 由本机 `npm publish` 完成(`npm whoami` = `nishuoyang`); 已回包核对发布物: 32 个文件,
  含 `lib/tools/ecs-find.js`、`lib/tools/ecs-snapshot.js`、`lib/snapshots.js`、`lib/regions.js`、
  `lib/anchors.js`、`templates/instances.json`、`lib/client.js` 与两份 README, 版本号 0.8.0。
- **GitHub 推送未完成**: 本次网络无法完成 `git push`, 逐项排查结论(供下次一步到位):
  1. **仓库配了代理但代理没在跑**: `git config http.proxy = http://127.0.0.1:7897`, 而本机 7897/7890/10809/1080/8080
     均无监听 —— 这是"`git push` 报 Failed to connect"的直接原因。启动代理客户端后 `git push` 即可。
  2. 绕过代理直连: `github.com:443` 的 TCP 三次握手能通(`Test-NetConnection` 连续 3 次 True), 但 git 的 HTTPS
     被 **Connection was reset** —— 典型的 SNI 阻断, 客户端侧无解; 本机无 HTTP(S)_PROXY 环境变量。
  3. SSH 通道: `ssh.github.com:443` 可达, 但本机 `~/.ssh/id_rsa` 在 GitHub 侧**未授权**
     (`Permission denied (publickey)`) —— 需要先把公钥加到 GitHub 账号。
  因此 `main` 的 3 个提交与 tag `v0.8.0` **仍只在本地**, CI(Test/Publish)未触发; 恢复代理后补推:

```bash
git push origin main
git push origin v0.8.0        # 注意: 单次推送 tag 不超过 3 个, 否则 GitHub 不触发 workflow
```
  (CI 的 Publish 步骤是幂等的: `npm view dsh-workbench-ecs@<ver>` 已存在则跳过 —— 所以 npm 已发布这件事
  不会让流水线变红。)
- 历史遗留的 `backfill` dist-tag(`0.6.2`)本 Token 无 dist-tag 权限(403), 需在 npm 网页端删除。

**开发期踩坑(务必记牢): 不要用 PowerShell 5.1 的 `Get-Content`/`Set-Content` 改本仓库的源码文件。**
本机 `pwsh` 实际是 Windows PowerShell 5.1: 它把无 BOM 的 UTF-8 文件按 ANSI(GBK) 读入, 再写回时
多字节序列的尾部字节被替换成 `?` —— 本次由此**真实损坏**了 `lib/common.js` 与 `package.json`
(共 600+ 处字节丢失, 不可逆)。已从 git 恢复并重新施加改动。
**改文件一律用 read/edit/write 工具; pwsh 只用来跑测试与 git 等只读/可控命令。**

---

*本文件位于插件仓库 `docs/`, 随代码演进维护; 反馈原文保留在 `E:\AiProject\nailong\docs\`。*
