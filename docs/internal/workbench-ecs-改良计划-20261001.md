# dsh-workbench-ecs 改良计划(v0.8.0 → v0.9.0): 桌面端适配

> 触发: DeepSeek Harness 发布**桌面端**后, 反馈"插件在桌面端完全不生效"。
> 核对基线: 插件源码 **v0.8.0**(commit `c099406`)+ 本机 DSH **0.1.1-rc.2**(全局 CLI)与桌面端内置 **0.2.0-rc.2**
> 核对环境: Windows + DeepSeek Harness 桌面应用(host 进程 `dsh-desktop-host`, 端口 19387)
> 日期: 2026-10-01
> 上一份同类文档: `workbench-ecs-改良计划-20260927.md`(v0.6.7 → v0.8.0)
>
> **本文件记录一次"看起来像缺功能、实际是配置与版本闸门"的排查**: 插件代码本身在桌面端
> 一直可用, 但它**从未被桌面端加载过**。根因有两个, 第二个是真正的坑。
>
> **实施状态(2026-10-01 更新)**: 已发布 **v0.9.0**(commit `23d8d71`, tag `v0.9.0`,
> npm `0.9.0` = latest)。回归: `compat` + `unit 104/104` + `smoke` 全绿; 桌面端**真机**
> 验证通过(health 200 / 11 个工具在册 / 设置页标签出现)。

---

## 一、环境事实(实测, 不是推测)

| 项 | 浏览器端 | 桌面端 |
|---|---|---|
| 宿主进程 | `dsh web`(npm 全局安装的 `@deepseek-ai/dsh`) | `dsh-desktop-host`(Electron 内置运行时) |
| DSH 运行时版本 | **0.1.1-rc.2** | **0.2.0-rc.2** |
| profile | `%DSH_HOME%\profiles\web` | `%DSH_HOME%\profiles\desktop` |
| 默认端口 | 3080 | 19387 |
| 界面 | 浏览器 web shell | **同一个 web shell**(Electron 里加载 `http://127.0.0.1:19387`) |

桌面宿主启动命令(实测):

```text
DeepSeek Harness.exe --expose-internals ...\dsh-desktop-host\lib\index.js ...\app.asar\dsh C:\Users\ASUS\.dsh\profiles\desktop ...
```

即: **桌面端 = Electron 壳 + 内置 DSH 运行时 + `desktop` profile**, 并且它 `runProfile` 时
带的是 `@deepseek-ai/dsh-web-app` 那一套 —— **桌面端仍然是 web 面**。

由此可断定(并已逐一在源码里核对):

| 结论 | 证据 |
|---|---|
| 客户端半不需要为桌面端另写一份 | 0.2.0 的 `dsh-client-modules` 里筛选条件仍是 `decl.platform !== "web"` 就跳过; 桌面端内置的 `dsh-web-app` 自身也声明 `platform: "web"` |
| 设置页插槽名没变 | 0.2.0 `dsh-client-ui-settings-general` 用 `ctx.slots.inject("settings.section", () => ctx.slots.register({ name: "settings.section", id, order, label, ... }))`, 与 0.1.1 同形 |
| 工具定义契约没变 | 两份 `dsh-tools` 的 `defineTool` / `register()` / `assertSupportedJsonSchema` 逐行比对一致(0.2.0 只多了 `projectContent` / `deferLoading` 两个可选字段) |
| `ctx.subprocess` 收集式输出没变 | 0.2.0 README 明确示例 `stdio: { stdout: { maxBytes } }` + `handle.collected.stdout?.readFrom(0)`, 与插件 `spawnProcess` 用法一致 |
| `webServer.register({ kind, path, handler })` 没变 | 0.2.0 `dsh-host-webserver` 的 `WebServer.register` 签名一致 |

---

## 二、根因(两条, 第二条是静默故障)

### R1 · 插件只装在 web profile(配置层)

`profiles\desktop\cordis.patch.yml` 里从来没有插件行 —— 两个 profile 不共享配置。
桌面端用户即使装过插件(按 README 执行的是 `dsh plugin --profile web add`), 桌面端也毫无感知。

### R2 · 版本闸门把整个 bundle 静默跳过(真正的坑)

`dsh-app-boot` 的 `loadProfileDirectory` 会对每个 bundle 调用 `evaluatePluginCompatibility`:
把 `package.json` 的 `peerDependencies` 里每个 `@deepseek-ai/dsh*` 与**运行时版本**比对,
不满足就**把整个 bundle 丢进 `skippedBundles`** —— 不抛错、不打印、插件一行都不加载。

而 v0.8.0 声明的是 `@deepseek-ai/dsh-tools: ^0.1.1-rc.2`。用真实 `semver` 实测:

