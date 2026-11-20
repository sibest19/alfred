import { createInboxTools, loadInboxConfig } from './inbox.js';
import { createTransport } from './server.js';

try {
  const config = loadInboxConfig();
  const server = createTransport(config, createInboxTools(config), 192 * 1024);
  server.listen(config.port, '0.0.0.0', () => console.info('Alfred inbox MCP listening on port ' + config.port));
  process.on('SIGTERM', () => server.close());
  process.on('SIGINT', () => server.close());
} catch {
  console.error('Invalid inbox configuration; check Hermes URL/key, MCP token/hosts, Telegram token/chat and limits');
  process.exit(1);
}
