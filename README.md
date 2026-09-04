# dsh-workbench-ecs

English | [中文](./README.zh.md)

> A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (Cordis) plugin that lets the Agent control remote Alibaba Cloud ECS instances through the local Workbench CLI.

## Why this plugin

Development and production environments differ, and production-only bugs are often impossible to reproduce locally. The traditional debugging loop is painful: a human logs into the server, copies commands back and forth, and pastes results to the Agent again and again.

This plugin gives the **Agent the ability to reach production instances on its own**: it executes the official Alibaba Cloud [Workbench CLI](https://help.aliyun.com/zh/ecs/user-guide/use-workbench-cli-to-manage-ecs-instances) locally through tool calls, covering instance listing, remote command execution, log inspection, process checks, service status, deployment, and more — no manual copy-paste of commands or results.

## Features

- **Agent-native tools**: registers `ecs_list` / `ecs_exec` as model-visible tools, integrating with the Harness tool pipeline
- **Real API calls**: tools run the local `workbench` command and reach instances through the Alibaba Cloud Workbench backend (works for instances **without public IPs**)
- **JSON parsing + readable rendering**: parses the CLI JSON output into tables/text; CLI-level errors (`{code, message}`) become readable messages
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

**Option A — add a plugin row to your Cordis composition (cordis.yml):**

```yaml
- id: dsh-workbench-ecs
  name: dsh-workbench-ecs
```

**Option B — use the Harness plugin manager:**

```bash
dsh plugin add dsh-workbench-ecs
```

Restart the Harness after installing; the registered `ecs_list` / `ecs_exec` tools become visible to the Agent.

### 6. Verify the installation

```bash
# Manually verify the CLI (run on the machine that has Workbench CLI installed):
workbench list ecs --region cn-hangzhou --output json
workbench exec --instance-id i-bp1xxxxx --command "df -h" --output json
```

Then ask the Agent:

```text
ecs_list { region: "cn-shanghai" }
ecs_exec { instance_id: "i-uf66ct2o35p7fjcd0sru", command: "df -h" }
```

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

Returns: `{ command, region, count, instances: [{ instance_id, instance_name, instance_type, region_id, status, private_ip, public_ip, os_type, image_id, tags }] }`, rendered as a text table.

### `ecs_exec` — run a remote command on an instance

CLI equivalent: `workbench exec --instance-id <id> --command <cmd> [--timeout <s>] --output json`

| Parameter | Type | Required | Description |
|---|---|---|---|
| `instance_id` | string | ✅ | Target instance ID (obtain via `ecs_list`) |
| `command` | string | ✅ | Remote command; chain with `&&` or `;` when shared context is needed |
| `timeout` | integer | | Command timeout in seconds, default 30 |
| `region` | string | | Region, optional (CLI infers it from the instance ID) |

Returns: `{ instance_id, command, exit_code, output, stderr, stdout_truncated, command_line }`, rendered as text (output + stderr section + exit code).

> **Safety note**: `ecs_exec` is a non-interactive executor; each call is an isolated shell context. Destructive commands (`rm -rf`, `shutdown`, `reboot`, `mkfs`, `dd`, service stop/restart, …) must be confirmed with the user before execution — the plugin docs and the tool description both emphasize this for the model.

## Typical usage (production debugging)

```text
# 1. Find instances
ecs_list { region: "cn-shanghai", status: "Running" }

# 2. Check service status
ecs_exec { instance_id: "i-uf66ct2o35p7fjcd0sru", command: "systemctl status nginx" }

# 3. Inspect logs (shared context inside one call)
ecs_exec { instance_id: "i-uf66ct2o35p7fjcd0sru", command: "cd /var/log/nginx && tail -n 100 error.log" }

# 4. Check disk/memory
ecs_exec { instance_id: "i-uf66ct2o35p7fjcd0sru", command: "df -h && free -m" }
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

### Error message example

```text
ecs_exec: workbench CLI 错误 (code 1): session resolve: login instance: SDKError: ...
```

## Development

```bash
npm install          # install devDependencies (@deepseek-ai/dsh-tools)
npm test             # smoke test: module exports + tool registration contract
npm run build:body   # generate the dynamic-mount body (test/body.generated.js, same origin as lib/index.js)
```

- Source: [`lib/index.js`](./lib/index.js) — a standard Cordis plugin (`export { name, inject, apply }`)
- Dynamic mount (temporary session): `npm run build:body`, then use the generated body as the `code.host` of `cordis_define`
- Layout: `lib/` (publishable) · `test/` (smoke) · `scripts/` (build helpers)

## License

[MIT](./LICENSE) © 2026 [nishuoyang](https://github.com/nishuoyang)
