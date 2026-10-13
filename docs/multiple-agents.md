# Named sessions and coding tools

One gateway can address multiple computers, coding tools and conversations. Start with `/host <id>`, `/sessions`, then `/session <number>`: the selected native conversation supplies its directory and engine (`codex`, `opencode`, or `claude`). `/dir <path or shortcut>` optionally narrows discovery; `/dir all` clears the filter. The configuration retains the `projects` field for directory/tool routes and backward compatibility.

## Parallel conversations

Existing project conversations migrate to the `main` thread. Their native session IDs are preserved. These commands create or select additional threads:

```text
/dir pc-code
/thread review
Review the error handling in this repository
/thread tests
Find missing tests for the parser
/threads
/in vm-code/review Review the latest changes
```

`/thread <name>` creates an empty named thread if necessary and selects it; its first prompt creates a native session. Names use letters, numbers, underscores or hyphens. `/threads` lists the relay's named threads. `/sessions` browses native conversations across the selected computer, or within an optional directory filter; `/session 1` selects a listed conversation and its directory/engine. Switching conversations does not stop other runs. Plain text and file captions go to the selected thread. `/in <directory-shortcut>/<thread> <prompt>` addresses another thread without switching.

Each thread has its own pending messages, permissions, native ID and run state. `/status <project>/<thread>` and `/stop <project>/<thread>` target it explicitly. Bare `/approve`, `/deny`, and `/cancel` apply to the currently selected thread, even when other runs are waiting. Use an explicit target such as `/approve pc-code/review` to answer another thread's request; each approval message includes its target. The relay refuses to run the same native session simultaneously through two slots it controls. Other clients remain independent; Codex writer ownership can remain held even while a desktop conversation is idle.

Parallel conversations in one folder share its files. Use separate worktrees/project folders when agents should edit independently. Incoming and outgoing attachments remain in that project's `.whatsapp-relay` storage; named threads do not silently duplicate or isolate files.

## Engine configuration

See [the multi-engine example](../examples/controller-config.multi-engine.json). Configure at least one source for each coding tool on each computer; discovered conversations supply additional directories automatically. Unspecified engines remain Codex for compatibility. Codex's global model/profile settings are not applied to other engines.

### Codex

Launches a separate native `codex app-server` using the existing account and local session store. Supports its existing sandbox modes and interactive approvals through the relay. Each named thread maps to a native Codex thread. It cannot attach to a conversation still owned by the desktop app's server. When `thread/resume` refuses with `already has an active writer`, no new turn has been submitted; finish desktop work and fully quit the owning client before resending, or explicitly start a different conversation with `/new`. See [operational limits](host-vm.md#operational-limits-and-validation).

### OpenCode and OpenChamber

Set `engine: "opencode"` and `opencodeUrl` to the **existing** OpenCode server origin. When OpenChamber is in use, point at its OpenCode backend so both interfaces access the same conversations. No new server is started. OpenChamber-specific scheduling, multi-run and other UI workflows are not reimplemented by this adapter.

The adapter supports the OpenCode v1 and v2 API families. `opencodeApiVersion` can be `auto`, `v1` or `v2`. Pin the verified API version for an installed deployment. A JSON health/API response is required; an HTML fallback page is not accepted as proof of API availability.

Authentication uses environment-variable names, never a password in the configuration or URL. Defaults are `OPENCODE_SERVER_USERNAME` and `OPENCODE_SERVER_PASSWORD`; `opencodeUsernameEnv` and `opencodePasswordEnv` select alternatives. On a VM, those variables must be available to the worker **on the VM**. The gateway does not forward its credentials. The Node launcher (`scripts/launch.mjs`) refreshes only the configured authentication variables from the existing Windows user/machine environment without printing them, and preserves native MCP stdin/stdout pipes.

On Windows, a registration using that launcher looks like:

```powershell
codex mcp add whatsapp-relay -- node C:\Relay\codex-whatsapp-relay\scripts\launch.mjs mcp
```

Use your actual full checkout path. `node scripts/launch.mjs startup` starts an already paired and enabled gateway idempotently, and leaves an unconfigured gateway inactive. `node scripts/launch.mjs pair --enable-controller` prints a private localhost pairing URL and allows the linked account's own number after scanning. Open that URL and use WhatsApp's Linked devices screen to scan. The QR stays in memory and expires after at most ten minutes. The optional `scripts/windows-launch.ps1` wrapper supports interactive pairing and login startup; register MCP directly with Node. The gateway belongs on the PC only; the VM needs just the worker checkout.

OpenCode projects use `permissionLevel: "native"`, preserving the server and session's rules. This is not a Codex OS sandbox. The relay supports explicit one-time permission decisions; it does not turn a temporary approval into OpenCode's persistent `always` grant. A native form/question needing richer input requires attention in OpenCode/OpenChamber. Failed or uncertain prompt admission is never automatically replayed.

References: [OpenCode server API](https://opencode.ai/docs/server/), [OpenChamber backend configuration](https://docs.openchamber.dev/environment/).

### Claude Code

Set `engine: "claude"`. Uses the installed native Claude Code CLI and its existing account, instructions, MCP connections and hooks. This controls **Claude Code**, not Claude web/desktop account chats. `claudeBin` can be configured globally or per host when the SSH environment cannot find it.

Requires a CLI supporting `--permission-prompts none` (Claude Code 2.1.259 or newer). Prompts travel through stdin; responses use structured output. New sessions get explicit IDs, and resumes verify that the native transcript belongs to the selected workspace. Session listing reads bounded metadata from the native transcript store.

Claude projects use `permissionLevel: "native"`. Actions requiring unanswered interactive permissions fail or are denied by the native CLI; the relay does not bypass permissions. Review the reported denial in a native Claude Code session before continuing. Claude's native permission system is not presented as a Codex filesystem sandbox.

Reference: [Run Claude Code programmatically](https://code.claude.com/docs/en/headless).

## VM and memory

Use the full same-version checkout on the VM. The existing SSH worker runs the selected adapter under the VM user's account. OpenCode HTTP requests originate inside the VM, so its local backend and credentials remain local. Only run events, approval decisions, prompt/result text and requested file bytes cross the SSH connection.

Preserve the native coding tools' configured Hindsight connections and the existing transcript collector. This feature introduces neither a memory database nor an archive importer. Verify actual recall and capture under each machine's user account; a healthy SSH connection alone does not establish memory access.
