# Existing desktop sessions through a shared gateway

This experimental adapter lets the WhatsApp controller connect to the same Codex backend as the desktop app. It reuses an independently installed realtime gateway. It does not install that gateway or add an AI routing agent. A normal WhatsApp prompt still causes the selected Codex session to do work; connection checks, heartbeats and reply collection use ordinary code.

The default adapter continues to start its own app-server. Enable the shared adapter only after the gateway can prove that the desktop is connected to its loopback backend. A desktop using its ordinary private connection cannot be attached merely by enabling this setting. Switching that desktop to the gateway may require a one-time quit and relaunch after its current work finishes.

### Findings from the v0.8.0 preview

Live validation of the v0.8.0 preview found that a verified desktop WebSocket connection is insufficient for activation:

- An independently launched backend can lose the desktop's app-tools bootstrap context. In the tested Windows installation, app-tools MCP failed because `CODEX_APP_TOOLS_PIPE_PATH` was absent, removing native chat and automation controls. Retaining startup feature flags did not preserve these tools. Repeatedly restarting the same launcher does not resolve the missing context.
- Creating a new paginated-history conversation succeeded, but history inspection before its first prompt failed with `missing source rollout`. The prompt was not submitted. New-session delivery needs a validated first-turn flow; do not interpret that error as empty history for arbitrary existing conversations or automatically retry uncertain creation attempts.

Keep each route disabled until both native desktop tools and a complete message/reply test pass on that machine. The standard adapter can still work with conversations it owns; it cannot take over a conversation held by the desktop.

### Desktop-owned bridge candidate

The unreleased source includes an alternative Windows transport under `scripts/stage-desktop-owned-bridge.mjs` and `plugins/whatsapp-relay/scripts/desktop-owned-bridge.mjs`. The desktop launches a small executable shim through its installed `CODEX_CLI_PATH` override. The shim delegates to the native backend using the desktop's original arguments and inherited environment. The broker passes the desktop's stdio traffic through and exposes a capability-protected loopback WebSocket for the gateway. It does not copy or reconstruct private desktop bootstrap values.

The desktop performs the native initialization and receives every server-originated tool or approval request. Gateway connections have a restricted method list, separate request IDs and bounded message queues. Closing a gateway connection does not cancel or replay a native turn. Normal desktop EOF closes the native stdin pipe; the bridge never force-stops the backend.

Readiness requires a successful initialization reply delivered to the desktop, followed by either its `initialized` notification or a successful reply to a later desktop request. This accommodates desktop builds that omit the notification without inventing protocol messages. The health response exposes only handshake flags and the readiness basis; it does not include request contents, credentials or private desktop context. A ready connection still needs the tool and message validation described below.

This is an experimental compatibility layer, not a confirmed native multi-client feature. The `CODEX_CLI_PATH` override and package/sandbox behavior require validation against the installed desktop version. Staging and offline tests do not establish native tool parity. Do not enable the route until the actual desktop-owned process chain, tools and message/reply round trip have passed validation on that machine.

On 2026-10-15, the candidate passed live validation on a Windows VM with desktop version `26.1007.9446.0`: a new dedicated chat completed its first message, a second message completed in the same chat, and persisted native history confirmed a successful `codex_app/read_thread` call. The connection also exposed Hindsight recall metadata. These checks used the relay's SSH gateway path; they do not establish phone-originated WhatsApp delivery, every native tool's behavior, or compatibility with another desktop installation.

The Windows verifier starts its five-second freshness window immediately before its first process observation, after PowerShell startup and built-in module loading. Process ancestry, listener ownership, full-file hashes and the live connection response all remain inside that window. A binding records exact live process identities: a later desktop restart requires a fresh verified capture. Do not update recorded process IDs by hand or replay a completed launch plan.

When migrating from an independently running backend, first verify that other local Codex work has finished and close its automatic management and new-work admission. The launcher waits for a normal desktop Quit, an empty loaded-session list, and the natural exit of the old backend's tracked descendants, including helper backends outside the desktop's process tree. It retains the old backend itself and never terminates processes or deletes writer locks. Ambiguous process identities, newly observed descendants, or uncertain launch results prevent a new launch; they are not grounds for an automatic retry.

Tracking begins when the launcher is armed. Before arming, reconcile every previously observed backend descendant and intermediate parent with fresh process evidence. A surviving process whose parent has already exited must not disappear from the review merely because its current ancestry no longer reaches the old backend. Leave activation unarmed whenever ownership or ongoing work is uncertain.

The bridge worker configuration additionally requires `transportTokenFile`, an absolute local path to a private 64-character base64url capability. Generate it independently on each machine from 48 random bytes and restrict its Windows ACL to the user and SYSTEM. Do not send it through WhatsApp, copy it between machines, or commit it. The gateway transport must support authenticated WebSocket handshakes, and new-session delivery requires the upgraded gateway core's `send_created` method.

## Installation contract

