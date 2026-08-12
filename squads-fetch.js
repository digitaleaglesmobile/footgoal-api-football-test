// ============================================================
// squads-fetch.js — footgoal.co Predicted XI
// Fetches the FULL current squad for all 20 Premier League teams from
// API-Football and saves the results to a single local JSON file.
// Does NOT touch Supabase — safe to run anytime, paused DB or not.
// Run squads-import.js afterward (whenever Supabase is resumed) to
// load this saved file into the players table.
//
// Usage:
//   API_FOOTBALL_KEY=your_key node squads-fetch.js
// ============================================================

const fs = require('fs');

const API_FOOTBALL_KEY = process.env.API_FOOTBALL_KEY;
const DELAY_MS = 300;
const TEAM_CONCURRENCY = 3;

const TEAMS = [
  { name: 'Arsenal FC', api_team_id: '42' },
  { name: 'Aston Villa FC', api_team_id: '66' },
  { name: 'AFC Bournemouth', api_team_id: '35' },
  { name: 'Brentford FC', api_team_id: '55' },
  { name: 'Brighton & Hove Albion FC', api_team_id: '51' },
  { name: 'Chelsea FC', api_team_id: '49' },
  { name: 'Coventry City FC', api_team_id: '1346' },
  { name: 'Crystal Palace FC', api_team_id: '52' },
  { name: 'Everton FC', api_team_id: '45' },
  { name: 'Fulham FC', api_team_id: '36' },
  { name: 'Hull City AFC', api_team_id: '64' },
  { name: 'Ipswich Town FC', api_team_id: '57' },
  { name: 'Leeds United FC', api_team_id: '63' },
  { name: 'Liverpool FC', api_team_id: '40' },
  { name: 'Manchester City FC', api_team_id: '50' },
  { name: 'Manchester United FC', api_team_id: '33' },
  { name: 'Newcastle United FC', api_team_id: '34' },
  { name: 'Nottingham Forest FC', api_team_id: '65' },
  { name: 'Sunderland AFC', api_team_id: '746' },
  { name: 'Tottenham Hotspur FC', api_team_id: '47' },
];

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function pMap(items, mapper, concurrency) {
  const results = new Array(items.length);
  let index = 0;
  async function worker() {
    while (index < items.length) {
      const current = index++;
      results[current] = await mapper(items[current], current);
    }
  }
  const workers = [];
  for (let i = 0; i < Math.min(concurrency, items.length); i++) workers.push(worker());
  await Promise.all(workers);
  return results;
}

async function apiFetch(path) {
  await sleep(DELAY_MS);
  const res = await fetch('https://v3.football.api-sports.io' + path, {
    headers: { 'x-apisports-key': API_FOOTBALL_KEY },
  });
  if (res.status === 429) {
    console.warn('API-Football rate limited - waiting 60s');
    await sleep(60000);
    return apiFetch(path);
  }
  if (!res.ok) {
    const txt = await res.text();
    throw new Error('API-Football ' + res.status + ': ' + txt);
  }
  const data = await res.json();
  if (data.errors && Object.keys(data.errors).length > 0) {
    console.warn('API errors:', data.errors);
  }
  return data;
}

async function main() {
  if (!API_FOOTBALL_KEY) {
    console.error('Missing API_FOOTBALL_KEY env var');
    process.exit(1);
  }

  console.log('squads-fetch.js starting - ' + TEAMS.length + ' teams');
  const output = {};

  await pMap(TEAMS, async (team) => {
    try {
      console.log('Fetching: ' + team.name + ' (' + team.api_team_id + ')');
      const data = await apiFetch('/players/squads?team=' + team.api_team_id);
      const teamBlock = data.response && data.response[0];
      const playerCount = teamBlock && teamBlock.players ? teamBlock.players.length : 0;
      console.log(team.name + ': ' + playerCount + ' players');
      output[team.api_team_id] = { team_name: team.name, raw_response: data };
    } catch (err) {
      console.error(team.name + ' failed: ' + err.message);
      output[team.api_team_id] = { team_name: team.name, error: err.message };
    }
  }, TEAM_CONCURRENCY);

  const outPath = 'squads-all-teams.json';
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
  console.log('Saved all squads to ' + outPath);
  console.log('Next step: resume Supabase when ready, then run squads-import.js against this file.');
}

main().catch((err) => {
  console.error('Fatal error: ' + err.message);
  process.exit(1);
});
