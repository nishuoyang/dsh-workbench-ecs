# dsh-workbench-ecs

[![Listed on dsh-plugin.org](https://dsh-plugin.org/badges/listed.svg)](https://dsh-plugin.org/plugins/nishuoyang/dsh-workbench-ecs)

> v0.9.2 · MIT License

[中文](README.md) | English

> A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (Cordis) plugin that lets the Agent control remote Alibaba Cloud ECS instances through the local Workbench CLI.

It drives the official Alibaba Cloud [Workbench CLI](https://help.aliyun.com/en/ecs/user-guide/use-workbench-cli-to-manage-ecs-instances) locally and ships **11 agent-native tools** (`ecs_find` / `ecs_list` / `ecs_exec` / `ecs_log` / `ecs_upload` / `ecs_download` / `ecs_diagnose` / `ecs_deploy` / `ecs_runbook` / `ecs_snapshot` / `ecs_session`), covering the full *find → list → diagnose → execute → upload → restart → verify → snapshot check* loop, plus a visual settings panel. Instances are reached through the Workbench backend channel, so **no public IP is needed**; destructive commands go through the Harness approval guard and are rejected unless explicitly allowed (fail closed).

## Features

> Only the highlights here; the **complete list** is in [Complete feature list](docs/en/features.md), and parameter-level details are in the [tools reference](docs/en/tools.md).

- **Runs on both surfaces** (v0.9.0+): the browser surface (`dsh web`) and the DeepSeek Harness desktop app (`dsh-desktop-host`) — one package, one `lib/client.js`; the settings tab and all 11 tools appear on both, locked in by `test/compat.mjs`
- **No public IP required**: tools run the local `workbench` command and reach instances through the Alibaba Cloud Workbench backend; `upload` / `download` relay through OSS
- **Zero-escaping script delivery** (v0.4.0+): `ecs_exec { script }` base64-delivers the body to a remote file and executes it, never through a shell quoting layer — nested quotes, Chinese text, `$`, backticks and heredocs all work untouched; bodies over 16KB are chunked and byte-verified
- **Guarded deployment** (v0.6.0+): `ecs_deploy { steps }` expresses "upload → run → assert → read log" as one call; `assert` states exactly which check failed, what was expected and what happened; `dry_run` previews, `from_step` resumes
- **Release snapshots** (v0.8.0+): `ecs_snapshot` makes "rollback point before + difference check after" a first-class tool — read-only collection written to `.dsh/workbench-ecs/snapshots/<name>.json` in the workspace, diffable / committable / greppable
- **Failures you can attribute** (v0.7.0+): remote timeouts settle to `exit_code: 124` (the CLI's JSON claims 0); guard rejections are explained in four distinct cases (no approval service / `never` policy / user rejected / no responder); upload failures say the problem is the "machine → OSS" hop, not the target instance
- **Long tasks and pseudo-sessions** (v0.5.0+): `detach` starts a remote `nohup` job and returns `job_id` / `log_path` immediately without holding the instance; `session_id` carries `cd`/`export` across calls
- **Visual settings panel**: CLI status, instance browser, one-click diagnostics with disk & memory gauges, guarded deploy wizard, sessions, operation timeline — auto-adapts to light/dark

## Quick start

Three steps, about five minutes. Full instructions (all five credential modes, least-privilege RAM policy, multiple profiles, the Windows PATH trap) are in **[Installation & credentials](docs/en/getting-started.md)**.

### 1. Install Workbench CLI and configure credentials

```bash
# Linux / macOS
curl -fsSL https://workbench-cli.oss-cn-hangzhou.aliyuncs.com/install.sh | bash
# Windows (PowerShell)
irm https://workbench-cli.oss-cn-hangzhou.aliyuncs.com/install.ps1 | iex

workbench version      # self-check: prints version / commit / build date
workbench config       # prompts for AccessKey ID / Secret, writes ~/.workbench/config.json (0600)
```

> **Official docs**: Alibaba Cloud — [Install and configure Workbench CLI credentials](https://help.aliyun.com/en/ecs/user-guide/install-and-configure-workbench-cli-credentials) (installation, least-privilege RAM policy, every credential mode, upgrade and uninstall).
> In production prefer a RAM role (`RamRoleArn`) over a long-lived AccessKey; [`scripts/workbench-setup.ps1`](./scripts/workbench-setup.ps1) in this repo writes the config, fixes permissions and handles multiple profiles in one go.

### 2. Install the plugin

```bash
# browser surface
dsh plugin --profile web add dsh-workbench-ecs

# desktop app (a separate profile — the two are not interchangeable)
dsh plugin --profile desktop add dsh-workbench-ecs
```

Restart the host afterwards (the desktop app reads its profile only at process start).

### 3. Verify

```bash
# the desktop host uses 19387, `dsh web` uses 3080 — use whichever you run
curl -s http://127.0.0.1:19387/dsh-workbench-ecs/health
# => {"ok":true,"plugin":"dsh-workbench-ecs","version":"0.9.2"}
```

Then ask the agent to call:

```text
ecs_list { region: "cn-shanghai" }
ecs_exec { instance_id: "i-xxx", command: "df -h" }
```

## Tools at a glance

| Tool | What it does | Since |
|---|---|---|
| `ecs_find` | Cross-region instance search (name / ID / private & public IP / type / tag); searches all 22 public regions in parallel by default | v0.7.0+ |
| `ecs_list` | List instances in one region with status / tag / type / name filters and pagination | — |
| `ecs_exec` | Remote command execution: zero-escaping `script`, `instance_ids` batches, concurrency, `detach` long tasks, `session_id` pseudo-sessions, `read_only` guard | v0.5.0+ |
| `ecs_log` | Read any remote file by byte cursor (read-only) | v0.5.0+ |
| `ecs_upload` | Upload a file or a whole directory (`local_dir` → tar + sha256 verify + remote extract), with retries on transient failures | — |
| `ecs_download` | Download a file from an instance | — |
| `ecs_diagnose` | One-shot read-only diagnostics (host / disk / memory / ports / containers), read-only guard on by default | — |
| `ecs_deploy` | Guarded deployment and multi-step orchestration: `steps` / `assert` / `dry_run` / `from_step` / `runbook` | v0.6.0+ |
| `ecs_runbook` | Read-only inventory and static checks for workspace runbooks (`validate` / `plan`) | v0.6.3+ |
| `ecs_snapshot` | Release snapshots: `create` / `list` / `diff` / `against` | v0.8.0+ |
| `ecs_session` | Pseudo-session management (list / reset) | v0.5.0+ |

## Documentation

| Doc | Contents |
|---|---|
| [Complete feature list](docs/en/features.md) | All 30 feature notes verbatim, with the version and reasoning behind each |
| [Installation & credentials](docs/en/getting-started.md) | Workbench CLI install, all five credential modes, least-privilege RAM policy, multiple profiles, manual install, local development |
| [Usage guide](docs/en/usage-guide.md) | Settings panel, how it works, project-level instance anchors (`instances.json`), production fix loop |
| [Tools reference](docs/en/tools.md) | Every tool's parameters and results, built-in runbook templates, snapshots and diffs |
| [Safety & troubleshooting](docs/en/safety-and-troubleshooting.md) | Approval guard, read-only guard, exit-code semantics, common issues |
| [Development & release](docs/en/development.md) | Local debugging, test matrix, release flow and the traps hit along the way |

## Safety

- **Destructive commands fail closed**: `rm -rf`, `shutdown`, `reboot`, `mkfs`, `dd`, `iptables -F/-X` and friends go through the Harness approval service; anything without `allowed-once` is rejected — the plugin never guesses that you meant it
- **Read-only guard**: `read_only: true` rejects redirects, `rm`/`mv`/`chmod`, `docker`/`systemctl` mutations before they reach a shell; on by default for `ecs_diagnose`
- **Credentials stay local**: the plugin neither reads nor forwards `~/.workbench/config.json` — it only invokes the local `workbench` command; grant the RAM user the [official least-privilege policy](https://help.aliyun.com/en/ecs/user-guide/install-and-configure-workbench-cli-credentials)

## Requirements

| Item | Requirement |
|---|---|
| Node.js | ≥ 20 |
| Host | `dsh web` or the DeepSeek Harness desktop app — install the plugin into **each** profile separately |
| Workbench CLI | On the **same machine** as the plugin, with credentials configured |
| Target instance | Linux only (Workbench CLI connects over SSH; Windows instances are unsupported) with the Cloud Assistant agent running |
| Network | The local machine reaches `*.aliyuncs.com` and the Workbench backend WebSocket; upload/download also need the instance to reach its regional OSS internal endpoint |

## License

[MIT](./LICENSE) © 2026 [nishuoyang](https://github.com/nishuoyang)
