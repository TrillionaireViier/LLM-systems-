// api/video-proxy.js
// Vercel serverless function: generic proxy to multiple video model providers.
// Template handlers are intentionally minimal. Configure PROVIDER_KEY and/or
// PROVIDER_ENDPOINT environment variables on Vercel for each provider you use.

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
    // Heuristic mapping: if provider returns a direct URL or job id, normalize it.
    // We expect the endpoint to return { status: 'done'|'queued', url?: '...' }
    return res.status(fetchRes.status).json(json);
  } catch (err) {
    console.error('forwardToEndpoint error', err);
    return res.status(502).json({ error: 'Failed to reach configured endpoint', detail: err.message });
  }
}

// --- Provider handlers (templates) ---
async function handleRunway(payload, res) {
  // If you set RUNWAY_ENDPOINT / RUNWAY_KEY in env, we forward to it.
  // Example: RUNWAY_ENDPOINT = 'https://api.runwayml.com/v1/video' (example only)
  return forwardToEndpoint('runway', { payload }, res);
}

async function handlePika(payload, res) {
  // Pika typically requires server-side calls. Configure PIKA_ENDPOINT and PIKA_KEY.
  return forwardToEndpoint('pika', { payload }, res);
}

async function handleSynthesia(payload, res) {
  // Synthesia example: configure SYNTHESIA_ENDPOINT and SYNTHESIA_KEY.
  return forwardToEndpoint('synthesia', { payload }, res);
}

async function handleOpenAIVideo(payload, res) {
  // OpenAI Video is a placeholder here. Configure OPENAI_VIDEO_ENDPOINT / OPENAI_VIDEO_KEY
  // If you want to call OpenAI's APIs directly, implement the specific request shape below
  // and read the key from process.env.OPENAI_VIDEO_KEY.
  return forwardToEndpoint('openai_video', { payload }, res);
}
