'use strict';
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { createMcpSession } = require('./src/mcpClient');
const { runAnalysis } = require('./src/llm');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3003;
const MCP_N8N_URL = (process.env.MCP_N8N_URL || 'http://mcp-n8n:3000').replace(/\/$/, '');
const API_SECRET = process.env.API_SECRET || '';

app.get('/healthz', (_req, res) => res.json({ ok: true, service: 'mcp-answers' }));

/**
 * POST /query
 * Body: { question, email, datasetId? }
 * Returns: { answer, sql, rows, columns, conversationId }
 */
app.post('/query', async (req, res) => {
  const { question, email, datasetId, datasetName, conversationHistory } = req.body || {};

  if (!question || typeof question !== 'string' || !question.trim()) {
    return res.status(400).json({ error: 'question is required' });
  }
  if (!email || typeof email !== 'string') {
    return res.status(400).json({ error: 'email is required' });
  }

  let mcpClient, mcpTools;
  try {
    const session = await createMcpSession();
    mcpClient = session.client;
    mcpTools = session.tools;
  } catch (err) {
    console.error('Failed to connect to mcp-postgres:', err.message);
    return res.status(503).json({ error: 'MCP Postgres service unavailable' });
  }

  const startTime = Date.now();
  let result;
  try {
    result = await runAnalysis({ question, email, datasetId: datasetId || null, conversationHistory: conversationHistory || [], mcpClient, mcpTools });
  } catch (err) {
    console.error('LLM analysis error:', err.message);
    return res.status(500).json({ error: 'Analysis failed: ' + err.message });
  } finally {
    try { await mcpClient.close(); } catch {}
  }
  const durationSeconds = Math.round((Date.now() - startTime) / 1000);

  // Determine dataset info — prefer explicit selection, fall back to what the LLM actually queried
  const queried = result.queriedDatasets || [];
  const historyDatasetId   = datasetId   || queried[0]?.datasetId   || null;
  const historyDatasetName = datasetName || (queried.length > 0
    ? queried.map(d => d.datasetName).join(', ')
    : null);

  // Save to conversation history via mcp-n8n
  let conversationId = null;
  try {
    const saveRes = await axios.post(
      `${MCP_N8N_URL}/conversations`,
      {
        user_email: email,
        prompt: question.trim(),
        response: result.answer,
        ai_model: result.model || 'unknown',
        dataset_id: historyDatasetId,
        dataset_name: historyDatasetName,
        duration_seconds: durationSeconds,
        source: 'mcp_answers',
      },
      { headers: { 'x-api-secret': API_SECRET }, timeout: 5000 }
    );
    conversationId = saveRes.data?.id || null;
  } catch (err) {
    // Non-fatal — history save failure should not break the response
    console.warn('Could not save conversation history:', err.message);
  }

  return res.json({
    answer: result.answer,
    sql: result.sql,
    rows: result.rows,
    columns: result.columns,
    conversationId,
    model: result.model || null,
    queriedDatasets: result.queriedDatasets || [],
  });
});

app.listen(PORT, () => {
  console.log(`mcp-answers listening on port ${PORT}`);
});
