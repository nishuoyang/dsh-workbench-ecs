# 开发与发布

> 中文 | [English](../en/development.md) · 返回 [README](../../README.md)

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
- CI: [GitHub Actions](../../.github/workflows/ci.yml) —— push/PR 跑测试, `v*` tag 自动发布 npm
- 发版前请读下面的「发布流程(踩过的坑)」
- 类型声明: [`lib/types/index.d.ts`](../../lib/types/index.d.ts)
- 一键配置脚本: [`scripts/workbench-setup.ps1`](../../scripts/workbench-setup.ps1)

### 发布流程(踩过的坑)

1. **CI 发布需要 `NPM_TOKEN` secret**(Settings → Secrets and variables → Actions;值用 npm Automation token)。
   未配置时工作流会打一条 warning 并**优雅跳过**发布(tag 仍然有效), 不会让流水线变红;
   此时可本机 `npm login` 后直接 `npm publish`(两条路径产出的包一致)。
2. **一次推送不超过 3 个 tag**:GitHub 对"单次推送超过 3 个 tag"的 push **完全不触发** workflow
   (既不报错也不排队) —— 补推历史 tag 时要分批, 每次 ≤3 个。
3. **回填老版本别把 `latest` 拽回去**:补发历史版本用 `npm publish --tag backfill`,
   否则 `latest` 会被指到刚发布的旧版本上(清理该临时 tag 用 `npm dist-tag rm dsh-workbench-ecs backfill`)。
