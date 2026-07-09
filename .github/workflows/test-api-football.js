// test-api-football.js
// READ-ONLY test: pulls data from API-Football, writes to af_* Supabase tables.
// Does NOT touch Webflow. Safe to run anytime.

const API_KEY = process.env.API_FOOTBALL_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

// League IDs on API-Football (different from football-data.org codes!)
const LEAGUES = [
  { code: 'PL',  name: 'Premier League',  id: 39,  season: 2026 },
  { code: 'PD',  name: 'La Liga',         id: 140, season: 2026 },
  { code: 'BL1', name: 'Bundesliga',      id: 78,  season: 2026 },
  { code: 'SA',  name: 'Serie A',         id: 135, season: 2026 },
  { code: 'DED', name: 'Eredivisie',      id: 88,  season: 2026 },
  { code: 'FL1', name: 'Ligue 1',         id: 61,  season: 2026 },
  { code: 'BSA', name: 'Brasileirão',     id: 71,  season: 2026 },
  { code: 'CL',  name: 'Champions League',id: 2,   season: 2026 },
];

async function apiFetch(path) {
  const res = await fetch(`https://v3.football.api-sports.io${path}`, {
    headers: { 'x-apisports-key': API_KEY }
  });
  const data = await res.json();
  console.log(`  📡 ${path} → ${res.status} | results: ${data.results ?? 'n/a'}`);
  if (data.errors && Object.keys(data.errors).length > 0) {
    console.warn(`  ⚠️ API errors:`, data.errors);
  }
  return data;
}

async function supabaseUpsert(table, rows, conflictCols) {
  if (!rows || rows.length === 0) return;
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?on_conflict=${conflictCols}`, {
    method: 'POST',
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': 'resolution=merge-duplicates,return=minimal'
    },
    body: JSON.stringify(rows)
  });
  if (!res.ok) {
    console.error(`  ❌ Supabase ${table}: ${await res.text()}`);
  } else {
    console.log(`  ✅ Supabase: wrote ${rows.length} rows to ${table}`);
  }
}

async function testLeague(league) {
  console.log(`\n🏟️  Testing: ${league.name} (season ${league.season})`);

  // 1. Check coverage first — tells us if this season is actually populated
  const info = await apiFetch(`/leagues?id=${league.id}&season=${league.season}`);
  const seasonInfo = info.response?.[0]?.seasons?.find(s => s.year === league.season);
  if (!seasonInfo) {
    console.warn(`  ⚠️ Season ${league.season} not found for ${league.name} yet.`);
    return;
  }
  console.log(`  📋 Coverage:`, JSON.stringify(seasonInfo.coverage, null, 2));

  // 2. Teams
  const
