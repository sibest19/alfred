export type Config = ReturnType<typeof loadConfig>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const apiUrl = new URL(env.ALFRED_API_URL || 'http://alfred-api:8080');
  if (!['http:', 'https:'].includes(apiUrl.protocol) || apiUrl.username || apiUrl.password ||
      apiUrl.pathname !== '/' || apiUrl.search || apiUrl.hash) {
    throw new Error('ALFRED_API_URL must be an HTTP(S) origin without credentials, path, query or fragment');
  }
  const apiToken = env.ALFRED_API_TOKEN ?? '';
  const mcpToken = env.MCP_TOKEN ?? '';
  for (const token of [apiToken, mcpToken]) {
    if (Buffer.byteLength(token) < 16 || /\s/.test(token)) {
      throw new Error('ALFRED_API_TOKEN and MCP_TOKEN must have at least 16 bytes and no whitespace');
    }
  }
  if (apiToken === mcpToken) throw new Error('Use distinct MCP and Alfred API credentials');
  const port = Number(env.HTTP_PORT || '8080');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('HTTP_PORT must be an integer from 1 to 65535');
  const rateLimit = Number(env.MCP_RATE_LIMIT || '60');
  const maxConcurrent = Number(env.MCP_MAX_CONCURRENT || '4');
  if ([rateLimit, maxConcurrent].some((n) => !Number.isInteger(n) || n < 1 || n > 1000)) {
    throw new Error('MCP_RATE_LIMIT and MCP_MAX_CONCURRENT must be integers from 1 to 1000');
  }
  const allowedHosts = (env.MCP_ALLOWED_HOSTS || 'alfred-mcp,localhost,127.0.0.1,[::1]').split(',').map((s) => s.trim());
  if (allowedHosts.some((s) => !s || /[\s/*?#@]/.test(s))) throw new Error('MCP_ALLOWED_HOSTS must contain explicit hostnames');
  return { apiUrl: apiUrl.origin, apiToken, mcpToken, port, allowedHosts, rateLimit, maxConcurrent };
}