Install the same relay revision on both machines. Each machine needs Python 3.11 or newer and its own verified gateway installation containing `gateway_core.py`, `gateway_runtime.py`, and `vm-test/rpc_probe.py`. The gateway code is an external dependency and is not bundled in this repository. Its runtime verifier must accept explicit `expected_computer` and `expected_host` arguments for VM use. Use the native user's normal Codex home and preserve their existing tools and settings.

Add a `codexGateway` object to the corresponding controller `hosts` entry:

```json
{
  "id": "host",
  "transport": "local",
  "platform": "win32",
  "codexGateway": {
    "pythonBin": "C:\\Python311\\python.exe",
    "configPath": "C:\\RelayGateway\\whatsapp.json"
  }
}
```

For the VM, retain its `transport: "ssh"`, `target`, `workerPath` and `nodeBin`; add the same object with paths that exist **inside the VM**. WhatsApp credentials remain on the main PC. The SSH worker starts a short-lived Python observer locally on the VM; the desktop backend remains owned by the gateway. Do not expose the unauthenticated WebSocket port to the network.

The host-local worker configuration is separate from the controller configuration:

```json
{
  "gatewayRoot": "C:\\RelayGateway\\source",
  "bindingManifest": "C:\\RelayGateway\\runtime\\binding.json",
  "ledgerDir": "C:\\RelayGateway\\state\\whatsapp",
  "expectedComputer": "MY-PC",
  "host": "local",
  "sender": { "kind": "whatsapp", "id": "relay-owner", "host": "local" },
  "workflow": "whatsapp-user-message",
  "allowSelectedSessions": true,
  "allowCreateSessions": true,
  "allowedWorkspaceRoots": ["C:\\Work"],
  "observationTimeoutSeconds": 3600
}
```

These are placeholders. `expectedComputer` must match the actual machine name. `host` must match the gateway binding manifest; it is a gateway identity and need not be the relay's `/host` shortcut. The manifest is produced by the verified gateway lifecycle manager. Do not fabricate its process IDs or socket proof.

`allowSelectedSessions` permits an allowed WhatsApp sender to choose native sessions with `/sessions` and `/session`. Before sending, the adapter checks the exact native session ID and directory against the verified backend. `allowedWorkspaceRoots` optionally restricts this selection and creation to specific directories. Both selection and creation are disabled unless explicitly enabled. Fixed destination policies can be configured instead and take precedence over dynamic selection.

Keep the worker configuration, runtime manifests and request ledger private. Their paths are supplied by the installation, never interpreted from a WhatsApp prompt or file attachment. Preserve these records during upgrades; deleting request receipts can remove duplicate protection.

## Usage and limits

The phone workflow stays the same:

```text
/host vm
/sessions
/session 1
Please continue the comparison study.
```

The session supplies its directory. Uploads and `/send` continue using the existing inbox/outbox and SSH file transfer paths. Hindsight and native transcripts remain with the same account and session.

Existing sessions retain their native model and permission settings. Manage their permissions in Codex; the shared adapter does not apply WhatsApp permission switches. An unloaded session whose settings cannot be preserved is refused before a prompt is sent. Open the session in the desktop before trying again. New sessions require `allowCreateSessions` and an explicitly selected directory, and use the relay's configured permission level for that new conversation only.

An existing conversation must have a nonempty title in Codex, because the gateway checks its title along with its ID and directory. The relay does not rename existing conversations automatically.

The shared adapter currently leaves approval decisions and stopping native work to the Codex desktop. A WhatsApp or SSH disconnect detaches the observer; it does not stop the desktop session. `/stop` cannot override an unresolved delivery receipt or claim that the native turn was stopped.

Each WhatsApp message gets a durable request ID. Duplicate delivery reuses the recorded outcome. If the connection fails after submission may have started, the controller holds follow-ups rather than automatically resending. Use `/status refresh` to query the saved request and native history without submitting it again. A completed response can be recovered this way; otherwise the status remains unresolved and includes its request ID. A lost response while creating a new session is also held for inspection, preventing accidental duplicate conversations.

## Validation before activation

Offline tests exercise routing, request receipts, disconnect handling and the adapter contract. They do not establish a live desktop connection. Validate these on each actual machine before relying on the integration:

Run the relay checks with `npm run check` and `npm test`, plus the portable worker suite with `python -B plugins/whatsapp-relay/scripts/test_codex_gateway_worker.py -v`.

1. The gateway verifies the desktop's exact process identity and connection to its backend.
2. `/sessions` lists the expected native session and directory.
3. A harmless prompt reaches that exact session while the desktop stays open, and its reply returns to WhatsApp.
4. Repeated delivery of the same request does not create another turn.
5. An interrupted observer can recover the response by request ID without resubmission.
6. Existing model, permissions and tools remain usable; attachments still reach the selected directory.

Upstream Codex's WebSocket app-server interface is experimental. See the [official app-server documentation](https://learn.chatgpt.com/docs/app-server). Keep the gateway disabled when its runtime ownership checks or installed-version checks fail.
