# Contributing

This fork builds on [Adolfo Builes' Codex WhatsApp Relay](https://github.com/abuiles/codex-whatsapp-relay). The current phase focuses on one WhatsApp gateway, native Codex sessions on a PC and VM, and files stored on the selected machine. See the [setup guide](docs/host-vm.md) for the architecture and limitations.

Preserve native Codex configuration, session storage, and existing Hindsight connections and transcript collectors. Portable Windows voice support is deferred. Live WhatsApp pairing and SSH acceptance on users' machines still need validation; do not describe mocked tests as proof of deployment.

## Development

Use Node.js 20 or newer. From a checkout of the revision described in the README:

```sh
npm ci
npm run check
npm test
```

The automated suite uses temporary files and mocked model/network interactions. It does not require a WhatsApp account, model API credentials, or a live VM. Run relevant tests while editing, then the full checks above before submitting a pull request. Add regressions for routing, permissions, file boundaries, or concurrency changes; describe any manual testing separately.

Keep changes focused and explain the concrete problem and resulting behavior. Include the affected PC/VM platforms when relevant. Follow `AGENTS.md` for release preparation; ordinary fixes do not need a version bump or tag. Preserve upstream attribution and existing license notices, and identify the source of any external code you introduce.

## Reports and pull requests

For a reproducible bug, include the revision, Node/Codex versions, operating systems, minimal steps, and expected versus actual behavior. Use synthetic files and placeholder host/project names. Share only the smallest sanitized diagnostic excerpt needed to reproduce the issue.

Never attach authentication folders, QR codes, tokens, private keys, phone numbers, full controller configuration, conversation transcripts, or Hindsight archives. Review screenshots and logs before posting. Report suspected vulnerabilities according to [SECURITY.md](SECURITY.md), not through a public bug report.
