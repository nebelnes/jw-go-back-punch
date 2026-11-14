# JW Atlanta – Owner Go-Back Punch

Phone-first punch-list app for engineering go-backs at JW Marriott Atlanta: a 237-room matrix, one checklist per room (global checks + that room's own items from the Halsey owner back-punch schedule), per-room sign-off with initials. Several phones share one live board.

## Layout
- `public/index.html` – the whole app (self-contained, no build step)
- `src/worker.js` – Cloudflare Worker: serves `public/` and a small JSON API
- `wrangler.toml` – Worker config; shared state lives in a Durable Object (free plan)
- `data.json` – the parsed room list and punch items (also embedded in the app)

## Deploy to Cloudflare
Either connect this repo in the Cloudflare dashboard (**Workers & Pages → Create → Import a repository**) and deploy with the defaults, or locally:

```
npx wrangler login
npx wrangler deploy
```

Then open `https://jw-go-back-punch.<your-subdomain>.workers.dev` on each phone and "Add to Home Screen".

**Change the team PIN** in `wrangler.toml` (`PIN = "2026"`) before deploying, or set a secret named `PIN` in the Worker's settings (overrides the file). The app asks for the PIN once per phone before it will save.

## How storage is chosen
The app picks the first that works: the Worker API (shared, live) → claude.ai artifact storage (shared, when opened as a Claude artifact) → this phone only (local mode, shown as a banner).