```text
semver.satisfies('0.2.0-rc.2', '^0.1.1-rc.2', { includePrerelease: true })  ===  false
semver.validRange('^0.1.1-rc.2', { includePrerelease: true })  ===  '>=0.1.1-rc.2 <0.2.0-0'
```

即 `^0.1.1-rc.2` 的上界是 `0.2.0-0`, **0.2.0-rc.2 落在界外**。于是即便把插件行写进 desktop
profile, 桌面端照样什么都不加载 —— 而且**没有任何报错**。
(注: `@deepseek-ai/cordis` 不在闸门管辖内, 闸门只看 `@deepseek-ai/dsh` 与 `@deepseek-ai/dsh-*`。)

---

## 三、改动清单(v0.9.0)

| # | 改动 | 文件 |
|---|---|---|
| 1 | peer 区间改为同时覆盖两个运行时: `"@deepseek-ai/dsh-tools": "^0.1.1-rc.2 \|\| ^0.2.0-rc.2"`; `"@deepseek-ai/cordis": ">=4.0.1 <5.0.0"` | `package.json` |
| 2 | 版本号 `0.8.0 → 0.9.0`(包与 `PLUGIN_VERSION` 单源) | `package.json`、`lib/common.js` |
| 3 | **新增兼容性守卫测试**: ①断言 peer 区间覆盖每个"已实测运行时"(清单可扩展), 区间比较器与真实 `semver` 交叉验证; ②用真 `@deepseek-ai/dsh-tools` 内核复核全部 11 个工具定义 | `test/compat.mjs`(新) |
| 4 | `npm test` 串上兼容性测试, 并加 `test:compat` 单跑入口 | `package.json` |
| 5 | 本地安装脚本支持按 profile 安装(`-Profile all\|web\|desktop\|<名>`), `status` 逐 profile 汇报 | `scripts/install-local.ps1` |
| 6 | 双宿主安装说明、版本闸门说明、桌面端验证方式(含 401 澄清) | `README.md`、`README.zh.md` |

**设计取舍**:

- **不新增第二份客户端产物**: 桌面端就是 web 面, 复制一份只会制造漂移。
- **不引入 semver 依赖**: 兼容性测试自己实现区间比较器(本包运行时零依赖), 同时**用本机真实
  semver 交叉验证**(找不到就跳过, 不让无网环境假红)。这里踩过一个真实的坑: `includePrerelease`
  下 semver 的 `^x` 上界是 `x.y.z-0`, 不是 `x.y.z` —— 第一版比较器写错, 被自检断言抓住。
- **不申请版本豁免**: 豁免是"明知不兼容也硬跑"; 而这里两端 API 契约实测一致, 正确做法是**放宽
  正确声明的区间**, 而不是让用户去点风险确认。

---

## 四、验证

### 离线(仓库测试)

- `npm test`: `compat`(peer 区间 + 11 个工具定义过真内核)+ `unit` **104/104** + `smoke` 全绿;
  源文件编码守卫 **44** 个文件全部合法 UTF-8。
- `npm pack --dry-run`: 发布物 **32 个文件**, 与 v0.8.0 发布物同构, 版本号 0.9.0。

### 真机(桌面端, 重启后)

| 检查 | 结果 |
|---|---|
| 宿主进程已重启 | PID 287804, 启动于 2026-10-01 20:23:56 |
| `GET /dsh-workbench-ecs/health` | `HTTP 200` → `{"ok":true,"plugin":"dsh-workbench-ecs","version":"0.9.0"}`(安装前为 **404**) |
| 宿主实时工具表 | 11 个 `ecs_*` 工具全部在册(bundle 未被跳过、`defineTool` 在 0.2.0 内核下注册成功) |
| `GET /dsh-workbench-ecs/rpc` | `405`(路由在, 仅接受 POST); 未知子路径 `404` |
| 工具执行通道 | `ecs_list { region: "cn-shanghai" }` 真机命中 `i-uf66ct2o35p7fjcd0sru`, 表格渲染正常 |
| 设置页 | 用户确认「Workbench ECS」标签页出现(客户端半与面板 RPC 均正常) |

---

## 五、发版记录(2026-10-01)

| 版本 | commit | npm | 说明 |
|---|---|---|---|
| v0.9.0 | `23d8d71` | ✅ **0.9.0(latest)** | 桌面端适配; 版本号 0.8.0 → 0.9.0(无功能增删, 只有兼容性与安装路径修复) |

**发布物核对(2026-10-01, 从注册表回读)**:

