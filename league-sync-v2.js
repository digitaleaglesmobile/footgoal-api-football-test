// ============================================================
// league-sync-v2.js — footgoal.co
// LIVE MODE — all 7 active leagues (Premier League, La Liga, Bundesliga,
// Serie A, Eredivisie, Ligue 1, Brasileirão). Brasileirão runs Jan–Dec
// (mid-season, real Round 19 data); European leagues are pre-season 2026-27.
// Champions League excluded until the Aug 27, 2026 draw.
// ============================================================

const DRY_RUN = false;

// ── ENV ──────────────────────────────────────────────────────
const SUPABASE_URL  = process.env.SUPABASE_URL;
const SUPABASE_KEY  = process.env.SUPABASE_KEY;
const WEBFLOW_TOKEN = process.env.WEBFLOW_TOKEN;
const API_FOOTBALL_KEY = process.env.API_FOOTBALL_KEY;

// ── WEBFLOW COLLECTION IDs ─────────────────────────
const WF = {
  LEAGUES:     '6a32a8954e8d7db479514a79',
  TEAMS:       '6a20064807685f373db26660',
  STANDINGS:   '6a200649847c9fcb9278de02',
  MATCHES:     '6a200649c668e2cb8f11e82b',
  TOP_SCORERS: '6a32a89633c9bd6bea624094',
};

// ── LEAGUE CONFIG — all 7 active leagues (Champions League excluded until Aug 27, 2026 draw) ────────────
const LEAGUES = [
  { code: 'PL',  name: 'Premier League',        api_id: 39,  webflow_id: '6a32a9cb63396a5393212f3a', season: 2026 },
  { code: 'LL',  name: 'La Liga',                api_id: 140, webflow_id: '6a32a9cb63396a5393212f3e', season: 2026 },
  { code: 'BL',  name: 'Bundesliga',             api_id: 78,  webflow_id: '6a32a9cb63396a5393212f40', season: 2026 },
  { code: 'SA',  name: 'Serie A',                api_id: 135, webflow_id: '6a32a9cb63396a5393212f42', season: 2026 },
  { code: 'ERE', name: 'Eredivisie',             api_id: 88,  webflow_id: '6a32a9cb63396a5393212f44', season: 2026 },
  { code: 'L1',  name: 'Ligue 1',                api_id: 61,  webflow_id: '6a32a9cb63396a5393212f46', season: 2026 },
  { code: 'BSA', name: 'Brasileiro Série A',     api_id: 71,  webflow_id: '6a32a9cb63396a5393212f48', season: 2026 },
  // Champions League intentionally excluded — real 36-team field not set until the Aug 27, 2026 draw.
  // { code: 'UCL', name: 'UEFA Champions League', api_id: 2, webflow_id: '6a32a9cb63396a5393212f3c', season: 2026 },
];

const DELAY_MS = 300;
const WEBFLOW_WRITE_DELAY_MS = 1000;
const TEAM_CONCURRENCY = 5;
const STANDINGS_CONCURRENCY = 5;
const MATCH_CONCURRENCY = 6;

// ── CONCURRENCY HELPER ─────────────────────────────────────────
// Runs `mapper` over `items` with at most `concurrency` in flight at once,
// instead of fully serial. Safe in JS since only one callback body runs
// at a time between awaits — no manual locking needed for shared counters.
async function pMap(items, mapper, concurrency) {
  var results = new Array(items.length);
  var index = 0;
  async function worker() {
    while (index < items.length) {
      var current = index++;
      results[current] = await mapper(items[current], current);
    }
  }
  var workers = [];
  for (var i = 0; i < Math.min(concurrency, items.length); i++) workers.push(worker());
  await Promise.all(workers);
  return results;
}

