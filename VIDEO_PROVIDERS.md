VIDEO PROVIDER PROXY (templates)

This directory contains a single serverless proxy function (api/video-proxy.js) that
is a template for forwarding client requests to video model providers. The client
(app) posts JSON { provider, payload } to /api/video-proxy and the proxy forwards
or normalizes requests/responses for the chosen provider.

How it works
- The client stores a "provider key" which may be either:
  - a server endpoint (recommended): the proxy will call that endpoint, or
  - (less recommended) an API key (not forwarded by default here) — prefer server-side.
- The proxy reads environment variables like RUNWAY_ENDPOINT, RUNWAY_KEY, PIKA_ENDPOINT, etc.
- If an endpoint is configured, the proxy forwards the payload to that endpoint, adding
  an Authorization header using the corresponding KEY env var if present.

Environment variables (set these in Vercel or your hosting provider)
- RUNWAY_ENDPOINT (optional)
- RUNWAY_KEY (optional)
- PIKA_ENDPOINT
- PIKA_KEY
- SYNTHESIA_ENDPOINT
- SYNTHESIA_KEY
- OPENAI_VIDEO_ENDPOINT
- OPENAI_VIDEO_KEY
- GEMINI_ENDPOINT
- GEMINI_KEY

Example usage (client -> proxy)
POST /api/video-proxy
{
  "provider": "runway",
  "payload": { "topic": "Create a 60s news-style video about AI", "format": "16:9" }
}

What you should implement on the provider side
- Configure a server-side function or endpoint that calls the provider's API using your
  provider API key (stored in environment variables). The provider endpoint should return
  a simple JSON object the client can consume, ideally { status: 'done', url: 'https://...' }
  or { status: 'queued', id: 'job-id' }.

Notes & security
- Do NOT store provider API keys in the browser for production. Use serverless functions
  / backend endpoints to keep secrets safe.
- The templates are intentionally generic: provider APIs differ. Adapt the proxy to the
  exact provider API shape and response format.

Quick Vercel deploy steps
1. Add these environment variables in your Vercel project settings.
2. Deploy the repo. The endpoint will be available at https://<your-site>/api/video-proxy
3. In the client (API modal), set the provider's key field to the server endpoint (e.g.
   https://<your-site>/api/video-proxy) so the client forwards requests through your proxy.
