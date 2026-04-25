'use strict';
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');

let _session = null;

async function _connect() {
  const mcpPostgresUrl = (process.env.MCP_POSTGRES_URL || 'http://mcp-postgres:3002').replace(/\/$/, '');
  const client = new Client({ name: 'mcp-answers-client', version: '0.1.0' }, { capabilities: {} });
  const transport = new StreamableHTTPClientTransport(new URL(`${mcpPostgresUrl}/mcp`));
  await client.connect(transport);
  const { tools } = await client.listTools();
  return { client, tools };
}

/**
 * Returns the cached MCP session, creating one if needed.
 * Call invalidateMcpSession() to force reconnect on next use.
 */
async function createMcpSession() {
  if (!_session) {
    _session = await _connect();
  }
  return _session;
}

function invalidateMcpSession() {
  if (_session) {
    try { _session.client.close(); } catch {}
  }
  _session = null;
}

module.exports = { createMcpSession, invalidateMcpSession };