// ── MANUAL ALIASES ──────────────────────────────────────────────
const MANUAL_ALIASES = {
  'atletico paranaense': 'paranaense',
  'atletico mg': 'mineiro',
  'inter': 'internazionale milano',
  'lyon': 'olympique lyonnais',
  'rennes': 'stade rennais',
  'estac troyes': 'es troyes',
};

// ── HELPERS ───────────────────────────────────────────────────
function sleep(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }

function slugify(str) {
  return str.toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s-]/g, '')
    .trim().replace(/\s+/g, '-').replace(/-+/g, '-');
}

function normalizeTeamName(name) {
  var n = name
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[.\-']/g, ' ')
    .replace(/\b(fc|afc|cf|sc|ac|rc|rcd|cd|ud|sv|vfl|vfb|tsg|ssc|us|as|ss|fsv|tsv|spvgg|bsc|bv|vfr|fk|nk|sk|gnk|ca|club|de|del|la|le|el|los|las|a|do|da)\b/gi, '')
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (MANUAL_ALIASES[n]) return MANUAL_ALIASES[n];
  return n;
}

function getMatchTokens(normalized) {
  var all = normalized.split(' ').filter(function(x) { return x; });
  return new Set(all.filter(function(t) { return !/^\d+$/.test(t); }));
}

function findTeamMatch(apiTeamName, webflowTeamsByNormalizedName) {
  var normalized = normalizeTeamName(apiTeamName);
  if (webflowTeamsByNormalizedName.has(normalized)) {
    return { item: webflowTeamsByNormalizedName.get(normalized), method: 'exact' };
  }
  var apiTokens = getMatchTokens(normalized);
  if (apiTokens.size === 0) return null;
  var candidates = [];
  for (var entry of webflowTeamsByNormalizedName.entries()) {
    var wfNormalized = entry[0];
    var item = entry[1];
    var wfTokens = getMatchTokens(wfNormalized);
    if (wfTokens.size === 0) continue;
    var apiSubsetOfWf = [...apiTokens].every(function(t) { return wfTokens.has(t); });
    var wfSubsetOfApi = [...wfTokens].every(function(t) { return apiTokens.has(t); });
    if (apiSubsetOfWf || wfSubsetOfApi) candidates.push(item);
  }
  if (candidates.length === 1) {
    return { item: candidates[0], method: 'token-subset' };
  }
  return null;
}

function getFormString(form) {
  if (!form) return '';
  return form.slice(-5);
}

// Maps API-Football's country name strings to the 2-letter codes their own
// flag CDN expects (https://media.api-sports.io/flags/{code}.svg).
var COUNTRY_TO_FLAG_CODE = {
  'England': 'gb-eng', 'Spain': 'es', 'France': 'fr', 'Germany': 'de',
  'Italy': 'it', 'Netherlands': 'nl', 'Brazil': 'br', 'Portugal': 'pt',
  'Belgium': 'be', 'Scotland': 'gb-sct', 'Switzerland': 'ch', 'Austria': 'at',
  'Denmark': 'dk', 'Croatia': 'hr', 'Serbia': 'rs', 'Turkey': 'tr',
  'Czech-Republic': 'cz', 'Norway': 'no', 'Sweden': 'se', 'Poland': 'pl',
  'Greece': 'gr', 'Ukraine': 'ua', 'Kazakhstan': 'kz', 'Azerbaijan': 'az',
};
function countryToFlagCode(countryName) {
  return COUNTRY_TO_FLAG_CODE[countryName] || countryName.toLowerCase().replace(/\s+/g, '-');
}

function mapMatchStatus(shortStatus) {
  var finished = ['FT', 'AET', 'PEN'];
  var live = ['1H', '2H', 'HT', 'ET', 'BT', 'P', 'SUSP', 'INT', 'LIVE'];
  if (finished.indexOf(shortStatus) !== -1) return 'Played';
  if (live.indexOf(shortStatus) !== -1) return 'Live';
  return 'Upcoming';
}

// ── API-FOOTBALL ──────────────────────────────────────────────
async function apiFetch(path) {
  await sleep(DELAY_MS);
  var res = await fetch('https://v3.football.api-sports.io' + path, {
    headers: { 'x-apisports-key': API_FOOTBALL_KEY }
  });
  if (res.status === 429) {
    console.warn('API-Football rate limited - waiting 60s');
    await sleep(60000);
    return apiFetch(path);
  }
  if (!res.ok) {
    var txt = await res.text();
    throw new Error('API-Football ' + res.status + ': ' + txt);
  }
  var data = await res.json();
  if (data.errors && Object.keys(data.errors).length > 0) {
    console.warn('API errors:', data.errors);
  }
  return data;
}

// ── SUPABASE ─────────────────────────────────────────────────
async function supabaseUpsert(table, data, conflictCols) {
  if (!data || (Array.isArray(data) && data.length === 0)) return;
  var url = conflictCols
    ? SUPABASE_URL + '/rest/v1/' + table + '?on_conflict=' + conflictCols
    : SUPABASE_URL + '/rest/v1/' + table;
  var res = await fetch(url, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: 'Bearer ' + SUPABASE_KEY,
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates,return=minimal'
    },
    body: JSON.stringify(data)
  });
  if (!res.ok) {
    console.error('Supabase ' + table + ': ' + (await res.text()));
  } else {
    var count = Array.isArray(data) ? data.length : 1;
    console.log('Supabase: upserted ' + count + ' rows to ' + table);
  }
}

