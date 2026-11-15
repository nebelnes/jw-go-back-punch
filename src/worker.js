// JW Atlanta go-back punch + weekly walk — Cloudflare Worker
// Serves public/ and a small JSON API backed by Durable Objects.
//
// Punch list (DO "main"):
//   GET  /api/state?since=<v>        -> {v, rooms:{id: body}}  (304 if unchanged)
//   PUT  /api/room/<id>   (x-pin)    -> {v}
//   DELETE /api/room/<id> (x-pin)    -> {v}
// Weekly walks (DO "walks"):
//   GET  /api/walks                  -> {walks:[summary...]}
//   GET  /api/walk/<id>              -> walk doc
//   PUT  /api/walk/<id>   (x-pin)    -> {ok}
//   DELETE /api/walk/<id> (x-pin)    -> {ok}
// Photos (DO "photos"):
//   POST /api/photo       (x-pin, image/jpeg body) -> {id}
//   GET  /api/photo/<id>             -> image/jpeg
// Reports (public, read-only):
//   GET  /report/<walkId>            -> printable HTML
//   GET  /report/<walkId>.csv        -> CSV

const ID_RE = /^[A-Za-z0-9_.-]{1,64}$/;

export class Punch {
  constructor(state) { this.storage = state.storage; }

  async fetch(req) {
    const url = new URL(req.url);
    const p = url.pathname;

    // ---- punch rooms
    const room = p.match(/^\/api\/room\/([A-Za-z0-9_.-]{1,64})$/);
    if (p === '/api/state' && req.method === 'GET') {
      const v = (await this.storage.get('__v')) || 0;
      const since = Number(url.searchParams.get('since') || -1);
      if (since === v) return new Response(null, { status: 304 });
      const all = await this.storage.list();
      const rooms = {};
      for (const [k, val] of all) if (k !== '__v') rooms[k] = val;
      return json({ v, rooms });
    }
    if (room && req.method === 'PUT') {
      const body = await readJson(req, 64 * 1024);
      if (!body) return json({ error: 'bad body' }, 400);
      const v = ((await this.storage.get('__v')) || 0) + 1;
      await this.storage.put({ [room[1]]: body, __v: v });
      return json({ v });
    }
    if (room && req.method === 'DELETE') {
      const v = ((await this.storage.get('__v')) || 0) + 1;
      await this.storage.delete(room[1]);
      await this.storage.put('__v', v);
      return json({ v });
    }

    // ---- walks
    const walk = p.match(/^\/api\/walk\/([A-Za-z0-9_.-]{1,64})$/);
    if (p === '/api/walks' && req.method === 'GET') {
      const all = await this.storage.list({ prefix: 'walk:' });
      const walks = [];
      for (const [, w] of all) walks.push(summary(w));
      walks.sort((a, b) => (b.date + b.createdAt).localeCompare(a.date + a.createdAt));
      return json({ walks });
    }
    if (p === '/api/walks/open' && req.method === 'GET') {
      // all unfixed defects across every walk (for carry-over)
      const all = await this.storage.list({ prefix: 'walk:' });
      const items = [];
      for (const [, w] of all) for (const d of openDefects(w)) items.push(d);
      items.sort((a, b) => a.at.localeCompare(b.at));
      return json({ items });
    }
    if (walk && req.method === 'GET') {
      const w = await this.storage.get('walk:' + walk[1]);
      if (!w) return json({ error: 'not found' }, 404);
      return json(w);
    }
    if (walk && req.method === 'PUT') {
      const body = await readJson(req, 240 * 1024);
      if (!body) return json({ error: 'bad body' }, 400);
      body.id = walk[1];
      body.updatedAt = new Date().toISOString();
      await this.storage.put('walk:' + walk[1], body);
      return json({ ok: true, updatedAt: body.updatedAt });
    }
    if (walk && req.method === 'DELETE') {
      await this.storage.delete('walk:' + walk[1]);
      return json({ ok: true });
    }

    // ---- photos
    const photo = p.match(/^\/api\/photo\/([A-Za-z0-9_.-]{1,64})$/);
    if (p === '/api/photo' && req.method === 'POST') {
      const buf = await req.arrayBuffer();
      if (buf.byteLength < 100 || buf.byteLength > 1_500_000) return json({ error: 'size' }, 413);
      const id = 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
      await this.storage.put('photo:' + id, buf);
      return json({ id });
    }
    if (photo && req.method === 'GET') {
      const buf = await this.storage.get('photo:' + photo[1]);
      if (!buf) return new Response('not found', { status: 404 });
      return new Response(buf, { headers: { 'content-type': 'image/jpeg', 'cache-control': 'public, max-age=31536000, immutable' } });
    }
    if (photo && req.method === 'DELETE') {
      await this.storage.delete('photo:' + photo[1]);
      return json({ ok: true });
    }

    // ---- report
    const rep = p.match(/^\/report\/([A-Za-z0-9_-]{1,64})(\.csv)?$/);
    if (rep && req.method === 'GET') {
      const w = await this.storage.get('walk:' + rep[1]);
      if (!w) return new Response('Report not found', { status: 404 });
      if (rep[2]) return new Response(csv(w), { headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="walk-${w.date}.csv"` } });
      const all = await this.storage.list({ prefix: 'walk:' });
      const carry = [];
      for (const [, o] of all) if (o.id !== w.id && o.status === 'closed') for (const d of openDefects(o)) carry.push(d);
      carry.sort((a, b) => a.at.localeCompare(b.at));
      return new Response(reportHtml(w, carry), { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
    }

    return json({ error: 'not found' }, 404);
  }
}

async function readJson(req, max) {
  const txt = await req.text();
  if (txt.length > max) return null;
  try { const b = JSON.parse(txt); return b && typeof b === 'object' && !Array.isArray(b) ? b : null; } catch { return null; }
}
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
}
function allDefects(w) {
  const out = [];
  for (const [areaId, a] of Object.entries(w.areas || {})) for (const d of a.defects || []) out.push({ ...d, areaId, areaLabel: areaName(w, areaId), walkId: w.id, walkDate: w.date });
  return out;
}
function openDefects(w) { return allDefects(w).filter((d) => !d.fixed); }
function summary(w) {
  const ds = allDefects(w);
  const walked = Object.values(w.areas || {}).filter((a) => a.ok || (a.defects || []).length).length;
  return { id: w.id, date: w.date, by: w.by, status: w.status, createdAt: w.createdAt, closedAt: w.closedAt || null, updatedAt: w.updatedAt, defects: ds.length, open: ds.filter((d) => !d.fixed).length, walked };
}

// ---- area naming (mirrors the app)
const PUBLIC = {
  lobby: 'Lobby', 'lobby-restrooms': 'Lobby restrooms', reception: 'Reception', ledger: 'Ledger – lobby bar', 'jw-market': 'JW Market / Restaurant',
  fitness: 'Fitness Center', spa: 'Spa', pool: 'Pool Bar / Pool deck', 'exec-lounge': 'Executive Lounge', ballroom: 'Ballroom', prefunction: 'Prefunction A/B',
  studios: 'Studios', boardroom: 'Boardroom', arbor: 'Arbor Room', haven: 'Haven', 'mtg-4th': '4th Floor Meeting', elevators: 'Guest Elevators',
  'fiora': 'Fiora Service bar', exterior: 'Exterior', boh: 'Back of house',
};
function areaName(w, id) {
  if (PUBLIC[id]) return PUBLIC[id];
  const h = id.match(/^hall-(\d+)$/); if (h) return ord(+h[1]) + ' Floor hallway';
  const r = id.match(/^room-(\d+)$/); if (r) return 'Room ' + r[1];
  const x = (w.extraAreas || []).find((e) => e.id === id); if (x) return x.label;
  return id;
}
function ord(n) { return n + (n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] || 'th'); }
function areaOrder(w, id) {
  const keys = Object.keys(PUBLIC);
  if (keys.includes(id)) return keys.indexOf(id);
  if (id.startsWith('hall-')) return 100 + (16 - +id.slice(5));
  if (id.startsWith('room-')) return 200 + +id.slice(5) / 10000;
  return 150;
}

// ---- CSV
function csv(w) {
  const esc = (s) => '"' + String(s ?? '').replace(/"/g, '""') + '"';
  const rows = [['Walk date', 'Walked by', 'Area', 'Defect', 'Location', 'Category', 'Severity', 'Department', 'Status', 'Fixed by', 'Fixed at', 'Logged at', 'Photos']];
  const ds = allDefects(w).sort((a, b) => areaOrder(w, a.areaId) - areaOrder(w, b.areaId));
  for (const d of ds) rows.push([w.date, w.by, d.areaLabel, d.t, d.loc || '', d.cat || '', d.sev || '', d.dept || '', d.fixed ? 'Fixed' : 'Open', d.fixed?.by || '', d.fixed?.at || '', d.at, (d.photos || []).length]);
  return rows.map((r) => r.map(esc).join(',')).join('\r\n');
}

// ---- Report HTML
function reportHtml(w, carry) {
  const h = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const fmtD = (iso) => { const d = new Date(iso + (iso.length === 10 ? 'T12:00:00' : '')); return d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }); };
  const fmtT = (iso) => new Date(iso).toLocaleString('en-US', { month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' });
  const age = (iso) => { const d = Math.floor((Date.now() - new Date(iso)) / 864e5); return d < 1 ? 'today' : d === 1 ? '1 day' : d < 14 ? d + ' days' : Math.floor(d / 7) + ' wks'; };
  const ds = allDefects(w);
  const areas = Object.entries(w.areas || {}).filter(([, a]) => a.ok || (a.defects || []).length).sort((a, b) => areaOrder(w, a[0]) - areaOrder(w, b[0]));
  const count = (arr, k) => arr.reduce((m, d) => (m[d[k] || '—'] = (m[d[k] || '—'] || 0) + 1, m), {});
  const bySev = count(ds, 'sev'), byDept = count(ds, 'dept'), byCat = count(ds, 'cat');
  const pills = (m, cls) => Object.entries(m).sort((a, b) => b[1] - a[1]).map(([k, v]) => `<span class="pill ${cls ? cls(k) : ''}">${h(k)} <b>${v}</b></span>`).join(' ');
  const sevCls = (s) => ({ High: 'hi', Medium: 'md', Low: 'lo' }[s] || '');
  const defectRow = (d, showWalk) => `
    <div class="d ${d.fixed ? 'fixed' : ''}">
      <div class="dh"><span class="sev ${sevCls(d.sev)}">${h(d.sev || '')}</span><span class="dt">${h(d.t)}</span>${d.fixed ? '<span class="fx">✓ Fixed ' + h(d.fixed.by) + ' · ' + fmtT(d.fixed.at) + '</span>' : ''}</div>
      <div class="dm">${[d.loc && 'at ' + h(d.loc), d.cat && h(d.cat), d.dept && '→ ' + h(d.dept), showWalk ? 'from walk ' + h(d.walkDate) + ' · open ' + age(d.at) : 'logged ' + fmtT(d.at) + (d.by ? ' by ' + h(d.by) : '')].filter(Boolean).join(' · ')}</div>
      ${(d.photos || []).length ? '<div class="ph">' + d.photos.map((p) => `<a href="/api/photo/${h(p)}" target="_blank"><img src="/api/photo/${h(p)}" loading="lazy" alt=""></a>`).join('') + '</div>' : ''}
    </div>`;
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light only">
<title>Weekly Walk ${h(w.date)} – JW Marriott Atlanta</title>
<style>
body{margin:0;font:15px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;color:#1c1b18;background:#fff}
.wrap{max-width:860px;margin:0 auto;padding:22px 18px 60px}
h1{font-size:22px;margin:0 0 2px}.sub{color:#6b6861;margin-bottom:14px}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px;margin:14px 0}
.k{border:1px solid #e2dfd8;border-radius:10px;padding:10px 12px}.k b{display:block;font-size:24px}.k span{font-size:12px;color:#6b6861;text-transform:uppercase;letter-spacing:.5px}
.pills{margin:6px 0 2px}.pill{display:inline-block;border:1px solid #e2dfd8;border-radius:999px;padding:2px 10px;font-size:12.5px;margin:2px 2px 2px 0}.pill b{margin-left:3px}
.pill.hi{background:#fde8e6;border-color:#f3b4ae}.pill.md{background:#fff1d6;border-color:#f3d28f}.pill.lo{background:#eef4ea;border-color:#c9dcc0}
h2{font-size:16px;margin:26px 0 8px;padding-bottom:4px;border-bottom:2px solid #1c1b18}
h3{font-size:15px;margin:16px 0 6px;display:flex;align-items:center;gap:8px}
.ok{color:#2e7d44;font-size:12.5px;font-weight:600;border:1px solid #b8dfc3;background:#e6f4ea;border-radius:999px;padding:1px 9px}
.d{border:1px solid #e2dfd8;border-radius:10px;padding:10px 12px;margin:6px 0;break-inside:avoid}
.d.fixed{opacity:.65}.dh{display:flex;gap:8px;align-items:baseline;flex-wrap:wrap}.dt{font-weight:600}
.sev{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;padding:1px 7px;border-radius:5px;background:#eee}.sev.hi{background:#c0392b;color:#fff}.sev.md{background:#f6c453}.sev.lo{background:#dfe6ee}
.fx{font-size:12px;color:#2e7d44;font-weight:600;margin-left:auto}.dm{font-size:12.5px;color:#6b6861;margin-top:2px}
.ph{display:flex;gap:6px;flex-wrap:wrap;margin-top:8px}.ph img{width:110px;height:110px;object-fit:cover;border-radius:8px;border:1px solid #e2dfd8}
.foot{margin-top:30px;font-size:12px;color:#6b6861}
.okgrid{display:flex;flex-wrap:wrap;gap:6px;margin:6px 0 2px}
@media print{.wrap{padding:0}.ph img{width:80px;height:80px}a{text-decoration:none;color:inherit}}
</style></head><body><div class="wrap">
<h1>Weekly Property Walk — JW Marriott Atlanta</h1>
<div class="sub">${fmtD(w.date)} · walked by ${h(w.by)} · ${w.status === 'closed' ? 'completed ' + fmtT(w.closedAt || w.updatedAt) : '<b>walk still in progress</b>'}</div>
<div class="kpis">
 <div class="k"><b>${areas.length}</b><span>areas checked</span></div>
 <div class="k"><b>${ds.length}</b><span>defects found</span></div>
 <div class="k"><b>${ds.filter((d) => !d.fixed).length}</b><span>still open</span></div>
 <div class="k"><b>${carry.length}</b><span>carried over from prior walks</span></div>
</div>
<div class="pills"><b>Severity:</b> ${pills(bySev, sevCls) || '—'}</div>
<div class="pills"><b>Department:</b> ${pills(byDept) || '—'}</div>
<div class="pills"><b>Category:</b> ${pills(byCat) || '—'}</div>

<h2>Findings by area</h2>
${areas.filter(([, a]) => (a.defects || []).length).map(([id, a]) => `<h3>${h(areaName(w, id))} <span style="color:#6b6861;font-weight:400;font-size:13px">${a.defects.length} defect${a.defects.length === 1 ? '' : 's'}</span></h3>${a.defects.map((d) => defectRow(d)).join('')}`).join('') || '<p>No defects logged.</p>'}

${areas.filter(([, a]) => a.ok && !(a.defects || []).length).length ? `<h2>Checked — no issues</h2><div class="okgrid">${areas.filter(([, a]) => a.ok && !(a.defects || []).length).map(([id]) => `<span class="ok">✓ ${h(areaName(w, id))}</span>`).join('')}</div>` : ''}

${carry.length ? `<h2>Still open from previous walks</h2>${carry.map((d) => `<div style="font-size:13px;color:#6b6861;margin-top:10px"><b style="color:#1c1b18">${h(d.areaLabel)}</b></div>` + defectRow(d, true)).join('')}` : ''}

<div class="foot">Generated ${fmtT(new Date().toISOString())} · <a href="/report/${h(w.id)}.csv">Download CSV</a></div>
</div></body></html>`;
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const p = url.pathname;
    if (p.startsWith('/api/') || p.startsWith('/report/')) {
      if (req.method !== 'GET') {
        const pin = req.headers.get('x-pin') || '';
        if (!env.PIN || pin !== String(env.PIN)) return json({ error: 'pin' }, 401);
      }
      const which = p.startsWith('/api/photo') ? 'photos' : (p.startsWith('/api/walk') || p.startsWith('/report/')) ? 'walks' : 'main';
      return env.PUNCH.get(env.PUNCH.idFromName(which)).fetch(req);
    }
    return env.ASSETS.fetch(req);
  },
};
