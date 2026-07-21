// ============================================================
// match-topscorers-dryrun.js - footgoal.co
// READ-ONLY. Does NOT write to Webflow. For each of the 7 leagues,
// pulls API-Football's topscorers list and matches it against your
// existing Top Scorers CMS items - first by rank position, falling
// back to a full-list name search if the rank-based guess doesn't
// look right (handles rank drift as goal tallies change over time).
//
// USAGE: node match-topscorers-dryrun.js
// ============================================================

const WEBFLOW_TOKEN = process.env.WEBFLOW_TOKEN;
const API_FOOTBALL_KEY = process.env.API_FOOTBALL_KEY;

const TOP_SCORERS_COLLECTION_ID = '6a32a89633c9bd6bea624094';

var LEAGUES = [
  { code: 'PL',  name: 'Premier League',    api_id: 39,  webflow_id: '6a32a9cb63396a5393212f3a', season: 2026 },
  { code: 'LL',  name: 'La Liga',            api_id: 140, webflow_id: '6a32a9cb63396a5393212f3e', season: 2026 },
  { code: 'BL',  name: 'Bundesliga',         api_id: 78,  webflow_id: '6a32a9cb63396a5393212f40', season: 2026 },
  { code: 'SA',  name: 'Serie A',            api_id: 135, webflow_id: '6a32a9cb63396a5393212f42', season: 2026 },
  { code: 'ERE', name: 'Eredivisie',         api_id: 88,  webflow_id: '6a32a9cb63396a5393212f44', season: 2026 },
  { code: 'L1',  name: 'Ligue 1',            api_id: 61,  webflow_id: '6a32a9cb63396a5393212f46', season: 2026 },
  { code: 'BSA', name: 'Brasileiro Serie A', api_id: 71,  webflow_id: '6a32a9cb63396a5393212f48', season: 2026 },
];

function sleep(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }

function normalizeName(name) {
  return name.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z\s]/g, '').trim();
}

function namesRoughlyMatch(a, b) {
  var na = normalizeName(a), nb = normalizeName(b);
  if (na === nb) return true;
  var partsA = na.split(' ').filter(Boolean);
  var partsB = nb.split(' ').filter(Boolean);
  var lastA = partsA[partsA.length - 1];
  var lastB = partsB[partsB.length - 1];
  return lastA === lastB || na.indexOf(lastB) !== -1 || nb.indexOf(lastA) !== -1;
}

function findByNameInList(cmsName, apiList) {
  for (var i = 0; i < apiList.length; i++) {
    if (namesRoughlyMatch(cmsName, apiList[i].player.name)) return apiList[i];
  }
  return null;
}

async function apiFetch(path) {
  await sleep(250);
  var res = await fetch('https://v3.football.api-sports.io' + path, {
    headers: { 'x-apisports-key': API_FOOTBALL_KEY }
  });
  if (res.status === 429) {
    console.warn('Rate limited - waiting 30s');
    await sleep(30000);
    return apiFetch(path);
  }
  if (!res.ok) throw new Error('API-Football ' + res.status + ': ' + (await res.text()));
  return res.json();
}

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

async function main() {
  console.log('Fetching existing Top Scorers CMS items...');
  var allItems = await wfGetAllItems(TOP_SCORERS_COLLECTION_ID);
  console.log('Found ' + allItems.length + ' CMS items total.\n');

  var proposedMatches = [];
  var noMatch = [];

  for (var i = 0; i < LEAGUES.length; i++) {
    var league = LEAGUES[i];
    var leagueItems = allItems.filter(function(item) {
      return item.fieldData && item.fieldData.league === league.webflow_id;
    });
    if (leagueItems.length === 0) {
      console.log(league.name + ': no CMS items found for this league, skipping.');
      continue;
    }

    console.log('Fetching API-Football topscorers for ' + league.name + '...');
    var data = await apiFetch('/players/topscorers?league=' + league.api_id + '&season=' + league.season);
    var apiList = data.response || [];
    if (apiList.length === 0) {
      console.log('  No topscorers data returned for ' + league.name + ' (likely pre-season, no goals yet) - skipping.\n');
      continue;
    }

    for (var j = 0; j < leagueItems.length; j++) {
      var item = leagueItems[j];
      var rank = item.fieldData.rank;
      var method = null;
      var apiEntry = null;

      if (rank && rank >= 1 && rank <= apiList.length) {
        var rankGuess = apiList[rank - 1];
        if (namesRoughlyMatch(item.fieldData.name, rankGuess.player.name)) {
          apiEntry = rankGuess;
          method = 'rank';
        }
      }
      if (!apiEntry) {
        var nameGuess = findByNameInList(item.fieldData.name, apiList);
        if (nameGuess) {
          apiEntry = nameGuess;
          method = 'name-fallback (rank drifted)';
        }
      }

      if (!apiEntry) {
        noMatch.push({ cmsName: item.fieldData.name, league: league.name, reason: 'no rank or name match found in current topscorers list' });
        continue;
      }

      proposedMatches.push({
        cmsId: item.id,
        cmsName: item.fieldData.name,
        rank: rank,
        apiPlayerId: apiEntry.player.id,
        apiName: apiEntry.player.name,
        league: league.name,
        method: method,
      });
    }
  }

  console.log('\n========== PROPOSED MATCHES ==========\n');
  for (var k = 0; k < proposedMatches.length; k++) {
    var m = proposedMatches[k];
    console.log('[' + m.method + '] ' + m.league + ' (CMS rank ' + m.rank + '): CMS "' + m.cmsName + '" -> API "' + m.apiName + '" (player_id: ' + m.apiPlayerId + ')');
  }

  console.log('\n========== SUMMARY ==========');
  console.log('Total proposed matches: ' + proposedMatches.length);
  var viaFallback = proposedMatches.filter(function(m) { return m.method !== 'rank'; });
  console.log('Matched via rank drift fallback (double check these): ' + viaFallback.length);
  if (noMatch.length) {
    console.log('\nTruly unmatched (needs manual lookup):');
    for (var n = 0; n < noMatch.length; n++) {
      console.log('  - ' + noMatch[n].cmsName + ' (' + noMatch[n].league + '): ' + noMatch[n].reason);
    }
  }
  console.log('\nNothing has been written. Review the list above.');
  console.log('Once approved, we will build the real write script using this same matching logic.');
}

main().catch(function(err) { console.error('Fatal error: ' + err.message); process.exit(1); });
