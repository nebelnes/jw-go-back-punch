# JW Atlanta – Owner Go-Back Punch

Phone-first app for JW Marriott Atlanta with two tabs sharing one live board across phones:

- **Go-Back Punch** – 237-room matrix, one checklist per room (global checks + that room's own items from the Halsey owner back-punch schedule), per-room sign-off with initials.
- **Weekly Walk** – start a walk, mark public areas / hallways / spot-checked rooms as checked or log defects (category, severity, department, photos). Unfixed defects carry over into the next walk. Finishing a walk produces a shareable report at `/report/<walkId>` (and `/report/<walkId>.csv`).

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

**Change the team PIN** in `wrangler.toml` (`PIN = "2026"`) and the **reset code** (`RESET_CODE = "2026"`, needed to reset or delete a whole walk) before deploying, or set a secret named `PIN` in the Worker's settings (overrides the file). The app asks for the PIN once per phone before it will save.

## How storage is chosen
The app picks the first that works: the Worker API (shared, live) → claude.ai artifact storage (shared, when opened as a Claude artifact) → this phone only (local mode, shown as a banner).

## Live report + department updates

`/report/<walkId>` refreshes itself every few seconds. Tap **Update status**, enter the department code
(`DEPT_CODE`, currently `ATLJD`, not case-sensitive) and every defect gets a **Mark complete** button
(name + optional comment). Completed defects stay on the report, shown green. **Reopen** undoes it.
Departments can filter the report by tapping their name.
