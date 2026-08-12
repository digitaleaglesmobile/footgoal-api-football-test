// ============================================================
// squads-fetch-all-leagues.js — footgoal.co Predicted XI
// Fetches the FULL current squad (every player, not just starters) for
// all 134 teams across the 7 active leagues from API-Football and saves
// everything to one local JSON file: squads-all-leagues.json
//
// Same approach as squads-fetch.js (Premier League only) — this is just
// the same script widened to cover every league at once. No Supabase,
// no database — matches the "just download it" decision.
//
// Usage (run via GitHub Actions, same as before):
//   API_FOOTBALL_KEY=your_key node squads-fetch-all-leagues.js
// ============================================================

const fs = require('fs');

const API_FOOTBALL_KEY = process.env.API_FOOTBALL_KEY;
const DELAY_MS = 300;
const TEAM_CONCURRENCY = 3;

// Real team IDs pulled from the Webflow Teams collection (api-team-id
// field, written by league-sync-v2) — same 7 active leagues that script
// already covers. Champions League intentionally excluded (real 36-team
// field not set until the Aug 27, 2026 draw).
const LEAGUES = {
  'Premier League': [
    { name: 'Leeds United FC', api_team_id: '63' },
    { name: 'Coventry City FC', api_team_id: '1346' },
    { name: 'Sunderland AFC', api_team_id: '746' },
    { name: 'AFC Bournemouth', api_team_id: '35' },
    { name: 'Brentford FC', api_team_id: '55' },
    { name: 'Brighton & Hove Albion FC', api_team_id: '51' },
    { name: 'Crystal Palace FC', api_team_id: '52' },
    { name: 'Nottingham Forest FC', api_team_id: '65' },
    { name: 'Ipswich Town FC', api_team_id: '57' },
    { name: 'Hull City AFC', api_team_id: '64' },
    { name: 'Tottenham Hotspur FC', api_team_id: '47' },
    { name: 'Newcastle United FC', api_team_id: '34' },
    { name: 'Manchester United FC', api_team_id: '33' },
    { name: 'Manchester City FC', api_team_id: '50' },
    { name: 'Liverpool FC', api_team_id: '40' },
    { name: 'Fulham FC', api_team_id: '36' },
    { name: 'Everton FC', api_team_id: '45' },
    { name: 'Chelsea FC', api_team_id: '49' },
    { name: 'Aston Villa FC', api_team_id: '66' },
    { name: 'Arsenal FC', api_team_id: '42' },
  ],
  'La Liga': [
    { name: 'Elche CF', api_team_id: '797' },
    { name: 'Levante UD', api_team_id: '539' },
    { name: 'Real Racing Club de Santander', api_team_id: '4665' },
    { name: 'Sevilla FC', api_team_id: '536' },
    { name: 'RC Celta de Vigo', api_team_id: '538' },
    { name: 'RC Deportivo de A Coruña', api_team_id: '544' },
    { name: 'Deportivo Alavés', api_team_id: '542' },
    { name: 'Málaga CF', api_team_id: '535' },
    { name: 'Valencia CF', api_team_id: '532' },
    { name: 'Villarreal CF', api_team_id: '533' },
    { name: 'Real Sociedad de Fútbol', api_team_id: '548' },
    { name: 'Real Betis Balompié', api_team_id: '543' },
    { name: 'Rayo Vallecano de Madrid', api_team_id: '728' },
    { name: 'Getafe CF', api_team_id: '546' },
    { name: 'RCD Espanyol de Barcelona', api_team_id: '540' },
    { name: 'CA Osasuna', api_team_id: '727' },
    { name: 'Athletic Club', api_team_id: '531' },
    { name: 'Real Madrid CF', api_team_id: '541' },
    { name: 'FC Barcelona', api_team_id: '529' },
    { name: 'Club Atlético de Madrid', api_team_id: '530' },
  ],
  'Serie A': [
    { name: 'Frosinone', api_team_id: '512' },
    { name: 'US Sassuolo Calcio', api_team_id: '488' },
    { name: 'Como 1907', api_team_id: '895' },
    { name: 'AC Monza', api_team_id: '1579' },
    { name: 'US Lecce', api_team_id: '867' },
    { name: 'Torino FC', api_team_id: '503' },
    { name: 'Venezia FC', api_team_id: '517' },
    { name: 'Udinese Calcio', api_team_id: '494' },
    { name: 'SSC Napoli', api_team_id: '492' },
    { name: 'Parma Calcio 1913', api_team_id: '523' },
    { name: 'SS Lazio', api_team_id: '487' },
    { name: 'Genoa CFC', api_team_id: '495' },
    { name: 'Cagliari Calcio', api_team_id: '490' },
    { name: 'AS Roma', api_team_id: '497' },
    { name: 'ACF Fiorentina', api_team_id: '502' },
    { name: 'Juventus FC', api_team_id: '496' },
    { name: 'FC Internazionale Milano', api_team_id: '505' },
    { name: 'Bologna FC 1909', api_team_id: '500' },
    { name: 'Atalanta BC', api_team_id: '499' },
    { name: 'AC Milan', api_team_id: '489' },
  ],
  'Bundesliga': [
    { name: 'Hamburger SV', api_team_id: '175' },
    { name: '1. FC Köln', api_team_id: '192' },
    { name: 'FC Schalke 04', api_team_id: '174' },
    { name: '1. FC Union Berlin', api_team_id: '182' },
    { name: 'SC Paderborn 07', api_team_id: '185' },
    { name: 'Eintracht Frankfurt', api_team_id: '169' },
    { name: 'Borussia Mönchengladbach', api_team_id: '163' },
    { name: 'SC Freiburg', api_team_id: '160' },
    { name: 'FC Augsburg', api_team_id: '170' },
    { name: '1. FSV Mainz 05', api_team_id: '164' },
    { name: 'SV Werder Bremen', api_team_id: '162' },
    { name: 'SV Elversberg', api_team_id: '1660' },
    { name: 'TSG 1899 Hoffenheim', api_team_id: '167' },
    { name: 'RB Leipzig', api_team_id: '173' },
    { name: 'VfB Stuttgart', api_team_id: '172' },
    { name: 'FC Bayern München', api_team_id: '157' },
    { name: 'Borussia Dortmund', api_team_id: '165' },
    { name: 'Bayer 04 Leverkusen', api_team_id: '168' },
  ],
  'Eredivisie': [
    { name: 'ADO Den Haag', api_team_id: '198' },
    { name: 'SC Cambuur', api_team_id: '420' },
    { name: 'Telstar 1963', api_team_id: '427' },
    { name: 'SBV Excelsior', api_team_id: '196' },
    { name: 'Sparta Rotterdam', api_team_id: '426' },
    { name: 'Fortuna Sittard', api_team_id: '205' },
    { name: 'NEC', api_team_id: '413' },
    { name: 'Go Ahead Eagles', api_team_id: '410' },
    { name: 'PEC Zwolle', api_team_id: '193' },
    { name: 'AZ', api_team_id: '201' },
    { name: 'AFC Ajax', api_team_id: '194' },
    { name: 'FC Groningen', api_team_id: '202' },
    { name: 'FC Utrecht', api_team_id: '207' },
    { name: 'SC Heerenveen', api_team_id: '210' },
    { name: 'Willem II Tilburg', api_team_id: '195' },
    { name: 'FC Twente \'65', api_team_id: '415' },
    { name: 'Feyenoord Rotterdam', api_team_id: '209' },
    { name: 'PSV', api_team_id: '197' },
  ],
  'Ligue 1': [
    { name: 'Le Mans FC', api_team_id: '1298' },
    { name: 'ES Troyes AC', api_team_id: '110' },
    { name: 'Paris FC', api_team_id: '114' },
    { name: 'FC Lorient', api_team_id: '97' },
    { name: 'RC Strasbourg Alsace', api_team_id: '95' },
    { name: 'Racing Club de Lens', api_team_id: '116' },
    { name: 'Le Havre AC', api_team_id: '111' },
    { name: 'Angers SCO', api_team_id: '77' },
    { name: 'Stade Rennais FC 1901', api_team_id: '94' },
    { name: 'Olympique Lyonnais', api_team_id: '80' },
    { name: 'OGC Nice', api_team_id: '84' },
    { name: 'AJ Auxerre', api_team_id: '108' },
    { name: 'Olympique de Marseille', api_team_id: '81' },
    { name: 'Toulouse FC', api_team_id: '96' },
    { name: 'AS Monaco FC', api_team_id: '91' },
    { name: 'Paris Saint-Germain FC', api_team_id: '85' },
    { name: 'Lille OSC', api_team_id: '79' },
    { name: 'Stade Brestois 29', api_team_id: '106' },
  ],
  'Brasileiro Serie A': [
    { name: 'Clube do Remo', api_team_id: '1198' },
    { name: 'Coritiba FBC', api_team_id: '147' },
    { name: 'Chapecoense AF', api_team_id: '132' },
    { name: 'CA Paranaense', api_team_id: '134' },
    { name: 'Santos FC', api_team_id: '128' },
    { name: 'SC Internacional', api_team_id: '119' },
    { name: 'Mirassol FC', api_team_id: '7848' },
    { name: 'RB Bragantino', api_team_id: '794' },
    { name: 'CR Flamengo', api_team_id: '127' },
    { name: 'EC Vitória', api_team_id: '136' },
    { name: 'CR Vasco da Gama', api_team_id: '133' },
    { name: 'SC Corinthians Paulista', api_team_id: '131' },
    { name: 'EC Bahia', api_team_id: '118' },
    { name: 'São Paulo FC', api_team_id: '126' },
    { name: 'Cruzeiro EC', api_team_id: '135' },
    { name: 'Botafogo FR', api_team_id: '120' },
    { name: 'SE Palmeiras', api_team_id: '121' },
    { name: 'Grêmio FBPA', api_team_id: '130' },
    { name: 'CA Mineiro', api_team_id: '1062' },
    { name: 'Fluminense FC', api_team_id: '124' },
  ],
};

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

  const output = {};
  let totalTeams = 0;
  for (const league of Object.keys(LEAGUES)) totalTeams += LEAGUES[league].length;
  console.log('squads-fetch-all-leagues.js starting - ' + totalTeams + ' teams across ' + Object.keys(LEAGUES).length + ' leagues');

  for (const leagueName of Object.keys(LEAGUES)) {
    console.log('--- ' + leagueName + ' ---');
    const teams = LEAGUES[leagueName];
    const leagueOutput = {};
    await pMap(teams, async (team) => {
      try {
        console.log('Fetching: ' + team.name + ' (' + team.api_team_id + ')');
        const data = await apiFetch('/players/squads?team=' + team.api_team_id);
        const teamBlock = data.response && data.response[0];
        const playerCount = teamBlock && teamBlock.players ? teamBlock.players.length : 0;
        console.log(team.name + ': ' + playerCount + ' players');
        leagueOutput[team.api_team_id] = { team_name: team.name, raw_response: data };
      } catch (err) {
        console.error(team.name + ' failed: ' + err.message);
        leagueOutput[team.api_team_id] = { team_name: team.name, error: err.message };
      }
    }, TEAM_CONCURRENCY);
    output[leagueName] = leagueOutput;
  }

  const outPath = 'squads-all-leagues.json';
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
  console.log('Saved all squads to ' + outPath);
}

main().catch((err) => {
  console.error('Fatal error: ' + err.message);
  process.exit(1);
});
