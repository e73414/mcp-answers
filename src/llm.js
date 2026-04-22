'use strict';
const axios = require('axios');
const { fetchAnalyzeModel, fetchMcpAnswersTemperature, fetchMcpAnswersSystemPrompt, fetchUserPrompt } = require('./appSettings');

const MAX_TOOL_ROUNDS = 8;

/**
 * Parses the text output of list_tables into a map of viewName -> { datasetId, datasetName }.
 * Format: "- view_name: v_ds_xxx  dataset_name: My Dataset  dataset_id: abc-123"
 */
function parseListTablesResult(text) {
  const map = {};
  for (const line of text.split('\n')) {
    const m = line.match(/view_name:\s+(\S+)\s+dataset_name:\s+(.*?)\s+dataset_id:\s+(\S+)/);
    if (m) {
      map[m[1].toLowerCase()] = { datasetName: m[2].trim(), datasetId: m[3].trim() };
    }
  }
  return map;
}

/**
 * Extracts v_ds_* view names referenced in a SQL string.
 */
function extractViewsFromSql(sql) {
  const pattern = /(?:FROM|JOIN)\s+(?:n8n_data\.)?["`]?([^\s,;)("`]+)["`]?/gi;
  const names = new Set();
  let match;
  while ((match = pattern.exec(sql)) !== null) {
    const name = (match[1] || '').toLowerCase().replace(/["`]/g, '');
    if (name.startsWith('v_ds_')) names.add(name);
  }
  return [...names];
}

/**
 * Runs the LLM tool-use loop using the MCP client session.
 * Returns { answer, sql, rows, columns, model, queriedDatasets } where sql/rows/columns may be null.
 */
async function runAnalysis({ question, email, datasetId, conversationHistory, mcpClient, mcpTools, signal }) {
  const [model, temperature, customSystemPrompt, userPrompt] = await Promise.all([
    fetchAnalyzeModel(),
    fetchMcpAnswersTemperature(),
    fetchMcpAnswersSystemPrompt(),
    fetchUserPrompt(email),
  ]);
  const apiUrl = process.env.AI_ANALYZE_API_URL || 'https://api.fuelix.ai/v1';
  const apiKey = process.env.OPENROUTER_API_KEY || '';

  // Build OpenAI-compatible tool definitions from MCP tool list
  const tools = mcpTools.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.inputSchema,
    },
  }));

  const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD

  const defaultSystemPrompt = `You are a data analyst with access to tools to explore and query a PostgreSQL database.
The user you are serving has email: ${email}.
Today's date is ${today}. Use this when the user refers to relative dates such as "current month", "last week", "this year", etc.
${datasetId ? `Focus on the dataset with id: ${datasetId}.` : 'Search across all datasets accessible to this user.'}

## Required process
1. Call list_tables to discover available tables.
2. Call describe_table on any table that might be relevant.
3. Only after understanding the schema, write and execute precise SQL.
4. Base your answer SOLELY on the rows returned by your queries.

## Strict rules — never violate these
- NEVER state a number, name, date, or fact that did not appear in an actual query result. If you did not run a query that directly returns a value, you do not know that value.
- NEVER estimate, extrapolate, or infer beyond what the query results show.
- If a query returns zero rows, say so. Do not interpret empty results as confirmation of anything.
- If no table contains data relevant to the question, respond with: "I was unable to find data in the accessible datasets that answers this question. This information may not be available."
- If the question is ambiguous (time range, metric, grouping, or multiple interpretations), ask ONE specific clarifying question before querying. Do not guess.
- If you found only partially relevant data, clearly state what you could determine from the data and what you could not.
- Do not use phrases like "based on typical patterns" or "generally" — only report what the data shows.
- ALWAYS use the exact column names returned by describe_table. If execute_query returns a "column does not exist" error, you used a wrong column name — this is NOT an access restriction. Call describe_table again to verify the exact names and retry.
- NEVER tell the user there are "access restrictions on columns". Column-level restrictions do not exist in this system. A "column does not exist" error always means a wrong column name in your SQL.

## Confidence check before answering
Before writing your final response, ask yourself: "Did I execute a query whose results directly and completely answer this question?" If yes, answer confidently. If no, either ask a clarifying question or state the limitation.

When you have a final answer or a clarifying question, respond in Markdown without calling any more tools. Use **bold** for key figures, bullet lists or numbered lists for multiple items, and tables for tabular data.`;

  // Use admin-configured system prompt if set, otherwise fall back to built-in default
  const userPromptSection = userPrompt
    ? `\n\n## Personal context from the user\n${userPrompt}`
    : '';

  const systemPrompt = customSystemPrompt
    ? `${customSystemPrompt}\n\nThe user you are serving has email: ${email}.\nToday's date is ${today}. Use this when the user refers to relative dates such as "current month", "last week", "this year", etc.\n${datasetId ? `Focus on the dataset with id: ${datasetId}.` : 'Search across all datasets accessible to this user.'}${userPromptSection}`
    : `${defaultSystemPrompt}${userPromptSection}`;

  const priorMessages = Array.isArray(conversationHistory) ? conversationHistory : [];

  const messages = [
    { role: 'system', content: systemPrompt },
    ...priorMessages,
    { role: 'user', content: question },
  ];

  let lastSql = null;
  let lastRows = null;
  let lastColumns = null;
  let viewToDataset = {}; // populated when list_tables is called

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    if (signal?.aborted) throw new Error('Cancelled');
    const response = await axios.post(
      `${apiUrl}/chat/completions`,
      {
        model,
        messages,
        tools,
        tool_choice: 'auto',
        temperature,
      },
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        timeout: 60000,
        signal,
      }
    );

    const choice = response.data.choices[0];
    const assistantMsg = choice.message;
    messages.push(assistantMsg);

    if (!assistantMsg.tool_calls || assistantMsg.tool_calls.length === 0) {
      // Final answer
      const queriedDatasets = lastSql
        ? extractViewsFromSql(lastSql).map(v => viewToDataset[v]).filter(Boolean)
        : [];
      return {
        answer: assistantMsg.content || '',
        sql: lastSql,
        rows: lastRows,
        columns: lastColumns,
        model,
        queriedDatasets,
      };
    }

    // Process tool calls
    for (const toolCall of assistantMsg.tool_calls) {
      if (signal?.aborted) throw new Error('Cancelled');
      const toolName = toolCall.function.name;
      let toolArgs;
      try {
        toolArgs = JSON.parse(toolCall.function.arguments || '{}');
      } catch {
        toolArgs = {};
      }

      // Inject the requesting user's email into every tool call
      toolArgs.email = email;

      let toolResult;
      try {
        const mcpResult = await mcpClient.callTool({ name: toolName, arguments: toolArgs });
        const content = mcpResult.content?.[0];
        toolResult = content?.text || JSON.stringify(mcpResult);

        // Build view→dataset map from list_tables result (plain text)
        if (toolName === 'list_tables') {
          viewToDataset = parseListTablesResult(toolResult);
        }

        // Capture SQL from call args and parse rows from the plain-text result
        if (toolName === 'execute_query') {
          if (toolArgs.sql) lastSql = toolArgs.sql;
          // Result format: "Query returned N row(s):\n[JSON array]"
          const rowMatch = toolResult.match(/Query returned \d+ row\(s\):\n([\s\S]+)/);
          if (rowMatch) {
            try {
              lastRows = JSON.parse(rowMatch[1]);
              lastColumns = lastRows.length > 0 ? Object.keys(lastRows[0]) : [];
            } catch { /* ignore parse errors */ }
          }
        }
      } catch (err) {
        toolResult = `Error calling ${toolName}: ${err.message}`;
      }

      messages.push({
        role: 'tool',
        tool_call_id: toolCall.id,
        content: toolResult,
      });
    }
  }

  // Exhausted rounds — ask for a final answer without tools
  if (signal?.aborted) throw new Error('Cancelled');
  messages.push({ role: 'user', content: 'Please summarize what you found so far.' });
  const finalResp = await axios.post(
    `${apiUrl}/chat/completions`,
    { model, messages, temperature },
    {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      timeout: 30000,
      signal,
    }
  );
  const queriedDatasets = lastSql
    ? extractViewsFromSql(lastSql).map(v => viewToDataset[v]).filter(Boolean)
    : [];
  return {
    answer: finalResp.data.choices[0].message.content || '',
    sql: lastSql,
    rows: lastRows,
    columns: lastColumns,
    model,
    queriedDatasets,
  };
}

module.exports = { runAnalysis };
