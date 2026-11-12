#!/usr/bin/env node
/**
 * Squads for Guess the Lineup (app + web game).
 *
 * Runs right after export-app-data.mjs, on the same output folder. Reads the
 * exported leagues.json + teams/index.json (so the team list always matches
 * the CMS, including promoted/relegated clubs), fetches each team's current
 * squad from API-Football, and writes:
 *
 *   squads/leagues.json        league list for the game's home screen
 *   squads/<league-slug>.json  { name, country, teamCount, updatedAt, teams:[{ id, name, logo, slug, players:[{id,name,num,group,photo}] }] }
 *
 * Same file shape as guess-the-lineup-app/public/data, so the web game can read it too.
 *
 * API budget: squads change slowly, so each team is cached (in --cache, kept
 * between GitHub runs with actions/cache) and only re-fetched once it is older
 * than SQUAD_MAX_AGE_HOURS (default 72). That is roughly 60 calls a day for
 * ~190 teams. --force re-fetches everything (~190 calls).
 *
 * If API-Football fails for a team, the cached squad is kept. If there is no
 * cached squad either, the team is left out of the game rather than shipped empty.
 *
 * Usage:
 *   API_FOOTBALL_KEY=xxx node squads.mjs --out app-data --cache .squads-cache [--force]
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

const args = process.argv.slice(2);
const arg = (name, def) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def; };
const OUT_DIR = path.resolve(arg('--out', 'app-data'));
const CACHE_DIR = path.resolve(arg('--cache', '.squads-cache'));
const FORCE = args.includes('--force');
const MAX_AGE_MS = Number(process.env.SQUAD_MAX_AGE_HOURS || 72) * 3600000;
const KEY = process.env.API_FOOTBALL_KEY;
const API = (process.env.API_FOOTBALL_BASE || 'https://v3.football.api-sports.io').replace(/\/$/, '');
const MAX_CALLS = Number(process.env.SQUAD_MAX_CALLS || 250);

const GROUP = { Goalkeeper: 'GK', Defender: 'DF', Midfielder: 'MF', Attacker: 'FW' };
const ACCENT = {
  'premier-league': '#37003C', 'la-liga': '#EE8707', 'serie-a': '#008FD7', bundesliga: '#D3010C',
  eredivisie: '#004B94', 'ligue-1': '#001B5E', brasileirao: '#009C3B', 'champions-league': '#0B1E5B',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readJson = async (p) => JSON.parse(await readFile(p, 'utf8'));
const sha = (s) => createHash('sha256').update(s).digest('hex').slice(0, 16);

let calls = 0;
async function fetchSquad(teamId) {
  for (let attempt = 0; attempt < 3; attempt++) {
    calls++;
    await sleep(250);
    const res = await fetch(`${API}/players/squads?team=${encodeURIComponent(teamId)}`, { headers: { 'x-apisports-key': KEY } });
    if (res.status === 429) { await sleep(30000); continue; }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();
    const errs = body.errors && (Array.isArray(body.errors) ? body.errors.length : Object.keys(body.errors).length);
    if (errs) throw new Error(JSON.stringify(body.errors).slice(0, 200));
    const players = body.response?.[0]?.players || [];
    return players
      .filter((p) => p && p.id && p.name && GROUP[p.position])
      .map((p) => ({ id: String(p.id), name: p.name, num: Number.isInteger(p.number) ? p.number : null, group: GROUP[p.position], photo: p.photo || null }));
  }
  throw new Error('rate limited');
}

async function main() {
  const leagues = await readJson(path.join(OUT_DIR, 'leagues.json'));
  const teams = await readJson(path.join(OUT_DIR, 'teams/index.json'));
  await mkdir(CACHE_DIR, { recursive: true });

  const byLeague = new Map();
  for (const t of teams) {
    if (!t.apiTeamId || !t.league) continue;
    if (!byLeague.has(t.league)) byLeague.set(t.league, []);
    byLeague.get(t.league).push(t);
  }
  // Domestic clubs also playing in the Champions League appear in that game too.
  const ucl = leagues.find((l) => l.slug === 'champions-league');
  if (ucl) {
    if (!byLeague.has(ucl.id)) byLeague.set(ucl.id, []);
    for (const t of teams) if (t.alsoInChampionsLeague && t.apiTeamId && t.league !== ucl.id) byLeague.get(ucl.id).push(t);
  }

  // Refresh the stalest teams first, within the per-run call budget.
  const plan = [];
  for (const t of teams.filter((x) => x.apiTeamId)) {
    let cached = null;
    try { cached = await readJson(path.join(CACHE_DIR, `${t.apiTeamId}.json`)); } catch {}
    const age = cached ? Date.now() - Date.parse(cached.fetchedAt) : Infinity;
    plan.push({ t, cached, stale: FORCE || !cached || age > MAX_AGE_MS, age });
  }
  let toFetch = plan.filter((p) => p.stale).sort((a, b) => b.age - a.age);
  if (toFetch.length && !KEY) { console.warn('No API_FOOTBALL_KEY - using cached squads only'); toFetch = []; }

  let ok = 0, failed = 0, skippedBudget = 0;
  for (const p of toFetch) {
    if (calls >= MAX_CALLS) { skippedBudget++; continue; }
    try {
      const players = await fetchSquad(p.t.apiTeamId);
      if (players.length < 11) throw new Error(`only ${players.length} players`);
      p.cached = { fetchedAt: new Date().toISOString(), players };
      await writeFile(path.join(CACHE_DIR, `${p.t.apiTeamId}.json`), JSON.stringify(p.cached));
      ok++;
    } catch (e) {
      failed++;
      console.warn(`  ! ${p.t.name} (${p.t.apiTeamId}): ${e.message}${p.cached ? ' - keeping cached squad' : ''}`);
    }
  }
  console.log(`Squads: ${plan.length} teams, ${toFetch.length} due, ${ok} refreshed, ${failed} failed, ${skippedBudget} deferred, ${calls} API calls`);

  const squadByTeam = new Map(plan.filter((p) => p.cached).map((p) => [p.t.id, p.cached]));
  const outLeagues = {};
  const written = {};
  await mkdir(path.join(OUT_DIR, 'squads'), { recursive: true });

  for (const l of leagues) {
    const list = (byLeague.get(l.id) || [])
      .filter((t) => squadByTeam.has(t.id))
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((t) => {
        const s = squadByTeam.get(t.id);
        return {
          id: String(t.apiTeamId), name: t.name, slug: t.slug,
          logo: t.badge?.url || `https://media.api-sports.io/football/teams/${t.apiTeamId}.png`,
          updatedAt: s.fetchedAt, players: s.players,
        };
      });
    if (list.length < 2) continue;
    const updatedAt = list.map((t) => t.updatedAt).sort().at(-1);
    const file = { name: l.name, country: l.country || null, teamCount: list.length, updatedAt, teams: list };
    const json = JSON.stringify(file);
    await writeFile(path.join(OUT_DIR, 'squads', `${l.slug}.json`), json);
    written[`squads/${l.slug}.json`] = { json, count: list.length };
    outLeagues[l.slug] = {
      name: l.name, country: l.country || null, teamCount: list.length,
      accent: l.colorHex || ACCENT[l.slug] || '#C8102E', logo: l.logo?.url || null, updatedAt,
    };
  }

  const leaguesJson = JSON.stringify(outLeagues);
  await writeFile(path.join(OUT_DIR, 'squads', 'leagues.json'), leaguesJson);
  written['squads/leagues.json'] = { json: leaguesJson, count: Object.keys(outLeagues).length };

  // Add the new files to the manifest written by export-app-data.mjs.
  const mPath = path.join(OUT_DIR, 'manifest.json');
  const manifest = await readJson(mPath);
  for (const [rel, { json, count }] of Object.entries(written)) {
    manifest.files[rel] = { sha256: sha(json), bytes: Buffer.byteLength(json), count };
  }
  await writeFile(mPath, JSON.stringify(manifest, null, 1));
  console.log(`Wrote ${Object.keys(outLeagues).length} league squad files: ${Object.entries(outLeagues).map(([k, v]) => `${k} ${v.teamCount}`).join(', ')}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
