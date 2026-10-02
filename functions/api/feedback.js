export async function onRequestPost() {
  return Response.json({ ok: true, stored: false, note: 'Feedback storage is disabled in the static Cloudflare build until D1 is configured.' }, {
    status: 201,
    headers: { 'Cache-Control': 'no-store' }
  });
}
