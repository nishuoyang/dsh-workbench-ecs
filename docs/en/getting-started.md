# Installation & credentials

> [中文](../zh/getting-started.md) | English · Back to [README.en.md](../../README.en.md)

## Installation

> **Two hosts, two profiles (v0.9.0+)** — DSH now ships both a **browser** surface and a **desktop app**. They are separate host processes loading separate profiles, so the plugin must be installed **into each one**:
>
> | Which one you use | Host process | Profile directory | Install command |
> |---|---|---|---|
> | Browser (`dsh web`) | `dsh web` (npm-global CLI) | `%DSH_HOME%\profiles\web` | `dsh plugin --profile web add dsh-workbench-ecs` |
> | **Desktop app** | `dsh-desktop-host` (the runtime bundled in Electron) | `%DSH_HOME%\profiles\desktop` | `dsh plugin --profile desktop add dsh-workbench-ecs` |
>
> Run both commands to cover both. The desktop side is **still the web surface** (it bundles `dsh-web-app`, and the client module system only accepts `dsh.client.platform === "web"`), so one package and one `lib/client.js` serve both — but the **profiles are not shared**: if you only installed into the web profile, the desktop app will not load the plugin at all (no tools, no settings tab).

### Prerequisites

- Node.js ≥ 20, with the target host running (`dsh web`, or the DeepSeek Harness desktop app);
- The official Workbench CLI installed and authenticated **on the same machine** (see [Before first use](#before-first-use) below).

### Version compatibility (v0.9.0+)

When the host loads a bundle it applies a **version gate**: every `@deepseek-ai/dsh-*` entry in the package's `peerDependencies` is compared against the running DSH version, and a mismatch makes the host **silently skip the whole bundle** (the plugin never loads and nothing is reported). The peer range therefore has to cover both runtimes:

| Host | Measured DSH runtime | This package's peer declaration |
|---|---|---|
| Browser `dsh web` | `0.1.1-rc.2` | `@deepseek-ai/dsh-tools: ^0.1.1-rc.2 \|\| ^0.2.0-rc.2` |
| Desktop app | `0.2.0-rc.2` | same (plus `@deepseek-ai/cordis: >=4.0.1 <5.0.0`) |

> v0.8.0 only knew `^0.1.1-rc.2`, which under semver means `>=0.1.1-rc.2 <0.2.0-0` — **0.2.0-rc.2 does not satisfy it**, so the desktop host skipped the entire bundle. v0.9.0 fixes that and turns the gate into a regression test (`test/compat.mjs`): if either runtime stops being covered, `npm test` fails.

### Install via the official dsh command

```bash
# browser surface
dsh plugin --profile web add dsh-workbench-ecs

# desktop app (a separate command)
dsh plugin --profile desktop add dsh-workbench-ecs
```

Afterwards the 11 tools are visible to the Agent and a **"Workbench ECS"** tab appears in the harness settings (gear icon).

- **`dsh web`**: restart `dsh web` when hot reload is unavailable;
- **Desktop app**: the profile is read **once at process start** — **quit and reopen DeepSeek Harness**.

> For local development from a checkout, link the repo instead:
> `dsh plugin --profile <web|desktop> add link:<absolute-path-to-repo>` — subsequent `lib/client.js` edits apply after a plain page refresh (no server restart).

### Verify

```bash
# the desktop host uses 19387, `dsh web` uses 3080 — use whichever you run
curl -s http://127.0.0.1:19387/dsh-workbench-ecs/health
# => {"ok":true,"plugin":"dsh-workbench-ecs","version":"0.9.0"}
```

> On the desktop host (and any host with authentication on) a bare `curl` can return `401 unauthorized`: the host protects the whole site with a launch token plus a session cookie. That does **not** mean the plugin is missing — open the same URL from the **already signed-in page** to see the `health` JSON.

Then ask the Agent:

```text
ecs_list { region: "cn-shanghai" }
ecs_exec { instance_id: "i-uf66ct2o35p7fjcd0sru", command: "df -h" }
ecs_diagnose { instance_id: "i-uf66ct2o35p7fjcd0sru" }
```

## Before first use: Workbench CLI & credentials

> **Official docs (the exact procedure)**: Alibaba Cloud [Install and configure Workbench CLI credentials](https://help.aliyun.com/en/ecs/user-guide/install-and-configure-workbench-cli-credentials) — installation, least-privilege RAM policy, all credential modes, upgrade and uninstall. Connecting: [Connect to an instance by using Workbench CLI](https://help.aliyun.com/en/ecs/user-guide/connect-to-an-instance-through-workbench-cli/). Commands: [Manage ECS instances by using Workbench CLI](https://help.aliyun.com/en/ecs/user-guide/use-workbench-cli-to-manage-ecs-instances).
>
> What follows is the **minimum set of steps** that works with this plugin (non-interactive forms included, so it can be scripted); where this page and the official docs disagree, the official docs win.


### Install the Workbench CLI (required)

| Platform | Command |
|---|---|
| Windows (PowerShell) | `irm https://workbench-cli.oss-cn-hangzhou.aliyuncs.com/install.ps1 \| iex` |
| Linux / macOS | `curl -fsSL https://workbench-cli.oss-cn-hangzhou.aliyuncs.com/install.sh \| bash` |

Verify after install:

```bash
workbench version     # should print version / commit / build date
```

> ⚠️ **Windows note**: if you installed the CLI *after* the Harness process started, the host process's inherited `PATH` is stale and `workbench` will not resolve on its own. The plugin includes a fallback scan of common install locations, so it usually works without a restart; if it still fails, restart the Harness session or add the install directory (e.g. `C:\Program Files\workbench`) to `PATH`.

### Configure credentials

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

**One-shot setup script (Windows):** the repo ships [`scripts/workbench-setup.ps1`](../../scripts/workbench-setup.ps1) supporting all 5 modes and non-interactive multi-profile setup:

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

### Minimum RAM policy (recommended)

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

### Manual install (advanced)

Add the plugin row to your Cordis composition instead (cordis.yml / cordis.patch.yml):

```yaml
- id: dsh-workbench-ecs
  name: dsh-workbench-ecs
```

Note: the settings panel is only wired up by the `dsh` command (which uses the package's `dsh.bundle` layer and `dsh.client` declarations). Add the row to **each** profile you want it in — `%DSH_HOME%\profiles\web` for the browser, `%DSH_HOME%\profiles\desktop` for the desktop app.

### Local development from a checkout

Use [`scripts/install-local.ps1`](../../scripts/install-local.ps1) to link the repo into `%DSH_HOME%` with a junction and write the plugin row for you. It is idempotent and reversible:

```powershell
# every profile that already exists (web + desktop)
powershell -ExecutionPolicy Bypass -File .\scripts\install-local.ps1
# just one of them
powershell -ExecutionPolicy Bypass -File .\scripts\install-local.ps1 -Profile desktop
# inspect / undo
powershell -ExecutionPolicy Bypass -File .\scripts\install-local.ps1 status
powershell -ExecutionPolicy Bypass -File .\scripts\install-local.ps1 uninstall
```

A profile directory only exists after its host has started once (`dsh web` for `web`, the desktop app for `desktop`). Edits apply on the next patch reload, a page refresh, or the relevant host restart — the desktop app reads its profile once at process start, so it needs a restart.
