# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

## [0.7.1] - 2026-10-13

### Fixed

- Codex writer-ownership refusals now explain that the message was not submitted and preserve the selected conversation. A desktop client can retain ownership while idle; ending its current turn alone does not ensure the relay can resume it.
- Startup acknowledgments distinguish connecting from an accepted turn, and queued follow-ups are held after an ownership refusal instead of being replayed automatically.
- Documentation now states that simultaneous control of a desktop-owned Codex conversation is unsupported by the current separate-app-server adapter. This release improves refusal handling; it does not add a shared desktop connection.

## [0.7.0] - 2026-10-13

### Changed

- Session browsing now starts with a computer: `/host` then `/sessions` discovers native conversations across directories and configured coding tools, with bounded paging and explicit partial errors.
- Selecting a listed session automatically restores its directory and engine without replacing other active or queued conversations.
- `/dir` and `/dirs` expose optional directory selection/filtering; legacy project commands and configuration remain compatible.
- Host and directory changes invalidate numbered session choices; session activity labels distinguish known relay activity from saved native history.

### Fixed

- Claude session discovery verifies directory links with filesystem metadata, including Windows junctions misclassified by older Node.js directory listings.

## [0.6.1] - 2026-10-13

### Fixed

- Native session lists and connection errors identify their host, coding engine and workspace, making project-specific discovery explicit.
- Targeted session selection guidance keeps the project and named thread explicit so subsequent messages reach the intended conversation.

## [0.6.0] - 2026-10-13

### Added

- Named parallel relay threads within one project, independent selection and queues, and explicit project/thread targeting for work and control.
- OpenCode v1/v2 adapters that reuse existing servers and OpenChamber conversations, with native permission handling and no duplicate backend.
- Claude Code native CLI adapter for new/resumed sessions, bounded native session listing, structured results and interruption.
- Multi-engine configuration, SSH worker event/control transport, and Windows launch support for existing user-scoped OpenCode authentication.
- Local browser pairing with an in-memory QR code, verified owner-number enablement, and an idempotent login startup helper.

### Changed

- Project destinations now include their coding engine; Codex remains the default for existing configurations.
- Non-Codex engines use their native permission systems. Codex sandbox settings are never silently presented as equivalent protections.
- Legacy conversations remain the main named thread; `/threads` lists named relay threads and `/sessions` lists saved native sessions.

### Fixed

- Atomic controller-state saves briefly retry Windows file locks, preserve the previous state on failure, and clean up their own temporary files.

Portable voice support remains deferred. Real WhatsApp pairing and installed engine/version checks are required for each deployment.

## [0.5.0] - 2026-10-13

### Added

- Host and VM project routing through one WhatsApp gateway and on-demand SSH workers, preserving each machine's native Codex environment and memory configuration.
- `/hosts` and `/host` selection, host-specific native session listing/resumption, and new-session control.
- Incoming documents, images and videos, caption prompts, `/files`, `/send`, and the `whatsapp_send_file` MCP tool.
- Persistent workspace inbox/outbox snapshots and SHA-256 manifests, with a 25 MiB cap, bounded media downloads, path/link checks and credential export exclusions.
- Host/VM configuration guide and cross-platform automated validation workflow.
- Open-source license and attribution, contributor documentation, private security reporting guidance, and issue/PR templates.

### Fixed

- Windows native Codex launching, hidden controller startup, runtime-directory creation, and user-home ownership lock placement.
- Thread/queue destination binding and concurrent project-state updates.
- App-server initialization, coalesced turn-completion handling, and interruption acknowledgment races.
- Disabled automatic outbound URL previews and removed the vulnerable optional preview dependency.

Portable Windows voice support and live PC/VM WhatsApp acceptance testing remain follow-up work.

## [0.4.3] - 2026-03-30

### Fixed

- `/voice on` and `/voice off` can now be changed while a Codex run is still active, and in-flight replies honor the updated voice mode instead of the stale run-start setting.

## [0.4.2] - 2026-03-29

### Added

- Multi-project WhatsApp controller support, including sticky per-project sessions, `/projects`, `/project`, `/in`, and `/btw` flows inside one chat.
- New project and session helpers for multi-project work, including project-aware session browsing and switching.
- Global controller ownership locking so one checkout cannot silently steal the live WhatsApp session from another.

