# Safety & troubleshooting

> [中文](../zh/safety-and-troubleshooting.md) | English · Back to [README.en.md](../../README.en.md)

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
