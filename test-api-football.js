// test-api-football.js
// READ-ONLY test: pulls 2026-27 season data for all 8 leagues, writes to af_* Supabase tables.
// Does NOT touch Webflow. Safe to run anytime.

const API_KEY = process.env.API_FOOTBALL_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

const LEAGUES = [
  { code: 'PL',  name: 'Premier League',       id: 39,  season: 2026 },
  { code: 'PD',  name: 'La Liga',               id: 140, season: 2026 },
  { code: 'BL1', name: 'Bundesliga',            id: 78,  season: 2026 },
  { code: 'SA',  name: 'Serie A',               id: 135, season: 2026 },
  { code: 'DED', name: 'Eredivisie',            id: 88,  season: 2026 },
  { code: 'FL1', name: 'Ligue 1',               id: 61,  season: 2026 },
  { code: 'BSA', name: 'Brasileirão',           id: 71,  season: 2026 },
  { code: 'CL',  name: 'Champions League',      id: 2,   season: 2026 },
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
  console.log(`\n🏟️  ${league.name} (season ${league.season})`);

  const info = await apiFetch(`/leagues?id=${league.id}&season=${league.season}`);
  const seasonInfo = info.response?.[0]?.seasons?.find(s => s.year === league.season);
  if (!seasonInfo) {
    console.warn(`  ⚠️ Season ${league.season} not found for ${league.name}.`);
    return;
  }

  const teamsData = await apiFetch(`/teams?league=${league.id}&season=${league.season}`);
  const teamRows = (teamsData.response || []).map(t => ({
    api_id: t.team.id,
    league_code: league.code,
    season: league.season,
    name: t.team.name,
    short_name: t.team.code,
    slug: t.team.name.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
    crest: t.team.logo,
    venue: t.venue?.name,
    founded: t.team.founded,
    updated_at: new Date().toISOString()
  }));
  await supabaseUpsert('af_teams', teamRows, 'api_id');

  const standingsData = await apiFetch(`/standings?league=${league.id}&season=${league.season}`);
  const table = standingsData.response?.[0]?.league?.standings?.[0] || [];
  const standingRows = table.map(s => ({
    league_code: league.code,
    season: league.season,
    team_id: s.team.id,
    team_name: s.team.name,
    position: s.rank,
    played: s.all.played,
    won: s.all.win,
    drawn: s.all.draw,
    lost: s.all.lose,
    goals_for: s.all.goals.for,
    goals_against: s.all.goals.against,
    points: s.points,
    updated_at: new Date().toISOString()
  }));
  await supabaseUpsert('af_standings', standingRows, 'league_code,season,team_id');

  console.log(`  🎉 ${league.name}: ${teamRows.length} teams, ${standingRows.length} standings rows`);
}

async function main() {
  console.log('🧪 API-Football full 8-league test run starting (season 2026-27)...\n');
  for (const league of LEAGUES) {
    try {
      await testLeague(league);
      await new Promise(r => setTimeout(r, 1000));
    } catch (err) {
      console.error(`❌ ${league.name} failed:`, err.message);
    }
  }
  console.log('\n✅ All 8 leagues tested. Check af_teams / af_standings in Supabase.');
}

main();
