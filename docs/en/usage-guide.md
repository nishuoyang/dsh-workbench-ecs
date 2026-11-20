# Usage guide: settings panel, how it works, instance anchors, recipes

> [中文](../zh/usage-guide.md) | English · Back to [README.en.md](../../README.en.md)

## Settings panel

| Area | Capabilities |
|---|---|
| CLI status | CLI availability / version / credential profile / daemon; **20s host cache + instant local render** (panel opens immediately, refreshes silently in the background; [Refresh] forces a re-check) |
| ECS instances | region / status filters, name-or-ID search, status distribution strip, checkboxes for batch actions, **30s auto-refresh** |
| Row actions | [Run] pick target / [Diagnose] one-shot health check (disk · memory gauges) / [Deploy] guarded publish wizard / [Details] metadata + recent logs |
| Remote command | command history (datalist), two-click confirmation for destructive patterns (host still rejects); batch execution with per-instance result table |
| Guarded deploy | upload local file (OSS relay, ≤1GB) + restart/apply command + health check, 3-stage progress; save/reuse templates; **mode switchable to "Runbook"** (run a workspace runbook, with preview) (v0.6.2+) |
| Runbook (release runbook) | scans `<workspace>/.dsh/workbench-ecs/runbooks/*.json` and lists name / description / step count / kinds / declared params plus the **static check verdict** (a broken file is flagged invalid without hiding the others); per row: **Validate** (read-only, item-by-item error/warn with step positions) / **Preview** (zero side effects) / **Execute**; results render per step, including `skipped` markers and per-assertion ✔/✘ (v0.6.2+, checks in v0.6.3+, **parameter contracts and replay advice in v0.8.0+** — the panel and the pre-execution check share one implementation) |
| Workbench sessions | session list / close one / close all (troubleshooting & resource reclamation) |
| Operation timeline | every panel action is logged for the current session |