// ── WEBFLOW API ──────────────────────────────────────────────
async function wfGetAllItems(collectionId, retries) {
  if (retries === undefined) retries = 5;
  var items = [];
  var offset = 0;
  var limit = 100;
  while (true) {
    var res = await fetch(
      'https://api.webflow.com/v2/collections/' + collectionId + '/items?limit=' + limit + '&offset=' + offset,
      { headers: { Authorization: 'Bearer ' + WEBFLOW_TOKEN, accept: 'application/json' } }
    );
    if (res.status === 429) {
      if (retries <= 0) throw new Error('Webflow GET items: gave up after repeated rate limiting');
      await sleep(15000);
      return wfGetAllItems(collectionId, retries - 1);
    }
    if (!res.ok) throw new Error('Webflow GET items: ' + res.status);
    var data = await res.json();
    items = items.concat(data.items || []);
    if (items.length >= (data.pagination ? data.pagination.total : 0)) break;
    offset += limit;
  }
  return items;
}

async function wfCreateItem(collectionId, fieldData, retries) {
  if (retries === undefined) retries = 3;
  var res = await fetch('https://api.webflow.com/v2/collections/' + collectionId + '/items', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + WEBFLOW_TOKEN, 'Content-Type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ fieldData: fieldData, isDraft: true })
  });
  if (res.status === 429) {
    if (retries <= 0) throw new Error('Webflow CREATE: gave up after repeated rate limiting');
    await sleep(15000);
    return wfCreateItem(collectionId, fieldData, retries - 1);
  }
  if (!res.ok) {
    if (retries > 0) { await sleep(2000); return wfCreateItem(collectionId, fieldData, retries - 1); }
    throw new Error('Webflow CREATE: ' + (await res.text()));
  }
  return res.json();
}

