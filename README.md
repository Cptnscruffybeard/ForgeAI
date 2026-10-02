# ForgeAI — Cloudflare Pages deployment build

This package is prepared for Cloudflare Pages with Pages Functions.

## One-time setup

1. Push this repository to GitHub (the project files must live at the repository root, not inside a zip).
2. In Cloudflare: **Workers & Pages → Create application → Pages → Import an existing Git repository**.
3. Select the repository.
4. Use:
   - Production branch: `main`
   - Build command: `npm run build`
   - Build output directory: `dist`
5. Deploy.

Cloudflare will provide a `*.pages.dev` URL.

## Optional AI diagnosis

In Cloudflare Pages project settings, add the secret:

- `OPENAI_API_KEY` — your server-side OpenAI API key
- `OPENAI_MODEL` — optional; defaults to `gpt-5.6-luna`

The key is only read by the Pages Function and is never placed in browser JavaScript.

If `OPENAI_API_KEY` is absent or the provider fails, ForgeAI uses the deterministic verified-catalog matcher automatically.

## Local Cloudflare preview

```bash
npm install
npm run build
npx wrangler pages dev dist
```

Security headers live in `public/_headers` so the build copies them into `dist/`, where Cloudflare Pages reads them.

## Tests

```bash
npm test
```

## Legacy Node server

`server.js` is the earlier standalone Node build (admin discovery endpoint, JSON-file storage). It is not used by the Cloudflare deployment; `.env.example` documents its variables.

## Important

The catalog is still a demo catalog. Replace it with properly sourced, verified records before public launch.

Feedback persistence is intentionally disabled in this static Cloudflare build. Add D1 before storing user feedback/accounts.
