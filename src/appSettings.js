'use strict';
const axios = require('axios');

let _cachedSettings = null;
let _cacheTime = 0;
const CACHE_TTL_MS = 60_000; // re-fetch at most once per minute

async function fetchAppSettings() {
  const now = Date.now();
  if (_cachedSettings && now - _cacheTime < CACHE_TTL_MS) return _cachedSettings;

  const url = (process.env.MCP_N8N_URL || 'http://mcp-n8n:3000').replace(/\/$/, '');
  const secret = process.env.API_SECRET || '';
  try {
    const res = await axios.get(`${url}/app-settings`, {
      headers: { 'x-api-secret': secret },
      timeout: 5000,
    });
    _cachedSettings = res.data || {};
    _cacheTime = now;
    return _cachedSettings;
  } catch (err) {
    console.warn('Could not fetch app-settings, using defaults:', err.message);
    return {};
  }
}

async function fetchAnalyzeModel() {
  const settings = await fetchAppSettings();
  return settings.analyze_model || 'gpt-5-mini';
}

async function fetchMcpAnswersTemperature() {
  const settings = await fetchAppSettings();
  const raw = settings.mcp_answers_temperature;
  const parsed = parseFloat(raw);
  return !isNaN(parsed) && parsed >= 0 && parsed <= 2 ? parsed : 0.3;
}

async function fetchMcpAnswersSystemPrompt() {
  const settings = await fetchAppSettings();
  const prompt = (settings.mcp_answers_system_prompt || '').trim();
  return prompt || null;
}

async function fetchUserPrompt(email) {
  const url = (process.env.MCP_N8N_URL || 'http://mcp-n8n:3000').replace(/\/$/, '');
  const secret = process.env.API_SECRET || '';
  try {
    const res = await axios.get(`${url}/user-prompt`, {
      params: { email },
      headers: { 'x-api-secret': secret },
      timeout: 5000,
    });
    const prompt = (res.data?.user_prompt || '').trim();
    return prompt || null;
  } catch (err) {
    console.warn('Could not fetch user prompt:', err.message);
    return null;
  }
}

module.exports = { fetchAnalyzeModel, fetchMcpAnswersTemperature, fetchMcpAnswersSystemPrompt, fetchUserPrompt };