async function wfUpdateItem(collectionId, itemId, fieldData, retries) {
  if (retries === undefined) retries = 3;
  var res = await fetch('https://api.webflow.com/v2/collections/' + collectionId + '/items/' + itemId, {
    method: 'PATCH',
    headers: { Authorization: 'Bearer ' + WEBFLOW_TOKEN, 'Content-Type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ fieldData: fieldData })
  });
  if (res.status === 429) {
    if (retries <= 0) throw new Error('Webflow PATCH: gave up after repeated rate limiting');
    await sleep(15000);
    return wfUpdateItem(collectionId, itemId, fieldData, retries - 1);
  }
  if (!res.ok) {
    if (retries > 0) { await sleep(2000); return wfUpdateItem(collectionId, itemId, fieldData, retries - 1); }
    throw new Error('Webflow PATCH: ' + (await res.text()));
  }
  return res.json();
}

async function wfPublishItems(collectionId, itemIds) {
  if (!itemIds || itemIds.length === 0) return;
  for (var i = 0; i < itemIds.length; i += 100) {
    var batch = itemIds.slice(i, i + 100);
    var res = await fetch('https://api.webflow.com/v2/collections/' + collectionId + '/items/publish', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + WEBFLOW_TOKEN, 'Content-Type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ itemIds: batch })
    });
    if (!res.ok) console.warn('Publish warning: ' + (await res.text()));
    await sleep(WEBFLOW_WRITE_DELAY_MS);
  }
}

// ── SYNC TEAMS ────────────────────────────────────────────────
async function syncTeams(league) {
  console.log('Syncing teams for ' + league.name);
  var teamsData = await apiFetch('/teams?league=' + league.api_id + '&season=' + league.season);
  var apiTeams = teamsData.response || [];
  var existing = await wfGetAllItems(WF.TEAMS);
  var byNormalizedName = new Map();
  for (var item of existing) {
    var n = item.fieldData ? item.fieldData.name : null;
    if (n) byNormalizedName.set(normalizeTeamName(n), item);
  }
  var matched = 0, matchedByToken = 0, unmatched = 0;
  var updatedIds = [];
  await pMap(apiTeams, async function(t) {
    var teamName = t.team.name;
    var slug = slugify(teamName);
    var fieldData = {
      name: teamName, slug: slug,
      'short-name': t.team.code || teamName.substring(0, 3).toUpperCase(),
      league: league.webflow_id,
      city: t.venue && t.venue.city ? t.venue.city : '',
      founded: t.team.founded || null,
      stadium: t.venue && t.venue.name ? t.venue.name : '',
      'api-team-id': String(t.team.id),
      country: t.team.country || '',
    };
    if (t.team.country) {
      fieldData.flag = 'https://media.api-sports.io/flags/' + countryToFlagCode(t.team.country) + '.svg';
    }
    // FIX (2026-07-30): added `alt` so every badge — new or re-synced — gets
    // descriptive alt text automatically. Matches inherit this for free since
    // syncMatches() copies the team's fieldData.badge object as-is.
    if (t.team.logo) fieldData.badge = { url: t.team.logo, alt: teamName + ' badge' };
    var match = findTeamMatch(teamName, byNormalizedName);
    if (match) {
      matched++;
      if (match.method === 'token-subset') matchedByToken++;
      var updateData = Object.assign({}, fieldData, { name: match.item.fieldData.name, slug: match.item.fieldData.slug });
      await wfUpdateItem(WF.TEAMS, match.item.id, updateData);
      updatedIds.push(match.item.id);
    } else {
      unmatched++;
      console.warn('NO MATCH for "' + teamName + '" - CREATING new item');
      var created = await wfCreateItem(WF.TEAMS, fieldData);
      updatedIds.push(created.id);
    }
  }, TEAM_CONCURRENCY);
  console.log(league.name + ' teams: ' + matched + ' matched (' + matchedByToken + ' via token match), ' + unmatched + ' unmatched');
  await wfPublishItems(WF.TEAMS, updatedIds);
  return updatedIds;
}

