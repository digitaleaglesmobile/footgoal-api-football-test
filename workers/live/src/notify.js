/**
 * Match notifications for the footgoal app.
 *
 * Runs every minute (cron). Uses the app-data schedule to decide whether anything
 * is happening; when no followed fixture is near kick-off or in play it makes
 * zero API-Football calls. Every notification has a unique key in the `sent`
 * table, so nothing is ever sent twice.
 */

export const KINDS = ['lineups', 'reminder', 'kickoff', 'goal', 'red', 'halftime', 'fulltime'];
export const DEFAULT_PREFS = { lineups: false, reminder: true, kickoff: false, goal: true, red: true, halftime: false, fulltime: true };

const SCHEDULE_URL = 'https://footgoal-app-data.pages.dev/v1/schedule.json';
const EXPO_PUSH = 'https://exp.host/--/api/v2/push/send';
const API = 'https://v3.football.api-sports.io';

const LIVE = new Set(['1H', 'HT', '2H', 'ET', 'BT', 'P', 'LIVE', 'INT', 'SUSP']);
const DONE = new Set(['FT', 'AET', 'PEN', 'AWD', 'WO', 'CANC', 'ABD']);
const MIN = 60_000;

// ---------------------------------------------------------------------------
// Subscriptions
// ---------------------------------------------------------------------------

export async function subscribe(env, body) {
  const token = typeof body?.token === 'string' ? body.token : '';
  if (!/^Expo(nent)?PushToken\[[A-Za-z0-9_-]{10,}\]$/.test(token)) return { status: 400, body: { error: 'invalid token' } };
  const teams = Array.isArray(body.teams) ? [...new Set(body.teams.filter((t) => Number.isInteger(t) && t > 0))].slice(0, 50) : [];
  const prefs = {};
  for (const k of KINDS) prefs[k] = typeof body.prefs?.[k] === 'boolean' ? body.prefs[k] : DEFAULT_PREFS[k];

  const stmts = [env.DB.prepare('DELETE FROM follows WHERE token = ?').bind(token)];
  if (!teams.length) {
    stmts.push(env.DB.prepare('DELETE FROM devices WHERE token = ?').bind(token));
  } else {
    stmts.push(
      env.DB.prepare('INSERT INTO devices (token, prefs, updated_at) VALUES (?, ?, ?) ON CONFLICT(token) DO UPDATE SET prefs = excluded.prefs, updated_at = excluded.updated_at')
        .bind(token, JSON.stringify(prefs), Date.now()),
    );
    for (const t of teams) stmts.push(env.DB.prepare('INSERT OR IGNORE INTO follows (token, team_id) VALUES (?, ?)').bind(token, t));
  }
  await env.DB.batch(stmts);
  return { status: 200, body: { ok: true, teams: teams.length } };
}

// ---------------------------------------------------------------------------
// Cron
// ---------------------------------------------------------------------------

