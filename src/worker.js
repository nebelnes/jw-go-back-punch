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
//   DELETE /api/walk/<id> (x-pin, x-reset) -> {ok}
//   POST /api/walk/<id>/reset (x-pin, x-reset) -> clears the walk
// Photos (DO "photos"):
//   POST /api/photo       (x-pin, image/jpeg body) -> {id}
//   GET  /api/photo/<id>             -> image/jpeg
// Reports (public, read-only):
//   GET  /report/<walkId>            -> printable HTML
//   GET  /report/<walkId>.csv        -> CSV
//   POST /report/<walkId>/auth                (x-code)            -> {ok}
//   POST /report/<walkId>/defect/<defectId>   (x-code) {action:'complete'|'reopen', by, note} -> {ok}

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
      keepReportFixes(await this.storage.get('walk:' + walk[1]), body);
      body.updatedAt = new Date().toISOString();
      await this.storage.put('walk:' + walk[1], body);
      return json({ ok: true, updatedAt: body.updatedAt });
    }
    if (walk && req.method === 'DELETE') {
      await this.storage.delete('walk:' + walk[1]);
      return json({ ok: true });
    }
    const reset = p.match(/^\/api\/walk\/([A-Za-z0-9_.-]{1,64})\/reset$/);
    if (reset && req.method === 'POST') {
      const w = await this.storage.get('walk:' + reset[1]);
      if (!w) return json({ error: 'not found' }, 404);
      w.areas = {}; w.rooms = []; w.extraAreas = []; w.status = 'open'; delete w.closedAt; w.updatedAt = new Date().toISOString();
      await this.storage.put('walk:' + reset[1], w);
      return json({ ok: true, updatedAt: w.updatedAt });
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

    // ---- report: department status updates
    const act = p.match(/^\/report\/([A-Za-z0-9_-]{1,64})\/defect\/([A-Za-z0-9_.-]{1,64})$/);
    if (act && req.method === 'POST') {
      const w = await this.storage.get('walk:' + act[1]);
      if (!w) return json({ error: 'not found' }, 404);
      const b = (await readJson(req, 4000)) || {};
      let def = null;
      for (const a of Object.values(w.areas || {})) for (const d of a.defects || []) if (d.id === act[2]) def = d;
      if (!def) return json({ error: 'defect not found' }, 404);
      if (b.action === 'complete') {
        const by = String(b.by || '').trim().slice(0, 30);
        if (!by) return json({ error: 'name' }, 400);
        def.fixed = { by, at: new Date().toISOString(), note: String(b.note || '').trim().slice(0, 300), via: 'report' };
      } else if (b.action === 'reopen') def.fixed = null;
      else return json({ error: 'action' }, 400);
      w.updatedAt = new Date().toISOString();
      await this.storage.put('walk:' + act[1], w);
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
      // other walks' open defects, plus ones completed since this walk began (so they turn green instead of vanishing)
      for (const [, o] of all) if (o.id !== w.id && o.status === 'closed') for (const d of allDefects(o)) if (!d.fixed || (d.fixed.at || '') >= (w.createdAt || '')) carry.push(d);
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
// A walker's phone may save a stale copy of the walk; don't let it wipe completions made on the live report meanwhile.
function keepReportFixes(old, body) {
  if (!old || !body.updatedAt || !(old.updatedAt > body.updatedAt)) return;
  const keep = {};
  for (const a of Object.values(old.areas || {})) for (const d of a.defects || []) if (d.fixed && d.fixed.via === 'report') keep[d.id] = d.fixed;
  for (const a of Object.values(body.areas || {})) for (const d of a.defects || []) if (!d.fixed && keep[d.id]) d.fixed = keep[d.id];
}
function openDefects(w) { return allDefects(w).filter((d) => !d.fixed); }
function summary(w) {
  const ds = allDefects(w);
  const walked = Object.values(w.areas || {}).filter((a) => a.ok || (a.defects || []).length).length;
  return { id: w.id, date: w.date, by: w.by, status: w.status, createdAt: w.createdAt, closedAt: w.closedAt || null, updatedAt: w.updatedAt, defects: ds.length, open: ds.filter((d) => !d.fixed).length, walked };
}

// ---- area naming (mirrors the app)
const PUBLIC = {
  'front-drive': 'Front drive',
  'hotel-lobby': 'Hotel Lobby',
  'ledger': 'Ledger',
  'lobby-men-restrooms': 'Lobby Men Restrooms',
  'lobby-women-restrooms': 'Lobby Women Restrooms',
  'fiora': 'Fiora',
  'fiora-bar': 'Fiora Bar',
  'jw-market': 'JW Market',
  'hotel-elevators': 'Hotel Elevators',
  'parking-elevators': 'Parking Elevators',
  'executive-lounge': 'Executive Lounge',
  'perch': 'Perch',
  'pool-deck': 'Pool deck',
  'spa': 'SPA',
  'fitness-center': 'Fitness Center',
  '16th-floor-hallway': '16th floor hallway',
  'arbor-1': 'Arbor 1',
  'arbor-2': 'Arbor 2',
  'haven': 'Haven',
  'canopy-1': 'Canopy 1',
  'canopy-2': 'Canopy 2',
  'canopy-prefunction': 'Canopy prefunction',
  'conservatory': 'Conservatory',
  'cyprus-1': 'Cyprus 1',
  'cyprus-2': 'Cyprus 2',
  'juniper': 'Juniper',
  '4th-floor-women-restrooms': '4th Floor Women Restrooms',
  '4th-floor-men-restrooms': '4th Floor Men Restrooms',
  '4th-floor-hallway': '4th floor hallway',
  'banquet-boh': 'Banquet BOH',
  'banquet-kitchen': 'Banquet Kitchen',
  'lobby-level-hallway': 'Lobby level hallway',
  'main-kitchen': 'Main Kitchen',
  'service-elevators': 'Service elevators',
  'employee-dining-room': 'Employee dining room',
  'men-locker': 'Men Locker',
  'women-locker': 'Women Locker',
  'loading-dock': 'Loading Dock',
  'p1-hallway': 'P1 hallway',
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
  const rows = [['Walk date', 'Walked by', 'Area', 'Defect', 'Location', 'Category', 'Priority', 'Department', 'Status', 'Completed by', 'Completed at', 'Comment', 'Logged at', 'Photos']];
  const ds = allDefects(w).sort((a, b) => areaOrder(w, a.areaId) - areaOrder(w, b.areaId));
  for (const d of ds) rows.push([w.date, w.by, d.areaLabel, d.t, d.loc || '', d.cat || '', d.sev || '', d.dept || '', d.fixed ? 'Complete' : 'Open', d.fixed?.by || '', d.fixed?.at || '', d.fixed?.note || '', d.at, (d.photos || []).length]);
  return rows.map((r) => r.map(esc).join(',')).join('\r\n');
}

// ---- Report HTML
function reportHtml(w, carry) {
  const h = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const fmtD = (iso) => { const d = new Date(iso + (iso.length === 10 ? 'T12:00:00' : '')); return d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }); };
  const fmtT = (iso) => new Date(iso).toLocaleString('en-US', { month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' });
  const age = (iso) => { const d = Math.floor((Date.now() - new Date(iso)) / 864e5); return d < 1 ? 'today' : d === 1 ? '1 day' : d < 14 ? d + ' days' : Math.floor(d / 7) + ' wks'; };
  const ds = allDefects(w);
  const carryOpen = carry.filter((d) => !d.fixed);
  const areas = Object.entries(w.areas || {}).filter(([, a]) => a.ok || (a.defects || []).length).sort((a, b) => areaOrder(w, a[0]) - areaOrder(w, b[0]));
  const bySev = ds.filter((d) => d.sev).reduce((m, d) => (m[d.sev] = (m[d.sev] || 0) + 1, m), {});
  const sevCls = (s) => ({ High: 'hi', Medium: 'md', Low: 'lo' }[s] || '');
  const sevPills = Object.entries(bySev).sort((a, b) => b[1] - a[1]).map(([k, v]) => `<span class="pill ${sevCls(k)}">${h(k)} <b>${v}</b></span>`).join(' ');
  // department scoreboard: open items (this walk + carried over) per department
  const everything = ds.concat(carry);
  const depts = {};
  for (const d of everything) { const k = d.dept || '—'; depts[k] = depts[k] || { open: 0, total: 0 }; depts[k].total++; if (!d.fixed) depts[k].open++; }
  const deptPills = Object.entries(depts).sort((a, b) => b[1].open - a[1].open || a[0].localeCompare(b[0])).map(([k, v]) => `<button class="pill dp ${v.open ? '' : 'alldone'}" data-dept="${h(k)}">${h(k)} <b>${v.open ? v.open + ' open' : '✓ complete'}</b></button>`).join(' ');
  const defectRow = (d, showWalk) => `
    <div class="d ${d.fixed ? 'fixed' : ''}" data-walk="${h(d.walkId)}" data-id="${h(d.id)}" data-dept="${h(d.dept || '—')}" data-done="${d.fixed ? 1 : 0}">
      <div class="pic">${(d.photos || []).length ? `<a href="/api/photo/${h(d.photos[0])}" target="_blank"><img src="/api/photo/${h(d.photos[0])}" loading="lazy" alt=""></a>${d.photos.length > 1 ? `<span class="more">+${d.photos.length - 1}</span>` : ''}` : '<span class="nopic">No photo</span>'}</div>
      <div class="dc">
        <div class="dh"><span class="area">${h(d.areaLabel)}${d.loc ? ' · ' + h(d.loc) : ''}</span>${d.sev ? `<span class="sev ${sevCls(d.sev)}">${h(d.sev)}</span>` : ''}<b class="dept">${h(d.dept || '')}</b></div>
        <div class="dt">${h(d.t)}</div>
        ${(d.photos || []).length > 1 ? '<div class="ph">' + d.photos.slice(1).map((p) => `<a href="/api/photo/${h(p)}" target="_blank"><img src="/api/photo/${h(p)}" loading="lazy" alt=""></a>`).join('') + '</div>' : ''}
        ${d.fixed && d.fixed.note ? `<div class="cnote">“${h(d.fixed.note)}”</div>` : ''}
        <div class="df"><span class="fx">${d.fixed ? '✓ Complete · ' + h(d.fixed.by) + ' · ' + fmtT(d.fixed.at) : ''}</span>${d.fixed ? '<button class="act re" data-act="reopen">Reopen</button>' : '<button class="act go" data-act="complete">✓ Mark complete</button>'}<span class="tm">${showWalk ? 'walk ' + h(d.walkDate) + ' · ' + (d.fixed ? '' : 'open ' + age(d.at)) : fmtT(d.at) + (d.by ? ' · ' + h(d.by) : '')}</span></div>
      </div>
    </div>`;
  const clean = areas.filter(([, a]) => a.ok && !(a.defects || []).length);
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light only">
<title>Weekly Walk ${h(w.date)} – JW Marriott Atlanta</title>
<style>
body{margin:0;font:15px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;color:#1c1b18;background:#fff}
.wrap{max-width:860px;margin:0 auto;padding:22px 18px 60px}
h1{font-size:22px;margin:0 0 2px}.sub{color:#6b6861;margin-bottom:10px}
.top{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin:8px 0 4px}
.live{font-size:12px;color:#6b6861;flex:1}.live i{display:inline-block;width:8px;height:8px;border-radius:50%;background:#2e7d44;margin-right:5px;animation:p 2s infinite}@keyframes p{50%{opacity:.3}}
.lock.sh{border-color:#cfcbc2;font-weight:600}
.lock{font:inherit;font-size:13.5px;font-weight:600;border:1.5px solid #1c1b18;background:#fff;border-radius:999px;padding:6px 14px;cursor:pointer}
body.unlocked .lock{background:#2e7d44;border-color:#2e7d44;color:#fff}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px;margin:14px 0}
.k{border:1px solid #e2dfd8;border-radius:10px;padding:10px 12px}.k b{display:block;font-size:24px}.k span{font-size:12px;color:#6b6861;text-transform:uppercase;letter-spacing:.5px}
.k.g{background:#e6f4ea;border-color:#b8dfc3}.k.g b{color:#2e7d44}
.pills{margin:6px 0 2px}.pill{display:inline-block;border:1px solid #e2dfd8;border-radius:999px;padding:2px 10px;font-size:12.5px;margin:2px 2px 2px 0;background:#fff;font-family:inherit;color:inherit}.pill b{margin-left:3px}
.pill.hi{background:#fde8e6;border-color:#f3b4ae}.pill.md{background:#fff1d6;border-color:#f3d28f}.pill.lo{background:#eef4ea;border-color:#c9dcc0}
button.dp{cursor:pointer;padding:4px 12px;font-size:13px}button.dp.alldone{background:#e6f4ea;border-color:#b8dfc3;color:#2e7d44}button.dp.on,button.flt.on{outline:2px solid #1c1b18;outline-offset:1px}
button.flt{font:inherit;font-size:13px;border:1px solid #e2dfd8;background:#fff;border-radius:999px;padding:4px 12px;cursor:pointer;margin:2px 2px 2px 0}
h2{font-size:16px;margin:26px 0 8px;padding-bottom:4px;border-bottom:2px solid #1c1b18}
.ok{color:#2e7d44;font-size:12.5px;font-weight:600;border:1px solid #b8dfc3;background:#e6f4ea;border-radius:999px;padding:1px 9px}
.d{display:flex;gap:12px;border:1px solid #e2dfd8;border-radius:12px;padding:10px;margin:8px 0;break-inside:avoid;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.04)}
.d.fixed{background:#f0faf3;border-color:#a9d8b8;box-shadow:inset 5px 0 0 #2e7d44}
.d.hide{display:none}
.pic{flex:0 0 118px;position:relative}.pic img{width:118px;height:118px;object-fit:cover;border-radius:9px;display:block;border:1px solid #e2dfd8}
.pic .nopic{display:flex;align-items:center;justify-content:center;width:118px;height:118px;border-radius:9px;background:#f0eee9;color:#a39f96;font-size:12px}
.pic .more{position:absolute;right:6px;bottom:6px;background:rgba(0,0,0,.65);color:#fff;font-size:11px;font-weight:700;border-radius:999px;padding:1px 7px}
.dc{flex:1;min-width:0;display:flex;flex-direction:column}
.dh{display:flex;gap:8px;align-items:baseline}.area{font-size:12.5px;color:#6b6861;flex:1;min-width:0}
.dt{font-weight:700;font-size:15px;margin-top:4px;line-height:1.35}
.cnote{font-size:13px;color:#33533c;margin-top:4px;font-style:italic}
.sev{font-size:10.5px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;padding:1px 7px;border-radius:5px;background:#eee;flex:none}.sev.hi{background:#c0392b;color:#fff}.sev.md{background:#f6c453}.sev.lo{background:#dfe6ee}
.dept{flex:none;font-size:13.5px;white-space:nowrap}
.ph{display:flex;gap:6px;flex-wrap:wrap;margin-top:8px}.ph img{width:64px;height:64px;object-fit:cover;border-radius:7px;border:1px solid #e2dfd8}
.df{display:flex;gap:8px;align-items:center;margin-top:auto;padding-top:6px;flex-wrap:wrap}.fx{font-size:12.5px;color:#2e7d44;font-weight:700}.tm{font-size:11.5px;color:#9b978e;margin-left:auto}
.act{display:none;font:inherit;font-size:13px;font-weight:700;border-radius:8px;padding:6px 12px;cursor:pointer}
.act.go{border:1.5px solid #2e7d44;background:#fff;color:#2e7d44}.act.re{border:1px solid #cfcbc2;background:#fff;color:#6b6861;font-weight:600;font-size:12px;padding:3px 9px}
body.unlocked .act{display:inline-block}
.foot{margin-top:30px;font-size:12px;color:#6b6861}.pgen{display:none}
.okgrid{display:flex;flex-wrap:wrap;gap:6px;margin:6px 0 2px}
.ov{position:fixed;inset:0;background:rgba(20,18,14,.5);display:none;align-items:center;justify-content:center;padding:20px;z-index:10}.ov.on{display:flex}
.mb{background:#fff;border-radius:14px;padding:18px;width:100%;max-width:380px}.mb h3{margin:0 0 4px;font-size:17px}.mb p{margin:0 0 10px;color:#6b6861;font-size:13.5px}
.mb label{display:block;font-size:12px;font-weight:700;color:#6b6861;margin:8px 0 3px;text-transform:uppercase;letter-spacing:.4px}
.mb input,.mb textarea{width:100%;box-sizing:border-box;font:inherit;font-size:16px;border:1.5px solid #cfcbc2;border-radius:9px;padding:9px 10px}.mb textarea{min-height:64px;resize:vertical}
.err{color:#c0392b;font-size:13px;min-height:18px;margin-top:6px}.ma{display:flex;gap:8px;justify-content:flex-end;margin-top:6px}
.ma button{font:inherit;font-weight:700;border-radius:9px;padding:9px 16px;cursor:pointer;border:1.5px solid #cfcbc2;background:#fff}.ma button.pri{background:#2e7d44;border-color:#2e7d44;color:#fff}
.toast{position:fixed;left:50%;bottom:22px;transform:translateX(-50%);background:#1c1b18;color:#fff;padding:9px 16px;border-radius:999px;font-size:13.5px;opacity:0;transition:opacity .2s;pointer-events:none;z-index:20}.toast.on{opacity:1}
@media print{.wrap{padding:0}.pic,.pic img,.pic .nopic{width:96px;height:96px;flex-basis:96px}a{text-decoration:none;color:inherit}.noprint,.act,.top{display:none!important}.pgen{display:inline}.d.fixed{-webkit-print-color-adjust:exact;print-color-adjust:exact}}
</style></head><body><div class="wrap">
<div class="top noprint"><span class="live"><i></i>Live · updated <span id="lt">now</span></span><button class="lock sh" id="share">Share link</button><button class="lock" id="lock">🔒 Update status</button></div>
<div id="app">
<h1>Weekly Property Walk — JW Marriott Atlanta</h1>
<div class="sub">${fmtD(w.date)} · walked by ${h(w.by)} · ${w.status === 'closed' ? 'completed ' + fmtT(w.closedAt || w.updatedAt) : '<b>walk still in progress</b>'}</div>
<div class="kpis">
 <div class="k"><b>${areas.length}</b><span>areas checked</span></div>
 <div class="k"><b>${ds.length}</b><span>defects found</span></div>
 <div class="k g"><b>${ds.filter((d) => d.fixed).length}</b><span>complete</span></div>
 <div class="k"><b>${ds.filter((d) => !d.fixed).length}</b><span>still open</span></div>
 <div class="k"><b>${carryOpen.length}</b><span>carried over from prior walks</span></div>
</div>
${sevPills ? `<div class="pills"><b>Priority:</b> ${sevPills}</div>` : ''}
<div class="pills noprint"><b>Department</b> <span style="color:#9b978e;font-size:12px">(tap to filter)</span><br>${deptPills || '—'}</div>
<div class="pills noprint"><button class="flt" data-flt="all">All</button><button class="flt" data-flt="open">Open only</button></div>

<h2>Findings</h2>
${ds.sort((a, b) => areaOrder(w, a.areaId) - areaOrder(w, b.areaId)).map((d) => defectRow(d)).join('') || '<p>No defects logged.</p>'}

${clean.length ? `<h2>Checked — no issues</h2><div class="okgrid">${clean.map(([id]) => `<span class="ok">✓ ${h(areaName(w, id))}</span>`).join('')}</div>` : ''}

${carry.length ? `<h2>Still open from previous walks</h2>${carry.map((d) => defectRow(d, true)).join('')}` : ''}
</div>
<div class="foot"><span class="pgen" id="pgen"></span><a class="noprint" href="/report/${h(w.id)}.csv">Download CSV</a></div>
</div>
<div class="ov" id="ov"><div class="mb"><h3 id="mt"></h3><p id="mp"></p><div id="mf1"><label id="ml1"></label><input id="mi1" autocomplete="off"></div><div id="mf2"><label id="ml2"></label><textarea id="mi2"></textarea></div><div class="err" id="me"></div><div class="ma"><button id="mc">Cancel</button><button class="pri" id="mo">OK</button></div></div></div>
<div class="toast" id="toast"></div>
<script>
(function(){
var WID=${JSON.stringify(w.id)},$=function(i){return document.getElementById(i)},LS=window.localStorage;
function ls(k,v){try{if(v===undefined)return LS.getItem(k)||'';if(v===null)LS.removeItem(k);else LS.setItem(k,v)}catch(e){return ''}}
var code=ls('jw.rep.code'),FD='',FO=false,modal=false;
$('pgen').textContent='Printed '+new Date().toLocaleString();
function toast(m){var t=$('toast');t.textContent=m;t.className='toast on';setTimeout(function(){t.className='toast'},2200)}
function setLock(){document.body.className=code?'unlocked':'';$('lock').textContent=code?'🔓 Update mode on · Lock':'🔒 Update status'}
function applyFilter(){
  document.querySelectorAll('.d').forEach(function(d){var hide=(FD&&d.dataset.dept!==FD)||(FO&&d.dataset.done==='1');d.classList.toggle('hide',hide)});
  document.querySelectorAll('button.dp').forEach(function(b){b.classList.toggle('on',b.dataset.dept===FD)});
  document.querySelectorAll('button.flt').forEach(function(b){b.classList.toggle('on',(b.dataset.flt==='open')===FO)});
}
function ask(o){return new Promise(function(res){
  modal=true;$('mt').textContent=o.title;$('mp').textContent=o.text||'';$('me').textContent='';
  [1,2].forEach(function(n){var f=o['f'+n];$('mf'+n).style.display=f?'':'none';if(f){$('ml'+n).textContent=f.label;var i=$('mi'+n);i.value=f.value||'';i.placeholder=f.ph||''}});
  $('mo').textContent=o.ok||'OK';$('mo').style.display='';$('ov').className='ov on';
  var first=o.f1?$('mi1'):null;if(first)setTimeout(function(){first.focus()},50);
  function close(v){modal=false;$('ov').className='ov';$('mo').onclick=$('mc').onclick=null;res(v)}
  $('mc').onclick=function(){close(null)};
  $('mo').onclick=function(){close({a:o.f1?$('mi1').value.trim():'',b:o.f2?$('mi2').value.trim():''})};
})}
function post(path,body){return fetch(path,{method:'POST',headers:{'content-type':'application/json','x-code':code},body:JSON.stringify(body||{})})}
async function unlock(){
  for(;;){
    var r=await ask({title:'Update status',text:'Enter the department code to mark defects complete.',f1:{label:'Code',ph:'Code'},ok:'Unlock'});
    if(!r)return;
    var c=r.a.toUpperCase();code=c;
    try{var x=await post('/report/'+WID+'/auth');if(x.ok){ls('jw.rep.code',c);setLock();toast('Update mode on');return}}catch(e){code='';toast('No connection');return}
    code='';$('me').textContent='';toast('Wrong code')
  }
}
async function act(card,a){
  var id=card.dataset.id,wk=card.dataset.walk,title=card.querySelector('.dt').textContent;
  var body;
  if(a==='complete'){
    var r=await ask({title:'Mark complete',text:title,f1:{label:'Your name',value:ls('jw.rep.name'),ph:'e.g. Mike (Engineering)'},f2:{label:'Comment (optional)',ph:'What was done?'},ok:'Mark complete'});
    if(!r)return;if(!r.a){toast('Name is required');return}
    ls('jw.rep.name',r.a);body={action:'complete',by:r.a,note:r.b};
  }else{
    var q=await ask({title:'Reopen this defect?',text:title,ok:'Reopen'});if(!q)return;body={action:'reopen'};
  }
  try{
    var x=await post('/report/'+wk+'/defect/'+id,body);
    if(x.status===401){code='';ls('jw.rep.code',null);setLock();toast('Code no longer valid');return}
    if(!x.ok){toast('Could not save');return}
    toast(a==='complete'?'Marked complete ✓':'Reopened');await refresh(true);
  }catch(e){toast('No connection — try again')}
}
async function refresh(force){
  if(!force&&(document.hidden||modal))return;
  try{
    var r=await fetch(location.pathname,{cache:'no-store'});if(!r.ok)return;
    var d=new DOMParser().parseFromString(await r.text(),'text/html'),n=d.getElementById('app');
    if(n&&n.innerHTML!==$('app').innerHTML){$('app').innerHTML=n.innerHTML;applyFilter()}
    $('lt').textContent=new Date().toLocaleTimeString([],{hour:'numeric',minute:'2-digit',second:'2-digit'});
  }catch(e){}
}
document.addEventListener('click',function(e){
  var t=e.target.closest('button');if(!t)return;
  if(t.classList.contains('dp')){FD=FD===t.dataset.dept?'':t.dataset.dept;applyFilter()}
  else if(t.classList.contains('flt')){FO=t.dataset.flt==='open';applyFilter()}
  else if(t.dataset.act){act(t.closest('.d'),t.dataset.act)}
});
$('lock').onclick=function(){if(code){code='';ls('jw.rep.code',null);setLock();toast('Update mode off')}else unlock()};
$('share').onclick=function(){var u=location.origin+location.pathname,t=document.title;if(navigator.share)navigator.share({title:t,url:u}).catch(function(){});else if(navigator.clipboard)navigator.clipboard.writeText(u).then(function(){toast('Report link copied')});else prompt('Copy this link',u)};
$('mi1').onkeydown=function(e){if(e.key==='Enter')$('mo').click()};
document.addEventListener('visibilitychange',function(){if(!document.hidden)refresh()});
setInterval(refresh,8000);setLock();applyFilter();$('lt').textContent=new Date().toLocaleTimeString([],{hour:'numeric',minute:'2-digit',second:'2-digit'});
})();
</script></body></html>`;
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const p = url.pathname;
    if (p.startsWith('/api/') || p.startsWith('/report/')) {
      if (p.startsWith('/report/') && req.method === 'POST') {
        // departments use the shared report code instead of the team PIN
        const c = (req.headers.get('x-code') || '').trim().toUpperCase();
        if (!env.DEPT_CODE || c !== String(env.DEPT_CODE).trim().toUpperCase()) return json({ error: 'code' }, 401);
        if (p.endsWith('/auth')) return json({ ok: true });
      } else if (req.method !== 'GET') {
        const pin = req.headers.get('x-pin') || '';
        if (!env.PIN || pin !== String(env.PIN)) return json({ error: 'pin' }, 401);
      }
      // destructive walk operations need the reset code as well
      if ((req.method === 'DELETE' && p.startsWith('/api/walk/')) || p.endsWith('/reset')) {
        const code = req.headers.get('x-reset') || '';
        if (!env.RESET_CODE || code !== String(env.RESET_CODE)) return json({ error: 'reset-code' }, 403);
      }
      const which = p.startsWith('/api/photo') ? 'photos' : (p.startsWith('/api/walk') || p.startsWith('/report/')) ? 'walks' : 'main';
      return env.PUNCH.get(env.PUNCH.idFromName(which)).fetch(req);
    }
    return env.ASSETS.fetch(req);
  },
};
