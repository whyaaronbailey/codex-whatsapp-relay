# Security

This is an independent relay using the unofficial Baileys WhatsApp linked-device client. It is not an official WhatsApp Business API integration. It connects an account with access to WhatsApp messages to native Codex processes that can act with the selected account's permissions.

## Reporting a vulnerability

Use [GitHub's private vulnerability reporting](https://github.com/whyaaronbailey/codex-whatsapp-relay/security/advisories/new), which is enabled for this repository. Include the affected revision, a minimal reproduction using synthetic data, the trust boundary crossed, and the potential impact.

If private reporting is unavailable, open an issue asking the maintainer to enable a private reporting channel, without disclosing the vulnerability, exploit steps, or sensitive data. Do not include credentials or private messages in either a public report or a reproduction. This project does not promise a response time or a supported-release service level.

## Trust boundaries

- **WhatsApp control:** the controller accepts configured direct-chat identities before downloading attachments or dispatching work. Protect the controlling WhatsApp account and linked-device credentials. The command allowlist is not an isolation boundary for all messages accessible to the linked account or other MCP messaging tools.
- **PC and VM:** SSH authenticates the remote operating-system account. The worker runs on demand under that account and uses its existing Codex configuration. It is not a separate privilege sandbox. Native Codex permissions and operating-system permissions still matter.
- **Files:** transfers are limited to 25 MiB and restricted to the selected workspace. The relay rejects traversal, links/junctions, and common credential/configuration paths. These checks do not recognize every sensitive file or make untrusted content safe. Incoming and outgoing snapshots persist under `.whatsapp-relay`; there is no automatic expiration or additional encryption at rest implemented by the relay.
- **Configuration and memory:** local relay configuration, SSH configuration, Codex configuration, and their owners are trusted. Hindsight remains an existing external service; the relay adds no archive, collector, or memory security layer. A VM's loopback address is distinct from its host's, and existing memory access routes must be preserved.
- **Sessions:** the relay isolates configured projects and guards its own concurrent updates. It does not guarantee exclusive thread ownership against another Codex client writing to the same session.

Keep authentication material and private runtime data outside commits and issue attachments. Tests cover the implemented boundaries with mocked network/model behavior; live WhatsApp and VM deployment acceptance remains unverified. Portable Windows voice support is deferred.
