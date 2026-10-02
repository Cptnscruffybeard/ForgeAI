# ForgeAI — Cloudflare Pages deployment build

This package is prepared for Cloudflare Pages with Pages Functions.

## One-time setup

1. Create a new GitHub repository.
2. Upload the contents of this folder to the repository root.
3. In Cloudflare: **Workers & Pages → Create application → Pages → Import an existing Git repository**.
4. Select the repository.
5. Use:
   - Production branch: `main`
   - Build command: `npm run build`
   - Build output directory: `dist`
6. Deploy.

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

## Important

The catalog is still a demo catalog. Replace it with properly sourced, verified records before public launch.

Feedback persistence is intentionally disabled in this static Cloudflare build. Add D1 before storing user feedback/accounts.
