// ============================================================
// league-sync-v2.js — footgoal.co
// Syncs 8 football leagues from API-Football (v3.football.api-sports.io)
// to Supabase + Webflow CMS
// DRY_RUN mode: set to true to preview changes without writing to Webflow
// ============================================================

const DRY_RUN = true; // ⚠️ Keep this true until we've verified slug matching!

// ── ENV ──────────────────────────────────────────────────────
const SUPABASE_URL  = process.env.SUPABASE_URL;
const SUPABASE_KEY  = process.env.SUPABASE_KEY;
const WEBFLOW_TOKEN = process.env.WEBFLOW_TOKEN;
const API_FOOTBALL_KEY = process.env.API_FOOTBALL_KEY;

// ── WEBFLOW COLLECTION IDs (unchanged) ─────────────────────────
const WF = {
  LEAGUES:     '6a32a8954e8d7db479514a79',
  TEAMS:       '6a20064807685f373db26660',
  STANDINGS:   '6a200649847c9fcb9278de02',
  MATCHES:     '6a200649c668e2cb8f11e82b',
  TOP_SCORERS: '6a32a89633c9bd6bea624094',
};

// ── LEAGUE CONFIG — API-Football IDs, season 2026 ─────────────
const LEAGUES = [
  { code: 'PL',  name: 'Premier League',        api_id: 39,  webflow_id: '6a32a9cb63396a5393212f3a', season: 2026 },
  { code: 'PD',  name: 'La Liga',                api_id: 140, webflow_id: '6a32a9cb63396a5393212f3e', season: 2026 },
  { code: 'BL1', name: 'Bundesliga',             api_id: 78,  webflow_id: '6a32a9cb63396a5393212f40', season: 2026 },
  { code: 'SA',  name: 'Serie A',                api_id: 135, webflow_id: '6a32a9cb63396a5393212f42', season: 2026 },
  { code: 'DED', name: 'Eredivisie',             api_id: 88,  webflow_id: '6a32a9cb63396a5393212f44', season: 2026 },
  { code: 'FL1', name: 'Ligue 1',                api_id: 61,  webflow_id: '6a32a9cb63396a5393212f46', season: 2026 },
  { code: 'BSA', name: 'Brasileiro Série A',     api_id: 71,  webflow_id: '6a32a9cb63396a5393212f48', season: 2026 },
  { code: 'CL',  name: 'UEFA Champions League',  api_id: 2,   webflow_id: '6a32a9cb63396a5393212f3c', season: 2026 },
];

const DELAY_MS = 1000;

// ── HELPERS ───────────────────────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function slugify(str) {
  return str.toLowerCase()
    .replace(/[áàäâ]/g, 'a').replace(/[éèëê]/g, 'e')
    .replace(/[íìïî]/g, 'i').replace(/[óòöô]/g, 'o')
    .replace(/[úùüû]/g, 'u').replace(/ñ/g, 'n')
    .replace(/ç/g, 'c').replace(/[^a-z0-9\s-]/g, '')
    .trim().replace(/\s+/g, '-').replace(/-+/g, '-');
}

