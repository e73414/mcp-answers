'use strict';
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');

async function createMcpSession() {
  const mcpPostgresUrl = (process.env.MCP_POSTGRES_URL || 'http://mcp-postgres:3002').replace(/\/$/, '');
  const client = new Client({ name: 'mcp-answers-client', version: '0.1.0' }, { capabilities: {} });
  const transport = new StreamableHTTPClientTransport(new URL(`${mcpPostgresUrl}/mcp`));
  await client.connect(transport);
  const { tools } = await client.listTools();
  return { client, tools };
}

module.exports = { createMcpSession };
