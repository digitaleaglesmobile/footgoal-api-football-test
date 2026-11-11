#!/usr/bin/env node
/**
 * footgoal.co → mobile app data export
 *
 * Reads PUBLISHED items from the Webflow CMS (Data API v2, read-only) and writes
 * clean, app-friendly JSON files plus a manifest.json the app uses to download
 * only what changed.
 *
 * This script never writes to Webflow. It only calls GET endpoints.
 *
 * Usage:
 *   WEBFLOW_API_TOKEN=xxx node export-app-data.mjs            # writes ./app-data
 *   WEBFLOW_API_TOKEN=xxx node export-app-data.mjs --out dist  # custom folder
 *   WEBFLOW_API_TOKEN=xxx node export-app-data.mjs --dry-run   # fetch + validate, write nothing
 *
 * Env:
 *   WEBFLOW_API_TOKEN  (required) site token with cms:read scope
 *   WEBFLOW_API_BASE   (optional) defaults to https://api.webflow.com/v2 (used by tests)
 *   SITE_ORIGIN        (optional) defaults to https://footgoal.co
 *
 * Requires Node 18+ (built-in fetch). No npm dependencies.
 */

import { mkdir, writeFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const API_BASE = (process.env.WEBFLOW_API_BASE || 'https://api.webflow.com/v2').replace(/\/$/, '');
const TOKEN = process.env.WEBFLOW_API_TOKEN;
const SITE_ORIGIN = (process.env.SITE_ORIGIN || 'https://footgoal.co').replace(/\/$/, '');
const SCHEMA_VERSION = 1;

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const outIdx = args.indexOf('--out');
const OUT_DIR = path.resolve(outIdx >= 0 ? args[outIdx + 1] : 'app-data');

// Fields that only matter for the website (SEO / template plumbing). Dropped everywhere.
const WEB_ONLY_FIELDS = [
  'seo-title', 'meta-description', 'share-image', 'page-url', 'team-page-url',
  'venue-page-url', 'match-date-iso', 'match-end-iso', 'show-fixtures-section',
  'seating-plan-alt',
];

/**
 * One entry per Webflow collection the app needs.
 *  - out:       'single'  → one file  <file>.json
 *               'grouped' → one file per league  <dir>/<league-slug>.json
 *               'split'   → <dir>/index.json (light list) + <dir>/<slug>.json (full item)
 *  - minCount:  safety check. If Webflow returns fewer published items than this,
 *               the whole export aborts so the app never receives an empty/broken file.
 *  - indexFields (split only): fields kept in the light index list.
 */
const COLLECTIONS = [
  { key: 'leagues', id: '6a32a8954e8d7db479514a79', out: 'single', file: 'leagues', minCount: 5 },
  {
    key: 'teams', id: '6a20064807685f373db26660', out: 'split', dir: 'teams', minCount: 100,
    indexFields: ['name', 'slug', 'shortName', 'badge', 'league', 'country', 'city', 'primaryColor',
      'venue', 'alsoInChampionsLeague', 'apiTeamId', 'webUrl'],
  },
  {
    key: 'standings', id: '6a200649847c9fcb9278de02', out: 'grouped', dir: 'standings',
    groupBy: 'league', sortBy: ['position', 'asc'], minCount: 50,
  },
  {
    key: 'matches', id: '6a200649c668e2cb8f11e82b', out: 'grouped', dir: 'matches',
    groupBy: 'league', sortBy: ['matchDate', 'asc'], minCount: 500,
  },
  {
    key: 'topScorers', id: '6a32a89633c9bd6bea624094', out: 'grouped', dir: 'top-scorers',
    groupBy: 'league', sortBy: ['rank', 'asc'], minCount: 20,
  },
  {
    key: 'venues', id: '69c4f95e9b0adb96456bf53b', out: 'split', dir: 'venues', minCount: 50,
    indexFields: ['name', 'slug', 'city', 'country', 'capacity', 'venueType', 'coordinates',
      'venueImages', 'homeTeams', 'competitions', 'homeTeamBadge', 'webUrl'],
  },
  { key: 'authors', id: '6a32a89594643f6e4b78ee05', out: 'single', file: 'authors', minCount: 1 },
  { key: 'records', id: '6ae3320ba376e9c8a49f65f3', out: 'single', file: 'records', minCount: 0 },
  {
    key: 'articlesEn', id: '69c3c0da2fd37856ad9e2ab1', out: 'split', dir: 'articles/en', minCount: 50,
    sortBy: ['createdOn', 'desc'], indexFields: ARTICLE_INDEX_FIELDS(),
  },
  {
    key: 'articlesEs', id: '69e5f0c0b01760ebae450b91', out: 'split', dir: 'articles/es', minCount: 0,
    sortBy: ['createdOn', 'desc'], indexFields: ARTICLE_INDEX_FIELDS(),
  },
  {
    key: 'articlesPt', id: '69e5f0c15c882b408ab73240', out: 'split', dir: 'articles/pt', minCount: 0,
    sortBy: ['createdOn', 'desc'], indexFields: ARTICLE_INDEX_FIELDS(),
  },
  // Deliberately NOT exported:
  //  - Comments: user-submitted, may contain personal data
  //  - Players: currently empty
  //  - Teams [Countries], Groups, Group Standings, Team Matches: World Cup 2026 legacy
];

function ARTICLE_INDEX_FIELDS() {
  return ['name', 'slug', 'shortDescription', 'mainImage', 'readingTime', 'authorName',
    'author', 'league', 'isSponsored', 'sponsorName', 'createdOn', 'lastPublished',
    'translationEn', 'translationEs', 'translationPt', 'webUrl'];
}

// ---------------------------------------------------------------------------
// Webflow API (read-only)
// ---------------------------------------------------------------------------

const MIN_GAP_MS = 550; // ≈109 req/min max, under the 120/min CMS-plan limit
let lastCall = 0;
let requestCount = 0;

async function api(pathname, attempt = 1) {
  const wait = lastCall + MIN_GAP_MS - Date.now();
  if (wait > 0) await sleep(wait);
  lastCall = Date.now();
  requestCount++;

  const res = await fetch(`${API_BASE}${pathname}`, {
    headers: { Authorization: `Bearer ${TOKEN}`, accept: 'application/json' },
  });

  if (res.status === 429 || res.status >= 500) {
    if (attempt > 5) throw new Error(`Webflow ${res.status} on ${pathname} after ${attempt - 1} retries`);
    const retryAfter = Number(res.headers.get('retry-after')) || 2 ** attempt;
    console.warn(`  ↻ ${res.status} on ${pathname}, retrying in ${retryAfter}s`);
    await sleep(retryAfter * 1000);
    return api(pathname, attempt + 1);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Webflow ${res.status} on ${pathname}: ${body.slice(0, 300)}`);
  }
  return res.json();
}

async function getSchema(collectionId) {
  return api(`/collections/${collectionId}`);
}

/** Published (live) items only — drafts and archived items are never exported. */
async function getLiveItems(collectionId) {
  const items = [];
  let offset = 0;
  for (;;) {
    const page = await api(`/collections/${collectionId}/items/live?limit=100&offset=${offset}`);
    items.push(...(page.items || []));
    const total = page.pagination?.total ?? items.length;
    offset += 100;
    if (offset >= total || !page.items?.length) break;
  }
  return items;
}

// ---------------------------------------------------------------------------
// Transform: Webflow item → clean app object
// ---------------------------------------------------------------------------

/** 'transport----train' → 'transportTrain', 'home-team' → 'homeTeam' */
function camel(slug) {
  return slug.replace(/-+([a-z0-9])/g, (_, c) => c.toUpperCase());
}

function absUrl(u) {
  if (!u || typeof u !== 'string') return u ?? null;
  return u.startsWith('/') && !u.startsWith('//') ? SITE_ORIGIN + u : u;
}

/** Make internal links in rich text absolute so the app can deep-link them. */
function fixRichText(html) {
  if (!html) return null;
  return html.replace(/(href|src)="\/(?!\/)/g, `$1="${SITE_ORIGIN}/`);
}

function image(v) {
  return v && v.url ? { url: v.url, alt: v.alt || null } : null;
}

function transformItem(item, schema) {
  const out = {
    id: item.id,
    createdOn: item.createdOn,
    lastPublished: item.lastPublished,
  };
  const fd = item.fieldData || {};

  for (const field of schema.fields) {
    if (WEB_ONLY_FIELDS.includes(field.slug)) continue;
    const v = fd[field.slug];
    const key = camel(field.slug);

    switch (field.type) {
      case 'Image':
        out[key] = image(v); break;
      case 'MultiImage':
        out[key] = Array.isArray(v) ? v.map(image).filter(Boolean) : []; break;
      case 'Option': {
        // Webflow returns an option ID hash; the app needs the readable name.
        const opt = field.validations?.options?.find((o) => o.id === v);
        out[key] = opt ? opt.name : null; break;
      }
      case 'MultiReference':
        out[key] = Array.isArray(v) ? v : []; break;
      case 'Reference':
        out[key] = v || null; break;
      case 'RichText':
        out[key] = fixRichText(v); break;
      case 'Link':
        out[key] = absUrl(v); break;
      case 'Switch':
        out[key] = v === true; break;
      default:
        out[key] = v ?? null;
    }
  }

  // Website URL for "open on web" / share / App Links.
  out.webUrl = `${SITE_ORIGIN}/${schema.slug}/${fd.slug}`;
  return out;
}

// ---------------------------------------------------------------------------
// Output helpers
// ---------------------------------------------------------------------------

const files = new Map(); // relative path → { json, count }

function addFile(rel, data, count) {
  // Deterministic, compact JSON so unchanged content → unchanged hash.
  files.set(rel, { json: JSON.stringify(data), count });
}

function sortItems(items, sortBy) {
  if (!sortBy) return items;
  const [key, dir] = sortBy;
  const m = dir === 'desc' ? -1 : 1;
  return [...items].sort((a, b) => {
    const x = a[key], y = b[key];
    if (x == null && y == null) return 0;
    if (x == null) return 1;
    if (y == null) return -1;
    return (x > y ? 1 : x < y ? -1 : 0) * m;
  });
}

function pick(obj, keys) {
  const o = {};
  for (const k of keys) if (k in obj) o[k] = obj[k];
  return o;
}

function safeSlug(s) {
  return String(s || '').replace(/[^a-z0-9-]/gi, '-').toLowerCase() || 'unknown';
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  if (!TOKEN) {
    console.error('Missing WEBFLOW_API_TOKEN');
    process.exit(1);
  }
  const started = Date.now();
  console.log(`Exporting footgoal app data from ${API_BASE}${DRY_RUN ? ' (dry run)' : ''}`);

  const data = {};
  const problems = [];

  for (const c of COLLECTIONS) {
    const schema = await getSchema(c.id);
    const raw = await getLiveItems(c.id);
    const items = sortItems(raw.map((it) => transformItem(it, schema)), c.sortBy);
    data[c.key] = items;
    console.log(`  ✓ ${c.key.padEnd(11)} ${String(items.length).padStart(5)} items`);
    if (items.length < c.minCount) {
      problems.push(`${c.key}: got ${items.length}, expected at least ${c.minCount}`);
    }
  }

  if (problems.length) {
    console.error('\nAborting — safety check failed, nothing was written:');
    for (const p of problems) console.error('  ✗ ' + p);
    process.exit(2);
  }

  // API-Football fixture IDs the live-score proxy is allowed to look up.
  addFile('fixture-ids.json', data.matches.map((m) => m.apiFixtureId).filter((x) => Number.isInteger(x)), data.matches.length);

  // Compact schedule for the notification service: upcoming and recent fixtures with API team IDs.
  {
    const teamApi = new Map(data.teams.map((t) => [t.id, Number(t.apiTeamId) || null]));
    const teamName = new Map(data.teams.map((t) => [t.id, t.shortName && t.name.length > 18 ? t.shortName : t.name]));
    const leagueSlugById = new Map(data.leagues.map((l) => [l.id, l.slug]));
    const from = Date.now() - 2 * 86400000, to = Date.now() + 21 * 86400000;
    const schedule = data.matches
      .filter((m) => Number.isInteger(m.apiFixtureId) && m.matchDate)
      .filter((m) => { const t = Date.parse(m.matchDate); return t >= from && t <= to; })
      .map((m) => ({
        f: m.apiFixtureId, k: m.matchDate, m: m.id, l: leagueSlugById.get(m.league) || 'other',
        h: teamApi.get(m.homeTeam) ?? null, a: teamApi.get(m.awayTeam) ?? null,
        hn: teamName.get(m.homeTeam) ?? (m.name.split(' vs ')[0] || ''), an: teamName.get(m.awayTeam) ?? (m.name.split(' vs ')[1] || ''),
      }));
    addFile('schedule.json', schedule, schedule.length);
  }

  // League id → slug, for grouping files by league.
  const leagueSlug = new Map(data.leagues.map((l) => [l.id, l.slug]));

  for (const c of COLLECTIONS) {
    const items = data[c.key];

    if (c.out === 'single') {
      addFile(`${c.file}.json`, items, items.length);
    }

    if (c.out === 'grouped') {
      const groups = new Map();
      for (const it of items) {
        const g = leagueSlug.get(it[c.groupBy]) || 'other';
        if (!groups.has(g)) groups.set(g, []);
        groups.get(g).push(it);
      }
      for (const [g, list] of groups) addFile(`${c.dir}/${safeSlug(g)}.json`, list, list.length);
    }

    if (c.out === 'split') {
      addFile(`${c.dir}/index.json`, items.map((it) => pick(it, ['id', ...c.indexFields])), items.length);
      for (const it of items) addFile(`${c.dir}/${safeSlug(it.slug)}.json`, it, 1);
    }
  }

  // Manifest: the app downloads this first and only fetches files whose hash changed.
  const manifest = {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    siteOrigin: SITE_ORIGIN,
    files: {},
  };
  // Detail files (one per article/team/venue) are listed via their index, not the manifest,
  // to keep the manifest small. Index + single + grouped files are listed with hashes.
  for (const [rel, { json, count }] of [...files].sort(([a], [b]) => a.localeCompare(b))) {
    const isDetail = !rel.endsWith('index.json') && COLLECTIONS.some((c) => c.out === 'split' && rel.startsWith(c.dir + '/'));
    if (isDetail) continue;
    manifest.files[rel] = { sha256: sha(json), bytes: Buffer.byteLength(json), count };
  }
  // Each split item gets a content hash inside its index entry so the app can refresh just that item.
  for (const c of COLLECTIONS.filter((x) => x.out === 'split')) {
    const idx = JSON.parse(files.get(`${c.dir}/index.json`).json);
    for (const entry of idx) entry.sha256 = sha(files.get(`${c.dir}/${safeSlug(entry.slug)}.json`).json);
    const json = JSON.stringify(idx);
    files.set(`${c.dir}/index.json`, { json, count: idx.length });
    manifest.files[`${c.dir}/index.json`] = { sha256: sha(json), bytes: Buffer.byteLength(json), count: idx.length };
  }

  const totalBytes = [...files.values()].reduce((s, f) => s + Buffer.byteLength(f.json), 0);
  console.log(`\n${files.size} files, ${(totalBytes / 1024 / 1024).toFixed(2)} MB, ${requestCount} API requests, ${((Date.now() - started) / 1000).toFixed(1)}s`);

  if (DRY_RUN) {
    console.log('Dry run — nothing written.');
    return;
  }

  // Write to a fresh folder so deleted CMS items disappear from the export too.
  await rm(OUT_DIR, { recursive: true, force: true });
  for (const [rel, { json }] of files) {
    const p = path.join(OUT_DIR, rel);
    await mkdir(path.dirname(p), { recursive: true });
    await writeFile(p, json);
  }
  // Manifest last: if anything above failed, there's no new manifest pointing at half-written files.
  await writeFile(path.join(OUT_DIR, 'manifest.json'), JSON.stringify(manifest, null, 1));
  console.log(`Written to ${OUT_DIR}`);
}

function sha(s) {
  return createHash('sha256').update(s).digest('hex').slice(0, 16);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

main().catch((err) => {
  console.error('\nExport failed:', err.message);
  process.exit(1);
});
