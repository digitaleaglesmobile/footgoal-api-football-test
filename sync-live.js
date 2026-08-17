// ============================================================
// sync-live.js — footgoal.co
// LIGHTWEIGHT, 1-MINUTE-SAFE companion to league-sync-v2-dryrun.js.
//
// Designed to be triggered every ~60s by an external pinger (cron-job.org,
// EasyCron, etc. hitting GitHub's workflow_dispatch/repository_dispatch API
// — GitHub's own `schedule:` trigger cannot go below 5 minutes).
//
// COST MODEL PER RUN:
//   - Nothing live right now:  1 API-Football call total. No Webflow calls.
//   - Something live:         1 + (1 per league with a live match) API-Football
//                              calls, only for the league(s) actually playing.
//
// This does NOT sync Teams and does NOT do a full Standings/Matches sweep of
// all 7 leagues every tick — that's still league-sync-v2-dryrun.js's job, on
// its own slower schedule (e.g. every 30 min) as the safety net that catches
// anything this script's narrower scope might miss.
// ============================================================

const SUPABASE_URL  = process.env.SUPABASE_URL;   // unused here, kept for parity
const WEBFLOW_TOKEN = process.env.WEBFLOW_TOKEN;
const API_FOOTBALL_KEY = process.env.API_FOOTBALL_KEY;

const WF = {
  TEAMS:      '6a20064807685f373db26660',
  STANDINGS:  '6a200649847c9fcb9278de02',
  MATCHES:    '6a200649c668e2cb8f11e82b',
};

const LEAGUES = [
  { code: 'PL',  name: 'Premier League',        api_id: 39,  webflow_id: '6a32a9cb63396a5393212f3a', season: 2026 },
  { code: 'LL',  name: 'La Liga',                api_id: 140, webflow_id: '6a32a9cb63396a5393212f3e', season: 2026 },
  { code: 'BL',  name: 'Bundesliga',             api_id: 78,  webflow_id: '6a32a9cb63396a5393212f40', season: 2026 },
  { code: 'SA',  name: 'Serie A',                api_id: 135, webflow_id: '6a32a9cb63396a5393212f42', season: 2026 },
  { code: 'ERE', name: 'Eredivisie',             api_id: 88,  webflow_id: '6a32a9cb63396a5393212f44', season: 2026 },
  { code: 'L1',  name: 'Ligue 1',                api_id: 61,  webflow_id: '6a32a9cb63396a5393212f46', season: 2026 },
  { code: 'BSA', name: 'Brasileiro Série A',     api_id: 71,  webflow_id: '6a32a9cb63396a5393212f48', season: 2026 },
];

const DELAY_MS = 200;
const WEBFLOW_WRITE_DELAY_MS = 800;
const MATCH_CONCURRENCY = 6;

// ── MANUAL ALIASES (kept in sync with league-sync-v2-dryrun.js) ──────────
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
  if (candidates.length === 1) return { item: candidates[0], method: 'token-subset' };
  return null;
}

function getFormString(form) {
  if (!form) return '';
  return form.slice(-5);
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
    console.warn('API-Football rate limited - waiting 30s');
    await sleep(30000);
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

// Full SITE publish - without this, item-level publishes above can sit
// "queued to publish" indefinitely, since item publishing alone does not
// push the compiled site out to the live domains. This is what actually
// makes changes visible on footgoal.co / www.footgoal.co.
var SITE_ID = '69c3c0d82fd37856ad9e297a';
var CUSTOM_DOMAINS = ['69c4fc77a50ac7d07e84308a', '69c4fc76a50ac7d07e843018']; // footgoal.co, www.footgoal.co
async function wfPublishSite() {
  var res = await fetch('https://api.webflow.com/v2/sites/' + SITE_ID + '/publish', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + WEBFLOW_TOKEN, 'Content-Type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ customDomains: CUSTOM_DOMAINS, publishToWebflowSubdomain: true })
  });
  if (!res.ok) {
    console.warn('Site publish warning: ' + (await res.text()));
  } else {
    console.log('Site published to footgoal.co / www.footgoal.co.');
  }
}

// ── STEP 1: THE ONE CHEAP CALL ─────────────────────────────────
// /fixtures?live=all returns every fixture currently in progress across
// every league your plan covers, in a single API call. This is the gate.
async function getLiveLeagueIds() {
  var data = await apiFetch('/fixtures?live=all');
  var liveFixtures = data.response || [];
  var liveLeagueIds = new Set(liveFixtures.map(function(f) { return f.league.id; }));
  return { liveLeagueIds: liveLeagueIds, liveFixtures: liveFixtures };
}

