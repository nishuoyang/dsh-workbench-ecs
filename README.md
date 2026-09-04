# dsh-workbench-ecs

English | [中文](./README.zh.md)

> A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (Cordis) plugin that lets the Agent control remote Alibaba Cloud ECS instances through the local Workbench CLI.

## Why this plugin

Development and production environments differ, and production-only bugs are often impossible to reproduce locally. The traditional debugging loop is painful: a human logs into the server, copies commands back and forth, and pastes results to the Agent again and again.

This plugin gives the **Agent the ability to reach production instances on its own**: through tool calls it executes the official Alibaba Cloud [Workbench CLI](https://help.aliyun.com/zh/ecs/user-guide/use-workbench-cli-to-manage-ecs-instances) locally, covering instance listing, remote command execution, file transfer, one-shot diagnostics, guarded deployment, and session management — the complete loop of *detect → locate → fix → upload → restart → verify*, with no manual copy-paste of commands or results.

## Features

- **7 Agent-native tools**: `ecs_list` / `ecs_exec` / `ecs_upload` / `ecs_download` / `ecs_diagnose` / `ecs_deploy` / `ecs_session`, integrated with the Harness tool pipeline
- **Real API calls**: tools run the local `workbench` command and reach instances through the Alibaba Cloud Workbench backend (works for instances **without public IPs**)
- **JSON parsing + readable rendering**: parses CLI JSON output into tables/text/terminal cards; CLI-level errors (`{code, message}`) become readable messages
- **Safety guard**: destructive commands (`rm -rf`, `shutdown`, `reboot`, `mkfs`, `dd`, …) request confirmation through the Harness approval service; anything not `allowed-once` is rejected (fail closed)
- **Background jobs**: `ecs_exec` supports `run_in_background` — long commands register with jobs, `job_output` reads incrementally, `job_kill` cancels
- **Batch execution**: `ecs_exec` supports an `instance_ids` array (serial; per-instance failures do not stop others)
- **Large-output spill**: oversized stdout spills to disk with the full path returned, so log triage never loses the head
- **Robust binary resolution**: resolves `workbench` via PATH and falls back to common install locations (e.g. `C:\Program Files\workbench\workbench.exe`), handling stale host-process PATH
- **Cancellation support**: aborted tool calls terminate the process tree (SIGTERM → SIGKILL), leaving no orphan processes

## Installation

### 1. DeepSeek Harness (required)

This is a standard [Cordis](https://github.com/cordiverse/cordis) plugin and must run inside DeepSeek Harness (or a compatible Cordis runtime).

### 2. Install the Workbench CLI (required)

| Platform | Command |
|---|---|
| Windows (PowerShell) | `irm https://workbench-cli.oss-cn-hangzhou.aliyuncs.com/install.ps1 \| iex` |
| Linux / macOS | `curl -fsSL https://workbench-cli.oss-cn-hangzhou.aliyuncs.com/install.sh \| bash` |

Verify after install:

```bash
workbench version     # should print version / commit / build date
```

> ⚠️ **Windows note**: if you installed the CLI *after* the Harness process started, the host process's inherited `PATH` is stale and `workbench` will not resolve on its own. The plugin includes a fallback scan of common install locations, so it usually works without a restart; if it still fails, restart the Harness session or add the install directory (e.g. `C:\Program Files\workbench`) to `PATH`.

### 3. Configure credentials

The Workbench CLI stores credentials in `~/.workbench/config.json` (must be mode `0600`). Five authentication modes are supported; edit the file directly (avoid interactive `workbench config`):

**AK mode (development / long-lived credentials, default):**

```json
{
  "current": "default",
  "profiles": {
    "default": {
      "mode": "AK",
      "access_key_id": "LTAIxxxxxxxxxxxxxxxx",
      "access_key_secret": "xxxxxxxxxxxxxxxxxxxxxxxx"
    }
  }
}
```

**StsToken mode (temporary security credentials):**

```json
{
  "current": "default",
  "profiles": {
    "default": {
      "mode": "StsToken",
      "access_key_id": "LTAIxxxxxxxxxxxxxxxx",
      "access_key_secret": "xxxxxxxxxxxxxxxxxxxxxxxx",
      "security_token": "xxxxxxxxxxxxxxxxxxxxxxxx"
    }
  }
}
```

**RamRoleArn mode (production / cross-account / least privilege, auto-refreshed STS tokens):**

```json
{
  "current": "default",
  "profiles": {
    "default": {
      "mode": "RamRoleArn",
      "access_key_id": "LTAIxxxxxxxxxxxxxxxx",
      "access_key_secret": "xxxxxxxxxxxxxxxxxxxxxxxx",
      "ram_role_arn": "acs:ram::123456789:role/WorkbenchRole",
      "role_session_name": "workbench-session"
    }
  }
}
```

**CredentialsCmd mode (zero-trust / Vault integration — external command prints credential JSON):**

```json
{
  "current": "default",
  "profiles": {
    "default": {
      "mode": "CredentialsCmd",
      "credentials_cmd": "vault read -format=json secret/aliyun-ecs"
    }
  }
}
```

**CredentialsURI mode (metadata service / sidecar):**

```json
{
  "current": "default",
  "profiles": {
    "default": {
      "mode": "CredentialsURI",
      "credentials_uri": "http://localhost:8080/credentials"
    }
  }
}
```

Set file permissions (Linux/macOS; on Windows make sure the file is not readable by other users):

```bash
chmod 600 ~/.workbench/config.json
```

**One-shot setup script (Windows):** the repo ships [`scripts/workbench-setup.ps1`](./scripts/workbench-setup.ps1) supporting all 5 modes and non-interactive multi-profile setup:

```powershell
# AK mode
./scripts/workbench-setup.ps1 -AccessKeyId LTAIxxx -AccessKeySecret xxx
# RamRoleArn mode (recommended for production) + profile switching
./scripts/workbench-setup.ps1 -Mode RamRoleArn -Profile prod -AccessKeyId LTAIxxx -AccessKeySecret xxx -RamRoleArn acs:ram::123456789:role/WorkbenchRole -AutoSwitch
```

**Multi-profile management (non-interactive):**

```bash
workbench config list                     # list all profiles (* marks the active one)
workbench config switch --profile prod    # switch the active profile
workbench config get                      # show the current profile details (JSON)
workbench config delete --profile old     # delete a profile (cannot delete the active one)
```

### 4. Minimum RAM policy (recommended)

Attach the following minimum policy to the RAM user/role that runs the CLI:

```json
{
  "Version": "1",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["ecs-workbench:LoginECSInstance", "ecs-workbench:ChatMessages"],
      "Resource": "*"
    },
    {
      "Effect": "Allow",
      "Action": ["ecs:DescribeInstances", "ecs:DescribeCloudAssistantStatus", "ecs:StartTerminalSession"],
      "Resource": "*"
    },
    {
      "Effect": "Allow",
      "Action": "ram:CreateServiceLinkedRole",
      "Resource": "*",
      "Condition": {
        "StringEquals": { "ram:ServiceName": "workbench.ecs.aliyuncs.com" }
      }
    }
  ]
}
```

To restrict to specific instances, replace `"Resource": "*"` with:

- `ecs-workbench:LoginECSInstance`: `acs:ecs:<region>:<account-id>:ecs/<instance-id>`
- `ecs` actions: `acs:ecs:<region>:<account-id>:instance/<instance-id>`

### 5. Install this plugin

**Option A — add a plugin row to your Cordis composition (cordis.yml / cordis.patch.yml):**

```yaml
- id: dsh-workbench-ecs
  name: dsh-workbench-ecs
```

**Option B — use the Harness plugin manager (recommended; also enables the settings UI):**

```bash
# web profile: tools + visual settings panel in one shot (ships its own cordis.patch.yml bundle layer)
dsh plugin --profile web add dsh-workbench-ecs
```

Restart `dsh web` after installing (or just refresh the page on deployments with hot reload);
the 7 registered tools become visible to the Agent.

> Since **v0.3.0** the package also ships a browser settings panel (see "Settings UI" below):
> `exports["./client"]` plus the `dsh.client` declaration are picked up automatically by the
> DSH client module system — no extra wiring needed.

### 6. Verify the installation

```bash
# Manually verify the CLI (run on the machine that has Workbench CLI installed):
workbench list ecs --region cn-hangzhou --output json
workbench exec --instance-id i-bp1xxxxx --command "df -h" --output json

# Verify the settings RPC route (requires the bundle row to be mounted):
curl -s http://127.0.0.1:3080/dsh-workbench-ecs/health
# => {"ok":true,"plugin":"dsh-workbench-ecs","version":"0.3.1"}
```

Then ask the Agent:

```text
ecs_list { region: "cn-shanghai" }
ecs_exec { instance_id: "i-uf66ct2o35p7fjcd0sru", command: "df -h" }
ecs_diagnose { instance_id: "i-uf66ct2o35p7fjcd0sru" }
```

### 7. Settings UI (visual panel, v0.3.0+)

Once the bundle is installed, open the Harness settings (gear icon) and you will find a
**"Workbench ECS"** tab:

| Area | Capabilities |
|---|---|
| CLI status | CLI availability / version / credential profile / daemon; **20s host cache + instant local render** (panel opens immediately, refreshes silently in the background; [Refresh] forces a re-check) |
| ECS instances | region / status filters, name-or-ID search, status distribution strip, checkboxes for batch actions, **30s auto-refresh** |
| Row actions | [Run] pick target / [Diagnose] one-shot health check (disk · memory gauges) / [Deploy] guarded publish wizard / [Details] metadata + recent logs |
| Remote command | command history (datalist), two-click confirmation for destructive patterns (host still rejects); batch execution with per-instance result table |
| Guarded deploy | upload local file (OSS relay, ≤1GB) + restart/apply command + health check, 3-stage progress; save/reuse templates |
| Workbench sessions | session list / close one / close all (troubleshooting & resource reclamation) |
| Operation timeline | every panel action is logged for the current session |

The panel talks to the **local** Workbench CLI through a same-origin route
(`/dsh-workbench-ecs/rpc`, registered by `lib/index.js`) — no LLM/Agent in the loop,
so the destructive-command guard is **deny-first** (for approval-gated execution use the
Agent's `ecs_exec` tool instead).

> The UI auto-adapts to light/dark themes; for local development use `install-local.ps1`
> to link the checkout with a junction and iterate live.

## Tools reference

### `ecs_list` — list ECS instances in a region

CLI equivalent: `workbench list ecs --region <region> [filters...] --output json`

| Parameter | Type | Required | Description |
|---|---|---|---|
| `region` | string | ✅ | Alibaba Cloud region, e.g. `cn-hangzhou` |
| `status` | string | | Instance status filter: `Running` / `Stopped` / `Starting` / `Stopping` |
| `tag` | array\<string\> | | Tag filter, each entry `key=value` or `key`, repeatable, AND logic |
| `instance_type` | string | | Instance type filter, e.g. `ecs.g7.large` |
| `instance_name` | string | | Instance name filter, `*` wildcard supported |
| `limit` | integer | | Page size 10–100, default 50 (ECS API page-size floor is 10) |

Returns the instance list (instance IDs feed the other tools), rendered as a text table.

### `ecs_exec` — run a remote command on an instance (enhanced)

CLI equivalent: `workbench exec --instance-id <id> --command <cmd> [--timeout <s>] --output json`

| Parameter | Type | Required | Description |
|---|---|---|---|
| `instance_id` | string | | Target instance ID (alternate with `instance_ids`) |
| `instance_ids` | array\<string\> | | Batch targets (serial, max 20, per-instance failures do not stop others) |
| `command` | string | ✅ | Remote command; chain with `&&` or `;` when shared context is needed |
| `timeout` | integer | | Command timeout in seconds, default 30 |
| `region` | string | | Region, optional (CLI infers it from the instance ID) |
| `run_in_background` | boolean | | Run long commands in the background: returns a `job_id`, read with `job_output` (not for batches) |

Returns `{ kind: single|batch|background, ... }`.

### `ecs_upload` — upload a local file to an instance

CLI equivalent: `workbench upload <local-file> <remote-path> --instance-id <id> [--force]`

| Parameter | Type | Required | Description |
|---|---|---|---|
| `local_file` | string | ✅ | Local file path (relative paths resolve against the session workspace) |
| `remote_path` | string | ✅ | Remote target path (file or directory) |
| `instance_id` | string | ✅ | Target instance ID |
| `region` | string | | Region, optional |
| `force` | boolean | | Overwrite an existing remote file without confirmation (default false) |

Transfers through Alibaba Cloud OSS (up to 1GB). Pair with `ecs_deploy` / `ecs_exec` for deployments.

### `ecs_download` — download a file from an instance

CLI equivalent: `workbench download <remote-path> [local-path] --instance-id <id> [--force]`

| Parameter | Type | Required | Description |
|---|---|---|---|
| `remote_path` | string | ✅ | Remote file path |
| `local_path` | string | | Local save path (file or directory, relative to the session workspace; omitted = current directory) |
| `instance_id` | string | ✅ | Target instance ID |
| `region` | string | | Region, optional |
| `force` | boolean | | Overwrite an existing local file without confirmation (default false) |

**Typical use**: pull production logs/config files back for analysis.

### `ecs_diagnose` — one-shot read-only diagnostics

CLI equivalent: one remote `exec` (semicolon-joined read-only command set)

| Parameter | Type | Required | Description |
|---|---|---|---|
| `instance_id` | string | ✅ | Target instance ID |
| `region` | string | | Region, optional |
| `extra_command` | string | | Extra read-only command (also passes the safety guard) |
| `timeout` | integer | | Timeout in seconds, default 120 |

Built-in 7 sections: host info / uptime & load / memory / disk / running services & containers (`docker ps`) / top memory processes / listening ports. **The starting point of production debugging** — one tool instead of a command string.

### `ecs_deploy` — guarded deployment (upload + restart + health check)

| Parameter | Type | Required | Description |
|---|---|---|---|
| `instance_id` | string | ✅ | Target instance ID |
| `command` | string | ✅ | Restart/apply command, e.g. `docker compose restart` |
| `local_file` | string | | Optional local file to upload |
| `remote_path` | string | | Upload target path (required when `local_file` is set) |
| `health_check` | string | | Optional health-check command, e.g. `curl -fsS http://127.0.0.1/health \|\| true` |
| `region` / `force` / `timeout` | | | As above |

All three phases return their results (a failing phase does not stop later ones): upload → restart → health check. **The complete *edit → upload → restart → verify* fix loop.**

### `ecs_session` — session management

CLI equivalent: `workbench session list` / `workbench session close <id>` / `--all`

| Parameter | Type | Required | Description |
|---|---|---|---|
| `action` | string | ✅ | `list` active sessions; `close` a session |
| `session_id` | string | | Session ID to close (for `close`) |
| `all` | boolean | | Close all sessions (for `close`) |

Normally unnecessary (sessions are auto-managed); used for diagnostics and resource cleanup.

## Safety

- **Destructive-command guard**: before execution, `ecs_exec` and `ecs_deploy` (restart command and health check) scan the command; matches against `rm -rf`, `shutdown`/`poweroff`/`reboot`/`halt`, `mkfs`, `dd`, `init 0/6`, `systemctl stop/disable/mask`, `service stop`, `iptables -F/-X`, `userdel`/`groupdel` go through the Harness `approval` service; anything not `allowed-once` (no approver, or policy `never`) is rejected (fail closed).
- **Read-only diagnostics**: `ecs_diagnose` sections are read-only; custom commands still pass the guard.
- **Transfer confirmation**: `ecs_upload`/`ecs_download` require confirmation on existing files unless `force=true`.
- **Credential hygiene**: credentials live only in local `~/.workbench/config.json` (0600); prefer RamRoleArn/CredentialsCmd/CredentialsURI over long-lived AK.

## Typical usage (production fix loop)

```text
# 1. Find instances
ecs_list { region: "cn-shanghai", status: "Running" }

# 2. One-shot diagnostics
ecs_diagnose { instance_id: "i-uf66ct2o35p7fjcd0sru" }

# 3. Inspect logs
ecs_exec { instance_id: "i-uf66ct2o35p7fjcd0sru", command: "cd /var/log/nginx && tail -n 100 error.log" }

# 4. Guarded deployment after fixing the code
ecs_deploy {
  instance_id: "i-uf66ct2o35p7fjcd0sru",
  local_file: "./app.jar", remote_path: "/opt/app/app.jar",
  command: "docker compose -f /opt/app/docker-compose.yml restart app",
  health_check: "curl -fsS http://127.0.0.1:3000/health || true"
}

# 5. Long task in the background
ecs_exec { instance_id: "i-uf66ct2o35p7fjcd0sru", command: "npm run build", run_in_background: true }
```

## Troubleshooting

### CLI exit codes

| Code | Meaning |
|---|---|
| 0 | Success |
| 1 | Unclassified runtime error (instance not found, API error, …) |
| 2 | Invalid/missing/illegal flag value |
| 3 | Session ID invalid or expired |
| 4 | Authentication/authorization failure |
| 5 | Network timeout / WebSocket exception |
| 6 | Local daemon not running or socket invalid |
| 7 | Session attached by another TTY |

### Common issues

| Error | Fix |
|---|---|
| `InvalidAccessKeyId` / auth errors (code 4) | Check AK/SK in `~/.workbench/config.json`; re-run `workbench config` |
| `profile not found` (code 1) | Check profile names with `workbench config list` |
| `insecure permissions` (code 2) | `chmod 600 ~/.workbench/config.json` |
| `workbench CLI 不可用` | Confirm the CLI is installed; if the host process started before installation, restart Harness or add the install dir to PATH |
| `network timeout` (code 5) | Check connectivity to `*.aliyuncs.com` and security-group rules |
| Instance not found (code 1) | Verify the instance ID and region; confirm with `ecs_list` |
| Instances without a public IP cannot connect | This plugin uses the Workbench backend channel — no public IP needed; confirm Cloud Assistant is installed on the instance |
| `破坏性命令未获批准` | Normal guard behavior: the user (or approver) must explicitly allow it |

### Error message example

```text
ecs_exec: workbench CLI 错误 (code 1): session resolve: login instance: SDKError: ...
```

## Development

```bash
npm install          # install devDependencies (@deepseek-ai/dsh-tools)
npm test             # smoke test: module exports + 7-tool registration contract + body consistency
npm run test:e2e     # real-CLI end-to-end test (needs local Workbench CLI, valid credentials, a reachable instance)
npm run build:body   # generate the dynamic-mount body (same origin as lib/)
```

- Source layout: `lib/common.js` (shared) · `lib/tools/*.js` (one module per tool) · `lib/index.js` (entry)
- Dynamic mount (temporary session): `npm run build:body`, then use the generated body as the `code.host` of `cordis_define`
- CI: [GitHub Actions](./.github/workflows/ci.yml) — push/PR run tests, `v*` tags publish to npm automatically (needs `NPM_TOKEN` secret)
- Type declarations: [`lib/types/index.d.ts`](./lib/types/index.d.ts)
- One-shot setup script: [`scripts/workbench-setup.ps1`](./scripts/workbench-setup.ps1)

## License

[MIT](./LICENSE) © 2026 [nishuoyang](https://github.com/nishuoyang)
