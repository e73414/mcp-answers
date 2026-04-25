'use strict';
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { createMcpSession, invalidateMcpSession } = require('./src/mcpClient');
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
    invalidateMcpSession();
    console.error('Failed to connect to mcp-postgres:', err.message);
    return res.status(503).json({ error: 'MCP Postgres service unavailable' });
  }

  const abortController = new AbortController();
  req.on('close', () => abortController.abort());

  const startTime = Date.now();
  console.log(`[timing] request start — datasetId=${datasetId || 'none'}`);
  let result;
  try {
    result = await runAnalysis({ question, email, datasetId: datasetId || null, conversationHistory: conversationHistory || [], mcpClient, mcpTools, signal: abortController.signal });
  } catch (err) {
    if (abortController.signal.aborted || err.message === 'Cancelled' || err.code === 'ERR_CANCELED') {
      return res.status(499).json({ error: 'Request cancelled' });
    }
    // Invalidate session on connection errors so next request reconnects
    if (err.code === 'ECONNREFUSED' || err.code === 'ECONNRESET' || err.code === 'ENOTFOUND') {
      invalidateMcpSession();
    }
    console.error('LLM analysis error:', err.message);
    return res.status(500).json({ error: 'Analysis failed: ' + err.message });
  }
  const durationSeconds = Math.round((Date.now() - startTime) / 1000);
  console.log(`[timing] total analysis: ${Date.now() - startTime}ms`);

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

/**
 * POST /query/stream
 * Same as /query but streams the final answer via SSE.
 * Events: { type: 'token', content: '...' } | { type: 'done', ...result } | { type: 'error', message: '...' }
 */
app.post('/query/stream', async (req, res) => {
  const { question, email, datasetId, datasetName, conversationHistory } = req.body || {};

  if (!question || typeof question !== 'string' || !question.trim()) {
    return res.status(400).json({ error: 'question is required' });
  }
  if (!email || typeof email !== 'string') {
    return res.status(400).json({ error: 'email is required' });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

  let mcpClient, mcpTools;
  try {
    const session = await createMcpSession();
    mcpClient = session.client;
    mcpTools = session.tools;
  } catch (err) {
    invalidateMcpSession();
    send({ type: 'error', message: 'MCP Postgres service unavailable' });
    return res.end();
  }

  const abortController = new AbortController();
  req.on('close', () => abortController.abort());

  const startTime = Date.now();
  console.log(`[timing] request start (stream) — datasetId=${datasetId || 'none'}`);
  let result;
  try {
    result = await runAnalysis({
      question,
      email,
      datasetId: datasetId || null,
      conversationHistory: conversationHistory || [],
      mcpClient,
      mcpTools,
      signal: abortController.signal,
      onToken: (token) => send({ type: 'token', content: token }),
    });
  } catch (err) {
    if (abortController.signal.aborted || err.message === 'Cancelled' || err.code === 'ERR_CANCELED') {
      send({ type: 'error', message: 'Request cancelled' });
      return res.end();
    }
    if (err.code === 'ECONNREFUSED' || err.code === 'ECONNRESET' || err.code === 'ENOTFOUND') {
      invalidateMcpSession();
    }
    console.error('LLM stream error:', err.message);
    send({ type: 'error', message: 'Analysis failed: ' + err.message });
    return res.end();
  }
  const durationSeconds = Math.round((Date.now() - startTime) / 1000);
  console.log(`[timing] total analysis (stream): ${Date.now() - startTime}ms`);

  const queried = result.queriedDatasets || [];
  const historyDatasetId   = datasetId   || queried[0]?.datasetId   || null;
  const historyDatasetName = datasetName || (queried.length > 0 ? queried.map(d => d.datasetName).join(', ') : null);

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
    console.warn('Could not save conversation history:', err.message);
  }

  send({
    type: 'done',
    answer: result.answer,
    sql: result.sql,
    rows: result.rows,
    columns: result.columns,
    model: result.model || null,
    queriedDatasets: result.queriedDatasets || [],
    conversationId,
  });
  res.end();
});

app.listen(PORT, () => {
  console.log(`mcp-answers listening on port ${PORT}`);
});
