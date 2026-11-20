# 使用指南：设置面板、工作原理、实例锚点、典型用法

> 中文 | [English](../en/usage-guide.md) · 返回 [README](../../README.md)

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

随包提供模板 [`templates/instances.json`](../../templates/instances.json)(连同 `templates/runbooks/` 一起拷进项目即可用):

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
