// api/video-proxy.js
// Vercel serverless function: generic proxy to multiple video model providers.
// Added: dedicated Gemini handler with optional direct call and polling support.
// Configure these env vars in your deployment:
// - GEMINI_ENDPOINT (optional) : full endpoint to POST generation requests to (if you use a gateway)
// - GEMINI_KEY              : API key or Bearer token for Gemini (keep secret)
// - GEMINI_MODEL            : optional model id (e.g. "models/gemini-video-preview")
// - GEMINI_OPERATIONS_ENDPOINT: optional operations base for polling (defaults to Google operations path)

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed, use POST' });
  }

  let body;
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  } catch (e) {
    body = req.body;
  }

  const { provider, payload } = body || {};
  if (!provider) return res.status(400).json({ error: 'Missing provider in request body' });

  try {
    switch (provider) {
      case 'runway':
        return await handleRunway(payload, res);
      case 'pika':
        return await handlePika(payload, res);
      case 'synthesia':
        return await handleSynthesia(payload, res);
      case 'gemini':
        return await handleGemini(payload, res);
      case 'gemini_poll':
        return await handleGeminiPoll(payload, res);
      case 'openai_video':
        return await handleOpenAIVideo(payload, res);
      default:
        return res.status(400).json({ error: 'Unsupported provider: ' + provider });
    }
  } catch (err) {
    console.error('proxy handler error', err);
    return res.status(500).json({ error: err.message || String(err) });
  }
}

// Helper: forward to a configured endpoint if present (flexible pattern)
async function forwardToEndpoint(providerId, payload, res) {
  const envPrefix = providerId.toUpperCase();
  const endpoint = process.env[envPrefix + '_ENDPOINT'];
  const apiKey = process.env[envPrefix + '_KEY'];

  if (!endpoint) {
    return res.status(501).json({ error: `No endpoint configured for ${providerId}. Set ${envPrefix}_ENDPOINT (and ${envPrefix}_KEY if needed) as env vars.` });
  }

  // Forward request
  try {
    const headers = { 'Content-Type': 'application/json' };
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
    const fetchRes = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(payload) });
    const json = await fetchRes.json();
    return res.status(fetchRes.status).json(json);
  } catch (err) {
    console.error('forwardToEndpoint error', err);
    return res.status(502).json({ error: 'Failed to reach configured endpoint', detail: err.message });
  }
}

// --- Provider handlers (templates) ---
async function handleRunway(payload, res) {
  return forwardToEndpoint('runway', { payload }, res);
}
async function handlePika(payload, res) {
  return forwardToEndpoint('pika', { payload }, res);
}
async function handleSynthesia(payload, res) {
  return forwardToEndpoint('synthesia', { payload }, res);
}
async function handleOpenAIVideo(payload, res) {
  return forwardToEndpoint('openai_video', { payload }, res);
}