// Strips common club-entity suffixes so "Arsenal FC" and "Arsenal" normalize closer together
function normalizeTeamName(name) {
  return name
    .toLowerCase()
    .replace(/\b(fc|afc|cf|sc|ac|rc|sv|vfl|vfb|tsg|ssc|us|as|ss)\b\.?/gi, '')
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Finds the best Webflow match for an API team name:
// 1. Try exact normalized match first (handles "Arsenal FC" ↔ "Arsenal")
// 2. Fall back to prefix match (handles "Newcastle" ↔ "Newcastle United FC")
//    Only accepts the prefix match if exactly ONE candidate qualifies, to avoid false positives.
function findTeamMatch(apiTeamName, webflowTeamsByNormalizedName) {
  const normalized = normalizeTeamName(apiTeamName);

  // 1. Exact match
  if (webflowTeamsByNormalizedName.has(normalized)) {
    return { item: webflowTeamsByNormalizedName.get(normalized), method: 'exact' };
  }

  // 2. Prefix match — API name is the start of a longer Webflow name (e.g. "leeds" → "leeds united")
  const candidates = [];
  for (const [wfNormalized, item] of webflowTeamsByNormalizedName.entries()) {
    if (wfNormalized.startsWith(normalized + ' ') || normalized.startsWith(wfNormalized + ' ')) {
      candidates.push(item);
    }
  }
  if (candidates.length === 1) {
    return { item: candidates[0], method: 'prefix' };
  }

  return null;
}

function getFormString(form) {
  if (!form) return '';
  return form.slice(-5);
}

// ── API-FOOTBALL ──────────────────────────────────────────────
async function apiFetch(path) {
  await sleep(DELAY_MS);
  const res = await fetch(`https://v3.football.api-sports.io${path}`, {
    headers: { 'x-apisports-key': API_FOOTBALL_KEY }
  });
  if (res.status === 429) {
    console.warn('⏳ Rate limited — waiting 60s...');
    await sleep(60000);
    return apiFetch(path);
  }
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`API-Football ${res.status}: ${txt}`);
  }
  const data = await res.json();
  if (data.errors && Object.keys(data.errors).length > 0) {
    console.warn(`  ⚠️ API errors:`, data.errors);
  }
  return data;
}

// ── SUPABASE (reusing existing af_teams / af_standings tables) ─
async function supabaseUpsert(table, data) {
  if (!data || (Array.isArray(data) && data.length === 0)) return;
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: 'POST',
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': 'resolution=merge-duplicates,return=minimal'
    },
    body: JSON.stringify(data)
  });
  if (!res.ok) {
    console.error(`  ❌ Supabase ${table}: ${await res.text()}`);
  } else {
    const count = Array.isArray(data) ? data.length : 1;
    console.log(`  ✅ Supabase: upserted ${count} rows to ${table}`);
  }
}

// ── WEBFLOW API ──────────────────────────────────────────────
async function wfGetAllItems(collectionId) {
  let items = [];
  let offset = 0;
  const limit = 100;
  while (true) {
    const res = await fetch(
      `https://api.webflow.com/v2/collections/${collectionId}/items?limit=${limit}&offset=${offset}`,
      { headers: { 'Authorization': `Bearer ${WEBFLOW_TOKEN}`, 'accept': 'application/json' } }
    );
    if (!res.ok) throw new Error(`Webflow GET items: ${res.status}`);
    const data = await res.json();
    items = items.concat(data.items || []);
    if (items.length >= (data.pagination?.total || 0)) break;
    offset += limit;
  }
  return items;
}

async function wfCreateItem(collectionId, fieldData) {
  if (DRY_RUN) {
    console.log(`  🔍 [DRY RUN] Would CREATE in ${collectionId}:`, fieldData.name || fieldData.slug);
    return { id: `dry-run-${slugify(fieldData.name || 'item')}` };
  }
  const res = await fetch(`https://api.webflow.com/v2/collections/${collectionId}/items`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${WEBFLOW_TOKEN}`, 'Content-Type': 'application/json', 'accept': 'application/json' },
    body: JSON.stringify({ fieldData, isDraft: true })
  });
  if (res.status === 429) { await sleep(60000); return wfCreateItem(collectionId, fieldData); }
  if (!res.ok) throw new Error(`Webflow CREATE: ${await res.text()}`);
  return res.json();
}

async function wfUpdateItem(collectionId, itemId, fieldData) {
  if (DRY_RUN) {
    console.log(`  🔍 [DRY RUN] Would UPDATE ${itemId} in ${collectionId}:`, JSON.stringify(fieldData).slice(0, 150));
    return { id: itemId };
  }
  const res = await fetch(`https://api.webflow.com/v2/collections/${collectionId}/items/${itemId}`, {
    method: 'PATCH',
    headers: { 'Authorization': `Bearer ${WEBFLOW_TOKEN}`, 'Content-Type': 'application/json', 'accept': 'application/json' },
    body: JSON.stringify({ fieldData })
  });
  if (res.status === 429) { await sleep(60000); return wfUpdateItem(collectionId, itemId, fieldData); }
  if (!res.ok) throw new Error(`Webflow PATCH: ${await res.text()}`);
  return res.json();
}