### Changed

- Project switching now lets Codex resolve natural project hints against the configured projects instead of relying only on exact aliases.
- Voice replies can now send a text companion when the answer includes actionable artifacts like links, slash commands, or confirmation codes.
- High-impact voice prompts now ask for text confirmation more precisely, avoiding benign prompts while still blocking risky repo actions from voice.
- Danger full access confirmations are shorter and easier to confirm from WhatsApp.
- README and bridge help text now document the multi-project controller flows.

### Fixed

- Legacy single-project state is now fully migrated into per-project buckets so thread and error state do not leak across projects.
- Background completions now clearly tell you when a result came from another project while you were already focused elsewhere.
- Approval replies now preserve multi-word project targets instead of collapsing them to the last token.
- Controller summaries and MCP status output now report the active project's thread instead of a stale chat-level thread id.

## [0.4.1] - 2026-03-28

### Changed

- Controller bridge restarts now reuse persisted local TTS defaults from `controller-config.json`, so outbound voice replies can stay on Chatterbox across daemon restarts.
- Chatterbox is now the default outbound TTS integration for WhatsApp voice replies, with Turbo for English and Chatterbox Multilingual for supported non-English languages.
- The non-English override can still force macOS `say` as a fallback when operators do not want multilingual Chatterbox.
- Voice-reply language tags are now stripped more robustly so hidden metadata does not leak into visible replies or local TTS.
- The local smoke-test command now accepts an explicit `--language-id` override for multilingual routing checks.
- Chatterbox install verification now checks the multilingual import path, and persisted boolean-like relay settings are normalized more safely when loaded from disk.

## [0.4.0] - 2026-03-28

### Added

- Optional local outbound TTS provider support for `ResembleAI/chatterbox-turbo`.
- Local Chatterbox installer and smoke-test commands for operator setup.
- Shortcut commands for WhatsApp bridge control, including `/n`, `/st`, `/ls`, `/p`, `/a`, `/d`, `/q`, `/x`, and `/h`.
- Numbered session switching so recent thread lists can be resumed with `/1`, `/2`, or `/session <number>`.

### Changed

- Bridge status now reports the active outbound voice-reply provider.
- README and skill docs now cover outbound voice replies and Chatterbox Turbo setup.
- WhatsApp bridge help, status, MCP startup output, and docs now advertise the shorter command forms.
- Permission switching now accepts `ro`, `ww`, and `dfa` alongside the full permission names.

## [0.3.0] - 2026-03-28

### Added

- Voice-note control for WhatsApp bridge chats with local Parakeet v3 transcription.
- Local audio download and transcription pipeline using Baileys media download, `ffmpeg`, and `uvx --from parakeet-mlx`.

### Changed

- WhatsApp bridge help and session handling now accept voice notes alongside text prompts.
- Short low-confidence voice-note transcripts now ask for a retry instead of sending a likely-garbled prompt to Codex.
- Spoken `cancelar` now cancels a pending approval from a voice-controlled chat.

### Fixed

- Transcriber timeout cleanup now force-kills the child process only when it is still actually running.

## [0.2.0] - 2026-03-28

### Added

- Per-chat bridge permission levels for `read-only`, `workspace-write`, and `danger-full-access`.
- WhatsApp approval handling for guarded command and file-change actions while running in `workspace-write`.
- WhatsApp session browsing and switching with `/sessions` and `/connect <thread-id-prefix>`.

### Changed

- The controller bridge now defaults to `workspace-write` with explicit approval prompts instead of forcing non-interactive workspace writes.

### Security

- Ignore rotated auth directories under `plugins/whatsapp-relay/data/auth*` so leaked local WhatsApp credentials do not get staged accidentally.

## [0.1.0] - 2026-03-27

### Added

- Initial prerelease of `WhatsApp Relay`.
- Terminal QR authentication flow for linking a local WhatsApp account.
- MCP tools for auth status, listing chats, reading messages, sending messages, and syncing history.
- Bidirectional WhatsApp-to-Codex control bridge for allowed phone numbers.
- Native Codex `app-server` transport for phone-controlled Codex sessions.
