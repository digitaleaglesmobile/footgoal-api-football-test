// test-api-football.js
// READ-ONLY test: pulls data from API-Football, writes to af_* Supabase tables.
// Does NOT touch Webflow. Safe to run anytime.

const API_KEY = process.env.API_FOOTBALL_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

// Small test: Premier League, season 2026 (now available on Pro plan)
const LEAGUES = [
  { code: 'PL', name: 'Premier League', id: 39, season: 2026 },
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

  // 1. Check coverage first — tells us what's actually available for this season
  const info = await apiFetch(`/leagues?id=${league.id}&season=${league.season}`);
  const seasonInfo = info.response?.[0]?.seasons?.find(s => s.year === league.season);
  if (!seasonInfo) {
    console.warn(`  ⚠️ Season ${league.season} not found for ${league.name}.`);
    return;
  }
  console.log(`  📋 Coverage:`, JSON.stringify(seasonInfo.coverage, null, 2));

  // 2. Teams
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
  console.log(`  📋 Sample team:`, JSON.stringify(teamRows[0], null, 2));
  await supabaseUpsert('af_teams', teamRows, 'api_id');

  // 3. Standings
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
  console.log(`  📋 Sample standing (rank 1):`, JSON.stringify(standingRows[0], null, 2));
  await supabaseUpsert('af_standings', standingRows, 'league_code,season,team_id');

  // 4. Predictions test — grab one finished fixture, check prediction quality
  const fixturesData = await apiFetch(`/fixtures?league=${league.id}&season=${league.season}&status=FT&last=1`);
  const fixture = fixturesData.response?.[0];
  if (fixture) {
    const predData = await apiFetch(`/predictions?fixture=${fixture.fixture.id}`);
    console.log(`  🔮 Sample prediction:`, JSON.stringify(predData.response?.[0]?.predictions, null, 2));
  }

  console.log(`  🎉 ${league.name}: ${teamRows.length} teams, ${standingRows.length} standings rows`);
}

async function main() {
  console.log('🧪 API-Football small test run starting...');
  for (const league of LEAGUES) {
    try {
      await testLeague(league);
      await new Promise(r => setTimeout(r, 1000));
    } catch (err) {
      console.error(`❌ ${league.name} failed:`, err.message);
    }
  }
  console.log('\n✅ Test run complete. Check af_teams / af_standings in Supabase.');
}

main();
