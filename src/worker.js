// JW Atlanta go-back punch — Cloudflare Worker
// Serves public/ and a tiny JSON API backed by a Durable Object.
//   GET  /api/state?since=<v>   -> {v, rooms:{id: body}}  (304 if unchanged)
//   PUT  /api/room/<id>         -> body JSON, header x-pin   -> {v}
//   DELETE /api/room/<id>       -> header x-pin              -> {v}

export class Punch {
  constructor(state) { this.storage = state.storage; }

  async fetch(req) {
    const url = new URL(req.url);
    const m = url.pathname.match(/^\/api\/room\/([A-Za-z0-9_.-]{1,64})$/);
    if (url.pathname === '/api/state' && req.method === 'GET') {
      const v = (await this.storage.get('__v')) || 0;
      const since = Number(url.searchParams.get('since') || -1);
      if (since === v) return new Response(null, { status: 304 });
      const all = await this.storage.list();
      const rooms = {};
      for (const [k, val] of all) if (k !== '__v') rooms[k] = val;
      return json({ v, rooms });
    }
    if (m && req.method === 'PUT') {
      const body = await req.json().catch(() => null);
      if (!body || typeof body !== 'object' || Array.isArray(body)) return json({ error: 'bad body' }, 400);
      const s = JSON.stringify(body);
      if (s.length > 64 * 1024) return json({ error: 'too large' }, 413);
      const v = ((await this.storage.get('__v')) || 0) + 1;
      await this.storage.put({ [m[1]]: body, __v: v });
      return json({ v });
    }
    if (m && req.method === 'DELETE') {
      const v = ((await this.storage.get('__v')) || 0) + 1;
      await this.storage.delete(m[1]);
      await this.storage.put('__v', v);
      return json({ v });
    }
    return json({ error: 'not found' }, 404);
  }
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname.startsWith('/api/')) {
      if (req.method !== 'GET') {
        const pin = req.headers.get('x-pin') || '';
        if (!env.PIN || pin !== String(env.PIN)) return json({ error: 'pin' }, 401);
      }
      const id = env.PUNCH.idFromName('main');
      return env.PUNCH.get(id).fetch(req);
    }
    return env.ASSETS.fetch(req);
  },
};