export async function runNotifications(env, now = Date.now(), deps = {}) {
  const fetchFn = deps.fetch || fetch;
  const log = [];

  const schedule = await loadSchedule(fetchFn);
  if (!schedule.length) return { log: ['empty schedule'] };

  // Only fixtures involving at least one followed team matter.
  const followed = new Set((await env.DB.prepare('SELECT DISTINCT team_id FROM follows').all()).results.map((r) => r.team_id));
  if (!followed.size) return { log: ['no followers'] };
  const relevant = schedule.filter((s) => followed.has(s.h) || followed.has(s.a));

  // 1. Reminders: kick-off within the next 10–16 minutes.
  for (const s of relevant) {
    const t = Date.parse(s.k);
    if (t - now > 10 * MIN && t - now <= 16 * MIN) {
      await notify(env, fetchFn, s, 'reminder', `rem:${s.f}`, `⏰ Kick-off in 15 minutes`, `${s.hn} vs ${s.an}`, log);
    }
  }

  // 2. Lineups: 20–60 min before kick-off, checked every 5 minutes, only if someone wants them.
  if (new Date(now).getUTCMinutes() % 5 === 0) {
    for (const s of relevant) {
      const t = Date.parse(s.k);
      if (t - now < 20 * MIN || t - now > 60 * MIN) continue;
      if (await alreadySent(env, `lin:${s.f}`)) continue;
      if (!(await anyoneWants(env, s, 'lineups'))) continue;
      const [fx] = await api(env, fetchFn, `/fixtures?id=${s.f}`);
      if (fx?.lineups?.length >= 2) {
        await notify(env, fetchFn, s, 'lineups', `lin:${s.f}`, '📋 Lineups are out', `${s.hn} vs ${s.an} – tap to see the starting XIs`, log);
      }
    }
  }

  // 3. In-play: fixtures from 2 min before kick-off until 3h after, not yet finished.
  const window = relevant.filter((s) => {
    const t = Date.parse(s.k);
    return now >= t - 2 * MIN && now <= t + 180 * MIN;
  });
  if (!window.length) return { log };

  const states = new Map();
  const ids = window.map((s) => s.f);
  const placeholders = ids.map(() => '?').join(',');
  for (const r of (await env.DB.prepare(`SELECT * FROM fixture_state WHERE fixture_id IN (${placeholders})`).bind(...ids).all()).results) {
    states.set(r.fixture_id, r);
  }
  const active = window.filter((s) => !DONE.has(states.get(s.f)?.status));
  if (!active.length) return { log };

  for (let i = 0; i < active.length; i += 20) {
    const chunk = active.slice(i, i + 20);
    const fixtures = await api(env, fetchFn, `/fixtures?ids=${chunk.map((s) => s.f).join('-')}`);
    for (const fx of fixtures) {
      const s = chunk.find((c) => c.f === fx.fixture.id);
      if (s) await processFixture(env, fetchFn, s, fx, states.get(s.f), log);
    }
  }
  return { log };
}

