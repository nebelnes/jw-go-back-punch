# JW Atlanta – Owner Go-Back Punch

Phone-first punch-list app for engineering go-backs at JW Marriott Atlanta: a 237-room matrix, one checklist per room (global checks + that room's own items from the Halsey owner back-punch schedule), per-room sign-off with initials.

- `index.html` – the whole app (self-contained, no build step)
- `data.json` – the parsed room list and punch items (also embedded in `index.html`)

Live: https://nebelnes.github.io/jw-go-back-punch/

Note: on GitHub Pages the app saves sign-offs in each phone's own browser storage (local mode). Live sync between phones is available in the claude.ai artifact version, or by wiring a backend.
