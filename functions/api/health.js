export function onRequestGet(context) {
  return Response.json({ ok: true, aiConfigured: Boolean(context.env.OPENAI_API_KEY), version: '0.5.0-cloudflare' }, {
    headers: { 'Cache-Control': 'no-store' }
  });
}