async function wfPublishItems(collectionId, itemIds) {
  if (DRY_RUN) {
    console.log(`  🔍 [DRY RUN] Would PUBLISH ${itemIds.length} items in ${collectionId}`);
    return;
  }
  if (!itemIds || itemIds.length === 0) return;
  for (let i = 0; i < itemIds.length; i += 100) {
    const batch = itemIds.slice(i, i + 100);
    const res = await fetch(`https://api.webflow.com/v2/collections/${collectionId}/items/publish`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${WEBFLOW_TOKEN}`, 'Content-Type': 'application/json', 'accept': 'application/json' },
      body: JSON.stringify({ itemIds: batch })
    });
    if (!res.ok) console.warn(`  ⚠️ Publish warning: ${await res.text()}`);
  }
}

// ── SYNC TEAMS ────────────────────────────────────────────────
async function syncTeams(league) {
  console.log(`\n  👕 Syncing teams for ${league.name}...`);

  const teamsData = await apiFetch(`/teams?league=${league.api_id}&season=${league.season}`);
  const apiTeams = teamsData.response || [];

  const existing = await wfGetAllItems(WF.TEAMS);
  const byNormalizedName = new Map();
  for (const item of existing) {
    const n = item.fieldData?.name;
    if (n) byNormalizedName.set(normalizeTeamName(n), item);
  }

  let matched = 0, matchedByPrefix = 0, unmatched = 0;
  const updatedIds = [];
  const supaRows = [];

  for (const t of apiTeams) {
    const teamName = t.team.name;
    const slug = slugify(teamName);

    const fieldData = {
      name: teamName,
      slug,
      'short-name': t.team.code || teamName.substring(0, 3).toUpperCase(),
      league: league.webflow_id,
      city: t.venue?.city || '',
      founded: t.team.founded || null,
      stadium: t.venue?.name || '',
    };
    if (t.team.logo) fieldData['badge'] = { url: t.team.logo };

    supaRows.push({
      api_id: t.team.id,
      competition_code: league.code,
      name: teamName,
      short_name: t.team.code,
      slug,
      crest: t.team.logo,
      venue: t.venue?.name,
      founded: t.team.founded,
      updated_at: new Date().toISOString()
    });

    const match = findTeamMatch(teamName, byNormalizedName);
    if (match) {
      matched++;
      if (match.method === 'prefix') {
        matchedByPrefix++;
        console.log(`    🔗 Prefix match: "${teamName}" → "${match.item.fieldData.name}"`);
      }
      // Keep the existing Webflow name/slug — only refresh stats/badge/stadium
      const updateData = { ...fieldData, name: match.item.fieldData.name, slug: match.item.fieldData.slug };
      await wfUpdateItem(WF.TEAMS, match.item.id, updateData);
      updatedIds.push(match.item.id);
    } else {
      unmatched++;
      console.warn(`    ⚠️ NO MATCH for "${teamName}" — would CREATE new item`);
      const created = await wfCreateItem(WF.TEAMS, fieldData);
      updatedIds.push(created.id);
    }
  }

  await supabaseUpsert('af_teams', supaRows);
  console.log(`  📊 ${league.name}: ${matched} matched (${matchedByPrefix} via prefix), ${unmatched} unmatched (would create new)`);
  return updatedIds;
}

// ── SYNC STANDINGS ────────────────────────────────────────────
async function syncStandings(league) {
  console.log(`\n  📊 Syncing standings for ${league.name}...`);

  const standingsData = await apiFetch(`/standings?league=${league.api_id}&season=${league.season}`);
  const table = standingsData.response?.[0]?.league?.standings?.[0] || [];
  if (table.length === 0) {
    console.log(`  ⚠️ No standings yet for ${league.name} (season not started)`);
    return [];
  }

  const wfTeams = await wfGetAllItems(WF.TEAMS);
  const teamByNormalizedName = new Map();
  for (const t of wfTeams) {
    if (t.fieldData?.name) teamByNormalizedName.set(normalizeTeamName(t.fieldData.name), t);
  }

  const wfStandings = await wfGetAllItems(WF.STANDINGS);
  const standingIndex = new Map();
  for (const s of wfStandings) {
    const teamRef = s.fieldData?.team;
    const leagueRef = s.fieldData?.league;
    if (teamRef && leagueRef === league.webflow_id) standingIndex.set(teamRef, s);
  }

  const updatedIds = [];
  const supaRows = [];

  for (const entry of table) {
    const teamName = entry.team.name;
    const form = getFormString(entry.form);

    const match = findTeamMatch(teamName, teamByNormalizedName);
    if (!match) {
      console.warn(`    ⚠️ No Webflow team found for: ${teamName}`);
      continue;
    }
    const wfTeam = match.item;

    supaRows.push({
      competition_code: league.code,
      team_id: entry.team.id,
      team_name: teamName,
      position: entry.rank,
      played: entry.all.played,
      won: entry.all.win,
      drawn: entry.all.draw,
      lost: entry.all.lose,
      goals_for: entry.all.goals.for,
      goals_against: entry.all.goals.against,
      points: entry.points,
      form,
      updated_at: new Date().toISOString()
    });

    const fieldData = {
      name: wfTeam.fieldData.name,
      slug: `${normalizeTeamName(wfTeam.fieldData.name).replace(/\s+/g, '-')}-${league.code.toLowerCase()}-standing`,
      team: wfTeam.id,
      league: league.webflow_id,
      position: entry.rank,
      played: entry.all.played,
      won: entry.all.win,
      drawn: entry.all.draw,
      lost: entry.all.lose,
      'goals-for': entry.all.goals.for,
      'goals-against': entry.all.goals.against,
      'goal-difference': entry.goalsDiff,
      points: entry.points,
      form,
    };

    const existingStanding = standingIndex.get(wfTeam.id);
    if (existingStanding) {
      await wfUpdateItem(WF.STANDINGS, existingStanding.id, fieldData);
      updatedIds.push(existingStanding.id);
    } else {
      const created = await wfCreateItem(WF.STANDINGS, fieldData);
      updatedIds.push(created.id);
    }
  }

  await supabaseUpsert('af_standings', supaRows);
  await wfPublishItems(WF.STANDINGS, updatedIds);
  console.log(`  ✅ Standings done: ${updatedIds.length} items`);
  return updatedIds;
}

// ── MAIN ──────────────────────────────────────────────────────
async function main() {
  console.log(`🔄 league-sync-v2.js starting... ${DRY_RUN ? '(DRY RUN — no Webflow writes)' : '⚠️ LIVE MODE'}`);
  console.log(`⏰ ${new Date().toISOString()}`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  for (const league of LEAGUES) {
    console.log(`\n🏟️  Processing: ${league.name} (${league.code})`);
    try {
      await syncTeams(league);
      await syncStandings(league);
      console.log(`  🎉 ${league.name} complete`);
    } catch (err) {
      console.error(`  ❌ ${league.name} failed: ${err.message}`);
    }
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  }

  console.log('\n🎉 league-sync-v2.js complete!');
  if (DRY_RUN) console.log('👉 This was a DRY RUN. Review the matched/unmatched counts above before setting DRY_RUN = false.');
}

main().catch(err => {
  console.error('❌ Fatal error:', err);
  process.exit(1);
});