// ── SYNC STANDINGS ────────────────────────────────────────────
// teamByNormalizedName and allStandings are fetched ONCE in main() and shared
// across all leagues, instead of each league re-fetching the whole collection.
async function syncStandings(league, teamByNormalizedName, allTeams, allStandings) {
  console.log('Syncing standings for ' + league.name);
  var standingsData = await apiFetch('/standings?league=' + league.api_id + '&season=' + league.season);
  var table = (standingsData.response && standingsData.response[0] && standingsData.response[0].league && standingsData.response[0].league.standings && standingsData.response[0].league.standings[0]) || [];

  if (table.length === 0) {
    // Pre-season: API-Football has no table yet. Build a zeroed table from
    // this league's Teams instead of leaving old/stale rows untouched.
    var leagueTeams = allTeams.filter(function(t) { return t.fieldData && t.fieldData.league === league.webflow_id; });
    if (leagueTeams.length === 0) {
      console.log('No standings from API and no teams found for ' + league.name + ' - skipping');
      return [];
    }
    console.log('No live standings from API for ' + league.name + ' - writing zeroed pre-season table (' + leagueTeams.length + ' teams)');
    table = leagueTeams.map(function(t, idx) {
      return {
        team: { name: t.fieldData.name },
        rank: idx + 1,
        all: { played: 0, win: 0, draw: 0, lose: 0, goals: { for: 0, against: 0 } },
        goalsDiff: 0, points: 0, form: null,
      };
    });
  }

  var standingIndex = new Map();
  for (var s of allStandings) {
    var teamRef = s.fieldData ? s.fieldData.team : null;
    var leagueRef = s.fieldData ? s.fieldData.league : null;
    if (teamRef && leagueRef === league.webflow_id) standingIndex.set(teamRef, s);
  }
  var updatedIds = [];
  await pMap(table, async function(entry) {
    var teamName = entry.team.name;
    var match = findTeamMatch(teamName, teamByNormalizedName);
    if (!match) { console.warn('No Webflow team found for: ' + teamName); return; }
    var wfTeam = match.item;
    var fieldData = {
      name: wfTeam.fieldData.name,
      slug: normalizeTeamName(wfTeam.fieldData.name).replace(/\s+/g, '-') + '-' + league.code.toLowerCase() + '-standing',
      team: wfTeam.id, league: league.webflow_id,
      position: entry.rank, played: entry.all.played, won: entry.all.win,
      drawn: entry.all.draw, lost: entry.all.lose,
      'goals-for': entry.all.goals.for, 'goals-against': entry.all.goals.against,
      'goal-difference': entry.goalsDiff, points: entry.points,
      form: getFormString(entry.form),
    };
    var existingStanding = standingIndex.get(wfTeam.id);
    if (existingStanding) {
      await wfUpdateItem(WF.STANDINGS, existingStanding.id, fieldData);
      updatedIds.push(existingStanding.id);
    } else {
      var created = await wfCreateItem(WF.STANDINGS, fieldData);
      updatedIds.push(created.id);
    }
  }, STANDINGS_CONCURRENCY);
  await wfPublishItems(WF.STANDINGS, updatedIds);
  console.log('Standings done: ' + updatedIds.length + ' items');
  return updatedIds;
}

