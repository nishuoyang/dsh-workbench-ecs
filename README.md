# dsh-workbench-ecs

> v0.6.6 · MIT License

English | [中文](README.zh.md)

> A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (Cordis) plugin that lets the Agent control remote Alibaba Cloud ECS instances through the local Workbench CLI.

It drives the official Alibaba Cloud [Workbench CLI](https://help.aliyun.com/zh/ecs/user-guide/use-workbench-cli-to-manage-ecs-instances) locally, and ships **9 agent-native tools** — `ecs_list` / `ecs_exec` / `ecs_log` / `ecs_upload` / `ecs_download` / `ecs_diagnose` / `ecs_deploy` / `ecs_runbook` / `ecs_session` — covering the full *list → diagnose → execute → upload → restart → verify* loop, plus a **visual settings panel** (CLI status, instance browser, guarded deploy wizard, sessions, operation timeline). Instances are reached through the Workbench backend channel, so **no public IP is needed**; destructive commands go through the Harness approval guard and are rejected unless explicitly allowed (fail closed).

## Features

- **9 Agent-native tools**: `ecs_list` / `ecs_exec` / `ecs_log` / `ecs_upload` / `ecs_download` / `ecs_diagnose` / `ecs_deploy` / `ecs_runbook` / `ecs_session`, integrated with the Harness tool pipeline
- **Detached long tasks + log cursor** (v0.5.0+): `ecs_exec { detach: true }` starts the job with remote `nohup`, writes a log file, and immediately returns `job_id`/`log_path`/`exit_path`; the plugin polls increments on an interval, so it never holds the instance for the whole run (other calls on the same instance interleave normally) and the remote log file stays the single source of truth — a slow reader can no longer lose or duplicate segments. `ecs_log` reads any remote file by **byte cursor**, so release-log polling no longer needs repeated full `tail`s
- **Pseudo-sessions** (v0.5.0+): `ecs_exec { session_id: "deploy" }` keeps the working directory and environment across calls (`cd`/`export` carry over), different session ids stay isolated, and an idle session resets after 30 minutes with an explicit notice
- **Visual settings panel** (v0.3.0+): CLI status with 20s host cache + instant local render, instance browser (search / batch / 30s auto-refresh), one-click diagnostics with disk & memory gauges, guarded publish wizard with templates (switchable to Runbook mode), session management, operation timeline — auto-adapts to light/dark themes
- **Real API calls**: tools run the local `workbench` command and reach instances through the Alibaba Cloud Workbench backend (works for instances **without public IPs**)
- **JSON parsing + readable rendering**: parses CLI JSON output into tables/text/terminal cards; CLI-level errors (`{code, message}`) become readable messages
- **Safety guard**: destructive commands (`rm -rf`, `shutdown`, `reboot`, `mkfs`, `dd`, `iptables -F/-X`, …) request confirmation through the Harness approval service; anything not `allowed-once` is rejected (fail closed)
- **Script delivery** (v0.4.0+): `ecs_exec`'s `script` parameter base64-delivers the body to a remote file and executes it, so the content never passes through a shell quoting layer — `docker exec ... node -e "..."`, Chinese text, `$`, backticks, heredocs and multi-line scripts all work with **zero escaping**; bodies over 16KB are delivered in chunks and verified by byte count
- **Read-only guard** (v0.4.0+): `read_only` on `ecs_exec` / `ecs_diagnose` rejects write operations before they reach a shell (redirects, `rm`/`mv`/`cp`/`chmod`, `docker`/`systemctl` mutations, `nohup`, …); on by default for `ecs_diagnose`, with zero false positives on the built-in diagnostic script
- **Transfer integrity** (v0.4.0+): `ecs_upload.verify_sha256` compares local/remote digests after upload; `ecs_deploy` enables it by default and **aborts before restart** on a mismatch. Local hashing uses `sha256sum`/`shasum`/`certutil`, so no extra runtime is required
- **Background jobs**: `ecs_exec` supports `run_in_background` — long commands register with jobs, `job_output` reads incrementally, `job_kill` cancels
- **Runbooks** (v0.6.2+): keep an orchestration as **pure data** in `<workspace>/.dsh/workbench-ecs/runbooks/*.json` and run it with `ecs_deploy { runbook: "release", runbook_params: { sha } }` in one call; the plugin only supplies the mechanism (load / validate / `${param}` substitution / expansion) while **the content and script bodies stay in the project repository** — reviewable, versioned, and free of plugin-side project logic. The settings panel can also **list / validate / preview / execute** the same runbook (shared engine, byte-identical preview); the `ecs_runbook` tool gives read-only static checks (typos, missing params, weak assertions, guard conflicts) and shell variables escape as `$${NAME}`
- **Multi-step orchestration** (v0.6.0+): `ecs_deploy { steps: [...] }` expresses "upload → run → assert → read log" as one call; `assert` evaluates `expect` checks and reports **exactly which assertion failed, what was expected, and what actually happened**; `dry_run` previews the commands without executing. A release drops from a dozen calls to one
- **Batch execution**: `ecs_exec` supports an `instance_ids` array (per-instance failures do not stop others); `concurrency` controls parallelism (default 4 when `read_only`, otherwise serial) while the same instance still serializes behind its lock — cluster triage no longer queues one host at a time (v0.5.1+)
- **Recursive directory upload** (v0.5.1+): `ecs_upload { local_dir: "dist" }` does "local `tar` → upload → sha256 verify → remote extract" in one call; a checksum mismatch **aborts the extract**, so a corrupt archive never rewrites the remote directory
- **Structured output** (v0.5.1+): `output_json: true` returns stable JSON text for downstream automation (`ecs_exec` / `ecs_list`)
- **Background jobs**: `ecs_exec` supports `run_in_background` — long commands are registered with the jobs service, read incrementally with `job_output`, terminated with `job_kill`; with a batch, each instance gets its own job and the call returns `job_ids` (v0.5.1+)
- **Per-instance serialization**: operations touching the same instance run one at a time (FIFO), so concurrent calls can never interleave output through the shared Workbench session; different instances still run in parallel. Detached tasks only hold the lock during each poll instead of for the whole run (v0.5.0+)
- **Large-output spill**: oversized stdout spills to disk with the full path returned, so log triage never loses the head
- **Output cleanup**: ANSI escapes, control characters and CLI progress frames (spinners, percentage bars) are stripped by default, so logs and upload results stay readable (`strip_ansi: false` opts out)
- **Reliable exit codes**: the remote `exit_code` from the CLI's JSON is authoritative (rather than the local process status), and `request_id`/`session_id` come back for after-the-fact isolation checks
- **Robust binary resolution**: resolves `workbench` via PATH and falls back to common install locations (e.g. `C:\Program Files\workbench\workbench.exe`), handling stale host-process PATH
- **Cancellation support**: aborted tool calls terminate the process tree (SIGTERM → SIGKILL), leaving no orphan processes

## Installation

### Prerequisites

- Node.js ≥ 20 with a running DeepSeek Harness `dsh web`;
- The official Workbench CLI installed and authenticated **on the same machine** (see [Before first use](#before-first-use) below).

### Install via the official dsh command

```bash
dsh plugin --profile web add dsh-workbench-ecs
```

That's it — the bundle layer inserts the plugin row into the web profile: the 7 tools become visible to the Agent and a **"Workbench ECS"** tab appears in the harness settings (gear icon). Restart `dsh web` when hot reload is unavailable.

> For local development from a checkout, link the repo instead:
> `dsh plugin --profile web add link:<absolute-path-to-repo>` — subsequent `lib/client.js` edits apply after a plain page refresh (no server restart).

### Verify

```bash
curl -s http://127.0.0.1:3080/dsh-workbench-ecs/health
# => {"ok":true,"plugin":"dsh-workbench-ecs","version":"0.6.1"}
```

Then ask the Agent:

```text
ecs_list { region: "cn-shanghai" }
ecs_exec { instance_id: "i-uf66ct2o35p7fjcd0sru", command: "df -h" }
ecs_diagnose { instance_id: "i-uf66ct2o35p7fjcd0sru" }
```

### Before first use: Workbench CLI & credentials

#### Install the Workbench CLI (required)

| Platform | Command |
|---|---|
| Windows (PowerShell) | `irm https://workbench-cli.oss-cn-hangzhou.aliyuncs.com/install.ps1 \| iex` |
| Linux / macOS | `curl -fsSL https://workbench-cli.oss-cn-hangzhou.aliyuncs.com/install.sh \| bash` |

Verify after install:

```bash
workbench version     # should print version / commit / build date
```

> ⚠️ **Windows note**: if you installed the CLI *after* the Harness process started, the host process's inherited `PATH` is stale and `workbench` will not resolve on its own. The plugin includes a fallback scan of common install locations, so it usually works without a restart; if it still fails, restart the Harness session or add the install directory (e.g. `C:\Program Files\workbench`) to `PATH`.

#### Configure credentials

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

#### Minimum RAM policy (recommended)

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

#### Manual install (advanced)

Add the plugin row to your Cordis composition instead (cordis.yml / cordis.patch.yml):

```yaml
- id: dsh-workbench-ecs
  name: dsh-workbench-ecs
```

Note: the browser settings panel is only wired up by the `dsh` command (which uses the package's `dsh.bundle` layer and `dsh.client` declarations).

#### Local development from a checkout

Use [`scripts/install-local.ps1`](./scripts/install-local.ps1) to link the repo into `%DSH_HOME%` with a junction and write the plugin row for you (`install` / `status` / `uninstall`) — edits apply on the next patch reload or `dsh web` restart.

## Settings panel

| Area | Capabilities |
|---|---|
| CLI status | CLI availability / version / credential profile / daemon; **20s host cache + instant local render** (panel opens immediately, refreshes silently in the background; [Refresh] forces a re-check) |
| ECS instances | region / status filters, name-or-ID search, status distribution strip, checkboxes for batch actions, **30s auto-refresh** |
| Row actions | [Run] pick target / [Diagnose] one-shot health check (disk · memory gauges) / [Deploy] guarded publish wizard / [Details] metadata + recent logs |
| Remote command | command history (datalist), two-click confirmation for destructive patterns (host still rejects); batch execution with per-instance result table |
| Guarded deploy | upload local file (OSS relay, ≤1GB) + restart/apply command + health check, 3-stage progress; save/reuse templates; **mode switchable to "Runbook"** (run a workspace runbook, with preview) (v0.6.2+) |
| Runbook (release runbook) | scans `<workspace>/.dsh/workbench-ecs/runbooks/*.json` and lists name / description / step count / kinds / declared params plus the **static check verdict** (a broken file is flagged invalid without hiding the others); per row: **Validate** (read-only, item-by-item error/warn with step positions) / **Preview** (zero side effects) / **Execute**; results render per step, including `skipped` markers and per-assertion ✔/✘ (v0.6.2+, checks in v0.6.3+) |
| Workbench sessions | session list / close one / close all (troubleshooting & resource reclamation) |
| Operation timeline | every panel action is logged for the current session |

The panel talks to the **local** Workbench CLI through a same-origin route (`/dsh-workbench-ecs/rpc`, registered by `lib/index.js`) — no LLM/Agent in the loop, so the destructive-command guard is **deny-first** (for approval-gated execution use the Agent's `ecs_exec` tool instead). The UI auto-adapts to light/dark themes.

## How it works

This package is a DSH **static two-half plugin**, composed into the DSH web profile as a **bundle layer**:

| Half | File | Responsibility |
|---|---|---|
| Host half (Node) | `lib/index.js` | Registers the 9 model tools with `tools`, and same-origin routes `/dsh-workbench-ecs/health` & `/dsh-workbench-ecs/rpc` with `webServer`; the settings RPC runs the local CLI through `subprocess` (shared `lib/common.js` / `lib/settings-api.js` / `lib/steps-engine.js`; runbook mechanism in `lib/runbooks.js`) |
| Browser half | `lib/client.js` | Single-file client bundle (`window.__ModuleLoader__` factory form): registers the "Workbench ECS" settings tab and talks to the host over the same-origin RPC route |
| Composition | `cordis.patch.yml` | `dsh.bundle` patch: inserts the plugin row into the profile composition — active on `dsh web` startup, picked up automatically by `dsh plugin --profile web add` |

Zero build on both ends: `lib/client.js` is a hand-written single-file bundle, no bundler required; the same `lib/` sources can also be mounted as a temporary dynamic body (`npm run build:body`).

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
| `vpc_id` | string | | VPC ID filter (v0.5.1+) |
| `vswitch_id` | string | | VSwitch ID filter (v0.5.1+) |
| `zone_id` | string | | Zone filter (v0.5.1+), e.g. `cn-shanghai-a` |
| `private_ip` | array\<string\> | | Private IP filter (v0.5.1+), repeatable |
| `image_id` | string | | Image ID filter (v0.5.1+) |
| `limit` | integer | | Page size 10–100, default 50 (ECS API page-size floor is 10) |
| `next_token` | string | | Token returned by the previous page (v0.5.1+, passed through to the CLI) |
| `output_json` | boolean | | Return stable JSON text instead of the rendered table (v0.5.1+) |

Returns the instance list (instance IDs feed the other tools), rendered as a text table.

> **Pagination status (measured on v0.5.1)**: `list ecs --output json` returns **only `instances`** — no `NextToken`/`TotalCount` — so the plugin cannot page automatically. When the result count reaches `limit` and the CLI returned no token, the value carries a `pagination_note` that says so explicitly (instead of letting the model assume "that's all"). Mitigation: tighten the filters (`instance_name`/`tag`/`status`/`vpc_id`/`zone_id`). A real fix needs the CLI to expose `NextToken` in its JSON output (tracked as an upstream ask in `docs/workbench-ecs-改良计划-20260912.md`).

### `ecs_exec` — run a remote command on an instance (enhanced)

CLI equivalent: `workbench exec --instance-id <id> --command <cmd> [--timeout <s>] --output json`

| Parameter | Type | Required | Description |
|---|---|---|---|
| `instance_id` | string | | Target instance ID (alternate with `instance_ids`) |
| `instance_ids` | array\<string\> | | Batch targets (max 20, per-instance failures do not stop others; `concurrency` optional) |
| `concurrency` | integer | | Batch parallelism (v0.5.1+; defaults to 4 when `read_only`, otherwise 1/serial). Same-instance calls still serialize behind the instance lock — only cross-instance work truly parallelizes |
| `command` | string | | Remote command (alternate with `script`); chain with `&&` or `;` when shared context is needed |
| `script` | string | | Script body (alternate with `command`). **Zero escaping**: the text is base64-delivered to a remote file and executed, so quotes, Chinese, `$`, backticks, multi-line and heredocs need no handling |
| `shell` | `bash`\|`sh` | | Interpreter for `script` mode, default `bash` |
| `keep_script` | boolean | | Keep the remote temp script (default false; removed after execution) |
| `read_only` | boolean | | Read-only guard: reject write operations (default false) |
| `description` | string | | Short purpose note (shown in the job list and card title) |
| `strip_ansi` | boolean | | Strip ANSI/control chars/progress frames (default true) |
| `timeout` | integer | | Remote command timeout in seconds, default 60 (always sent explicitly; the CLI default is only 30) |
| `region` | string | | Region, optional (CLI infers it from the instance ID) |
| `run_in_background` | boolean | | Run long commands in the background: returns a `job_id`, read with `job_output`; combined with `instance_ids` each instance gets its own job and the call returns `job_ids` (v0.5.1+) |
| `detach` | boolean | | **Remote detached task** (recommended for release/build work lasting minutes to hours): remote `nohup` + log file, returns `job_id`/`log_path`/`exit_path` immediately; polls increments without holding the instance |
| `poll_interval` | integer | | Detach poll interval in seconds, default 2 |
| `max_duration` | integer | | How long the plugin tracks a detached task, default 3600s; on expiry it stops tracking (the remote task keeps running) |
| `session_id` | string | | **Pseudo-session**: keeps cwd/env across calls with the same id; single-instance foreground only |
| `session_reset` | boolean | | Clear this session's cwd/env before executing |
| `env` | array\<string\> | | Session-persistent environment entries, each `K=V`, merged with existing ones |
| `output_json` | boolean | | Return stable JSON text (v0.5.1+; for downstream automation), default false renders readable text |

Returns `{ kind: single|batch|batch_background|background|detached, ... }` (including `exit_code` / `request_id` / `cli_session_id`, plus `session_cwd` / `env_keys` in session mode and `concurrency` for batches).

**When to use `script`**: whenever the command contains nested quotes. Compare —

```text
# Fragile (three quoting layers: remote sh -c + docker exec + node -e)
ecs_exec { instance_id: "i-xxx", command: "docker exec app node -e \"console.log('hi')\"" }

# Zero escaping (recommended)
ecs_exec { instance_id: "i-xxx", script: "docker exec app node -e \"console.log('hi')\"" }
```

### `ecs_log` — read a remote file by byte cursor (read-only)

CLI equivalent: `workbench exec` (only `wc -c` / `tail -c` / `head -c` / `cat` — strictly read-only)

| Parameter | Type | Required | Description |
|---|---|---|---|
| `instance_id` | string | ✅ | Target instance ID |
| `path` | string | ✅ | Remote file path, e.g. `/tmp/.dsh-ecs-xxx/out.log` |
| `after` | integer | | Starting byte offset (the previous `next_offset`; 0 on the first read) |
| `max_bytes` | integer | | Maximum bytes per read, default 262144; when `truncated=true`, read again immediately |
| `exit_file` | string | | Optional remote exit-code file; when present, its value is returned as `exit_code` |
| `region` / `timeout` | | | Region / timeout in seconds (default 60) |

**Usage**: polling a release/build log is `ecs_log { path: "<log>", after: <last next_offset> }` — no more full `tail`s plus eyeballing the delta. Combined with a detached task's `log_path`, arbitrarily long logs stay fully readable from the start.

### `ecs_upload` — upload a local file to an instance

CLI equivalent: `workbench upload <local-file> <remote-path> --instance-id <id> [--force]`

| Parameter | Type | Required | Description |
|---|---|---|---|
| `local_file` | string | | Local file path (relative paths resolve against the session workspace); alternate with `local_dir` |
| `local_dir` | string | | Local directory (**recursive upload**, v0.5.1+): local `tar` → upload → remote extract; alternate with `local_file` |
| `remote_path` | string | ✅ | Remote target. For `local_file`: a path (a trailing separator means directory, the file name is appended). For `local_dir`: the **target directory** |
| `instance_id` | string | ✅ | Target instance ID |
| `region` | string | | Region, optional |
| `force` | boolean | | Overwrite an existing remote file without confirmation (default false) |
| `verify_sha256` | boolean | | Compare local/remote sha256 after upload (default false; recommended on release paths. In directory mode a mismatch **aborts the extract**) |
| `keep_root_dir` | boolean | | Directory mode: keep the archive's top-level directory name (default false — only the directory contents are uploaded) |
| `keep_archive` | boolean | | Directory mode: keep the remote archive after extraction (default false — removed) |
| `timeout` | integer | | Directory mode: timeout for the remote extract command in seconds, default 120 |

Transfers through Alibaba Cloud OSS (up to 1GB). Returns `verification` (`ok` / `mismatch` / `remote-unavailable` / `local-tool-unavailable`) plus both digests. Pair with `ecs_deploy` / `ecs_exec` for deployments.

**Recursive directory upload** (v0.5.1+) collapses "pack locally → upload → extract remotely" into one call with a fixed order of **archive → upload → verify → extract**: on a sha256 mismatch the extract command is never issued, so a corrupt archive cannot rewrite the remote directory. Returns `entries` (archive entry count) / `extracted` / `local_archive_cleanup`. The local archive is staged in the session workspace root and removed afterwards (`.dsh-ecs-upload-*.tar.gz`). Requires local `tar` (bundled with Windows 10+ / Linux).

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
| `extra_command` | string | | Extra read-only command |
| `read_only` | boolean | | Read-only guard, **default true**; pass `false` to allow writes in `extra_command` |
| `description` | string | | Short purpose note |
| `strip_ansi` | boolean | | Strip ANSI/control chars/progress frames (default true) |
| `timeout` | integer | | Timeout in seconds, default 120 (always sent explicitly) |

Built-in 7 sections: host info / uptime & load / memory / disk / running services & containers (`docker ps`) / top memory processes / listening ports. **The starting point of production debugging** — one tool instead of a command string.

### `ecs_deploy` — guarded deployment / multi-step orchestration

Two usages: **(A) the classic three phases** (upload → verify → restart → health check) and **(B) `steps` orchestration** (v0.6.0+).

**(A) Classic phases**

| Parameter | Type | Required | Description |
|---|---|---|---|
| `instance_id` | string | ✅ | Target instance ID |
| `command` | string | | Restart/apply command, e.g. `docker compose restart` (not needed with `steps`) |
| `local_file` | string | | Optional local file to upload |
| `remote_path` | string | | Upload target path (required when `local_file` is set) |
| `health_check` | string | | Optional health-check command, e.g. `curl -fsS http://127.0.0.1/health \|\| true` |
| `verify_sha256` | boolean | | Verify sha256 after upload, **default true**; a mismatch aborts the deployment before restart |
| `region` / `force` / `timeout` | | | Region / overwrite confirmation / per-phase timeout in seconds (default 180) |

All phases return their results (a failing phase does not stop later ones): upload → sha256 verify → restart → health check — with the one exception that a verification failure aborts (`aborted` / `abort_reason`), so a corrupt artifact never gets deployed.

**(B) `steps` orchestration (v0.6.0+)** — model a whole sequence on one instance as a **single call**:

| Step | Fields | Description |
|---|---|---|
| `upload` | `local_file`, `remote_path`, `force?`, `verify_sha256?` | Upload; `verify_sha256` defaults to true and a mismatch **aborts the whole run** |
| `exec` | `command` \| `script`, `timeout?`, `read_only?`, `description?` | Run a command or a script (`script` uses zero-escape base64 delivery) |
| `assert` | `command` \| `script`, `expect` | Assertions: `expect: { exit_code?, stdout_contains?, stdout_not_contains?, stderr_contains? }` |
| `tail` | `path`, `after?`, `max_bytes?`, `exit_file?`, `wait_seconds?` | Read a remote log by **byte cursor**; `wait_seconds` waits for `exit_file` to appear |

Run-level parameters: `dry_run` (print the plan without executing — and **without requesting approval**), `continue_on_error` (default false: the first failure stops the run and remaining steps are marked `skipped`), `read_only` (guard every exec/assert step), `timeout` (global default, 180s). Maximum 20 steps.

**Per-step timeout (v0.6.6)**: a step's own `timeout` **overrides** the global value. Previously only the global value was honoured, so the per-step `timeout` promised by the tool schema was silently ignored: long steps (a release script, say) were still cut off by the CLI at the global 180s, and the plan preview showed a number you never wrote. The cap is 3600s (larger values are clamped) and non-positive values are ignored — lint warns about both, and previews report the `timeout` that will actually apply.

```jsonc
// One call: upload → assert → restart → assert → read log
{
  "instance_id": "i-xxx",
  "steps": [
    { "kind": "upload", "local_file": "dist/app.jar", "remote_path": "/opt/app/app.jar", "force": true },
    { "kind": "assert", "command": "test -s /opt/app/app.jar && echo size-ok",
      "expect": { "exit_code": 0, "stdout_contains": ["size-ok"] } },
    { "kind": "exec", "command": "docker compose up -d --force-recreate", "timeout": 300 },
    { "kind": "assert", "script": "curl -fsS http://127.0.0.1/health", "expect": { "stdout_contains": ["\"ok\":true"] } },
    { "kind": "tail", "path": "/tmp/release.log", "exit_file": "/tmp/release.exit", "wait_seconds": 60 }
  ]
}
```

Returns `mode` (`legacy` / `steps`), `ok`, `done_stage`/`total_stage`, `stopped_at`/`stopped_reason`/`failed_steps`, and per-step `stages` (assert steps carry per-check `assertions`; tail steps carry `next_offset`/`total_bytes`/`eof`). **Failures point at the exact step and the exact assertion** instead of requiring someone to read the log.

**(C) Runbooks (v0.6.2+)** — store an orchestration as **pure data**; the plugin supplies only the mechanism:

| Parameter | Description |
|---|---|
| `runbook` | `"name"` → reads `<workspace>/.dsh/workbench-ecs/runbooks/<name>.json`; or an inline object `{ name?, description?, params?, steps }` |
| `runbook_params` | Parameter object: overrides the runbook's `params` defaults and substitutes `${name}` placeholders; `${instance_id}` / `${region}` are implicit |

```jsonc
{
  "name": "release",
  "params": { "sha": "latest", "log": "/tmp/release.log" },
  "steps": [
    { "kind": "upload", "local_file": "dist/app.jar", "remote_path": "/opt/app/app.jar", "force": true },
    { "kind": "exec", "script": "bash /opt/app/deploy/release.sh ${sha} > ${log} 2>&1; echo $? > ${log}.exit", "timeout": 600 },
    { "kind": "assert", "command": "curl -fsS http://127.0.0.1/health", "expect": { "stdout_contains": ["\"ok\":true"] } },
    { "kind": "tail", "path": "${log}", "exit_file": "${log}.exit", "wait_seconds": 300 }
  ]
}
```

**Deliberate boundary**: the plugin supplies the *mechanism* (load / validate / substitute params / expand into `steps`); the *content* — steps, assertions, and script bodies — stays in the project repository. `${name}` is substituted inside any string, and a string that is exactly one placeholder **keeps its original type** (`"timeout": "${t}"` with `t=300` yields the number 300); a missing parameter fails loudly and lists the runbook's declared placeholders; unused inputs are reported as `unused_params`. Names are restricted to `[A-Za-z0-9._-]` (no path traversal). Requires the `fs` service; without it, use an inline `runbook` object.

- **Runbook directory = the session workspace**: the plugin resolves `<workspace>/.dsh/workbench-ecs/runbooks/` from `exec.agent.session.header.cwd` (the same source DSH built-in tools use), so runbooks living in your **project repository** are found, and relative `local_file` paths run with that directory as cwd. The settings panel has no session context, so it **follows the most recent agent session workspace** by default and lets you type an explicit directory (leave it empty to follow).

**(D) Run the same runbook from the panel (v0.6.2+)** — the settings panel's "Runbook" card scans the workspace runbook directory, lists name / description / step count / kinds / declared params, and offers per-row **Preview** (echoes the command lines only, zero side effects) and **Execute**; the publish wizard can also switch into "Runbook" mode.

- The panel and the Agent share **one orchestration engine** (`lib/steps-engine.js`), so a previewed command line is byte-for-byte what the Agent would send — no "works in the panel, fails through the tool" drift;
- **Guard difference (intentional)**: the panel has no approval context, so a destructive command pattern is **rejected outright** with the offending step index (use the Agent's `ecs_deploy` for approval-gated execution); `read_only` steps are pre-checked by the read-only guard;
- Panel-side RPC operations: `runbook-list` / `runbook-validate` / `runbook-plan` / `runbook-run` (same-origin route `/dsh-workbench-ecs/rpc`), each accepting `dir` to point at an explicit runbook directory;

### `ecs_runbook` — read-only inventory & static checks for workspace runbooks (v0.6.3+)

CLI equivalent: **none** — this tool runs no CLI command and never touches an ECS instance (local files + pure logic only)

| Parameter | Type | Required | Description |
|---|---|---|---|
| `action` | string | ✅ | `list` all runbooks with their check verdict; `validate` one runbook item by item; `plan` expand with params and echo the commands (no execution) |
| `runbook` | string \| object | validate / plan | `"name"` → reads `<workspace>/.dsh/workbench-ecs/runbooks/<name>.json`; or an inline object |
| `runbook_params` | object | | parameter object (overrides defaults, substitutes `${placeholders}`); `instance_id` / `region` are implicit |
| `instance_id` / `region` | string | | optional: display-only for `plan` (defaults to `<instance_id>`) |

**Why run it first**: a runbook is **pure data**, so every mistake can be found before a single command is sent. Checks include:

| Category | Example |
|---|---|
| Structure (the **same** validation the executor uses, identical wording) | illegal `kind`, upload missing `local_file`/`remote_path`, both `command` and `script`, more than 20 steps |
| Field typos (the sneakiest: unknown fields are silently ignored) | `commnad` → `did you mean command?` |
| Weak assertions | `assert` with an empty `expect` → in effect only `exit_code=0` is checked |
| Guard conflict | `read_only: true` whose command matches a write pattern → execution is guaranteed to be rejected (reported as an error) |
| Destructive commands | matches `rm -rf` / `systemctl stop` … → warns that the Agent path needs approval and the panel rejects it |
| Parameters | missing params (error; ALL-CAPS names get a `$${NAME}` escaping hint), unused inputs, `params` defaults never used |
| Tail semantics | neither `wait_seconds` nor `exit_file` → it reads once (you may catch a half-written log) |

```
# recommended order: read-only checks, then preview, then execute
ecs_runbook { action: "validate", runbook: "release", runbook_params: { sha: "abc123" } }
ecs_runbook { action: "plan",     runbook: "release", instance_id: "i-xxx", runbook_params: { sha: "abc123" } }
ecs_deploy  { instance_id: "i-xxx", runbook: "release", runbook_params: { sha: "abc123" } }
```

> **Escape shell variables**: `${NAME}` is treated as a runbook placeholder; write `$${NAME}` to leave `${NAME}`
> for the remote shell (kept verbatim, and not counted as a declared parameter).
> The settings panel's Runbook card has the same **Validate** button (equivalent to `validate`, touches no instance).

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
- **Read-only guard** (v0.4.0+): with `read_only=true`, write operations are rejected before the command reaches a shell — redirects other than `/dev/null`, `rm`/`mv`/`cp`/`mkdir`/`touch`/`chmod`/`chown`/`truncate`, `tee`, `sed -i`, `docker`/`docker compose` mutations, `systemctl`/`service` state changes, package managers, `git` writes, `kill`/`nohup`, `crontab`/user management, `find -delete/-exec`. This is a guard rail, not a sandbox (dynamic assembly can still evade it); hard enforcement stays with the approval service.
- **Read-only diagnostics**: `ecs_diagnose` sections are read-only and the guard is on by default; custom commands still pass the safety guard.
- **Transfer integrity**: `ecs_upload.verify_sha256` / `ecs_deploy.verify_sha256` (on by default for deploys) compare local and remote sha256 so a corrupt artifact is caught before any restart.
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
npm test             # unit regressions (no instance needed) + smoke test: module exports + 8-tool contract + body consistency
npm run test:unit    # unit regressions only: base64 / read-only guard / timeout defaults / output cleanup / sha256
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