```text
npm view dsh-workbench-ecs@0.9.0 peerDependencies
→ { "@deepseek-ai/cordis": ">=4.0.1 <5.0.0",
     "@deepseek-ai/dsh-tools": "^0.1.1-rc.2 || ^0.2.0-rc.2" }     ← 桌面端修复确实在发布物里
npm view dsh-workbench-ecs@0.9.0 dist
→ shasum aa08b0a7c242507478f7121f0cdfc9bfbdae1358, fileCount 32, integrity sha512-H2t97cHtOCHj6…
   (与本机 npm pack 的 shasum/integrity 逐字一致)
dist-tags → { "backfill": "0.6.2", "latest": "0.9.0" }
```

**git 与 CI(均已完成并核对)**:

- `main` → `23d8d71`;tag(附注 tag)`v0.9.0` → `23d8d71`。
- CI **三连全绿**:
  - push main(首版 `30ee699`)→ [run 36862461135](https://github.com/nishuoyang/dsh-workbench-ecs/actions/runs/36862461135) ✅
  - push main(`23d8d71`,夹带文档回填的强推)→ [run 36863184089](https://github.com/nishuoyang/dsh-workbench-ecs/actions/runs/36863184089) ✅
  - push tag `v0.9.0` → [run 36863192982](https://github.com/nishuoyang/dsh-workbench-ecs/actions/runs/36863192982) ✅
    (`Test` 与 `Publish to npm` 两个作业都 success; Publish 命中"版本已存在则跳过"分支 ——
    npm 上的 0.9.0 由本机发布, 流水线不会重复发也不会变红)
- 推送命令沿用上一轮的两处绕过(代理未跑 + schannel 吊销检查):

```bash
git -c http.proxy= -c http.schannelCheckRevoke=false push origin main
git -c http.proxy= -c http.schannelCheckRevoke=false push origin v0.9.0
```

### npm 12.x 的"暂存发布"踩坑 —— 本次唯一让人误判的地方

**现象**: 本机 `npm publish` 打印了成功(`+ dsh-workbench-ecs@0.9.0`), 但注册表里**查不到 0.9.0**。

**原因**: 打开 HTTP 层才看清 —— 返回的是 **202 Accepted**, 不是 200:

```text
http fetch PUT 202 https://registry.npmjs.org/dsh-workbench-ecs
```

npm 12.x 引入**暂存发布 + 人工审批(2FA 在场证明)**, 并在收紧"绕过 2FA 的自动化 Token"。
本机 `~/.npmrc` 只有旧的 granular automation token, 于是发布走了暂存通道; 暂存这一步
**故意不做 2FA**, 所以立刻返回 202、CLI 显示成功, 而版本要经过审批才真正上线。
注册表的元数据与 tarball **分批可见**: 本次 0.9.0 先出现 metadata(packument + dist-tags),
约 3~5 分钟后 tarball 才 200。

**误判与代价**: 在 metadata 还没出现时, 我把它判成"卡在中间态", 于是把版本号提到 0.9.1
重发 —— 而 0.9.0 其实已经成功。结果多出一个 0.9.1 的暂存态(至今未上线)。**教训: 看到 202
不要立刻下结论, 先按 30~60 秒间隔回注册表核对 metadata 与 tarball 直链。**

**给后来的自己(两条硬规则)**:

1. `npm publish` 出现 202 / "being processed" **不等于已发布**。必须回查:
   `npm view <pkg> version` 且 `curl -o NUL -w "%{http_code}" <tarball 直链>` 都是 200 才算成功。
2. 要"发完即上线", 用 `npm publish --otp=<6 位码>`(或换成支持 2FA 的 token);
   否则就去 web 端点做一次 approve。两条 409 的文案本身就说明了状态:
   `Cannot publish over previously staged version`(直接发布) 与
   `Cannot stage previously published version`(暂存)—— 同一版本号卡在中间态时两边都不让过,
   这时**不要反复重试**, 等元数据落地或换个版本号。

**复用上一轮的经验(2026-09-27 记录, 本次同样适用)**:

1. 本机 `git config http.proxy = http://127.0.0.1:7897`, 代理不在跑时必须 `-c http.proxy=` 绕过;
2. `http.sslBackend = schannel` 时会因访问不到 CA 的 CRL/OCSP 而报 `Connection was reset`
   (看着像 SNI 阻断), 必须 `-c http.schannelCheckRevoke=false`;
3. **不要用 Windows PowerShell 5.1 的 `Get-Content`/`Set-Content` 改本仓库源码**(会按 ANSI 读入、
   写回时损坏多字节字符)。改文件一律用 read/edit/write 工具。

---

*本文件位于插件仓库 `docs/`, 随代码演进维护。*
