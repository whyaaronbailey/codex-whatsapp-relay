# Attribution and third-party licenses

## Relay source

This project is a fork of [abuiles/codex-whatsapp-relay](https://github.com/abuiles/codex-whatsapp-relay), originally authored by Adolfo Builes. The fork started from commit `e46f5dc00cf72b9b06afa57820d79d1148dbc368` after upstream v0.4.3. Its [plugin manifest at that revision](https://github.com/abuiles/codex-whatsapp-relay/blob/e46f5dc00cf72b9b06afa57820d79d1148dbc368/plugins/whatsapp-relay/.codex-plugin/plugin.json) explicitly declares MIT and credits Adolfo Builes.

That upstream tree did not contain a root LICENSE file. This fork supplies the standard MIT text corresponding to that declaration, with attribution to the original author and fork maintainer. The copyright lines were added by this fork; they are not copied from a nonexistent upstream license file. Git history preserves original authorship. Fork changes include PC/VM routing, attachment storage and delivery, Windows fixes, concurrency protections, tests, documentation, and distinct terminal/relay icons.

## Dependencies

The root [LICENSE](LICENSE) covers relay source; it does not relicense dependencies. `package-lock.json` records resolved packages. Installations fetch those packages separately with their own license files and notices. The GitHub source release does not bundle `node_modules`, native libraries, model weights, WhatsApp credentials, or user data.

Material examples in the current lockfile include:

| Component | License / notice |
| --- | --- |
| [Baileys](https://github.com/WhiskeySockets/Baileys) | MIT; unofficial WhatsApp client. |
| [libsignal 6.0.0](https://github.com/WhiskeySockets/libsignal-node/blob/master/LICENSE) | GPL-3.0; required transitively by Baileys. |
| [Sharp](https://github.com/lovell/sharp/blob/main/LICENSE) | Apache-2.0 for Sharp source; platform packages can also contain libvips under LGPL-3.0-or-later. |
| [qrcode-terminal](https://github.com/gtanner/qrcode-terminal/blob/master/LICENSE) | Apache-2.0, with the bundled QRCode implementation's MIT attribution to Kazuhiko Arase. |
| [Model Context Protocol SDK](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/LICENSE) | MIT. |

This is not an exhaustive dependency license inventory. In particular, the installed dependency graph is not MIT-only. Preserve each component's notices and review its terms before distributing a combined executable, installer, container, or dependency bundle; a source-only GitHub release does not settle those other distribution cases.

Optional voice engines and model weights are acquired separately and retain their own terms. No voice models are included in this release.

## Names and affiliation

WhatsApp and associated marks belong to their owners. OpenAI, ChatGPT, and Codex names identify the products this community project integrates with. This project is not affiliated with or endorsed by OpenAI or WhatsApp/Meta. The fork uses its own terminal/relay artwork.
