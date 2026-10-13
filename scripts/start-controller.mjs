import { existsSync } from 'node:fs';
import { ControllerConfigStore } from '../plugins/whatsapp-relay/scripts/controller-config.mjs';
import { startControllerDaemon } from '../plugins/whatsapp-relay/scripts/controller-process.mjs';
import { credsFile } from '../plugins/whatsapp-relay/scripts/paths.mjs';

// Safe at login before first pairing, and idempotent when the gateway is already
// running. Explicitly stopping the bridge sets enabled=false and stays stopped.
const config = await new ControllerConfigStore().load();
if (!config.enabled || !config.allowedControllers.length || !existsSync(credsFile)) {
  process.stdout.write('WhatsApp Relay is installed; pairing and enablement are still required.\n');
} else {
  try {
    const status = await startControllerDaemon();
    process.stdout.write(`WhatsApp Relay is running (pid ${status.pid}).\n`);
  } catch (error) {
    process.stderr.write(`WhatsApp Relay startup failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}
