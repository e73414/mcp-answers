'use strict';
const axios = require('axios');

let _cachedSettings = null;
let _cacheTime = 0;
const CACHE_TTL_MS = 60_000; // re-fetch at most once per minute

let _orgGlossaryCache = null;
let _orgGlossaryCacheTime = 0;
const ORG_CACHE_TTL_MS = 5 * 60_000; // 5 minutes

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

/**
 * Fetches all companies and their business units from mcp-n8n.
 * Returns { companies: [{code, name, bus: [{code, name}]}], text: string|null }.
 * Cached for 5 minutes.
 */
async function fetchOrgGlossary() {
  const now = Date.now();
  if (_orgGlossaryCache && now - _orgGlossaryCacheTime < ORG_CACHE_TTL_MS) return _orgGlossaryCache;

  const url = (process.env.MCP_N8N_URL || 'http://mcp-n8n:3000').replace(/\/$/, '');
  const headers = { 'x-api-secret': process.env.API_SECRET || '' };
  try {
    const companiesRes = await axios.get(`${url}/admin/companies`, { headers, timeout: 5000 });
    const companies = companiesRes.data || [];

    const withBus = await Promise.all(
      companies.map(c =>
        axios.get(`${url}/admin/business-units`, { params: { company_code: c.code }, headers, timeout: 5000 })
          .then(r => ({ code: c.code, name: c.name, bus: r.data || [] }))
          .catch(() => ({ code: c.code, name: c.name, bus: [] }))
      )
    );

    const lines = withBus.map(c => {
      const buList = c.bus.length > 0
        ? c.bus.map(b => `${b.name} (${b.code})`).join(', ')
        : 'no business units defined';
      return `- ${c.name} (${c.code}): ${buList}`;
    });

    const text = lines.length > 0
      ? `## Organisation structure\nThe following companies and business units exist in this system. Use this to resolve business terms in questions to the correct company/dataset.\n${lines.join('\n')}`
      : null;

    _orgGlossaryCache = { companies: withBus, text };
    _orgGlossaryCacheTime = now;
    return _orgGlossaryCache;
  } catch (err) {
    console.warn('Could not fetch org glossary:', err.message);
    return { companies: [], text: null };
  }
}

/**
 * Fetches the user's decoded organisational context (company + BU names for each profile).
 * Returns a string to inject into the system prompt, or null if unavailable.
 */
async function fetchUserOrgContext(email) {
  const url = (process.env.MCP_N8N_URL || 'http://mcp-n8n:3000').replace(/\/$/, '');
  const headers = { 'x-api-secret': process.env.API_SECRET || '' };
  try {
    const [userRes, { companies }] = await Promise.all([
      axios.get(`${url}/users`, { params: { email }, headers, timeout: 5000 }),
      fetchOrgGlossary(),
    ]);

    const user = userRes.data;
    if (!user) return null;

    // Build lookup: companyCode -> { name, bus: { buCode -> buName } }
    const orgMap = {};
    for (const c of companies) {
      orgMap[c.code] = { name: c.name, bus: {} };
      for (const b of c.bus) orgMap[c.code].bus[b.code] = b.name;
    }

    const allProfiles = [
      user.profile,
      ...(Array.isArray(user.profiles) ? user.profiles : []),
    ].filter(p => p && p.trim().length === 9 && p.trim() !== 'admadmadm');

    if (allProfiles.length === 0) return null;

    const decoded = allProfiles.map(p => {
      const compCode = p.slice(0, 3).trim();
      const buCode = p.slice(3, 6).trim();
      const compName = orgMap[compCode]?.name || compCode;
      const buName = buCode === '000' ? 'All Business Units' : (orgMap[compCode]?.bus[buCode] || buCode);
      return `- ${compName} (${compCode}) > ${buName} (${buCode})`;
    });

    return `## User's organisational context\nThis user belongs to:\n${decoded.join('\n')}\n\nWhen the user uses a term that matches a company or business unit name above, prioritise datasets from that organisation. Do not search other companies' datasets for that term unless explicitly asked.`;
  } catch (err) {
    console.warn('Could not fetch user org context:', err.message);
    return null;
  }
}

module.exports = { fetchAnalyzeModel, fetchMcpAnswersTemperature, fetchMcpAnswersSystemPrompt, fetchUserPrompt, fetchOrgGlossary, fetchUserOrgContext };
