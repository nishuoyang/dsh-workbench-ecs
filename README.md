# dsh-workbench-ecs

> v0.8.0 · MIT License

English | [中文](README.zh.md)

> A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (Cordis) plugin that lets the Agent control remote Alibaba Cloud ECS instances through the local Workbench CLI.

It drives the official Alibaba Cloud [Workbench CLI](https://help.aliyun.com/zh/ecs/user-guide/use-workbench-cli-to-manage-ecs-instances) locally, and ships **11 agent-native tools** — `ecs_find` / `ecs_list` / `ecs_exec` / `ecs_log` / `ecs_upload` / `ecs_download` / `ecs_diagnose` / `ecs_deploy` / `ecs_runbook` / `ecs_snapshot` / `ecs_session` — covering the full *find → list → diagnose → execute → upload → restart → verify → snapshot check* loop, plus a **visual settings panel** (CLI status, instance browser, guarded deploy wizard, sessions, operation timeline). Instances are reached through the Workbench backend channel, so **no public IP is needed**; destructive commands go through the Harness approval guard and are rejected unless explicitly allowed (fail closed).

## Features

- **11 Agent-native tools** (v0.8.0+ adds `ecs_snapshot`, v0.7.0+ adds `ecs_find`): `ecs_find` / `ecs_list` / `ecs_exec` / `ecs_log` / `ecs_upload` / `ecs_download` / `ecs_diagnose` / `ecs_deploy` / `ecs_runbook` / `ecs_snapshot` / `ecs_session`, integrated with the Harness tool pipeline
- **Release snapshots `ecs_snapshot`** (v0.8.0+): makes "the **rollback point** before you touch anything + the **difference check** afterwards" a first-class concern instead of a hand-written `docker tag` + `docker cp` + `docker images/ps` assembly script per agent — `create` runs one **read-only** collection (default collectors: host info / `docker images --digests` / `docker ps` / `ss -tln`, plus `paths` file-and-directory fingerprints and `commands` custom collectors) and writes the manifest into the workspace at `.dsh/workbench-ecs/snapshots/<name>.json` (**diffable, committable, greppable**); `list` makes no remote call at all; `diff` re-collects with the collectors recorded in the manifest and compares item by item (files `added`/`removed`/`changed`/`metadata-only`, collector output reported down to the **first differing line**), and `against` compares two snapshots with each other
- **Runbook parameter contracts** (v0.8.0+): `params` grows from "just a default" into a **parameter descriptor** `{ required, pattern, enum, default, description, hint }` (the scalar form still means a default, fully backward compatible) and it covers implicit parameters too (including instance-anchor fields) — a missing required parameter, a `pattern` mismatch or an `enum` mismatch is caught by `validate` / `plan` **before any command is sent**. The settings panel's **Validate** button and the pre-execution checks share **one implementation**, so "the panel said OK but execution blew up" cannot happen
- **Replay advice and `from_step`** (v0.8.0+): `ecs_runbook validate/plan`, `ecs_deploy dry_run` and **failure results** all carry step-by-step idempotency analysis in a "replay advice" block (`safe_prefix` plus one directly actionable conclusion, e.g. "the first 2 steps can be repeated; step 3 onwards may have side effects — either re-run the whole runbook, or use from_step: 2 to continue from that step"). `ecs_deploy { from_step: N }` skips the steps with `[i] < N`, and both the preview and the real result explicitly list `skipped_prefix` while warning that "the side effects of these steps will not be recreated"
- **Cross-region search `ecs_find`** (v0.7.0+): answers "which region is my instance actually in" without guessing a region first — `keyword` substring-matches instance name / instance ID / private IP / public IP / instance type / tag values (case-insensitive), and an omitted `region` (or `"all"`) concurrently searches the built-in list of **22 public regions**, or pass one region or several comma-separated ones. There is **no early stop on first hit** (listing too few instances is far more dangerous than listing too many): results are grouped per region and the call reports `regions_tried` / `regions_ok` / `regions_failed` (a failing region never hides the others) / `scanned`, and it also lists the workspace instance anchors. `ecs_list` stays "region required, single region"; when that region returns 0 instances the result carries an `empty_hint` pointing at `ecs_find`
- **Project-level instance anchors** (v0.7.0+): record your usual machines in the workspace file `.dsh/workbench-ecs/instances.json` (**the plugin defines the format, the project fills in the content**), and afterwards **every tool that accepts `instance_id` / `instance_ids`** (`ecs_exec` / `ecs_upload` / `ecs_download` / `ecs_diagnose` / `ecs_deploy` / `ecs_log` / `ecs_runbook`, …) accepts an anchor name directly (e.g. `"prod"`) — the plugin resolves it to the real instance ID at the tool-registration boundary and fills in the anchor's `region` when none was given, so every tool stays unchanged. Fields other than `instance_id`/`region` (such as `repo`) become **implicit runbook parameters**, so a runbook can write `${repo}` without passing it every time. Without the file, behaviour is exactly as before
- **Upload retries + failure attribution** (v0.7.0+): `ecs_upload` gains `retries` (default 2, i.e. up to 3 attempts) and `retry_delay` (default 1s, exponential backoff), and **only transient network failures are retried** while semantic failures (remote file already exists, permission denied, bad argument) fail immediately. Failure messages state the owner of the problem: the "local machine → OSS" hop, **not the target ECS instance**, and suggest simply re-running the same command later (uploads are idempotent). `verify_sha256` now **defaults to true** in all three places: `ecs_upload` / `ecs_deploy` (classic phases) / `steps[].upload`
- **Correct remote-timeout settlement + debuggable rejections** (v0.7.0+): when a remote command times out the CLI's JSON claims `exit_code: 0` with `timed_out: true` (the process exit code is really 124) — so the previous "JSON is authoritative" rule rendered **a killed command as "success with no output"**. From v0.7.0 on, everything settles to **`exit_code: 124` + `timed_out: true`** with `duration` and the timeout reason, and a timed-out step in an orchestration fails loudly. The read-only guard now lists **every** matched rule with its matched text and position plus concrete "read-only equivalent" advice; and a rejected destructive command explains **four distinct cases** (no approval service mounted / session policy `never` / user rejected / request cancelled or unattended) instead of collapsing into one "not approved", stating explicitly that "this is not a syntax error, re-running the same command will not change the outcome"
- **Detached long tasks + log cursor** (v0.5.0+): `ecs_exec { detach: true }` starts the job with remote `nohup`, writes a log file, and immediately returns `job_id`/`log_path`/`exit_path`; the plugin polls increments on an interval, so it never holds the instance for the whole run (other calls on the same instance interleave normally) and the remote log file stays the single source of truth — a slow reader can no longer lose or duplicate segments. `ecs_log` reads any remote file by **byte cursor**, so release-log polling no longer needs repeated full `tail`s
- **Pseudo-sessions** (v0.5.0+): `ecs_exec { session_id: "deploy" }` keeps the working directory and environment across calls (`cd`/`export` carry over), different session ids stay isolated, and an idle session resets after 30 minutes with an explicit notice
- **Visual settings panel** (v0.3.0+): CLI status with 20s host cache + instant local render, instance browser (search / batch / 30s auto-refresh), one-click diagnostics with disk & memory gauges, guarded publish wizard with templates (switchable to Runbook mode), session management, operation timeline — auto-adapts to light/dark themes
- **Real API calls**: tools run the local `workbench` command and reach instances through the Alibaba Cloud Workbench backend (works for instances **without public IPs**)
- **JSON parsing + readable rendering**: parses CLI JSON output into tables/text/terminal cards; CLI-level errors (`{code, message}`) become readable messages
- **Safety guard**: destructive commands (`rm -rf`, `shutdown`, `reboot`, `mkfs`, `dd`, `iptables -F/-X`, …) request confirmation through the Harness approval service; anything not `allowed-once` is rejected (fail closed)
- **Script delivery** (v0.4.0+): `ecs_exec`'s `script` parameter base64-delivers the body to a remote file and executes it, so the content never passes through a shell quoting layer — `docker exec ... node -e "..."`, Chinese text, `$`, backticks, heredocs and multi-line scripts all work with **zero escaping**; bodies over 16KB are delivered in chunks and verified by byte count
- **Read-only guard** (v0.4.0+): `read_only` on `ecs_exec` / `ecs_diagnose` rejects write operations before they reach a shell (redirects, `rm`/`mv`/`cp`/`chmod`, `docker`/`systemctl` mutations, `nohup`, …); on by default for `ecs_diagnose`, with zero false positives on the built-in diagnostic script
- **Transfer integrity** (v0.4.0+): `ecs_upload.verify_sha256` compares local/remote digests after upload (on by default since v0.7.0, unified with `ecs_deploy`) and **aborts before restart** on a mismatch. Local hashing uses `sha256sum`/`shasum`/`certutil`, so no extra runtime is required
- **Background jobs**: `ecs_exec` supports `run_in_background` — long commands are registered with the jobs service, read incrementally with `job_output`, terminated with `job_kill`; with a batch, each instance gets its own job and the call returns `job_ids` (v0.5.1+)
- **Runbooks** (v0.6.2+): keep an orchestration as **pure data** in `<workspace>/.dsh/workbench-ecs/runbooks/*.json` and run it with `ecs_deploy { runbook: "release", runbook_params: { sha } }` in one call; the plugin only supplies the mechanism (load / validate / `${param}` substitution / expansion) while **the content and script bodies stay in the project repository** — reviewable, versioned, and free of plugin-side project logic. The settings panel can also **list / validate / preview / execute** the same runbook (shared engine, byte-identical preview); the `ecs_runbook` tool gives read-only static checks (typos, missing params, weak assertions, guard conflicts) and shell variables escape as `$${NAME}`; five **generic runbook templates** ship with the package (v0.6.7+: `host-check` / `compose-redeploy` / `disk-cleanup` / `tls-cert-check` / `log-dig`) — copy one into any project and it works
- **Multi-step orchestration** (v0.6.0+): `ecs_deploy { steps: [...] }` expresses "upload → run → assert → read log" as one call; `assert` evaluates `expect` checks and reports **exactly which assertion failed, what was expected, and what actually happened**; `dry_run` previews the commands without executing. A release drops from a dozen calls to one
- **Batch execution**: `ecs_exec` supports an `instance_ids` array (per-instance failures do not stop others); `concurrency` controls parallelism (default 4 when `read_only`, otherwise serial) while the same instance still serializes behind its lock — cluster triage no longer queues one host at a time (v0.5.1+)
- **Recursive directory upload** (v0.5.1+): `ecs_upload { local_dir: "dist" }` does "local `tar` → upload → sha256 verify → remote extract" in one call; a checksum mismatch **aborts the extract**, so a corrupt archive never rewrites the remote directory
- **Structured output** (v0.5.1+): `output_json: true` returns stable JSON text for downstream automation (`ecs_exec` / `ecs_list`)
- **Per-instance serialization**: operations touching the same instance run one at a time (FIFO), so concurrent calls can never interleave output through the shared Workbench session; different instances still run in parallel. Detached tasks only hold the lock during each poll instead of for the whole run (v0.5.0+)
- **Large-output spill**: oversized stdout spills to disk with the full path returned, so log triage never loses the head
- **Output cleanup**: ANSI escapes, control characters and CLI progress frames (spinners, percentage bars) are stripped by default, so logs and upload results stay readable (`strip_ansi: false` opts out)
- **Reliable exit codes**: the remote `exit_code` from the CLI's JSON is authoritative (rather than the local process status), and `request_id`/`session_id` come back for after-the-fact isolation checks; **a remote timeout settles as `124` + `timed_out: true` first** (v0.7.0+ — the CLI's JSON lies with `exit_code: 0` on timeout; see "New remote-timeout semantics" below)
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

