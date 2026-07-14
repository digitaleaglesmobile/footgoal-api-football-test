// ============================================================
// get-wc2026-fixtures.js — footgoal.co
// ONE-OFF, READ-ONLY. Does NOT touch Webflow or Supabase.
// Pulls the full World Cup 2026 fixture list from API-Football
// (league id 1 = World Cup) and writes it to a CSV reference file
// so you can manually match each row to your existing 104
// hand-entered Team Matches CMS items and paste in the fixture ID.
//
// USAGE:
//   API_FOOTBALL_KEY=your_key node get-wc2026-fixtures.js
//
// OUTPUT:
//   wc2026-fixtures.csv in the same folder, columns:
//   fixture_id, date, round, home_team, away_team, venue
// ============================================================

const API_FOOTBALL_KEY = process.env.API_FOOTBALL_KEY;
const LEAGUE_ID = 1;     // World Cup
const SEASON = 2026;

async function main() {
  if (!API_FOOTBALL_KEY) {
    console.error('Missing API_FOOTBALL_KEY env var. Run like:\n  API_FOOTBALL_KEY=xxxx node get-wc2026-fixtures.js');
    process.exit(1);
  }

  console.log('Fetching World Cup 2026 fixtures (league=' + LEAGUE_ID + ', season=' + SEASON + ')...');
  const res = await fetch(
    'https://v3.football.api-sports.io/fixtures?league=' + LEAGUE_ID + '&season=' + SEASON,
    { headers: { 'x-apisports-key': API_FOOTBALL_KEY } }
  );
  if (!res.ok) {
    console.error('API-Football request failed: ' + res.status + ' ' + (await res.text()));
    process.exit(1);
  }
  const data = await res.json();
  const fixtures = data.response || [];

  if (fixtures.length === 0) {
    console.warn('No fixtures returned. Possible causes:');
    console.warn('  - Season 2026 draw/schedule not yet published on API-Football\'s side');
    console.warn('  - League ID for World Cup may differ from 1 on your plan - double check');
    console.warn('Raw API response for debugging:');
    console.log(JSON.stringify(data, null, 2).slice(0, 2000));
    return;
  }

  console.log('Found ' + fixtures.length + ' fixtures.');

  // Sort by date so the CSV reads in chronological/tournament order.
  fixtures.sort((a, b) => new Date(a.fixture.date) - new Date(b.fixture.date));

  const rows = [['fixture_id', 'date', 'round', 'home_team', 'away_team', 'venue']];
  for (const f of fixtures) {
    rows.push([
      f.fixture.id,
      f.fixture.date,
      (f.league.round || '').replace(/,/g, ' '),
      f.teams.home.name.replace(/,/g, ' '),
      f.teams.away.name.replace(/,/g, ' '),
      (f.fixture.venue && f.fixture.venue.name ? f.fixture.venue.name : '').replace(/,/g, ' '),
    ]);
  }

  const csv = rows.map(r => r.join(',')).join('\n');
  const fs = require('fs');
  fs.writeFileSync('wc2026-fixtures.csv', csv);
  console.log('Wrote wc2026-fixtures.csv with ' + fixtures.length + ' rows.');
  console.log('Open it in Excel/Sheets, sort/filter by team name or date, and match each row');
  console.log('to your existing Team Matches CMS items to fill in the API Fixture ID field.');
}

main().catch(err => { console.error('Fatal error: ' + err.message); process.exit(1); });