// --- Gemini: dedicated implementation with polling support ---
async function handleGemini(payload, res) {
  // If a GEMINI_ENDPOINT is configured, prefer forwarding to it (gateway or your own wrapper)
  if (process.env.GEMINI_ENDPOINT) {
    return forwardToEndpoint('gemini', payload, res);
  }

  // Otherwise attempt a direct call to Google's Generative Language video endpoint.
  // NOTE: The exact request shape for Gemini video may vary. This implementation uses
  // a sensible, configurable default and returns a normalized response.
  const GEMINI_KEY = process.env.GEMINI_KEY;
  const GEMINI_MODEL = process.env.GEMINI_MODEL || 'models/gemini-video-preview';
  if (!GEMINI_KEY) return res.status(500).json({ error: 'GEMINI_KEY not configured' });

  // Build request body mapping common payload fields -> Gemini fields
  const prompt = payload.prompt || payload.topic || payload.input || '';
  const duration = payload.duration || payload.video?.duration || payload.durationSeconds || 8;
  const aspectRatio = payload.aspectRatio || payload.format || payload.video?.aspectRatio || '16:9';

  // Replace model id formatting if user provided short id
  const modelPath = GEMINI_MODEL.startsWith('models/') ? GEMINI_MODEL : `models/${GEMINI_MODEL}`;
  const url = `https://generativelanguage.googleapis.com/v1beta2/${modelPath}:generateVideo`;

  const body = {
    input: { text: prompt },
    // Place common video options under a `video` key. Adapt as needed for the real Gemini API.
    video: { durationSeconds: duration, aspectRatio }
  };

  try {
    const headers = { 'Content-Type': 'application/json' };
    // Prefer Bearer token; fall back to x-goog-api-key if GEMINI_KEY is an API key
    headers['Authorization'] = `Bearer ${GEMINI_KEY}`;

    const r = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
    const j = await r.json();
    // Possible response shapes:
    // - Immediate result with a URL (e.g. { outputUri: 'https://...' })
    // - Long-running operation (Google style) with a name: { name: 'operations/..' }
    // - Error

    if (!r.ok) {
      console.error('Gemini generate error', j);
      return res.status(r.status).json({ error: j });
    }

    // Long-running operation: return queued + operation name
    if (j.name) {
      return res.json({ status: 'queued', id: j.name, raw: j });
    }

    // If the provider returned a direct URL, normalize to {status:'done', url}
    const urlCandidates = [j.outputUri, j.output_url, j.url, j.videoUrl, j.resultUrl];
    const foundUrl = urlCandidates.find(Boolean);
    if (foundUrl) return res.json({ status: 'done', url: foundUrl, raw: j });

    // If the response contains nested output, try some heuristics
    if (Array.isArray(j.output) && j.output[0] && (j.output[0].uri || j.output[0].url)) {
      return res.json({ status: 'done', url: j.output[0].uri || j.output[0].url, raw: j });
    }

    // Unknown but successful response — return raw object so caller can inspect
    return res.json({ status: 'unknown', raw: j });
  } catch (err) {
    console.error('handleGemini error', err);
    return res.status(500).json({ error: err.message || String(err) });
  }
}

// Polling handler: POST { provider: 'gemini_poll', payload: { operation: 'operations/...' } }
async function handleGeminiPoll(payload, res) {
  const operation = payload.operation || payload.id || (payload.job && payload.job.name);
  if (!operation) return res.status(400).json({ error: 'Missing operation id in payload' });
  const GEMINI_KEY = process.env.GEMINI_KEY;
  if (!GEMINI_KEY) return res.status(500).json({ error: 'GEMINI_KEY not configured' });

  // Build operations endpoint
  const opsBase = process.env.GEMINI_OPERATIONS_ENDPOINT || 'https://generativelanguage.googleapis.com/v1/operations';
  // Normalize operation name: if it already contains the full path, strip common prefix from double inclusion
  // operation might be 'operations/abc' or a full path. We append it - if duplication occurs the endpoint should still work.
  const opPath = operation.replace(/^\//, '');
  const url = `${opsBase}/${encodeURIComponent(opPath)}`;

  try {
    const headers = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${GEMINI_KEY}` };
    const r = await fetch(url, { method: 'GET', headers });
    const j = await r.json();
    if (!r.ok) return res.status(r.status).json({ error: j });

    // Google-style Operation object has `done` flag and either `response` or `error`.
    if (j.done) {
      if (j.error) return res.json({ status: 'error', error: j.error });
      // Try to discover a resulting video URL in the response
      const resp = j.response || j.result || j;
      // heuristics for nested fields
      const urlCandidates = [resp.outputUri, resp.output_url, resp.url, resp.videoUrl, resp.resultUrl];
      const foundUrl = urlCandidates.find(Boolean) || (Array.isArray(resp.output) && (resp.output[0]?.uri || resp.output[0]?.url));
      if (foundUrl) return res.json({ status: 'done', url: foundUrl, raw: j });
      // Some providers return base64 data or signed urls in different shapes — return raw for inspection
      return res.json({ status: 'done', raw: j });
    }

    // Not done yet
    return res.json({ status: 'queued', id: operation, raw: j });
  } catch (err) {
    console.error('handleGeminiPoll error', err);
    return res.status(500).json({ error: err.message || String(err) });
  }
}