The panel talks to the **local** Workbench CLI through a same-origin route (`/dsh-workbench-ecs/rpc`, registered by `lib/index.js`) — no LLM/Agent in the loop, so the destructive-command guard is **deny-first** (for approval-gated execution use the Agent's `ecs_exec` tool instead). The panel's RPC follows the same rule as the tools: a remote-command timeout settles as **`exit_code 124` + `timed_out: true`** (v0.7.0+), so a killed command is never rendered as a success. The UI auto-adapts to light/dark themes.

## How it works

This package is a DSH **static two-half plugin**, composed into a DSH profile as a **bundle layer**. It works on **both hosts** — the browser surface (`dsh web`, DSH 0.1.x) and the desktop app (`dsh-desktop-host`, DSH 0.2.x) — because the desktop host serves the same web surface and filters client halves with the same `dsh.client.platform === "web"` rule:

| Half | File | Responsibility |
|---|---|---|
| Host half (Node) | `lib/index.js` | Registers the 11 model tools with `tools`, and same-origin routes `/dsh-workbench-ecs/health` & `/dsh-workbench-ecs/rpc` with `webServer`; the settings RPC runs the local CLI through `subprocess` (shared `lib/common.js` / `lib/settings-api.js` / `lib/steps-engine.js`; runbook mechanism in `lib/runbooks.js`, cross-region search in `lib/regions.js`, instance anchors in `lib/anchors.js`, release snapshots in `lib/snapshots.js` (v0.8.0+)) |
| Browser half | `lib/client.js` | Single-file client bundle (`window.__ModuleLoader__` factory form): registers the "Workbench ECS" settings tab and talks to the host over the same-origin RPC route |
| Composition | `cordis.patch.yml` | `dsh.bundle` patch: inserts the plugin row into the profile composition — active when either host boots that profile, and picked up automatically by `dsh plugin --profile <web\|desktop> add` |
| Compatibility guard | `test/compat.mjs` | Asserts the `peerDependencies` range covers every runtime this package is verified against (`0.1.x` browser + `0.2.x` desktop), because an uncovered runtime makes the host **silently skip the whole bundle**; then re-checks all 11 tool definitions with the real `@deepseek-ai/dsh-tools` kernel (v0.9.0+) |

Zero build on both ends: `lib/client.js` is a hand-written single-file bundle, no bundler required; the same `lib/` sources can also be mounted as a temporary dynamic body (`npm run build:body`).

## Project-level instance anchors: `instances.json` (v0.7.0+)

An instance's `instance_id` / `region` used to live only in the session transcript — the next session had to guess the region all over again. v0.7.0 defines a **project-level file**, following the same principle as runbooks: **the plugin defines the format, the project fills in the content**.

```jsonc
{
  "//1": "keys starting with // or _ are treated as comments (the usual JSON comment convention)",
  "prod":    { "instance_id": "i-uf66ct2o35p7fjcd0sru", "region": "cn-shanghai", "repo": "/root/app" },
  "staging": { "instance_id": "i-bp1xxxxxxxxxxxxxxxxx", "region": "cn-hangzhou", "repo": "/root/app-staging" }
}
```

A template ships with the package at [`templates/instances.json`](../../templates/instances.json) (copy it into a project alongside `templates/runbooks/`):

```bash
cp node_modules/dsh-workbench-ecs/templates/instances.json  .dsh/workbench-ecs/
```

**Effect one — every tool accepts an anchor name**: **every tool that takes `instance_id` / `instance_ids`** (`ecs_exec` / `ecs_upload` / `ecs_download` / `ecs_diagnose` / `ecs_deploy` / `ecs_log`, plus `ecs_runbook`'s `instance_id`, …) accepts an anchor name directly:

```text
ecs_exec { instance_id: "prod", command: "df -h" }        # same as i-uf66ct2o35p7fjcd0sru @ cn-shanghai
ecs_exec { instance_ids: ["prod", "staging"], command: "uptime" }
```

The plugin resolves it to the real `instance_id` at the **tool-registration boundary** and fills in the anchor's `region` when `region` was not given explicitly — so **every tool stays unchanged** and no parameter tables gained a field.

**Effect two — anchor fields become implicit runbook parameters**: fields other than `instance_id` / `region` (e.g. `repo` / `note`) are injected into a runbook as **implicit parameters**, so `${repo}` need not be passed every time. The precedence is unchanged:

```text
implicit (anchor fields / ${instance_id} / ${region}) < runbook params defaults < caller-supplied runbook_params
```

**Backward compatibility and failure posture**:

| Case | Behaviour |
|---|---|
| File absent | **Exactly as before** (an anchor-looking name goes to the CLI verbatim and fails there; nothing extra is blocked) |
| File corrupt (invalid JSON / top level not an object) | Degrades to "**pass the value through**"; tool calls are never blocked |
| Anchor name misspelled | Fails and **lists the available anchors** (far more useful than the CLI's "instance not found") |
| `fs` service not mounted | Same degradation, value passed through |

`ecs_find` lists the workspace anchors at the end of its result (which anchors exist, and where each one points), so one call answers both "where is the machine" and "has this project recorded it".

## Typical usage (production fix loop)

```text
# 1. Find instances (when the region is unknown, start with ecs_find — no guessing)
ecs_find { keyword: "nailong" }
ecs_list { region: "cn-shanghai", status: "Running" }

# 2. One-shot diagnostics
ecs_diagnose { instance_id: "i-uf66ct2o35p7fjcd0sru" }

# 3. Inspect logs
ecs_exec { instance_id: "i-uf66ct2o35p7fjcd0sru", command: "cd /var/log/nginx && tail -n 100 error.log" }

# 3b. Use script for anything with nested quotes (zero escaping, incl. in-container checks)
ecs_exec {
  instance_id: "i-uf66ct2o35p7fjcd0sru",
  script: "docker exec nailong-server node -e \"fetch('http://127.0.0.1/health').then(r=>console.log(r.status))\""
}

# 4. Guarded deployment after fixing the code (upload + sha256 verify + restart + health check)
ecs_deploy {
  instance_id: "i-uf66ct2o35p7fjcd0sru",
  local_file: "./app.jar", remote_path: "/opt/app/app.jar",
  command: "docker compose -f /opt/app/docker-compose.yml restart app",
  health_check: "curl -fsS http://127.0.0.1:3000/health || true"
}

# 4b. Leave a snapshot before and after the release (rollback point), then diff it
ecs_snapshot { action: "create", instance_id: "i-uf66ct2o35p7fjcd0sru", name: "pre-abc1234", profile: "web" }
#   ... run the release ...
ecs_snapshot { action: "diff",   name: "pre-abc1234" }

# 5. Long task in the background
ecs_exec { instance_id: "i-uf66ct2o35p7fjcd0sru", command: "npm run build", run_in_background: true }
```
