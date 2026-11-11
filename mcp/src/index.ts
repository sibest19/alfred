import { loadConfig } from './config.js';
import { createService } from './server.js';

try {
  const config = loadConfig();
  const server = createService(config);
  server.listen(config.port, '0.0.0.0', () => console.info('Alfred WhatsApp MCP listening on port ' + config.port));
  const shutdown = () => server.close();
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
} catch {
  console.error('Invalid MCP configuration; check API URL, distinct credentials, port and allowed hosts');
  process.exit(1);
}