That's it — the bundle layer inserts the plugin row into the web profile: the 11 tools become visible to the Agent and a **"Workbench ECS"** tab appears in the harness settings (gear icon). Restart `dsh web` when hot reload is unavailable.

> For local development from a checkout, link the repo instead:
> `dsh plugin --profile web add link:<absolute-path-to-repo>` — subsequent `lib/client.js` edits apply after a plain page refresh (no server restart).

### Verify

```bash
curl -s http://127.0.0.1:3080/dsh-workbench-ecs/health
# => {"ok":true,"plugin":"dsh-workbench-ecs","version":"0.8.0"}
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
| Runbook (release runbook) | scans `<workspace>/.dsh/workbench-ecs/runbooks/*.json` and lists name / description / step count / kinds / declared params plus the **static check verdict** (a broken file is flagged invalid without hiding the others); per row: **Validate** (read-only, item-by-item error/warn with step positions) / **Preview** (zero side effects) / **Execute**; results render per step, including `skipped` markers and per-assertion ✔/✘ (v0.6.2+, checks in v0.6.3+, **parameter contracts and replay advice in v0.8.0+** — the panel and the pre-execution check share one implementation) |
| Workbench sessions | session list / close one / close all (troubleshooting & resource reclamation) |
| Operation timeline | every panel action is logged for the current session |

The panel talks to the **local** Workbench CLI through a same-origin route (`/dsh-workbench-ecs/rpc`, registered by `lib/index.js`) — no LLM/Agent in the loop, so the destructive-command guard is **deny-first** (for approval-gated execution use the Agent's `ecs_exec` tool instead). The panel's RPC follows the same rule as the tools: a remote-command timeout settles as **`exit_code 124` + `timed_out: true`** (v0.7.0+), so a killed command is never rendered as a success. The UI auto-adapts to light/dark themes.

## How it works

This package is a DSH **static two-half plugin**, composed into the DSH web profile as a **bundle layer**:

| Half | File | Responsibility |
|---|---|---|
| Host half (Node) | `lib/index.js` | Registers the 11 model tools with `tools`, and same-origin routes `/dsh-workbench-ecs/health` & `/dsh-workbench-ecs/rpc` with `webServer`; the settings RPC runs the local CLI through `subprocess` (shared `lib/common.js` / `lib/settings-api.js` / `lib/steps-engine.js`; runbook mechanism in `lib/runbooks.js`, cross-region search in `lib/regions.js`, instance anchors in `lib/anchors.js`, release snapshots in `lib/snapshots.js` (v0.8.0+)) |
| Browser half | `lib/client.js` | Single-file client bundle (`window.__ModuleLoader__` factory form): registers the "Workbench ECS" settings tab and talks to the host over the same-origin RPC route |
| Composition | `cordis.patch.yml` | `dsh.bundle` patch: inserts the plugin row into the profile composition — active on `dsh web` startup, picked up automatically by `dsh plugin --profile web add` |

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

A template ships with the package at [`templates/instances.json`](./templates/instances.json) (copy it into a project alongside `templates/runbooks/`):

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

> **Next step when it returns 0 instances (v0.7.0+)**: the result carries an `empty_hint` telling the model the instance may live in another region and pointing at `ecs_find { keyword: "<name or IP>" }`.

### `ecs_find` — cross-region instance search (v0.7.0+)

CLI equivalent: `workbench list ecs --region <region> ... --output json` (run concurrently per region; **no single CLI command searches multiple regions**)

It answers **"which region is my instance in"** — without guessing a region first. The division of labour with `ecs_list` is deliberate:

| Tool | Question it answers | `region` |
|---|---|---|
| `ecs_list` | which instances live in this region | **required**, single region |
| `ecs_find` | which region my instance lives in | optional (= search everywhere), or one / several comma-separated regions |

| Parameter | Type | Required | Description |
|---|---|---|---|
| `keyword` | string | | Substring match against **instance name / instance ID / private IP / public IP / instance type / tag value**, case-insensitive |
| `region` | string | | Omitted or `"all"` = search the built-in list of **22 public regions**; or one region (`cn-shanghai`) or several comma-separated (`cn-shanghai,cn-hangzhou`) |
| `status` | string | | Status filter: `Running` / `Stopped` / `Starting` / `Stopping` |
| `instance_name` | string | | Instance-name filter (**CLI-side**, `*` wildcard supported); combinable with `keyword` |
| `tag` | array\<string\> | | Tag filter, each entry `key=value` or `key`, repeatable |
| `instance_type` | string | | Instance type filter, e.g. `ecs.g7.large` |
| `limit` | integer | | Page size **per region**, 10–100, default 50 |
| `concurrency` | integer | | Region concurrency, default 4 (cap 8) |
| `output_json` | boolean | | Return stable JSON text (default false renders readable text) |

**Behaviour (by design)**:

- **No early stop on first hit** — every candidate region is still queried even after instances matched in an earlier one. Listing too few instances is far more dangerous than listing too many;
- Results are **grouped per region** and report `regions_tried` / `regions_ok` / `regions_failed` (each failure as `{region, error}` — **a failing region never hides the others' results**) / `scanned`;
- When a region's result count reaches `limit` the value carries `regions_maxed` (the CLI JSON has no `NextToken`, so paging is impossible): tighten the filters or raise `limit` (≤100);
- It also lists the **workspace instance anchors** (see the previous section), answering "where is it" and "has the project recorded it" in one call.

```text
# you only remember the instance name or private IP
ecs_find { keyword: "nailong" }
ecs_find { keyword: "10.0.1.23" }

# search only two regions (much faster than the full list)
ecs_find { keyword: "prod", region: "cn-shanghai,cn-hangzhou" }

# survey one instance type across regions (no keyword)
ecs_find { instance_type: "ecs.g7.large", status: "Running" }
```

> **Why the plugin has to provide this (measured background)**: `--region all` **does not work** in the CLI (`invalid region "all": region does not exist or is not recognized`), there is **no "list regions" subcommand**, and a profile **cannot store a default region** (`workbench config set` only supports `language` / `log_level`; the default is always `cn-hangzhou`) — which is exactly the mechanism behind "0 instances in cn-hangzhou". Cross-region capability therefore exists only in the plugin: a built-in public-region list, queried concurrently, honestly reporting which regions were tried and which failed.

### `ecs_exec` — run a remote command on an instance (enhanced)

CLI equivalent: `workbench exec --instance-id <id> --command <cmd> [--timeout <s>] --output json`

| Parameter | Type | Required | Description |
|---|---|---|---|
| `instance_id` | string | | Target instance ID (alternate with `instance_ids`; a workspace anchor name also works, v0.7.0+) |
| `instance_ids` | array\<string\> | | Batch targets (max 20, per-instance failures do not stop others; `concurrency` optional; each entry may also be an anchor name, v0.7.0+) |
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

#### New remote-timeout semantics (v0.7.0+, **the single most important correction here**)

When a remote command times out, `workbench exec`'s JSON looks like this:

```json
{ "exit_code": 0, "timed_out": true, "duration": "3.002s" }
```

while the CLI process itself exits with **124**, and the actual reason appears only on stderr: `{"code":124,"message":"command timed out after 3s"}`.

The plugin used to treat the JSON's `exit_code` as authoritative (a rule that is correct in general — see [Reliable exit codes](#features)), so **a killed command was rendered as "success with no output"**: a long command cut off by the timeout looked like "it finished and printed nothing". That is the most dangerous kind of misinformation.

From v0.7.0 on, **`ecs_exec` / `ecs_diagnose` / `ecs_log` / `ecs_deploy` (including `steps` orchestration) / the settings-panel RPC all settle `timed_out` as `exit_code 124` + `timed_out: true`**, carrying `duration` and the timeout reason; the timeout message also states the next step:

- move long work to `detach: true` (remote `nohup` + a log file, then read it with `ecs_log` by **byte cursor**);
- or raise `timeout` (per-step cap 3600s; larger values are clamped).

In an orchestration a timed-out step **fails loudly** (it can no longer be mistaken for success) — see `ecs_deploy` below.

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
| `instance_id` | string | ✅ | Target instance ID (a workspace anchor name also works, v0.7.0+) |
| `path` | string | ✅ | One remote file, e.g. `/tmp/.dsh-ecs-xxx/out.log` (alternate with `paths`) |
| `paths` | array\<string\> | | **Read several files at once** (v0.7.0+, alternate with `path`, max 8): one remote call segments the output per file and **each file keeps its own `after` / `next_offset`** |
| `after` | integer \| object | | Starting byte offset (the previous `next_offset`; 0 on the first read). With several files it may be a number (one cursor for all) or an object such as `{"/var/log/app.log": 12}` (v0.7.0+) |
| `max_bytes` | integer | | Maximum bytes per read, default 262144; when `truncated=true`, read again immediately |
| `exit_file` | string | | Optional remote exit-code file; when present, its value is returned as `exit_code` |
| `region` / `timeout` | | | Region / timeout in seconds (default 60; a timeout settles as `124` + `timed_out` and the cursors do not advance) |

**Usage**: polling a release/build log is `ecs_log { path: "<log>", after: <last next_offset> }` — no more full `tail`s plus eyeballing the delta. Combined with a detached task's `log_path`, arbitrarily long logs stay fully readable from the start.

**Reading several files at once** (v0.7.0+) collapses "check the app log, then the access log" into a single remote call — the two files you almost always need together during triage:

```text
ecs_log { paths: ["/root/app/logs/app.log", "/root/app/logs/access.log"] }
ecs_log { paths: ["/var/log/app.log", "/var/log/nginx/error.log"], after: {"/var/log/app.log": 4096} }
```

It returns `files: [{ path, text, next_offset, total_bytes, eof, truncated, exit_code }]` (each file carries its own `exit_code` when `exit_file` is set), while **a single file keeps the existing flat fields** (`text` / `next_offset` / `total_bytes` / `eof` / `truncated`), so old call sites and scripts are unaffected. On a timeout the cursors **do not advance** — retry with the same `after`.

### `ecs_upload` — upload a local file to an instance

CLI equivalent: `workbench upload <local-file> <remote-path> --instance-id <id> [--force]`

| Parameter | Type | Required | Description |
|---|---|---|---|
| `local_file` | string | | Local file path (relative paths resolve against the session workspace); alternate with `local_dir` |
| `local_dir` | string | | Local directory (**recursive upload**, v0.5.1+): local `tar` → upload → remote extract; alternate with `local_file` |
| `remote_path` | string | ✅ | Remote target. For `local_file`: a path (a trailing separator means directory, the file name is appended). For `local_dir`: the **target directory** |
| `instance_id` | string | ✅ | Target instance ID (a workspace anchor name such as `"prod"` also works, v0.7.0+) |
| `region` | string | | Region, optional |
| `force` | boolean | | Overwrite an existing remote file without confirmation (default false) |
| `retries` | integer | | **Retries for transient network failures** (v0.7.0+; default 2, i.e. up to 3 attempts; cap 8). Semantic failures are never retried |
| `retry_delay` | integer | | Seconds to wait before the first retry (v0.7.0+; default 1, then **exponential backoff**) |
| `verify_sha256` | boolean | | Compare local/remote sha256 after upload (**default true**, unified with `ecs_deploy` in v0.7.0+; disabling requires an explicit `false`, which lint flags. In directory mode a mismatch **aborts the extract**) |
| `keep_root_dir` | boolean | | Directory mode: keep the archive's top-level directory name (default false — only the directory contents are uploaded) |
| `keep_archive` | boolean | | Directory mode: keep the remote archive after extraction (default false — removed) |
| `timeout` | integer | | Directory mode: timeout for the remote extract command in seconds, default 120 |

Transfers through Alibaba Cloud OSS (up to 1GB). Returns `verification` (`ok` / `mismatch` / `remote-unavailable` / `local-tool-unavailable`) plus both digests. Pair with `ecs_deploy` / `ecs_exec` for deployments.

**Automatic retries for transient failures + failure attribution** (v0.7.0+) — one hiccup no longer wastes a whole release:

| Class | Examples | Behaviour |
|---|---|---|
| Transient network | `i/o timeout` / `dial tcp` / `connection reset` / `TLS handshake` / `context deadline exceeded` / `operation error` | **Retried** (default 2 retries / up to 3 attempts, exponential backoff; `retry_delay` sets the first delay) |
| Semantic | `remote file ... already exists; use --force to overwrite` / permission denied / bad argument | **Fails immediately, no retry** (retrying cannot change the outcome) |

The final failure message states the owner: upload/download always go through the **Alibaba Cloud OSS relay**, so this class of network problem lives on the "**local machine → OSS**" hop and is **not a problem with the target ECS instance** — no need to inspect the instance, security groups or Cloud Assistant first; it also suggests simply re-running the same command/runbook later (**uploads are idempotent**).

**`verify_sha256` now defaults to `true` in all three places** (v0.7.0+): `ecs_upload` / `ecs_deploy` (classic phases) / `steps[].upload`. Turning it off requires an explicit `verify_sha256: false` (lint warns); in directory mode a digest mismatch still **aborts the extract**, so a corrupt archive never lands.

> **Related fix**: when `workbench upload` fails, stdout still prints an "Upload complete" line while the real error sits on stderr as `{code,message}`. The plugin previously read only stdout and could report a failure as success — since v0.7.0 **both are inspected together**, and a failed upload stage **aborts the deployment** instead of restarting with a stale (or missing) file.

**Recursive directory upload** (v0.5.1+) collapses "pack locally → upload → extract remotely" into one call with a fixed order of **archive → upload → verify → extract**: on a sha256 mismatch the extract command is never issued, so a corrupt archive cannot rewrite the remote directory. Returns `entries` (archive entry count) / `extracted` / `local_archive_cleanup`. The local archive is staged in the session workspace root and removed afterwards (`.dsh-ecs-upload-*.tar.gz`). Requires local `tar` (bundled with Windows 10+ / Linux).

### `ecs_download` — download a file from an instance

CLI equivalent: `workbench download <remote-path> [local-path] --instance-id <id> [--force]`

| Parameter | Type | Required | Description |
|---|---|---|---|
| `remote_path` | string | ✅ | Remote file path |
| `local_path` | string | | Local save path (file or directory, relative to the session workspace; omitted = current directory) |
| `instance_id` | string | ✅ | Target instance ID (a workspace anchor name such as `"prod"` also works, v0.7.0+) |
| `region` | string | | Region, optional |
| `force` | boolean | | Overwrite an existing local file without confirmation (default false) |

**Typical use**: pull production logs/config files back for analysis.

### `ecs_diagnose` — one-shot read-only diagnostics

CLI equivalent: one remote `exec` (semicolon-joined read-only command set)

| Parameter | Type | Required | Description |
|---|---|---|---|
| `instance_id` | string | ✅ | Target instance ID (a workspace anchor name also works, v0.7.0+) |
| `region` | string | | Region, optional |
| `sections` | array\<string\> | | **Pick the sections to collect** (v0.7.0+): `host` / `load` / `mem` / `disk` / `services` / `processes` / `ports` / `extra`; omitted = all 7. An illegal value fails and lists the legal ones; `extra` means **only** `extra_command` runs |
| `extra_command` | string | | Extra read-only command |
| `echo_command` | boolean | | Whether to echo the full collection command (v0.7.0+; **default false** — the output already carries per-section headers; see below) |
| `read_only` | boolean | | Read-only guard, **default true**; pass `false` to allow writes in `extra_command` |
| `description` | string | | Short purpose note |
| `strip_ansi` | boolean | | Strip ANSI/control chars/progress frames (default true) |
| `timeout` | integer | | Timeout in seconds, default 120 (always sent explicitly; a timeout settles as `124` + `timed_out`, v0.7.0+) |

Built-in 7 sections: host info / uptime & load / memory / disk / running services & containers (`docker ps`) / top memory processes / listening ports. **The starting point of production debugging** — one tool instead of a command string.

#### `sections` and `echo_command` (v0.7.0+)

When you only care about disk and ports, there is no reason to pull the whole report back:

```text
ecs_diagnose { instance_id: "i-xxx", sections: ["disk", "ports"] }      # only two sections
ecs_diagnose { instance_id: "i-xxx", sections: ["extra"], extra_command: "tail -n 50 /var/log/nginx/error.log" }
```

- The legal `sections` values are the 7 section names plus `extra`; a typo **fails and lists the legal values** instead of being silently ignored. `extra` on its own runs only `extra_command` (otherwise `extra_command` runs alongside the selected sections).
- **`echo_command` defaults to false**: the full 7-section command used to take up more than half the output. The result **always** carries the `sections` summary and `extra_command` (so it is clear which sections ran and whether a custom command was included); pass `echo_command: true` only when you want the verbatim command back.
- The read-only guard still applies to the script that is **actually sent** (`sections` only changes which parts get concatenated in, never the guard's rules).

### `ecs_deploy` — guarded deployment / multi-step orchestration

Two usages: **(A) the classic three phases** (upload → verify → restart → health check) and **(B) `steps` orchestration** (v0.6.0+).

**(A) Classic phases**

| Parameter | Type | Required | Description |
|---|---|---|---|
| `instance_id` | string | ✅ | Target instance ID (a workspace anchor name such as `"prod"` also works, v0.7.0+) |
| `command` | string | | Restart/apply command, e.g. `docker compose restart` (not needed with `steps`) |
| `local_file` | string | | Optional local file to upload |
| `remote_path` | string | | Upload target path (required when `local_file` is set) |
| `health_check` | string | | Optional health-check command, e.g. `curl -fsS http://127.0.0.1/health \|\| true` |
| `verify_sha256` | boolean | | Verify sha256 after upload, **default true**; a mismatch aborts the deployment before restart |
| `region` / `force` / `timeout` | | | Region / overwrite confirmation / per-phase timeout in seconds (default 180) |

All phases return their results (a failing phase does not stop later ones): upload → sha256 verify → restart → health check — with the one exception that a verification failure aborts (`aborted` / `abort_reason`), so a corrupt artifact never gets deployed. Added in v0.7.0+: the **upload phase retries transient failures too** (`retries` / `retry_delay`, same defaults as `ecs_upload`), and **a failed upload aborts the deployment** — it never continues to verification/restart, which would restart with a stale or missing file.

**(B) `steps` orchestration (v0.6.0+)** — model a whole sequence on one instance as a **single call**:

| Step | Fields | Description |
|---|---|---|
| `upload` | `local_file`, `remote_path`, `force?`, `verify_sha256?`, `retries?`, `retry_delay?` | Upload; `verify_sha256` defaults to true and a mismatch **aborts the whole run**; `retries`/`retry_delay` default as in `ecs_upload` (v0.7.0+, transient network failures only) |
| `exec` | `command` \| `script`, `timeout?`, `read_only?`, `description?` | Run a command or a script (`script` uses zero-escape base64 delivery) |
| `assert` | `command` \| `script`, `expect` | Assertions: `expect: { exit_code?, stdout_contains?, stdout_not_contains?, stderr_contains? }` |
| `tail` | `path`, `after?`, `max_bytes?`, `exit_file?`, `wait_seconds?` | Read a remote log by **byte cursor**; `wait_seconds` waits for `exit_file` to appear |

Run-level parameters: `dry_run` (print the plan without executing — and **without requesting approval**), `continue_on_error` (default false: the first failure stops the run and remaining steps are marked `skipped`), `read_only` (guard every exec/assert step), `timeout` (global default, 180s), `retries` / `retry_delay` (v0.7.0+: the defaults for **every `upload` step**; a step's own values win), `from_step` (v0.8.0+: skip the steps with `index < N` and continue from there — see "Replay advice and `from_step`" below). Maximum 20 steps.

**Upload-retry observability (v0.7.0+)**: a `dry_run` preview states "uploads retry transient failures automatically: up to N attempts" outright (no need to run a real upload to learn the retry count), and real results carry per-step `attempts` (attempts actually made) / `retry_errors` (the error recorded before each retry) / `timed_out` / `duration`.

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

Returns `mode` (`legacy` / `steps`), `ok`, `done_stage`/`total_stage`, `stopped_at`/`stopped_reason`/`failed_steps`, and per-step `stages` (assert steps carry per-check `assertions`; tail steps carry `next_offset`/`total_bytes`/`eof`). **Failures point at the exact step and the exact assertion** instead of requiring someone to read the log. From v0.7.0 on, **a timed-out step is reported as FAIL** (with `timed_out` / `duration`; see "New remote-timeout semantics") and can no longer pass for success.

**(C) Runbooks (v0.6.2+)** — store an orchestration as **pure data**; the plugin supplies only the mechanism:

| Parameter | Description |
|---|---|
| `runbook` | `"name"` → reads `<workspace>/.dsh/workbench-ecs/runbooks/<name>.json`; or an inline object `{ name?, description?, params?, steps }` |
| `runbook_params` | Parameter object: overrides the runbook's `params` defaults and substitutes `${name}` placeholders; `${instance_id}` / `${region}` are implicit, as are **instance-anchor** fields (v0.7.0+, e.g. `${repo}` — see "Project-level instance anchors"). A runbook's `params` accepts **parameter descriptors** (v0.8.0+; see "Runbook parameter contracts" below) |
| `from_step` | **Continue from the middle** (v0.8.0+, `steps`/`runbook` only): skips the steps with `index < N`, using the `[i]` shown in the plan (0-based); see "Replay advice and `from_step`" below |

```jsonc
{
  "name": "release",
  "params": { "sha": "latest", "log": "/tmp/release.log" },   // scalar = a default (overridable via runbook_params); parameter descriptors also work (v0.8.0+, below)
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

#### Runbook parameter contracts: required / pattern / enum (v0.8.0+)

`params` used to hold nothing but "a default", so "this parameter must be supplied" could only be approximated with a sentinel default plus a step-0 assertion. From v0.8.0 `params` accepts **parameter descriptors** — the scalar form still means a default, so this is fully backward compatible:

```jsonc
"params": {
  "sha": { "required": true, "pattern": "^[0-9a-f]{7,40}$", "hint": "git rev-parse --short HEAD" },
  "env": { "default": "prod", "enum": ["prod", "staging"], "description": "deploy environment" }
}
```

| Field | Effect |
|---|---|
| `required` | Required: no default and nobody passed it → error |
| `pattern` | The value must match this regex (the regex itself is validated too) |
| `enum` | The value must be one of these |
| `default` | The default value (same meaning as the scalar form) |
| `description` | What this parameter is (shown when a required parameter is missing) |
| `hint` | How to obtain it (shown when it is missing or fails `pattern`) |

- **Unknown fields are flagged**: a typo such as `patern` inside a descriptor produces "did you mean `pattern`?" — the same mechanism as step-field typos;
- **Validation happens before any command is sent**: `ecs_runbook validate` / `plan` blocks a missing required parameter, a `pattern` mismatch and an `enum` mismatch, reporting `missing_required` / `param_issues`; the settings panel's **Validate** button and the pre-execution check share **one implementation**, so "the panel said OK but execution blew up" cannot happen;
- **Implicit parameters are constrained too**: `${instance_id}` / `${region}` / instance-anchor fields (such as `${repo}`) are all validated — a wrong `repo` in an anchor does not slip through just because it is implicit;
- **The report shows the contract**: the textual `validate` / `plan` result lists each parameter's **required marker + default + pattern + enum + hint**, so "what is missing / what format is expected" is visible at a glance.

#### Step-level `raw: true`: turn off substitution for a whole step (v0.8.0+)

`$${NAME}` escaping still works (existing runbooks are unaffected), but "this step is one big shell script and every `${VAR}` belongs to the remote shell" makes per-variable escaping tedious:

```jsonc
{ "raw": true, "script": "echo \"$HOME\" > /tmp/x" }
```

- **Semantics**: the **whole step** skips placeholder substitution — its `${...}` are not runbook parameters and do not raise "missing parameter"; in non-`raw` steps `$${}` escaping behaves exactly as before;
- **Lint catches the counter-intuitive case**: if the step actually meant to use a runbook parameter, `raw: true` keeps it verbatim — lint emits a `raw_placeholders` warning (listing the `${...}` found in that step) suggesting "remove `raw` if you meant to use runbook parameters".

#### Replay advice and `from_step` (v0.8.0+)

**"Can I just re-run the whole runbook after a failure?"** used to be a human judgement call. From v0.8.0, `ecs_runbook`'s `validate` / `plan`, `ecs_deploy`'s `dry_run` preview and its **failure results** all carry a "replay advice" block: step-by-step idempotency analysis with a `safe_prefix` and one directly actionable conclusion.

| Step | Idempotency verdict |
|---|---|
| `upload` | **Only `force: true` counts as idempotent** (`--force` overwrites; identical content gives an identical result); without `--force` it fails when the remote file already exists |
| `exec` (with `read_only: true`) | Idempotent (read-only) |
| `assert` | Idempotent (read-only predicates) |
| `tail` | Idempotent (read-only log reading) |
| Any other write command | **Unknown** — re-running executes it again |

The conclusion reads like: "the first 2 steps (indices `[0]..[1]`) can be repeated; step 3 (docker compose up -d) onwards may have side effects — either re-run the whole runbook, or use `from_step: 2` to continue from that step."

**`from_step`: continue from the middle (v0.8.0+)**

```text
ecs_deploy { instance_id: "i-xxx", runbook: "release", runbook_params: { sha: "abc123" }, from_step: 2 }
```

- It skips the steps with `index < N`, **using the `[i]` shown in the plan (0-based)** — so `from_step: 2` skips `[0][1]`, exactly matching the numbering in `ecs_runbook plan` / `dry_run`;
- **Both the preview and the real result explicitly list the skipped prefix** as `skipped_prefix` and warn that "**the side effects of these steps will not be recreated**" — skipping the upload while expecting the remote file to be new is the classic way this kind of operation goes wrong;
- Skipped steps are rendered as "skipped (skipped via from_step)" and **do not affect the overall `ok: true`** (clearly distinguished from a `skipped` caused by an earlier failure);
- Out-of-range values (`N < 0` or `N ≥ step count`) fail outright and report the legal range;
- `from_step` only applies to `steps` / `runbook` — the classic three phases have a fixed four-stage shape with no skippable numbering.

### Built-in generic runbook templates (v0.6.7+)

Five runbooks that are **not tied to any project** ship with the package (`templates/runbooks/*.json`). Copy them into any project's `<workspace>/.dsh/workbench-ecs/runbooks/`, or pass one straight to `ecs_deploy` / `ecs_runbook` as an inline `runbook` object. They use the same mechanism as a project's own runbook (pure data, lintable, previewable).

| Template | Purpose | Key parameters (all have defaults) | Notes |
|---|---|---|---|
| `host-check` | host health check: **read-only** | `disk_max=90` `mem_max=90` `mount=/` `port=""` `process_name=""` | asserts disk/memory watermark, listening port, process presence; archives load/time-sync; safe to run any time |
| `compose-redeploy` | generic container redeploy | `app_dir` (must be passed) `compose_file=docker-compose.yml` `service=""` `container_name=""` `health_url=""` `git_ref=""` `step_timeout=300` | only uses `--force-recreate --no-deps` when `service` is given, otherwise plain `up -d`; empty `git_ref` / `health_url` / `container_name` skips that check |
| `disk-cleanup` | reclaim disk | `confirm=no` `cache_keep=2GB` `disk_max=90` `container_name=""` | **reports only unless `confirm=yes`**; prunes stopped containers / dangling images / build cache, then asserts the watermark and that the container is still up |
| `tls-cert-check` | domain & certificate check: **read-only** | `host` (must be passed) `port=443` `path=/` `min_days=14` | HTTPS reachable with a 2xx code, certificate days-left ≥ threshold (needs `openssl` on the box) |
| `log-dig` | log triage: **read-only** | `log_path` (must be passed) `lines=500` `pattern=ERROR` `max_hits=0` | counts matches in the last N lines and fails above the threshold; the default verdict is "no ERROR in the last 500 lines" |

```bash
# copy into a project, then use ecs_runbook validate / ecs_deploy runbook
cp -r node_modules/dsh-workbench-ecs/templates/runbooks/*.json  .dsh/workbench-ecs/runbooks/

# example: read-only host check — validate, preview, then execute
#   ecs_runbook  { action: "validate", runbook: "host-check" }
#   ecs_runbook  { action: "plan",     runbook: "host-check", instance_id: "i-xxx" }
#   ecs_deploy   { instance_id: "i-xxx", runbook: "host-check", runbook_params: { disk_max: 85, port: "443" } }
```

Conventions the templates themselves follow:

- **required parameters use a sentinel default** — `"app_dir": "<app_dir>"`; step 0 asserts it away with an actionable message, so a forgotten parameter fails before anything happens on the box;
- **optional/constrained parameters use parameter descriptors** (v0.8.0+): thresholds, ports and paths in the templates are written as `{ "default": …, "description": …, "hint": …, "pattern": … }` (e.g. `disk_max` must be 1–3 digits, `mount` must be an absolute path, `port` is empty or 1–5 digits, and `disk-cleanup`'s `confirm` uses `enum: ["no","yes"]`) — a bad value is caught **before any command is sent** instead of halfway through the remote run. Parameters that genuinely must be passed still use the sentinel default plus the step-0 assertion (both forms coexist; see "Runbook parameter contracts" above);
- **optional parameters default to an empty string** — the script branches on `if [ -n "${param}" ]`, skipping that check instead of inventing a fake default;
- **destructive work sits behind a confirmation gate** — `disk-cleanup` only reports unless `confirm=yes`;
- every template is covered by a **regression guard** in `test/smoke.mjs`: each one must lint with 0 errors and 0 warnings, have defaults for every placeholder, leave no placeholder unsubstituted, and expand into a complete plan — a rotten template turns CI red.

### `ecs_runbook` — read-only inventory & static checks for workspace runbooks (v0.6.3+)

CLI equivalent: **none** — this tool runs no CLI command and never touches an ECS instance (local files + pure logic only)

| Parameter | Type | Required | Description |
|---|---|---|---|
| `action` | string | ✅ | `list` all runbooks with their check verdict; `validate` one runbook item by item; `plan` expand with params and echo the commands (no execution) |
| `runbook` | string \| object | validate / plan | `"name"` → reads `<workspace>/.dsh/workbench-ecs/runbooks/<name>.json`; or an inline object |
| `runbook_params` | object | | parameter object (overrides defaults, substitutes `${placeholders}`); `instance_id` / `region` are implicit, as are instance-anchor fields (v0.7.0+). A runbook's `params` accepts **parameter descriptors** `{ required, pattern, enum, default, description, hint }` (v0.8.0+; a scalar still means a default) |
| `instance_id` / `region` | string | | optional: display-only for `plan` (defaults to `<instance_id>`) |
| `read_only` | boolean | | optional: pre-check `plan` against the read-only guard (same rules as `ecs_deploy read_only`) |
| `from_step` | integer | | optional (v0.8.0+): skip start (using the `[i]` shown in the plan, 0-based) — `validate` / `plan` mark the steps that **will be skipped** and report `skipped_prefix` |

**Why run it first**: a runbook is **pure data**, so every mistake can be found before a single command is sent. Checks include:

| Category | Example |
|---|---|
| Structure (the **same** validation the executor uses, identical wording) | illegal `kind`, upload missing `local_file`/`remote_path`, both `command` and `script`, more than 20 steps |
| Field typos (the sneakiest: unknown fields are silently ignored) | `commnad` → `did you mean command?` |
| Weak assertions | `assert` with an empty `expect` → in effect only `exit_code=0` is checked |
| Guard conflict | `read_only: true` whose command matches a write pattern → execution is guaranteed to be rejected (reported as an error) |
| Destructive commands | matches `rm -rf` / `systemctl stop` … → warns that the Agent path needs approval and the panel rejects it |
| Parameters | missing params (error; ALL-CAPS names get a `$${NAME}` escaping hint), unused inputs, `params` defaults never used |
| Parameter contracts (v0.8.0+) | missing required parameter (no default), value failing `pattern` / `enum`, descriptor field typos ("did you mean pattern?"), `raw: true` steps that actually meant to use parameters (`raw_placeholders`) |
| Tail semantics | neither `wait_seconds` nor `exit_file` → it reads once (you may catch a half-written log) |

```
# recommended order: read-only checks, then preview, then execute
ecs_runbook { action: "validate", runbook: "release", runbook_params: { sha: "abc123" } }
ecs_runbook { action: "plan",     runbook: "release", instance_id: "i-xxx", runbook_params: { sha: "abc123" } }
ecs_deploy  { instance_id: "i-xxx", runbook: "release", runbook_params: { sha: "abc123" } }
```

> **Escape shell variables**: `${NAME}` is treated as a runbook placeholder; write `$${NAME}` to leave `${NAME}`
> for the remote shell (kept verbatim, and not counted as a declared parameter).
> When a **whole step is a script**, **step-level `raw: true`** (v0.8.0+) turns off substitution for that step in one move — more readable than escaping each variable; both forms coexist and `$${NAME}` escaping is unaffected (see "Step-level `raw: true`" above).
> A `plan` result also carries the **replay advice** (step-by-step idempotency + `safe_prefix`) and marks the steps `from_step` will skip.
> The settings panel's Runbook card has the same **Validate** button (equivalent to `validate`, touches no instance).

### `ecs_snapshot` — release snapshots: rollback point + difference check (v0.8.0+)

CLI equivalent: `workbench exec` (one read-only collection script; a single call performs the whole collection)

The "last mile" of a controlled release is really two things: the **rollback point before you touch anything**, and the **difference check afterwards**. Every agent used to hand-write a `docker tag` + `docker cp` + `docker images` / `docker ps` assembly script for it (twenty-odd lines, rewritten every time). `ecs_snapshot` makes it first-class:

| Parameter | Type | Required | Description |
|---|---|---|---|
| `action` | string | ✅ | `create` collects and writes a manifest; `list` lists workspace snapshots; `diff` re-collects and compares item by item |
| `name` | string | create / diff | Snapshot name (letters, digits and `.` `_` `-` only; first character a letter or digit; ≤64 chars), e.g. `pre-abc1234` |
| `instance_id` | string | create required / diff optional | Target instance (a workspace anchor name such as `"prod"` also works); for `diff` it defaults to the instance recorded in the manifest |
| `region` | string | | Region, optional (the CLI infers it from the instance ID) |
| `note` | string | | create: a note (e.g. "rollback point before release"), written into the manifest |
| `profile` | string | | create: a **named profile** on the project side (see below) supplying `paths` / `commands` / `collectors` |
| `paths` | array\<string\> | | create: remote **files or directories** to fingerprint (max 50 per snapshot) |
| `commands` | object | | create: custom read-only collectors `{ "<label>": "<command>" }` |
| `collectors` | array\<string\> | | create: take only this subset of the **default collectors** |
| `against` | string | | diff: compare against **another snapshot** (default = compare against live state) |
| `timeout` | integer | | Collection timeout in seconds, default 180 |

**The three actions**:

- **`create`** — one **read-only** collection written into the workspace manifest at `.dsh/workbench-ecs/snapshots/<name>.json`:
  - default collectors `host` (`hostname` + kernel), `images` (`docker images --digests`), `containers` (`docker ps`), `ports` (`ss -tln`); when docker is absent that collector is recorded as an empty output with `exit_code != 0` and **never affects the others** (snapshots work on a box without docker);
  - `paths` fingerprints each remote file/directory: for a **file** = remote `sha256sum` + size + mtime; for a **directory** = file-list digest + entry count + mtime;
  - `commands` = custom read-only collectors `{ "<label>": "<command>" }` storing only the **output digest, line count and the first 12 lines** (the full output never enters the manifest);
  - `collectors` selects a subset of the default collectors.
- **`list`** — lists workspace snapshots (name / time / target instance / note / collectors) with **zero remote calls** (the manifests live in the workspace, so not even the CLI is touched).
- **`diff`** — **re-collects** with the collectors recorded in the manifest and compares item by item against the baseline:
  - files: `added` / `removed` / `changed` / `metadata-only` (**identical content, only the mtime moved**) / `unchanged`;
  - collector output: `changed` / `exit-changed` / `unchanged`, plus the **first differing line** (which line, and what it was before/after);
  - it returns `clean` / `changed_count` / `files_changed` / `commands_changed`, and the rendered result states a one-line verdict;
  - `against` compares with **another snapshot** instead (default = compare against live state).

**Design principle: mechanism in the plugin, content in the project repository** (the same rule as runbooks). Which paths to snapshot and which commands to collect live in a named profile file inside the project, `.dsh/workbench-ecs/snapshot-profiles.json`:

```jsonc
{
  "web": {
    "paths": ["/opt/app/app.jar", "/opt/app/docker-compose.yml", "/opt/app/logs"],
    "commands": { "nginx-version": "nginx -v", "compose-ps": "docker compose -f /opt/app/docker-compose.yml ps" },
    "collectors": ["host", "images", "containers", "ports"]
  }
}
```

Reference it with `ecs_snapshot { action: "create", profile: "web" }`. A missing profile fails and **lists the available names** (an empty file says so too), and a corrupt profile file reports the path and the reason — nothing is silently ignored.

**Other points**:

- **The collection script always passes the read-only guard**: its content is only `sha256sum`/`stat`/`find`/`docker images|ps`/`ss` plus custom read-only commands, and it is **always** run past the guard before delivery — **the snapshot flow cannot modify the remote host**, and does not rely on "we wrote it correctly";
- **The manifest lives in the workspace**: so it is diffable, committable and greppable, and `list` needs no remote call;
- **The default collection deliberately excludes volatile content** (such as `uptime` or exact disk numbers): a snapshot exists to compare before/after a release, and noise would drown the real changes — add such metrics yourself in a **project profile**.

**Typical usage (one-command check around a release)**:

```text
# before the release: leave a rollback point (read-only collection, manifest in the workspace)
ecs_snapshot { action: "create", instance_id: "prod", name: "pre-<sha>", profile: "web" }

# ... run the release ...

# after the release: re-collect with the manifest's collectors and compare item by item
ecs_snapshot { action: "diff", name: "pre-<sha>" }

# to see "what actually changed between two releases": compare two snapshots
ecs_snapshot { action: "diff", name: "pre-<sha>", against: "pre-<sha2>" }
```

### `ecs_session` — session management

CLI equivalent: `workbench session list` / `workbench session close <id>` / `--all`

| Parameter | Type | Required | Description |
|---|---|---|---|
| `action` | string | ✅ | `list` active sessions; `close` a session |
| `session_id` | string | | Session ID to close (for `close`) |
| `all` | boolean | | Close all sessions (for `close`) |

Normally unnecessary (sessions are auto-managed); used for diagnostics and resource cleanup.

## Safety

- **Destructive-command guard**: before execution, `ecs_exec` and `ecs_deploy` (restart command and health check) scan the command; matches against `rm -rf`, `shutdown`/`poweroff`/`reboot`/`halt`, `mkfs`, `dd`, `init 0/6`, `systemctl stop/disable/mask`, `service stop`, `iptables -F/-X`, `userdel`/`groupdel` go through the Harness `approval` service; anything not `allowed-once` (no approver, or policy `never`) is rejected (fail closed). The **four "not approved" cases are told apart in v0.7.0+** (see the table below).
- **Read-only guard** (v0.4.0+): with `read_only=true`, write operations are rejected before the command reaches a shell — redirects other than `/dev/null`, `rm`/`mv`/`cp`/`mkdir`/`touch`/`chmod`/`chown`/`truncate`, `tee`, `sed -i`, `docker`/`docker compose` mutations, `systemctl`/`service` state changes, package managers, `git` writes, `kill`/`nohup`, `crontab`/user management, `find -delete/-exec`. This is a guard rail, not a sandbox (dynamic assembly can still evade it); hard enforcement stays with the approval service. Its **rejection message became debuggable in v0.7.0+** (see below).
- **Read-only diagnostics**: `ecs_diagnose` sections are read-only and the guard is on by default; custom commands still pass the safety guard.
- **Snapshots are always read-only** (v0.8.0+): the `ecs_snapshot` collection script (`sha256sum`/`stat`/`find`/`docker images|ps`/`ss` plus custom read-only commands) is **always** run past the read-only guard before delivery — the snapshot flow **cannot** modify the remote host.
- **Transfer integrity**: `ecs_upload.verify_sha256` / `ecs_deploy.verify_sha256` (on by default; v0.7.0+ unifies the default to `true` across `ecs_upload` / `ecs_deploy` classic phases / `steps[].upload`) compare local and remote sha256 so a corrupt artifact is caught before any restart.
- **Transfer confirmation**: `ecs_upload`/`ecs_download` require confirmation on existing files unless `force=true`.
- **Credential hygiene**: credentials live only in local `~/.workbench/config.json` (0600); prefer RamRoleArn/CredentialsCmd/CredentialsURI over long-lived AK.

### A rejected destructive command: four distinct cases (v0.7.0+)

All four cases used to produce the same "not approved (rejected)" line, which made it easy for a model to **misread it as a syntax error** and retry the same command over and over, burning several rounds for nothing. Each case now states its cause and its **next step**:

| Case | Plugin behaviour and message |
|---|---|
| **Approval service not mounted** (no `approval` in the environment) | Fail closed: rejected with an explicit "this environment has no approval service mounted" |
| **Session approval policy is `never`** (approvals disabled) | **Rejected outright with no approval request issued** (it would inevitably come back rejected); the message states "this is not a syntax error, re-running the same command will not change the outcome" and offers two next steps: (a) ask the user to switch the policy back to `ask` and retry; (b) rewrite it into a form that needs no approval (e.g. back up first and delete specific paths instead of `rm -rf` on a whole directory) |
| **User rejected the approval** | States "the user rejected this command in the approval prompt" (with the policy in effect) and tells you **not to retry it verbatim** — use a smaller action the user will accept, or ask them to approve again |
| **Approval request cancelled / no responder** (`cancelled` / `unavailable`) | Separately explains "the request was cancelled (the tool call was aborted or the user withdrew it)" and "nobody answered (e.g. an unattended execution environment)"; the latter suggests running in an interactive session, or rewriting it into something that needs no approval |

### The read-only guard's rejection is now debuggable (v0.7.0+)

When `read_only: true` blocks a command, the useful part is not the rule but "how do I rewrite this". So the message now lists **every** matched rule:

- the matched **rule name**, the **matched text**, and its **position in the command** (at most 3 hits per rule, each excerpt truncated at 80 characters);
- previously **only the first hit** was reported — a script containing `mkdir` / `>` / `cp` / `curl -o` showed one rule at a time, so fixing one just ran into the next, round after round;
- followed by concrete **"read-only equivalent" advice**:

| Your intent | Suggested form |
|---|---|
| No file needs to be written | Print to stdout instead (`echo`/`printf`, no `>` redirect) — the guard allows it |
| You really do need to write | Pass `read_only: false` **explicitly** (writes must be declared; nothing is silently allowed) |
| Long task / large output | Use `detach: true` to start it under remote `nohup`, then read the log with `ecs_log` by **byte cursor** |
| A false positive (the command is read-only) | Also pass `read_only: false`, and report the pattern to the maintainer so the rule can be tightened |

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
| 124 | **Remote command timed out** (`--timeout` expired): the CLI process exits 124 while its JSON still says `exit_code: 0` — the plugin settles this as 124 based on `timed_out` (v0.7.0+) |

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
| `破坏性命令未获批准` | Normal guard behavior: the user (or approver) must explicitly allow it. Read which case it is — if the message says "session approval policy is never (approvals disabled)", approvals are **disabled**, not the command misspelled (v0.7.0+ states this outright), and re-running the same command changes nothing: ask the user to switch back to `ask`, or rewrite it into something that needs no approval |
| A command looks like "success with no output" although it was cut off by a timeout | Known defect before v0.7.0 (the CLI's JSON claims `exit_code: 0` on timeout). From v0.7.0 everything settles as `exit_code 124` + `timed_out: true`; upgrade the plugin, and move long work to `detach: true` with a remote log file read by `ecs_log` |
| Upload failed with an error mentioning OSS / `i/o timeout` | This is a network hiccup on the "**local machine → OSS relay**" hop, **not a problem with the target instance** (no need to check the instance, security groups or Cloud Assistant first). `ecs_upload` already retries transient failures (2 by default); if it still fails, just re-run the same command/runbook later — uploads are idempotent |
| `未找到实例锚点 "xxx"` (instance anchor not found) | The anchor name is wrong; the message **lists the available anchors**. Or the workspace has no `.dsh/workbench-ecs/instances.json` yet (copy `templates/instances.json`) |
| You do not know which region the instance is in | Use `ecs_find { keyword: "<name or IP>" }` to search across regions; `ecs_list` requires a region, and its 0-instance result also points at `ecs_find` |
| `ecs_snapshot: profile "xxx" 不存在` (profile not found) | The project's `.dsh/workbench-ecs/snapshot-profiles.json` has no such name — the error **lists the available profiles** (and says so explicitly when the file has none) |
| A runbook reports "missing required parameter" / "does not match pattern" | Its `params` uses **parameter descriptors** (v0.8.0+). `ecs_runbook { action: "validate" }` catches these before any command is sent and points at the `hint` for how to obtain the value; implicit parameters (including instance-anchor fields) are constrained the same way |
| A release failed — can the runbook just be re-run? | Read the **replay advice** in the result: it already assessed idempotency step by step and reports `safe_prefix`. To continue from the middle use `ecs_deploy { from_step: N }` (index as shown in the plan, 0-based) — but note that the `skipped_prefix` steps' side effects **will not be recreated** |

### Error message example

```text
ecs_exec: workbench CLI 错误 (code 1): session resolve: login instance: SDKError: ...
```

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
- CI: [GitHub Actions](./.github/workflows/ci.yml) — push/PR run tests, `v*` tags publish to npm automatically (needs `NPM_TOKEN` secret)
- Type declarations: [`lib/types/index.d.ts`](./lib/types/index.d.ts)
- One-shot setup script: [`scripts/workbench-setup.ps1`](./scripts/workbench-setup.ps1)

## License

[MIT](./LICENSE) © 2026 [nishuoyang](https://github.com/nishuoyang)