// ── SYNC MATCHES for one league (same shape as the full-sync script) ────
async function syncMatchesForLeague(league, teamByNormalizedName, matchByApiId) {
  console.log('[LIVE] Syncing matches for ' + league.name);
  var matchesData = await apiFetch('/fixtures?league=' + league.api_id + '&season=' + league.season);
  var apiMatches = matchesData.response || [];
  var updatedIds = [];
  var matched = 0, created = 0, skipped = 0, failed = 0;
  var pool = [];
  var index = 0;
  async function worker() {
    while (index < apiMatches.length) {
      var m = apiMatches[index++];
      var homeMatch = findTeamMatch(m.teams.home.name, teamByNormalizedName);
      var awayMatch = findTeamMatch(m.teams.away.name, teamByNormalizedName);
      if (!homeMatch || !awayMatch) { skipped++; continue; }
      var status = mapMatchStatus(m.fixture.status.short);
      var roundText = m.league.round || '';
      var roundMatch = roundText.match(/(\d+)/);
      var matchweek = roundMatch ? parseInt(roundMatch[1], 10) : null;
      var fieldData = {
        name: homeMatch.item.fieldData.name + ' vs ' + awayMatch.item.fieldData.name,
        slug: slugify(homeMatch.item.fieldData.name) + '-vs-' + slugify(awayMatch.item.fieldData.name) + '-' + m.fixture.id,
        league: league.webflow_id,
        'home-team': homeMatch.item.id, 'away-team': awayMatch.item.id,
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
    }
  }
  for (var i = 0; i < MATCH_CONCURRENCY; i++) pool.push(worker());
  await Promise.all(pool);
  await wfPublishItems(WF.MATCHES, updatedIds);
  console.log(league.name + ' [LIVE] matches: ' + matched + ' updated, ' + created + ' created, ' + skipped + ' skipped, ' + failed + ' failed');
  return updatedIds;
}

// ── SYNC STANDINGS for one league (only called for leagues with live action) ──
async function syncStandingsForLeague(league, teamByNormalizedName, allStandings) {
  console.log('[LIVE] Syncing standings for ' + league.name);
  var standingsData = await apiFetch('/standings?league=' + league.api_id + '&season=' + league.season);
  var table = (standingsData.response && standingsData.response[0] && standingsData.response[0].league && standingsData.response[0].league.standings && standingsData.response[0].league.standings[0]) || [];
  if (table.length === 0) { console.log('No standings table yet for ' + league.name); return []; }

  var standingIndex = new Map();
  for (var s of allStandings) {
    var teamRef = s.fieldData ? s.fieldData.team : null;
    var leagueRef = s.fieldData ? s.fieldData.league : null;
    if (teamRef && leagueRef === league.webflow_id) standingIndex.set(teamRef, s);
  }
  var updatedIds = [];
  for (var entry of table) {
    var match = findTeamMatch(entry.team.name, teamByNormalizedName);
    if (!match) continue;
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
    if (existingStanding) { await wfUpdateItem(WF.STANDINGS, existingStanding.id, fieldData); updatedIds.push(existingStanding.id); }
    else { var created = await wfCreateItem(WF.STANDINGS, fieldData); updatedIds.push(created.id); }
  }
  await wfPublishItems(WF.STANDINGS, updatedIds);
  console.log(league.name + ' [LIVE] standings done: ' + updatedIds.length + ' items');
  return updatedIds;
}

// ── MAIN ──────────────────────────────────────────────────────
async function main() {
  console.log('sync-live.js tick @ ' + new Date().toISOString());

  var liveCheck = await getLiveLeagueIds();
  var liveLeagues = LEAGUES.filter(function(l) { return liveCheck.liveLeagueIds.has(l.api_id); });

  if (liveLeagues.length === 0) {
    console.log('No live matches across any of the 7 leagues right now - exiting (1 API call used).');
    return;
  }

  console.log('LIVE right now: ' + liveLeagues.map(function(l) { return l.name; }).join(', '));

  var allTeams = await wfGetAllItems(WF.TEAMS);
  var teamByNormalizedName = new Map();
  for (var t of allTeams) {
    if (t.fieldData && t.fieldData.name) teamByNormalizedName.set(normalizeTeamName(t.fieldData.name), t);
  }
  var allMatches = await wfGetAllItems(WF.MATCHES);
  var matchByApiId = new Map();
  for (var m0 of allMatches) {
    var apiId = m0.fieldData ? m0.fieldData['api-fixture-id'] : null;
    if (apiId) matchByApiId.set(String(apiId), m0);
  }
  var allStandings = await wfGetAllItems(WF.STANDINGS);

  for (var league of liveLeagues) {
    try {
      await syncMatchesForLeague(league, teamByNormalizedName, matchByApiId);
      await syncStandingsForLeague(league, teamByNormalizedName, allStandings);
    } catch (err) {
      console.error(league.name + ' [LIVE] failed: ' + err.message);
    }
  }

  await wfPublishSite();
  console.log('sync-live.js tick complete.');
}

main().catch(function(err) { console.error('Fatal error: ' + err.message); process.exit(1); });
