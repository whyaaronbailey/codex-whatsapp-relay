# Codex WhatsApp Relay

This fork adds one WhatsApp gateway for Codex, OpenCode/OpenChamber and Claude Code on a PC and a VM, with named parallel sessions and bidirectional file transfers. Based on [Adolfo Builes' original relay](https://github.com/abuiles/codex-whatsapp-relay).

**Preview status:** host/VM routing, named sessions, multiple coding engines and attachments are available in this fork's preview release. Automated tests cover the bridge and worker on Windows and Linux; live WhatsApp pairing and PC-to-VM deployment must still be verified on your machines. Portable Windows voice dictation is deferred. See [releases](https://github.com/whyaaronbailey/codex-whatsapp-relay/releases) for the published tags; inherited tags through `v0.4.3` contain the original feature set.

Start with [the host/VM setup guide](docs/host-vm.md), [named sessions and coding tools](docs/multiple-agents.md), and [example configuration](examples/controller-config.host-vm.json). This uses each machine's existing accounts, instructions and Hindsight connections, with no additional agent framework or memory store.

```powershell
git clone --branch v0.6.1 https://github.com/whyaaronbailey/codex-whatsapp-relay.git
cd codex-whatsapp-relay
npm ci
npm run check
npm test
$relayLauncher = (Resolve-Path ./scripts/launch.mjs).Path
codex mcp add whatsapp-relay -- node $relayLauncher mcp
```

For an existing checkout, fetch tags and select the same release on both machines after preserving local changes. Run one linked WhatsApp gateway on the PC and the worker on the VM. Use `/hosts`, `/host vm`, `/sessions`, `/session 1`, `/dir`, `/new`, `/files` and `/send <relative path>`. Documents, images and videos save into the selected workspace's `.whatsapp-relay/inbox`; exports get persistent outbox snapshots and hash manifests. Transfers are limited to 25 MiB each.

The relay source is [MIT licensed](LICENSE). See [attribution and third-party licenses](THIRD_PARTY_NOTICES.md), [contribution guidance](CONTRIBUTING.md), and [security reporting](SECURITY.md). Dependencies retain their own licenses. This is an independent community project using Baileys, an unofficial WhatsApp integration; it is not affiliated with OpenAI or WhatsApp/Meta. The repository remains `private: true` in `package.json` only to prevent accidental npm publication; source releases are public on GitHub.

## Install In Codex

This installs the tagged preview from this fork as a direct MCP server using the full checkout. Follow [the host/VM guide](docs/host-vm.md) to configure machine routing and file transfers. The inherited plugin manifest is retained, but plugin-cache installation and its dependency placement have not been verified for this preview.

Paste this prompt into Codex:

```text
Install WhatsApp Relay for my user account through a direct Codex MCP registration.

Use this repository as the source:
https://github.com/whyaaronbailey/codex-whatsapp-relay

Install the current release tag:
v0.6.1

Do all of the following:

1. Clone the repo into ~/.codex/plugins/whatsapp-relay if it does not exist yet.
2. If it already exists, fetch tags and check out v0.6.1 without deleting unrelated user files.
3. Run npm ci inside ~/.codex/plugins/whatsapp-relay.
4. Resolve the absolute path to scripts/launch.mjs in that checkout.
5. Register it with: codex mcp add whatsapp-relay -- node <absolute-launcher-path> mcp
6. Preserve unrelated MCP entries and existing Hindsight configuration. If a relay registration already exists, inspect it and update only that entry. Avoid loading a duplicate relay through a plugin.
7. Verify the registration with codex mcp list and tell me to restart Codex.
8. After restart, verify the WhatsApp Relay tools are available. Pair WhatsApp only when I ask to link it.

Only set up the local checkout and MCP registration. Do not push, publish, or start the controller.
```

## After Install

1. Restart Codex.
2. Verify that the `whatsapp-relay` MCP tools are available.
3. Ask Codex to link your WhatsApp account and verify the authentication status.
4. Configure your controller allowlist and computers and coding tools using the setup guide before starting phone control.

The authentication flow shows a QR code for you to scan and verifies the session. If you want phone control, ask Codex to enable it after configuration. If you use the same WhatsApp account on your phone, `Message yourself` can be used as the control surface.

## Choose a computer, then a conversation

Type these commands in **WhatsApp**, in your allowed direct chat or **Message yourself**:

```text
/hosts
/host vm
/sessions
/session 1
Continue where we left off
```

A **host** is a computer: your PC or VM. A **session** is a native conversation with Codex, OpenCode or Claude Code. Each session already knows its working directory. Selecting it automatically chooses the correct directory and coding tool; you do not need to register that folder first.

`/sessions` searches across directories for the configured coding tools on the selected computer. The numbered list includes the tool and directory. It contains saved conversations as well as any sessions known to be working; it is not a list of open desktop windows. Activity is only labeled when the native tool or this relay can establish it. Discovery uses the operating-system account and native services configured for that computer.

The list is bounded and paged for WhatsApp. Use `/sessions more` for another page of the current list. Refresh with `/sessions`; changing the computer or directory filter invalidates old numbered choices. A coding tool that cannot be reached is reported rather than silently hiding its sessions.

## Directories are optional

You can narrow discovery when you already know where you want to work:

```text
/dir C:\Work\My Repository
/sessions
/dir all
/sessions
```

`/dir` shows the current working directory and listing filter. `/dirs` lists configured directory shortcuts; `/dir <shortcut>` selects one. An absolute path uses the selected computer and current coding tool. `/dir all` clears the listing filter while keeping the current conversation available. Selecting a computer with `/host` also resets the directory filter.

For a new conversation, choose a directory and send `/new <prompt>`. Files you upload, and files you return with `/send`, use the selected conversation's directory.

The configuration file retains its older `projects`, `defaultProject` and `projectAlias` field names for compatibility. They describe directory/tool routes, not ChatGPT Projects. Existing `/project` and `/projects` commands remain supported; everyday use starts with computers and sessions.

## Phone commands

| Command | Action |
| --- | --- |
| `/hosts`, `/host <id>` | List or select a computer. |
| `/sessions`, `/sessions more` | Browse native conversations across directories on that computer, or within an optional directory filter. |
| `/session <number>`, `/1` | Continue a listed conversation with its directory and coding tool selected automatically. |
| `/dir`, `/dirs`, `/dir <path or shortcut>`, `/dir all` | Inspect, select or clear the optional directory filter. |
| `/new <prompt>` | Start a native conversation in the selected directory. |
| `/status` | Show the selected session, computer, directory and relay run status. |
| `/files`, `/send <relative path>` | List stored transfers or return a file from the selected directory. |
| `/stop` | Stop the selected relay run and clear its queued follow-ups. |
| `/approve`, `/deny`, `/cancel` | Answer a pending approval in the selected relay conversation. |
| `/permissions`, `/ro`, `/ww`, `/dfa` | Inspect or change Codex permissions; full access requires a confirmation code. |
| `/help` | Show command help. |

Plain text and attachment captions continue the selected conversation. Another prompt for a busy relay conversation is queued. Switching conversations does not cancel background work or move queued prompts to the newly selected conversation.

## Several conversations at once

Named relay threads remain available for parallel work in one directory. `/thread review` and `/thread tests` create or select separate conversation slots; `/threads` lists those slots. These are distinct from `/sessions`, which browses the coding tool's saved conversations. See [named sessions and coding tools](docs/multiple-agents.md).

Advanced commands still accept directory shortcuts and named threads: `/in pc-code/review <prompt>`, `/status pc-code/review`, `/stop pc-code/review`, or `/approve pc-code/review`. `/btw <prompt>` asks a disposable side question without changing your selected conversation. Background completions do not steal focus.

## Files, accounts and permissions

One gateway owns the WhatsApp connection. Use the existing native accounts, instruction files, Hindsight configuration and transcript collector on each computer. The relay adds no separate memory database.

Uploads are stored under `<directory>/.whatsapp-relay/inbox`; returned files are snapshotted under `.whatsapp-relay/outbox`. Transfers are capped at 25 MiB, preserve hash manifests, and reject traversal and credential exports. See [file storage and host setup](docs/host-vm.md).

Only explicitly allowed direct-chat senders can control the relay. Credentials under `plugins/whatsapp-relay/data/auth*` are private runtime data. Codex defaults to `workspace-write`; OpenCode and Claude Code retain their native permission systems. Selecting an existing session does not import a stronger permission grant from that conversation. Full Codex access still requires the existing explicit confirmation flow.

The relay coordinates runs it starts, but cannot guarantee exclusive ownership against another desktop client. Finish a desktop turn before continuing the same native session through WhatsApp. Separate directories or worktrees are appropriate when simultaneous conversations should not edit the same files.

Portable Windows voice dictation remains deferred. The following voice instructions describe the inherited platform-specific implementation, not verified Windows support.

## Voice Notes

Voice-note control is local-first. The bridge downloads the WhatsApp audio, normalizes it with `ffmpeg`, runs Parakeet v3 through `uvx`, and then forwards the transcript into the existing `codex app-server` session.

You need these local tools available on the machine running the bridge:

- `ffmpeg`
- `uvx`

Optional environment variables:

- `WHATSAPP_RELAY_STT_MODEL` to override the default `mlx-community/parakeet-tdt-0.6b-v3`
- `WHATSAPP_RELAY_STT_TIMEOUT_MS` to extend or reduce the transcription timeout

The first voice note can be noticeably slower because `uvx` may need to install `parakeet-mlx` and download the model cache.

## Voice Replies

Outbound voice replies are also local-first.

The default provider is Chatterbox. English replies use `Chatterbox-Turbo`, and supported non-English replies use `Chatterbox-Multilingual`.

Provider selection is controlled with environment variables:

- `WHATSAPP_RELAY_TTS_PROVIDER=system` opts out of Chatterbox and uses the macOS `say` fallback.
- `WHATSAPP_RELAY_TTS_PROVIDER=chatterbox-turbo` explicitly keeps outbound voice replies on `ResembleAI/chatterbox-turbo`.
- `WHATSAPP_RELAY_TTS_CHATTERBOX_PYTHON` overrides the Python interpreter used for Chatterbox. By default the bridge looks for `plugins/whatsapp-relay/.venv-chatterbox/bin/python`.
- `WHATSAPP_RELAY_TTS_CHATTERBOX_DEVICE=auto|mps|cpu` controls the Chatterbox device selection. `auto` is the default.
- `WHATSAPP_RELAY_TTS_CHATTERBOX_AUDIO_PROMPT=/absolute/path/to/reference.wav` optionally enables voice cloning for Chatterbox with a local reference clip.
- `WHATSAPP_RELAY_TTS_CHATTERBOX_ALLOW_NON_ENGLISH=0` opts non-English replies back into the macOS fallback instead of multilingual Chatterbox.
- `WHATSAPP_RELAY_TTS_TIMEOUT_MS` extends or reduces the outbound TTS timeout for either provider.

If you want the controller bridge to keep using Chatterbox across restarts, persist it in the bridge config. `whatsapp_start_controller_bridge` accepts `ttsProvider` and `ttsChatterboxAllowNonEnglish`, stores them in `plugins/whatsapp-relay/data/controller-config.json`, and reuses them for future daemon starts.

To install Chatterbox Turbo locally:

```bash
npm run whatsapp:install-chatterbox
```

The installer creates `plugins/whatsapp-relay/.venv-chatterbox`, prefers `python3.11` when that interpreter can build a working virtualenv, falls back to `python3` otherwise, and installs `chatterbox-tts` there so the bridge can call it directly. It also pins `setuptools<81` because the current Perth dependency still imports `pkg_resources`.

To smoke-test whichever provider is active:

```bash
npm run whatsapp:tts:smoke -- --text "Testing local voice replies."
```

To smoke-test Chatterbox Turbo explicitly:

```bash
WHATSAPP_RELAY_TTS_PROVIDER=chatterbox-turbo \
npm run whatsapp:tts:smoke -- --provider chatterbox-turbo --text "Testing Chatterbox Turbo locally."
```

To force the multilingual route during a smoke test, pass a language hint:

```bash
WHATSAPP_RELAY_TTS_PROVIDER=chatterbox-turbo \
npm run whatsapp:tts:smoke -- --provider chatterbox-turbo --language-id es --text "Claro, te doy el resumen corto ahora."
```

The Chatterbox path is slower than `say` because the Python process and model are loaded locally for each generated reply. It is now the preferred provider. English uses Turbo, while supported non-English replies route through the multilingual model. If you prefer the lighter macOS voice path everywhere, set `WHATSAPP_RELAY_TTS_PROVIDER=system`. If you only want the macOS fallback for non-English replies, set `WHATSAPP_RELAY_TTS_CHATTERBOX_ALLOW_NON_ENGLISH=0`. On machines where Perth's native implicit watermarker is unavailable, the helper falls back to Perth's dummy watermarker so local synthesis still works.

## CLI Fallback

If you need to test outside Codex:

```bash
npm run whatsapp:auth
npm run whatsapp:controller
npm run whatsapp:status
```
