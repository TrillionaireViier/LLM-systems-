// api/video-proxy.js
// Vercel serverless function: generic proxy to multiple video model providers.
// Added: GET health endpoint, enhanced logging, and Gemini provider handler.

export default async function handler(req, res) {
  // Simple health/debug endpoint on GET (safe: does not leak API keys)
  if (req.method === 'GET') {
    const providers = ['runway','pika','synthesia','openai_video','gemini','google'];
    const env = {};
    providers.forEach(p => {
      const prefix = p.toUpperCase();
      env[p] = {
        endpointConfigured: !!process.env[`${prefix}_ENDPOINT`],
        keyConfigured: !!process.env[`${prefix}_KEY`],
        modelConfigured: !!process.env[`${prefix}_MODEL`]
      };
    });
    return res.status(200).json({ status: 'ok', env });
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST, GET');
    return res.status(405).json({ error: 'Method not allowed, use POST or GET' });
  }

  let body;
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  } catch (e) {
    body = req.body;
  }

  const { provider, payload } = body || {};
  if (!provider) return res.status(400).json({ error: 'Missing provider in request body' });

  console.info('[video-proxy] incoming', { provider, payloadSummary: summarize(payload) });

  try {
    switch (provider) {
      case 'runway':
        return await handleRunway(payload, res);
      case 'pika':
        return await handlePika(payload, res);
      case 'synthesia':
        return await handleSynthesia(payload, res);
      case 'openai_video':
        return await handleOpenAIVideo(payload, res);
      case 'gemini':
      case 'google':
        return await handleGemini(payload, res);
      default:
        return res.status(400).json({ error: 'Unsupported provider: ' + provider });
    }
  } catch (err) {
    console.error('[video-proxy] handler error', err && err.stack ? err.stack : err);
    return res.status(500).json({ error: err.message || String(err) });
  }
}

// Helper: forward to a configured endpoint if present (flexible pattern)
async function forwardToEndpoint(providerId, payload, res) {
  const envPrefix = providerId.toUpperCase();
  const endpoint = process.env[envPrefix + '_ENDPOINT'];
  const apiKey = process.env[envPrefix + '_KEY'];

  if (!endpoint) {
    console.warn(`[video-proxy] no endpoint configured for ${providerId}`);
    return res.status(501).json({ error: `No endpoint configured for ${providerId}. Set ${envPrefix}_ENDPOINT (and ${envPrefix}_KEY if needed) as env vars.` });
  }

  try {
    const headers = { 'Content-Type': 'application/json' };
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

    console.info('[video-proxy] forwarding', { providerId, endpoint, payloadSummary: summarize(payload) });

    const fetchRes = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(payload) });
    const text = await fetchRes.text();
    let json;
    try { json = JSON.parse(text); } catch (e) { json = null; }

    console.info('[video-proxy] provider response', { providerId, status: fetchRes.status, bodySummary: summarize(json ?? text) });

    const normalized = normalizeProviderResponse(json ?? text, fetchRes.status);
    return res.status(fetchRes.status).json(normalized);
  } catch (err) {
    console.error('[video-proxy] forwardToEndpoint error', err && err.stack ? err.stack : err);
    return res.status(502).json({ error: 'Failed to reach configured endpoint', detail: err.message || String(err) });
  }
}

// --- Provider handlers (templates) ---
async function handleRunway(payload, res) {
  return forwardToEndpoint('runway', payload, res);
}

async function handlePika(payload, res) {
  return forwardToEndpoint('pika', payload, res);
}

async function handleSynthesia(payload, res) {
  return forwardToEndpoint('synthesia', payload, res);
}

async function handleOpenAIVideo(payload, res) {
  return forwardToEndpoint('openai_video', payload, res);
}