async function processFixture(env, fetchFn, s, fx, prev, log) {
  const status = fx.fixture.status.short;
  const gh = fx.goals.home ?? 0;
  const ga = fx.goals.away ?? 0;
  const score = `${s.hn} ${gh}–${ga} ${s.an}`;
  const events = fx.events || [];
  const teamName = (id) => (id === fx.teams.home.id ? s.hn : id === fx.teams.away.id ? s.an : '');
  const min = (e) => `${e.time.elapsed ?? ''}${e.time.extra ? '+' + e.time.extra : ''}'`;

  const goalEvents = events.filter((e) => e.type === 'Goal' && e.detail !== 'Missed Penalty');
  const redEvents = events.filter((e) => e.type === 'Card' && /red/i.test(e.detail));
  const keyOf = (prefix, e) => `${prefix}:${s.f}:${e.time.elapsed}:${e.time.extra ?? ''}:${e.team.id}:${e.player?.id ?? e.player?.name ?? ''}`;

  // First time we see a match that is already under way (e.g. right after deploy):
  // record what already happened without notifying, so users don't get a burst of old events.
  if (!prev && status !== 'NS' && status !== 'TBD') {
    const keys = [
      ...goalEvents.map((e) => keyOf('g', e)),
      ...redEvents.map((e) => keyOf('r', e)),
      `ko:${s.f}`,
      ...(status === 'HT' || status === '2H' || DONE.has(status) ? [`ht:${s.f}`] : []),
      ...(DONE.has(status) ? [`ft:${s.f}`] : []),
    ];
    await markSent(env, keys);
    log.push(`seeded ${s.f} (${status})`);
  } else {
    if (LIVE.has(status) || DONE.has(status)) {
      await notify(env, fetchFn, s, 'kickoff', `ko:${s.f}`, '▶️ Kick-off', `${s.hn} 0–0 ${s.an}`, log);
    }
    for (const e of goalEvents) {
      const tag = e.detail === 'Own Goal' ? ' (OG)' : e.detail === 'Penalty' ? ' (pen)' : '';
      await notify(env, fetchFn, s, 'goal', keyOf('g', e), `⚽ GOAL! ${score}`, `${e.player?.name ?? teamName(e.team.id)} ${min(e)}${tag}`, log);
    }
    for (const e of redEvents) {
      await notify(env, fetchFn, s, 'red', keyOf('r', e), `🟥 Red card – ${teamName(e.team.id)}`, `${e.player?.name ?? ''} ${min(e)} · ${score}`, log);
    }
    if (status === 'HT') await notify(env, fetchFn, s, 'halftime', `ht:${s.f}`, '⏸️ Half-time', score, log);
    if (DONE.has(status) && ['FT', 'AET', 'PEN'].includes(status)) {
      const pens = fx.score?.penalty?.home != null ? ` (pens ${fx.score.penalty.home}–${fx.score.penalty.away})` : '';
      await notify(env, fetchFn, s, 'fulltime', `ft:${s.f}`, '🏁 Full-time', score + pens, log);
    }
  }

  await env.DB.prepare(
    'INSERT INTO fixture_state (fixture_id, status, home, away, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(fixture_id) DO UPDATE SET status = excluded.status, home = excluded.home, away = excluded.away, updated_at = excluded.updated_at',
  ).bind(s.f, status, gh, ga, Date.now()).run();
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let scheduleCache = { at: 0, data: [] };
async function loadSchedule(fetchFn) {
  if (Date.now() - scheduleCache.at < 10 * MIN && scheduleCache.data.length) return scheduleCache.data;
  try {
    const res = await fetchFn(SCHEDULE_URL, { cf: { cacheTtl: 600 } });
    if (res.ok) scheduleCache = { at: Date.now(), data: await res.json() };
  } catch {
    // keep previous
  }
  return scheduleCache.data;
}

async function api(env, fetchFn, path) {
  const res = await fetchFn(API + path, { headers: { 'x-apisports-key': env.API_FOOTBALL_KEY } });
  if (!res.ok) throw new Error(`API-Football ${res.status}`);
  const data = await res.json();
  return data.response || [];
}

async function alreadySent(env, key) {
  return !!(await env.DB.prepare('SELECT 1 FROM sent WHERE key = ?').bind(key).first());
}

async function markSent(env, keys) {
  if (!keys.length) return;
  await env.DB.batch(keys.map((k) => env.DB.prepare('INSERT OR IGNORE INTO sent (key, at) VALUES (?, ?)').bind(k, Date.now())));
}

async function recipients(env, s, kind) {
  const teams = [s.h, s.a].filter(Boolean);
  if (!teams.length) return [];
  const rows = (
    await env.DB.prepare(
      `SELECT DISTINCT d.token, d.prefs FROM follows f JOIN devices d ON d.token = f.token WHERE f.team_id IN (${teams.map(() => '?').join(',')})`,
    ).bind(...teams).all()
  ).results;
  return rows.filter((r) => {
    try {
      const p = JSON.parse(r.prefs);
      return p[kind] ?? DEFAULT_PREFS[kind];
    } catch {
      return DEFAULT_PREFS[kind];
    }
  }).map((r) => r.token);
}

async function anyoneWants(env, s, kind) {
  return (await recipients(env, s, kind)).length > 0;
}

/** Claims the key first (so concurrent runs can't double-send), then pushes. */
async function notify(env, fetchFn, s, kind, key, title, body, log) {
  const claim = await env.DB.prepare('INSERT OR IGNORE INTO sent (key, at) VALUES (?, ?)').bind(key, Date.now()).run();
  if (!claim.meta?.changes) return;
  const tokens = await recipients(env, s, kind);
  if (!tokens.length) return;
  const messages = tokens.map((to) => ({
    to, title, body, sound: 'default', channelId: 'match', priority: 'high',
    data: { matchId: s.m, league: s.l, fixtureId: s.f },
  }));
  for (let i = 0; i < messages.length; i += 100) {
    const batch = messages.slice(i, i + 100);
    try {
      const res = await fetchFn(EXPO_PUSH, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(batch),
      });
      const out = await res.json().catch(() => ({}));
      const tickets = out.data || [];
      const dead = tickets
        .map((t, j) => (t.status === 'error' && t.details?.error === 'DeviceNotRegistered' ? batch[j].to : null))
        .filter(Boolean);
      if (dead.length) {
        await env.DB.batch(dead.flatMap((t) => [
          env.DB.prepare('DELETE FROM follows WHERE token = ?').bind(t),
          env.DB.prepare('DELETE FROM devices WHERE token = ?').bind(t),
        ]));
      }
    } catch (err) {
      log.push(`push failed ${key}: ${err}`);
    }
  }
  log.push(`sent ${key} → ${tokens.length}`);
}

/** Housekeeping: forget dedupe keys and fixture states older than 7 days. */
export async function cleanup(env) {
  const cutoff = Date.now() - 7 * 86400000;
  await env.DB.batch([
    env.DB.prepare('DELETE FROM sent WHERE at < ?').bind(cutoff),
    env.DB.prepare('DELETE FROM fixture_state WHERE updated_at < ?').bind(cutoff),
  ]);
}