// ── SYNC MATCHES ──────────────────────────────────────────────
// teamByNormalizedName and matchByApiId are fetched ONCE in main() and shared
// across all leagues, instead of each league re-fetching the whole Matches
// collection (2,600+ items) from scratch every time.
async function syncMatches(league, teamByNormalizedName, matchByApiId) {
  console.log('Syncing matches for ' + league.name);
  var matchesData = await apiFetch('/fixtures?league=' + league.api_id + '&season=' + league.season);
  var apiMatches = matchesData.response || [];
  if (apiMatches.length === 0) { console.log('No fixtures returned for ' + league.name); return []; }

  var matched = 0, created = 0, skipped = 0, failed = 0;
  var updatedIds = [];
  var processed = 0;
  await pMap(apiMatches, async function(m) {
    processed++;
    var homeMatch = findTeamMatch(m.teams.home.name, teamByNormalizedName);
    var awayMatch = findTeamMatch(m.teams.away.name, teamByNormalizedName);
    if (!homeMatch || !awayMatch) { skipped++; return; }
    var status = mapMatchStatus(m.fixture.status.short);
    var roundText = m.league.round || '';
    var roundMatch = roundText.match(/(\d+)/);
    var matchweek = roundMatch ? parseInt(roundMatch[1], 10) : null;
    var fieldData = {
      name: homeMatch.item.fieldData.name + ' vs ' + awayMatch.item.fieldData.name,
      slug: slugify(homeMatch.item.fieldData.name) + '-vs-' + slugify(awayMatch.item.fieldData.name) + '-' + m.fixture.id,
      league: league.webflow_id,
      'home-team': homeMatch.item.id, 'away-team': awayMatch.item.id,
      // No separate fix needed here — this copies the team's badge object,
      // which now already contains `alt` thanks to the syncTeams() fix above.
      'home-badge': homeMatch.item.fieldData.badge || null, 'away-badge': awayMatch.item.fieldData.badge || null,
      'match-date': m.fixture.date, 'round-label': roundText,
      matchweek: matchweek,
      'home-score': m.goals.home, 'away-score': m.goals.away,
      status: status, venue: m.fixture.venue && m.fixture.venue.name ? m.fixture.venue.name : '',
      'api-fixture-id': m.fixture.id,
    };
    try {
      var existingMatch = matchByApiId.get(String(m.fixture.id));
      if (existingMatch) { matched++; await wfUpdateItem(WF.MATCHES, existingMatch.id, fieldData); updatedIds.push(existingMatch.id); }
      else { created++; var createdItem = await wfCreateItem(WF.MATCHES, fieldData); updatedIds.push(createdItem.id); }
    } catch (err) { failed++; console.error('Failed: ' + err.message); }
    if (processed % 50 === 0) console.log('...' + processed + '/' + apiMatches.length + ' processed');
  }, MATCH_CONCURRENCY);
  await wfPublishItems(WF.MATCHES, updatedIds);
  console.log(league.name + ' matches: ' + matched + ' updated, ' + created + ' created, ' + skipped + ' skipped, ' + failed + ' failed');
  return updatedIds;
}

// ── MAIN ──────────────────────────────────────────────────────
async function main() {
  console.log('league-sync-v2.js starting, LIVE MODE: ' + !DRY_RUN);

  // Phase 1: sync Teams for every league first (creates/updates/publishes).
  for (var league of LEAGUES) {
    try {
      await syncTeams(league);
    } catch (err) {
      console.error(league.name + ' teams failed: ' + err.message);
    }
  }

  // Phase 2: fetch Teams/Standings/Matches ONCE for the whole run instead of
  // once per league — this is what was causing most of the slow runtime,
  // since Matches alone is 2,600+ items (~27 pages) re-fetched 7x before.
  console.log('Fetching shared Teams/Standings/Matches reference data once...');
  var allTeams = await wfGetAllItems(WF.TEAMS);
  var teamByNormalizedName = new Map();
  for (var t of allTeams) {
    if (t.fieldData && t.fieldData.name) teamByNormalizedName.set(normalizeTeamName(t.fieldData.name), t);
  }
  var allStandings = await wfGetAllItems(WF.STANDINGS);
  var allMatches = await wfGetAllItems(WF.MATCHES);
  var matchByApiId = new Map();
  for (var m0 of allMatches) {
    var apiId = m0.fieldData ? m0.fieldData['api-fixture-id'] : null;
    if (apiId) matchByApiId.set(String(apiId), m0);
  }

  // Phase 3: Standings + Matches per league, reusing the shared data above.
  for (var league of LEAGUES) {
    console.log('Processing: ' + league.name);
    try {
      await syncStandings(league, teamByNormalizedName, allTeams, allStandings);
      await syncMatches(league, teamByNormalizedName, matchByApiId);
      console.log(league.name + ' complete');
    } catch (err) { console.error(league.name + ' failed: ' + err.message); }
  }
  console.log('league-sync-v2.js complete!');
}

main().catch(function(err) { console.error('Fatal error: ' + err.message); process.exit(1); });
