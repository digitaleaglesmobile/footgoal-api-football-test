// ============================================================
// league-sync-v2.js — footgoal.co
// LIVE MODE — Serie A, Eredivisie, Ligue 1 (with Troyes alias fix)
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

// ── LEAGUE CONFIG — Serie A, Eredivisie, Ligue 1 ────
const LEAGUES = [
  { code: 'SA',  name: 'Serie A',    api_id: 135, webflow_id: '6a32a9cb63396a5393212f42', season: 2026 },
  { code: 'DED', name: 'Eredivisie', api_id: 88,  webflow_id: '6a32a9cb63396a5393212f44', season: 2026 },
  { code: 'FL1', name: 'Ligue 1',    api_id: 61,  webflow_id: '6a32a9cb63396a5393212f46', season: 2026 },
];

const DELAY_MS = 1000;
const WEBFLOW_WRITE_DELAY_MS = 1000;

// ── MANUAL ALIASES (includes new Troyes fix) ─────────────
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
async function wfGetAllItems(collectionId) {
  var items = [];
  var offset = 0;
  var limit = 100;
  while (true) {
    var res = await fetch(
      'https://api.webflow.com/v2/collections/' + collectionId + '/items?limit=' + limit + '&offset=' + offset,
      { headers: { Authorization: 'Bearer ' + WEBFLOW_TOKEN, accept: 'application/json' } }
    );
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
    console.warn('Webflow rate limited, waiting 15s, retries left: ' + retries);
    await sleep(15000);
    return wfCreateItem(collectionId, fieldData, retries - 1);
  }
  if (!res.ok) {
    if (retries > 0) {
      console.warn('Webflow error, retrying, left: ' + retries);
      await sleep(2000);
      return wfCreateItem(collectionId, fieldData, retries - 1);
    }
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
    console.warn('Webflow rate limited, waiting 15s, retries left: ' + retries);
    await sleep(15000);
    return wfUpdateItem(collectionId, itemId, fieldData, retries - 1);
  }
  if (!res.ok) {
    if (retries > 0) {
      console.warn('Webflow error, retrying, left: ' + retries);
      await sleep(2000);
      return wfUpdateItem(collectionId, itemId, fieldData, retries - 1);
    }
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
  var supaRows = [];

  for (var t of apiTeams) {
    var teamName = t.team.name;
    var slug = slugify(teamName);

    var fieldData = {
      name: teamName,
      slug: slug,
      'short-name': t.team.code || teamName.substring(0, 3).toUpperCase(),
      league: league.webflow_id,
      city: t.venue && t.venue.city ? t.venue.city : '',
      founded: t.team.founded || null,
      stadium: t.venue && t.venue.name ? t.venue.name : '',
    };
    if (t.team.logo) fieldData.badge = { url: t.team.logo };

    supaRows.push({
      api_id: t.team.id,
      league_code: league.code,
      season: league.season,
      name: teamName,
      short_name: t.team.code,
      slug: slug,
      crest: t.team.logo,
      venue: t.venue ? t.venue.name : null,
      founded: t.team.founded,
      updated_at: new Date().toISOString()
    });

    var match = findTeamMatch(teamName, byNormalizedName);
    if (match) {
      matched++;
      if (match.method === 'token-subset') {
        matchedByToken++;
        console.log('  Token match: "' + teamName + '" -> "' + match.item.fieldData.name + '"');
      }
      var updateData = Object.assign({}, fieldData, { name: match.item.fieldData.name, slug: match.item.fieldData.slug });
      await wfUpdateItem(WF.TEAMS, match.item.id, updateData);
      updatedIds.push(match.item.id);
    } else {
      unmatched++;
      console.warn('NO MATCH for "' + teamName + '" - CREATING new item');
      var created = await wfCreateItem(WF.TEAMS, fieldData);
      updatedIds.push(created.id);
    }
  }

  await supabaseUpsert('af_teams', supaRows, 'api_id');
  console.log(league.name + ' teams: ' + matched + ' matched (' + matchedByToken + ' via token match), ' + unmatched + ' unmatched');
  return updatedIds;
}

// ── SYNC STANDINGS ────────────────────────────────────────────
async function syncStandings(league) {
  console.log('Syncing standings for ' + league.name);

  var standingsData = await apiFetch('/standings?league=' + league.api_id + '&season=' + league.season);
  var table = (standingsData.response && standingsData.response[0] && standingsData.response[0].league && standingsData.response[0].league.standings && standingsData.response[0].league.standings[0]) || [];
  if (table.length === 0) {
    console.log('No standings yet for ' + league.name);
    return [];
  }

  var wfTeams = await wfGetAllItems(WF.TEAMS);
  var teamByNormalizedName = new Map();
  for (var t of wfTeams) {
    if (t.fieldData && t.fieldData.name) teamByNormalizedName.set(normalizeTeamName(t.fieldData.name), t);
  }

  var wfStandings = await wfGetAllItems(WF.STANDINGS);
  var standingIndex = new Map();
  for (var s of wfStandings) {
    var teamRef = s.fieldData ? s.fieldData.team : null;
    var leagueRef = s.fieldData ? s.fieldData.league : null;
    if (teamRef && leagueRef === league.webflow_id) standingIndex.set(teamRef, s);
  }

  var updatedIds = [];
  var supaRows = [];

  for (var entry of table) {
    var teamName = entry.team.name;
    var match = findTeamMatch(teamName, teamByNormalizedName);
    if (!match) {
      console.warn('No Webflow team found for: ' + teamName);
      continue;
    }
    var wfTeam = match.item;

    supaRows.push({
      league_code: league.code,
      season: league.season,
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
      updated_at: new Date().toISOString()
    });

    var fieldData = {
      name: wfTeam.fieldData.name,
      slug: normalizeTeamName(wfTeam.fieldData.name).replace(/\s+/g, '-') + '-' + league.code.toLowerCase() + '-standing',
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
  }

  await supabaseUpsert('af_standings', supaRows, 'league_code,season,team_id');
  await wfPublishItems(WF.STANDINGS, updatedIds);
  console.log('Standings done: ' + updatedIds.length + ' items');
  return updatedIds;
}

// ── SYNC MATCHES ──────────────────────────────────────────────
async function syncMatches(league) {
  console.log('Syncing matches for ' + league.name);

  var matchesData = await apiFetch('/fixtures?league=' + league.api_id + '&season=' + league.season);
  var apiMatches = matchesData.response || [];

  if (apiMatches.length === 0) {
    console.log('No fixtures returned yet for ' + league.name);
    return [];
  }

  var wfTeams = await wfGetAllItems(WF.TEAMS);
  var teamByNormalizedName = new Map();
  for (var t of wfTeams) {
    if (t.fieldData && t.fieldData.name) teamByNormalizedName.set(normalizeTeamName(t.fieldData.name), t);
  }

  var wfMatches = await wfGetAllItems(WF.MATCHES);
  var matchByApiId = new Map();
  for (var m0 of wfMatches) {
    var apiId = m0.fieldData ? m0.fieldData['api-fixture-id'] : null;
    if (apiId) matchByApiId.set(String(apiId), m0);
  }

  var matched = 0, created = 0, skipped = 0, failed = 0;
  var updatedIds = [];
  var total = apiMatches.length;
  var processed = 0;

  for (var m of apiMatches) {
    processed++;
    var homeName = m.teams.home.name;
    var awayName = m.teams.away.name;

    var homeMatch = findTeamMatch(homeName, teamByNormalizedName);
    var awayMatch = findTeamMatch(awayName, teamByNormalizedName);

    if (!homeMatch || !awayMatch) {
      skipped++;
      console.warn('Skipping fixture - no team match for "' + (!homeMatch ? homeName : awayName) + '"');
      continue;
    }

    var status = mapMatchStatus(m.fixture.status.short);
    var roundLabel = m.league.round || '';

    var fieldData = {
      name: homeMatch.item.fieldData.name + ' vs ' + awayMatch.item.fieldData.name,
      slug: slugify(homeMatch.item.fieldData.name) + '-vs-' + slugify(awayMatch.item.fieldData.name) + '-' + m.fixture.id,
      league: league.webflow_id,
      'home-team': homeMatch.item.id,
      'away-team': awayMatch.item.id,
      'home-badge': homeMatch.item.fieldData.badge || null,
      'away-badge': awayMatch.item.fieldData.badge || null,
      'match-date': m.fixture.date,
      'round-label': roundLabel,
      'home-score': m.goals.home,
      'away-score': m.goals.away,
      status: status,
      venue: m.fixture.venue && m.fixture.venue.name ? m.fixture.venue.name : '',
      'api-fixture-id': m.fixture.id,
    };

    try {
      var existingMatch = matchByApiId.get(String(m.fixture.id));
      if (existingMatch) {
        matched++;
        await wfUpdateItem(WF.MATCHES, existingMatch.id, fieldData);
        updatedIds.push(existingMatch.id);
      } else {
        created++;
        var createdItem = await wfCreateItem(WF.MATCHES, fieldData);
        updatedIds.push(createdItem.id);
      }
    } catch (err) {
      failed++;
      console.error('Failed fixture "' + fieldData.name + '": ' + err.message);
    }

    await sleep(WEBFLOW_WRITE_DELAY_MS);
    if (processed % 50 === 0) console.log('...' + processed + '/' + total + ' processed');
  }

  await wfPublishItems(WF.MATCHES, updatedIds);
  console.log(league.name + ' matches: ' + matched + ' updated, ' + created + ' created, ' + skipped + ' skipped, ' + failed + ' failed');
  console.log('Matches done: ' + updatedIds.length + ' items');
  return updatedIds;
}

// ── MAIN ──────────────────────────────────────────────────────
async function main() {
  console.log('league-sync-v2.js starting, LIVE MODE: ' + !DRY_RUN);
  console.log(new Date().toISOString());

  for (var league of LEAGUES) {
    console.log('Processing: ' + league.name + ' (' + league.code + ')');
    try {
      await syncTeams(league);
      await syncStandings(league);
      await syncMatches(league);
      console.log(league.name + ' complete');
    } catch (err) {
      console.error(league.name + ' failed: ' + err.message);
    }
  }

  console.log('league-sync-v2.js complete!');
}

main().catch(function(err) {
  console.error('Fatal error: ' + err.message);
  process.exit(1);
});
