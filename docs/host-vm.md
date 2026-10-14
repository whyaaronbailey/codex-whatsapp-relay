# One WhatsApp gateway for a PC and VM

The main PC runs one WhatsApp controller. Choose a computer with `/host`, browse its conversations with `/sessions`, then select one with `/session 1`. The conversation supplies its directory and coding tool automatically. The VM runs the relay worker on demand; it does not need a second WhatsApp login, controller daemon, agent framework, or memory service.

For OpenCode/OpenChamber, Claude Code, or several simultaneous conversations in one directory, see [named sessions and coding tools](multiple-agents.md). The machine and file setup below applies to all three engines.

For an existing desktop-owned Codex conversation, this preview offers an opt-in [shared gateway adapter](shared-codex-gateway.md). The standard setup described below uses separate app-servers; it does not enable that experimental integration.

```text
WhatsApp phone
      |
Main PC: one linked-device gateway and controller
      |-- host / pc-work --> local Codex app-server --> local workspace
      `-- vm / vm-work   --> SSH worker --> VM Codex app-server --> VM workspace
```

An active remote Codex run keeps its SSH connection open. File operations use separate short-lived worker calls. Prompts, paths, and attachment bytes travel as JSON over stdin; the gateway does not interpolate them into remote shell commands. SSH uses the configured target, normal host-key checking, and `BatchMode=yes`. Both the PC and VM must be available for VM work.

## Prepare each machine

Use the same revision of this fork on both machines and install that revision's dependencies with `npm ci`. The worker is `plugins/whatsapp-relay/scripts/relay-worker.mjs` in the VM checkout. It imports other modules from this checkout, so copy or clone the full repository, not just that file.

On each machine, use the operating-system account that already runs Codex. Its Codex CLI must be installed and authenticated. The relay launches native `codex app-server`, so that account's Codex home, configuration, instructions, and existing sessions remain the source of truth. On Windows, the CLI launcher resolves npm's Codex wrapper to the native executable.

The PC needs the OpenSSH client. The VM needs an SSH server that the PC can reach, plus Node.js 20 or newer and Codex available in the SSH account's environment. The worker does not install software or set up SSH. Configure an SSH alias such as `relay-vm` in the PC account's SSH config and establish its host key normally. Authentication must work without an interactive password prompt; a key or an already available SSH agent is suitable.

These read-only checks exercise the intended SSH identity and executable lookup:

```powershell
ssh -T -o BatchMode=yes relay-vm node --version
ssh -T -o BatchMode=yes relay-vm codex --version
```

If the noninteractive SSH environment cannot locate Node or Codex, configure absolute `nodeBin` and `codexBin` paths for the VM host. A custom `CODEX_HOME` must be available in the corresponding machine's process environment; the gateway does not copy its own environment to the VM.

## Configure computers and coding tools

Register the full release checkout's MCP server in Codex on the gateway PC. From the repository root in PowerShell:

```powershell
$relayLauncher = (Resolve-Path ./scripts/launch.mjs).Path
codex mcp add whatsapp-relay -- node $relayLauncher mcp
```

Restart Codex to load the tools. If an installed WhatsApp Relay plugin already provides them, use a single registration pointing at this checkout; avoid loading duplicate relay MCP servers. The VM only needs the worker checkout, not this WhatsApp MCP registration. This command changes the gateway user's Codex MCP configuration; it does not pair WhatsApp or start the controller.

Use [the example configuration](../examples/controller-config.host-vm.json) as a template. Its paths and SSH alias are placeholders. Merge the desired settings into `plugins/whatsapp-relay/data/controller-config.json` in the gateway checkout. Preserve any existing controller allowlist and local configuration. Stop the controller before changing its host or project definitions, then restart it.

The example starts disabled and has an empty allowlist. After authentication, register your own WhatsApp number using the plugin's `whatsapp_allow_controller` tool. Start the controller using `whatsapp_start_controller_bridge`; it enables the configuration. Existing WhatsApp credentials stay in `plugins/whatsapp-relay/data/auth`. Do not copy those credentials to the VM or force a new login when the gateway is already linked.

The `whatsapp_start_controller_bridge` tool also accepts `hosts`, `projects` (including each project's `host`), `defaultProject`, and `maxAttachmentBytes` directly. Omitted fields preserve the saved settings; a supplied hosts or projects array replaces that entire array. Stop the bridge before changing those definitions, then start it with the complete desired arrays. `whatsapp_controller_status` reports configured host IDs, each project's host, and the attachment limit.

Important fields:

| Field | Meaning |
| --- | --- |
| `hosts[].id` | Stable machine identifier used by `/host`; lowercase letters, numbers, hyphens, or underscores. |
| `hosts[].transport` | `local` or `ssh`. Missing host configuration retains the legacy local `host` default. |
| `hosts[].target` | SSH alias or `user@hostname` for a remote host. Put SSH options in the SSH config. |
| `hosts[].platform` | `linux`, `darwin`, or `win32`. SSH defaults to Linux. |
| `hosts[].workerPath` | Absolute path to `relay-worker.mjs` on the VM. |
| `hosts[].nodeBin` / `codexBin` | Optional executable paths on that machine. |
| `projects[].host` | Configured machine ID; defaults to `host` for legacy projects. |
| `projects[].alias` | Globally unique directory shortcut, retained under this configuration key for compatibility. |
| `projects[].workspace` | Absolute workspace on the selected machine. Remote `~` and relative paths are rejected. |
| `maxAttachmentBytes` | Positive integer up to 26,214,400 bytes (25 MiB); defaults to this maximum. |

The example targets a Windows PC and Windows VM. The SSH launcher uses Windows PowerShell with an encoded bootstrap so Node and worker paths can contain spaces. For a Linux VM, set its `platform` to `linux`, `workerPath` to an absolute POSIX path such as `/opt/codex-whatsapp-relay/plugins/whatsapp-relay/scripts/relay-worker.mjs`, and its project workspace to a path such as `/home/agent/projects/example`.

Use distinct directory shortcuts such as `pc-work` and `vm-work` even if both machines store files at an identical path. Remote POSIX paths remain POSIX paths when the gateway runs on Windows. Configure at least one working route for each coding tool you want to discover on each computer. Its workspace is a launch directory, not a restriction on host-wide discovery. Additional session directories are selected automatically from native metadata.

To resume an existing VM conversation, send `/host vm`, `/sessions`, and `/session <number>`. The list searches native session stores across directories for the configured coding tools on that computer. Selecting a conversation activates its real directory and engine. `/dir <absolute path or shortcut>` optionally narrows the list; `/dir all` clears that filter. The internal `projects` configuration schema and legacy `/project` commands remain compatible.

## Control sessions from WhatsApp

Send commands from an allowed direct chat. A self-chat can be used when the linked WhatsApp account is your own.

| Message | Result |
| --- | --- |
| `/hosts` | Lists computers and marks the selected computer. |
| `/host host` | Selects the PC and clears the directory filter. |
| `/host vm` | Selects the VM and clears the directory filter. |
| `/dir`, `/dirs` | Shows the directory/filter or lists configured directory shortcuts. |
| `/dir C:\Work\My Repository` | Selects that directory on the current computer and narrows the session list. |
| `/dir all` | Returns to listing across directories. |
| `/new Summarize this repository` | Starts a native session in the selected directory. |
| `/sessions`, `/sessions more` | Lists native conversations on the selected computer, with optional directory filtering and additional pages. |
| `/session 1` or `/1` | Selects a listed conversation and its directory and coding tool automatically. |
| Plain text | Continues the selected session. |
| `/status` | Shows the selected computer, directory and session status. |
| `/files` | Lists up to 20 recent stored incoming/outgoing attachments for the selected directory. |
| `/send reports/result.pdf` | Sends that workspace-relative file back to the chat. |

Session discovery uses the selected computer's native account and configured services. The list includes saved conversations; native activity is not always available, so saved sessions are not automatically described as running or idle. Discovery is bounded to 200 results per configured provider source and paged for WhatsApp. Failures from one coding tool are reported alongside successful results from others. Changing computers or directory filters invalidates old numbered choices. This continues native sessions through the tool's integration interface; it does not control desktop windows.

## Where files go

Attach a document or image in the chat after selecting a conversation or directory. The relay saves it on the selected computer under:

```text
<workspace>/.whatsapp-relay/inbox/<transfer-id>/<sanitized-filename>
```

The confirmation includes its relative path, size, and SHA-256 hash. An attachment caption becomes a Codex prompt about that file after storage succeeds. Without a caption, the file is stored and acknowledged. Captions are not interpreted as administrative slash commands.

For a return file, ask Codex to write the result inside the workspace, then send `/send <relative path>`. The relay snapshots the exported bytes under `.whatsapp-relay/outbox/<transfer-id>/`, sends a WhatsApp document, and records successful sends in a manifest. `/files` lists these transfer records; it is not a general directory browser. Originals are never overwritten by incoming attachments.

Codex can also call the plugin's `whatsapp_send_file` tool when the controller is running. Supply `chatId` or `chatName`, an exact configured `projectAlias` such as `vm-work`, and a workspace-relative `relativePath` such as `reports/result.pdf`. The tool queues the request for the project's configured host; its response confirms queuing, not delivery. The controller checks the file, snapshots it, and records the successful send. Changing a project's host before a queued request runs invalidates that request instead of sending a file from a different machine.

The storage root contains `.whatsapp-relay/.gitignore` with `*` to exclude transfer contents from Git. Filenames are sanitized, payload sizes are bounded, and manifests record direction, status, timestamps, size, and hash. Absolute export paths, traversal, links/junctions, and common credential/configuration files are rejected. Workspace attachments are persistent files: there is no automatic expiration or retention cleanup in this implementation. Include them in your normal storage and cleanup decisions.

## Keep the existing Hindsight archive

This bridge introduces no separate memory database and no transcript ingester. Codex on each selected machine continues using its existing MCP configuration and instruction files. If those already connect to Hindsight, the relay's native Codex process can use that setup under the same account.

Preserve the existing Hindsight service, memory banks, recall rules, and transcript collector. Do not install another collector just for WhatsApp. Verify one new local session and one VM session by asking each to recall a known memory, then check the existing collector after its usual indexing delay. That confirms the actual machine/account wiring; configuring SSH alone does not prove memory access or indexing.

Loopback addresses belong to the machine running Codex. A VM's `127.0.0.1` is not the PC. Reuse the already verified VM-to-Hindsight route rather than copying the PC's loopback URL or exposing an unauthenticated service publicly. Only the selected workspace's files are transferred by the bridge; archives are not copied between machines.

## Operational limits and validation

Run one gateway for the linked WhatsApp account. The per-user owner lock prevents a second local checkout from claiming the controller on that machine. Windows uses the actual user home for this lock even when `HOME` is absent. The lock does not coordinate different operating-system accounts or separate computers, and process liveness is checked by PID rather than a process identity token.

The Codex adapter launches its own native app-server rather than attaching to the desktop app's app-server. Native writer ownership can remain held for a loaded conversation even when the desktop reports it as idle. Listing or selecting a saved session does not prove it can be resumed. When `thread/resume` rejects with `already has an active writer`, the relay has not submitted a new turn. That assurance applies to this specific resume rejection, not to arbitrary connection or turn failures.

For that error, the selected conversation and directory are preserved. Let work in the owning client finish, fully quit that client on the selected computer, and then resend your message to continue the same conversation. Switching tabs or finishing a turn alone may not release ownership. `/new <prompt>` is an explicit alternative that starts another conversation with separate history. Do not delete lock files, terminate another client's work, or copy transcripts to evade ownership. To keep the desktop open during ordinary use, see the opt-in [shared gateway adapter](shared-codex-gateway.md); it requires a verified connection to the same owning backend and is not enabled by this setup.

Portable voice dictation and spoken replies are postponed. The upstream voice-note implementation remains present, with platform-specific dependencies; do not treat it as working Windows voice support. Text commands and document/image transfer are the initial supported workflow.

Before relying on unattended use, validate this sequence on the actual linked account:

1. Select `pc-work`, start a session, and receive a text reply.
2. Select `vm-work`, start a session, and verify the reply came from the VM workspace.
3. List and continue an existing session on each machine after its previous client releases ownership. Separately verify that a desktop-owned conversation produces a clear refusal without starting a turn, and that its selected ID and directory are preserved.
4. Upload a small text file with a caption on each machine; verify the saved location and contents.
5. Send an output file back from each machine and compare its hash/content.
6. Confirm an unknown sender cannot control the bridge and an export outside the workspace fails.
7. Confirm Hindsight recall and existing transcript capture on both machines.

Automated tests cover routing, path handling, transfer rules, and Windows startup behavior. They do not replace this live WhatsApp/SSH validation.