async function handleGemini(payload, res) {
  // Gemini direct API flow:
  // If GEMINI_ENDPOINT is configured, we forward there. Otherwise use the public Google Generative API.
  // This supports a prompt-based flow and normalizes the response into a predictable shape.
  const apiKey = process.env.GEMINI_KEY || '';
  const model = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
  const explicitEndpoint = process.env.GEMINI_ENDPOINT;

  if (!apiKey && !explicitEndpoint) {
    return res.status(501).json({
      error: 'No Gemini config found. Set GEMINI_KEY and optionally GEMINI_MODEL in Vercel, or set GEMINI_ENDPOINT to a custom server endpoint.'
    });
  }

  // Build request payload for Google Gemini generateContent API.
  const promptText = extractPromptText(payload);
  const generationConfig = buildGeminiConfig(payload);
  const requestBody = {
    contents: [{ role: 'user', parts: [{ text: promptText }] }],
    generationConfig
  };

  const url = explicitEndpoint
    ? (apiKey && !explicitEndpoint.includes('key=') ? appendQueryParam(explicitEndpoint, 'key', apiKey) : explicitEndpoint)
    : `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;

  try {
    console.info('[video-proxy] forwarding Gemini request', { url, payloadSummary: summarize(requestBody) });

    const headers = { 'Content-Type': 'application/json' };
    if (apiKey && !explicitEndpoint) {
      // Google API key is already in querystring, so no Authorization header is required.
      // Keep it explicit, though some Gemini setups may accept x-goog-api-key as well.
      headers['x-goog-api-key'] = apiKey;
    }

    const fetchRes = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(requestBody)
    });

    const text = await fetchRes.text();
    let json;
    try { json = JSON.parse(text); } catch (e) { json = null; }

    console.info('[video-proxy] Gemini response', { status: fetchRes.status, bodySummary: summarize(json ?? text) });

    if (!fetchRes.ok) {
      return res.status(fetchRes.status).json({
        status: 'error',
        error: json || { message: text },
        provider: 'gemini'
      });
    }

    const normalized = normalizeGeminiResponse(json);
    return res.status(fetchRes.status).json(normalized);
  } catch (err) {
    console.error('[video-proxy] Gemini handler error', err && err.stack ? err.stack : err);
    return res.status(502).json({
      error: 'Failed to reach Gemini API',
      detail: err.message || String(err),
      provider: 'gemini'
    });
  }
}

function extractPromptText(payload) {
  if (!payload || typeof payload !== 'object') return 'Create a short AI video concept.';
  if (payload.prompt) return String(payload.prompt);
  if (payload.topic) return String(payload.topic);
  if (payload.text) return String(payload.text);
  if (payload.message) return String(payload.message);
  return JSON.stringify(payload, null, 2);
}

function buildGeminiConfig(payload) {
  const source = payload && typeof payload === 'object' ? payload : {};
  const config = {};

  if (source.temperature !== undefined) config.temperature = Number(source.temperature);
  if (source.maxOutputTokens !== undefined) config.maxOutputTokens = Number(source.maxOutputTokens);
  if (source.topP !== undefined) config.topP = Number(source.topP);
  if (source.topK !== undefined) config.topK = Number(source.topK);
  if (source.stopSequences) config.stopSequences = Array.isArray(source.stopSequences) ? source.stopSequences : [String(source.stopSequences)];
  if (source.responseMimeType) config.responseMimeType = source.responseMimeType;

  return Object.keys(config).length ? config : { temperature: 0.7 };
}

function normalizeGeminiResponse(json) {
  if (!json || typeof json !== 'object') {
    return { status: 'done', raw: json || null, provider: 'gemini' };
  }

  // Google Gemini response shape:
  // { candidates: [{ content: { parts: [{ text: '...' }] } }] }
  const candidate = Array.isArray(json.candidates) && json.candidates[0] ? json.candidates[0] : null;
  const text = candidate && candidate.content && Array.isArray(candidate.content.parts)
    ? candidate.content.parts.map(p => p.text || '').join('\n').trim()
    : '';

  const summary = text || (json.text ? String(json.text) : '');

  return {
    status: 'done',
    provider: 'gemini',
    text: summary,
    raw: json,
    url: null,
    id: json.name || null
  };
}

function appendQueryParam(url, key, value) {
  try {
    const u = new URL(url);
    if (!u.searchParams.has(key)) u.searchParams.set(key, value);
    return u.toString();
  } catch (e) {
    return url.includes('?') ? `${url}&${key}=${encodeURIComponent(value)}` : `${url}?${key}=${encodeURIComponent(value)}`;
  }
}

// Small helpers
function summarize(obj) {
  try {
    if (obj === undefined) return 'undefined';
    if (obj === null) return 'null';
    if (typeof obj === 'string') return obj.length > 200 ? obj.slice(0,200) + '...('+obj.length+' chars)' : obj;
    const s = JSON.stringify(obj);
    return s.length > 200 ? s.slice(0,200) + '...('+s.length+' chars)' : s;
  } catch (e) { return '<<unserializable>>'; }
}

function normalizeProviderResponse(body, status) {
  if (!body) return { status: status >= 200 && status < 300 ? 'ok' : 'error', raw: null };
  if (typeof body === 'object') {
    const { status: s, url, id, job_id, jobId } = body;
    return { status: s || (status >= 200 && status < 300 ? 'done' : 'error'), url, id: id || job_id || jobId, raw: body };
  }
  return { status: status >= 200 && status < 300 ? 'done' : 'error', raw: String(body) };
}
