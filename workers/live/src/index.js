/**
 * footgoal live-score proxy (Cloudflare Worker)
 *
 * Keeps the API-Football key off the phone and caches responses so that any
 * number of app users costs at most ~1 upstream call per endpoint per cache window.
 *
 *   GET /live          → live fixtures in footgoal's 8 leagues (cached 30s)
 *   GET /fixture/:id   → one fixture with events, lineups, statistics
 *                        (30s while live, 10 min before kick-off, 12h after full time)
 *
 * Only fixture IDs that exist in footgoal's own CMS export are served, so the
 * proxy can't be used to spend API quota on arbitrary matches.
 */

const API = 'https://v3.football.api-sports.io';
const FIXTURE_IDS_URL = 'https://footgoal-app-data.pages.dev/v1/fixture-ids.json';

// Premier League, La Liga, Champions League, Serie A, Bundesliga, Ligue 1, Eredivisie, Brasileirão
const LEAGUES = [39, 140, 2, 135, 78, 61, 88, 71];

const LIVE = new Set(['1H', 'HT', '2H', 'ET', 'BT', 'P', 'LIVE', 'INT', 'SUSP']);
const DONE = new Set(['FT', 'AET', 'PEN', 'AWD', 'WO', 'CANC', 'ABD', 'PST']);

let allowed = { at: 0, ids: new Set() };

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors() });
    if (request.method !== 'GET') return json({ error: 'method not allowed' }, 405);

    const url = new URL(request.url);
    try {
      if (url.pathname === '/live') {
        return cached(request, ctx, 30, () => getLive(env));
      }
      const m = url.pathname.match(/^\/fixture\/(\d{1,10})$/);
      if (m) {
        const id = Number(m[1]);
        if (!(await isAllowed(id))) return json({ error: 'unknown fixture' }, 404);
        return cached(request, ctx, null, () => getFixture(env, id));
      }
      if (url.pathname === '/' || url.pathname === '/health') return json({ ok: true });
      return json({ error: 'not found' }, 404);
    } catch (err) {
      return json({ error: 'upstream error', detail: String(err && err.message || err) }, 502);
    }
  },
};

async function api(env, path) {
  const res = await fetch(API + path, { headers: { 'x-apisports-key': env.API_FOOTBALL_KEY } });
  if (!res.ok) throw new Error(`API-Football ${res.status}`);
  const data = await res.json();
  if (data.errors && Object.keys(data.errors).length) throw new Error(JSON.stringify(data.errors));
  return data.response || [];
}

async function isAllowed(id) {
  if (Date.now() - allowed.at > 3600_000 || !allowed.ids.size) {
    try {
      const res = await fetch(FIXTURE_IDS_URL, { cf: { cacheTtl: 3600 } });
      if (res.ok) allowed = { at: Date.now(), ids: new Set(await res.json()) };
    } catch {
      // keep the previous list
    }
  }
  return allowed.ids.has(id);
}

function slimFixture(f) {
  return {
    id: f.fixture.id,
    date: f.fixture.date,
    status: { short: f.fixture.status.short, long: f.fixture.status.long, elapsed: f.fixture.status.elapsed, extra: f.fixture.status.extra ?? null },
    venue: f.fixture.venue ? { name: f.fixture.venue.name, city: f.fixture.venue.city } : null,
    referee: f.fixture.referee || null,
    league: { id: f.league.id, round: f.league.round },
    teams: {
      home: { id: f.teams.home.id, name: f.teams.home.name, logo: f.teams.home.logo },
      away: { id: f.teams.away.id, name: f.teams.away.name, logo: f.teams.away.logo },
    },
    goals: f.goals,
    score: f.score,
  };
}

async function getLive(env) {
  const list = await api(env, `/fixtures?live=${LEAGUES.join('-')}`);
  return { body: { updatedAt: new Date().toISOString(), fixtures: list.map(slimFixture) }, ttl: 30 };
}

async function getFixture(env, id) {
  const [f] = await api(env, `/fixtures?id=${id}`);
  if (!f) return { body: { error: 'not found' }, ttl: 300, status: 404 };
  const short = f.fixture.status.short;
  const ttl = LIVE.has(short) ? 30 : DONE.has(short) ? 43200 : 600;
  const body = {
    updatedAt: new Date().toISOString(),
    ...slimFixture(f),
    events: (f.events || []).map((e) => ({
      minute: e.time.elapsed, extra: e.time.extra, teamId: e.team.id, player: e.player?.name || null,
      assist: e.assist?.name || null, type: e.type, detail: e.detail,
    })),
    lineups: (f.lineups || []).map((l) => ({
      teamId: l.team.id, formation: l.formation, coach: l.coach?.name || null,
      startXI: (l.startXI || []).map((p) => ({ name: p.player.name, number: p.player.number, pos: p.player.pos })),
      substitutes: (l.substitutes || []).map((p) => ({ name: p.player.name, number: p.player.number, pos: p.player.pos })),
    })),
    statistics: (f.statistics || []).map((s) => ({
      teamId: s.team.id, stats: (s.statistics || []).map((x) => ({ type: x.type, value: x.value })),
    })),
  };
  return { body, ttl };
}

async function cached(request, ctx, fixedTtl, produce) {
  const cache = caches.default;
  const key = new Request(new URL(request.url).toString(), { method: 'GET' });
  const hit = await cache.match(key);
  if (hit) return withCors(hit);
  const { body, ttl, status = 200 } = await produce();
  const seconds = fixedTtl ?? ttl;
  const res = new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': `public, max-age=${seconds}` },
  });
  if (status === 200) ctx.waitUntil(cache.put(key, res.clone()));
  return withCors(res);
}

function cors() {
  return { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, OPTIONS' };
}
function withCors(res) {
  const r = new Response(res.body, res);
  for (const [k, v] of Object.entries(cors())) r.headers.set(k, v);
  return r;
}
function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...cors() } });
}
