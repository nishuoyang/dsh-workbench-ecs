# Development & release

> [中文](../zh/development.md) | English · Back to [README.en.md](../../README.en.md)

## Development

```bash
npm install          # install devDependencies (@deepseek-ai/dsh-tools)
npm test             # unit regressions (no instance needed) + smoke test: module exports + 11-tool contract + body consistency
npm run test:unit    # unit regressions only: base64 / read-only guard / timeout defaults / output cleanup / sha256
npm run test:e2e     # real-CLI end-to-end test (needs local Workbench CLI, valid credentials, a reachable instance)
npm run build:body   # generate the dynamic-mount body (same origin as lib/)
```

- Source layout: `lib/common.js` (shared) · `lib/steps-engine.js` (orchestration engine shared by tools and panel) · `lib/runbooks.js` (runbook mechanism + static checks) · `lib/snapshots.js` (release-snapshot mechanism, v0.8.0+) · `lib/regions.js` (public region list & cross-region search, v0.7.0+) · `lib/anchors.js` (project-level instance anchors, v0.7.0+) · `lib/settings-api.js` (settings RPC) · `lib/tools/*.js` (one module per tool) · `lib/index.js` (entry)
- Dynamic mount (temporary session): `npm run build:body`, then use the generated body as the `code.host` of `cordis_define`
- CI: [GitHub Actions](../../.github/workflows/ci.yml) — push/PR run tests, `v*` tags publish to npm automatically (needs `NPM_TOKEN` secret)
- Type declarations: [`lib/types/index.d.ts`](../../lib/types/index.d.ts)
- One-shot setup script: [`scripts/workbench-setup.ps1`](../../scripts/workbench-setup.ps1)
