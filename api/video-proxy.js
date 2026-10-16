// api/video-proxy.js
// Vercel serverless function: generic proxy to multiple video model providers.
// Added: GET health endpoint, enhanced logging, and Gemini provider handler.

export default async function handler(req, res) {
  // Simple health/debug endpoint on GET (safe: does not leak API keys)
  if (req.method === 'GET') {
    const providers = ['runway','pika','synthesia','openai_video','gemini'];
    const env = {};
    providers.forEach(p => {
      const prefix = p.toUpperCase();
      env[p] = {
        endpointConfigured: !!process.env[`${prefix}_ENDPOINT`],
        keyConfigured: !!process.env[`${prefix}_KEY`]
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

  // Log incoming request (payload may be large) - keep logs lightweight
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
async function forwardToEndpoint(providerId, payload, res, opts = {}) {
  const envPrefix = providerId.toUpperCase();
  const endpoint = process.env[envPrefix + '_ENDPOINT'];
  const apiKey = process.env[envPrefix + '_KEY'];

  if (!endpoint) {
    console.warn(`[video-proxy] no endpoint configured for ${providerId}`);
    return res.status(501).json({ error: `No endpoint configured for ${providerId}. Set ${envPrefix}_ENDPOINT (and ${envPrefix}_KEY if needed) as env vars.` });
  }

  // Forward request
  try {
    const headers = { 'Content-Type': 'application/json' };
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

    console.info('[video-proxy] forwarding', { providerId, endpoint, payloadSummary: summarize(payload) });

    const fetchRes = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(payload) });

    // Read response text for richer debugging, then try JSON parse
    const text = await fetchRes.text();
    let json;
    try { json = JSON.parse(text); } catch (e) { json = null; }

    console.info('[video-proxy] provider response', { providerId, status: fetchRes.status, bodySummary: summarize(json ?? text) });

    // Normalize common shapes: return status, url or id when present
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
  // Gemini may expect a different shape depending on your Gemini endpoint implementation.
  // Default behavior: forward payload to GEMINI_ENDPOINT with GEMINI_KEY if provided.
  // If you're using Google Cloud functions or a custom proxy for Gemini, configure GEMINI_ENDPOINT accordingly.
  return forwardToEndpoint('gemini', payload, res);
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
  // If provider already returned status/url/id, pass through but keep small shape
  if (!body) return { status: status >= 200 && status < 300 ? 'ok' : 'error', raw: null };
  if (typeof body === 'object') {
    const { status: s, url, id, job_id, jobId } = body;
    return { status: s || (status >= 200 && status < 300 ? 'done' : 'error'), url, id: id || job_id || jobId, raw: body };
  }
  // otherwise return text
  return { status: status >= 200 && status < 300 ? 'done' : 'error', raw: String(body) };
}
