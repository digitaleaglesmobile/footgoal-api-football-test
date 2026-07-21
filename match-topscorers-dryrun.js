// ============================================================
// match-topscorers-dryrun.js - footgoal.co
// READ-ONLY. Does NOT write to Webflow. For each of the 7 leagues,
// pulls API-Football's topscorers list (already ranked by goals) and
// matches it against your existing 80 Top Scorers CMS items using the
// rank field each item already has (rank 9 = 9th scorer in that league).
//
// Prints a full proposed match list, plus a name-mismatch warning for
// any pair where the CMS name and API name don't reasonably agree -
// review those manually before trusting the match.
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
      console.log('  No topscorers data returned for ' + league.name + ' - skipping.\n');
      continue;
    }

    for (var j = 0; j < leagueItems.length; j++) {
      var item = leagueItems[j];
      var rank = item.fieldData.rank;
      if (!rank || rank < 1 || rank > apiList.length) {
        noMatch.push({ cmsName: item.fieldData.name, league: league.name, reason: 'rank ' + rank + ' out of range (API list has ' + apiList.length + ')' });
        continue;
      }
      var apiEntry = apiList[rank - 1];
      var apiName = apiEntry.player.name;
      var confident = namesRoughlyMatch(item.fieldData.name, apiName);
      proposedMatches.push({
        cmsId: item.id,
        cmsName: item.fieldData.name,
        rank: rank,
        apiPlayerId: apiEntry.player.id,
        apiName: apiName,
        league: league.name,
        confident: confident,
      });
    }
  }

  console.log('\n========== PROPOSED MATCHES ==========\n');
  for (var k = 0; k < proposedMatches.length; k++) {
    var m = proposedMatches[k];
    var flag = m.confident ? '  OK  ' : ' CHECK';
    console.log('[' + flag + '] ' + m.league + ' rank ' + m.rank + ': CMS "' + m.cmsName + '" -> API "' + m.apiName + '" (player_id: ' + m.apiPlayerId + ')');
  }

  var uncertain = proposedMatches.filter(function(m) { return !m.confident; });
  console.log('\n========== SUMMARY ==========');
  console.log('Total proposed matches: ' + proposedMatches.length);
  console.log('Confident (names agree): ' + (proposedMatches.length - uncertain.length));
  console.log('NEEDS REVIEW (name mismatch): ' + uncertain.length);
  if (noMatch.length) {
    console.log('\nItems with no valid match (rank issue):');
    for (var n = 0; n < noMatch.length; n++) {
      console.log('  - ' + noMatch[n].cmsName + ' (' + noMatch[n].league + '): ' + noMatch[n].reason);
    }
  }
  console.log('\nNothing has been written. Review the CHECK-flagged rows above manually.');
  console.log('Once you approve, we will build the real write script using this same matching logic.');
}

main().catch(function(err) { console.error('Fatal error: ' + err.message); process.exit(1); });
