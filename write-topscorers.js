// ============================================================
// write-topscorers.js - footgoal.co
// Same rank/name matching logic as match-topscorers-dryrun.js, but
// actually PATCHes/CREATEs the matched Webflow CMS items with:
//   api-player-id, goals, assists, photo, nationality, rank (recalculated)
// AND publishes them, so changes actually go live on the site.
//
// SAFETY: defaults to dry-run printing. Nothing is written to Webflow
// unless you explicitly pass CONFIRM=yes.
//
// USAGE (safe preview, no writes):
//   node write-topscorers.js
//
// USAGE (writes + publishes to Webflow):
//   CONFIRM=yes node write-topscorers.js
// ============================================================

const WEBFLOW_TOKEN = process.env.WEBFLOW_TOKEN;
const API_FOOTBALL_KEY = process.env.API_FOOTBALL_KEY;
const CONFIRM = process.env.CONFIRM === 'yes';

const TOP_SCORERS_COLLECTION_ID = '6a32a89633c9bd6bea624094';
const TEAMS_COLLECTION_ID = '6a20064807685f373db26660';

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

async function wfPatchItem(collectionId, itemId, fieldData) {
  var res = await fetch(
    'https://api.webflow.com/v2/collections/' + collectionId + '/items/' + itemId,
    {
      method: 'PATCH',
      headers: {
        Authorization: 'Bearer ' + WEBFLOW_TOKEN,
        accept: 'application/json',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ fieldData: fieldData }),
    }
  );
  if (!res.ok) throw new Error('Webflow PATCH item ' + itemId + ': ' + res.status + ' ' + (await res.text()));
  return res.json();
}

async function wfCreateItem(collectionId, fieldData) {
  var res = await fetch(
    'https://api.webflow.com/v2/collections/' + collectionId + '/items',
    {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + WEBFLOW_TOKEN,
        accept: 'application/json',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ fieldData: fieldData, isDraft: false }),
    }
  );
  if (!res.ok) throw new Error('Webflow CREATE item: ' + res.status + ' ' + (await res.text()));
  return res.json();
}

// Publishes items so changes actually go live on the site - without this,
// PATCH/CREATE changes can sit "saved but not live" on the published domain.
async function wfPublishItems(collectionId, itemIds) {
  if (!itemIds.length) return;
  for (var i = 0; i < itemIds.length; i += 100) {
    var batch = itemIds.slice(i, i + 100);
    var res = await fetch('https://api.webflow.com/v2/collections/' + collectionId + '/items/publish', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + WEBFLOW_TOKEN,
        accept: 'application/json',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ itemIds: batch }),
    });
    if (!res.ok) console.warn('Publish warning: ' + (await res.text()));
    await sleep(500);
  }
}

function slugify(str) {
  return normalizeName(str).trim().replace(/\s+/g, '-');
}

async function main() {
  console.log(CONFIRM ? '*** LIVE MODE: will write + publish to Webflow ***\n' : 'Preview mode (no writes). Pass CONFIRM=yes to actually write.\n');

  console.log('Fetching existing Top Scorers CMS items...');
  var allItems = await wfGetAllItems(TOP_SCORERS_COLLECTION_ID);
  console.log('Found ' + allItems.length + ' CMS items total.\n');

  console.log('Fetching Teams collection for reference lookups...');
  var allTeams = await wfGetAllItems(TEAMS_COLLECTION_ID);
  console.log('Found ' + allTeams.length + ' team items.\n');

  function findTeamWebflowId(apiTeamName) {
    for (var t = 0; t < allTeams.length; t++) {
      var teamName = allTeams[t].fieldData && allTeams[t].fieldData.name;
      if (teamName && namesRoughlyMatch(teamName, apiTeamName)) return allTeams[t].id;
    }
    return null;
  }

  var toWrite = [];
  var toCreate = [];
  var noMatch = [];
  var droppedOut = [];
  var publishedIds = []; // collected as we go, published once at the end

  for (var i = 0; i < LEAGUES.length; i++) {
    var league = LEAGUES[i];
    var leagueItems = allItems.filter(function(item) {
      return item.fieldData && item.fieldData.league === league.webflow_id;
    });
    if (leagueItems.length === 0) continue;

    console.log('Fetching API-Football topscorers for ' + league.name + '...');
    var data = await apiFetch('/players/topscorers?league=' + league.api_id + '&season=' + league.season);
    var apiList = data.response || [];
    if (apiList.length === 0) {
      console.log('  No topscorers data for ' + league.name + ' - skipping.\n');
      continue;
    }

    var topN = leagueItems.length;
    var matchedApiPlayerIds = {};

    for (var j = 0; j < leagueItems.length; j++) {
      var item = leagueItems[j];
      var rank = item.fieldData.rank;
      var apiEntry = null;
      var method = null;

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
          method = 'name-fallback';
        }
      }
      if (!apiEntry) {
        noMatch.push({ cmsName: item.fieldData.name, league: league.name });
        continue;
      }

      var stats = apiEntry.statistics[0];
      var newRank = apiList.indexOf(apiEntry) + 1;
      matchedApiPlayerIds[String(apiEntry.player.id)] = true;

      var photoUrl = apiEntry.player.photo || (stats.team && stats.team.logo) || null;

      if (newRank > topN) {
        droppedOut.push({ cmsName: item.fieldData.name, league: league.name, newRank: newRank });
      }

      toWrite.push({
        cmsId: item.id,
        cmsName: item.fieldData.name,
        league: league.name,
        method: method,
        fieldData: {
          'api-player-id': String(apiEntry.player.id),
          goals: stats.goals.total || 0,
          assists: stats.goals.assists || 0,
          nationality: apiEntry.player.nationality,
          photo: photoUrl ? { url: photoUrl } : null,
          rank: newRank,
        },
      });
    }

    for (var p = 0; p < Math.min(topN, apiList.length); p++) {
      var candidate = apiList[p];
      var candidateId = String(candidate.player.id);
      if (matchedApiPlayerIds[candidateId]) continue;

      var cStats = candidate.statistics[0];
      var teamWfId = findTeamWebflowId(cStats.team.name);
      if (!teamWfId) {
        console.warn('  No Webflow Team match for "' + cStats.team.name + '" - skipping new item for ' + candidate.player.name);
        continue;
      }

      var newPhotoUrl = candidate.player.photo || cStats.team.logo || null;

      toCreate.push({
        cmsName: candidate.player.name,
        league: league.name,
        fieldData: {
          name: candidate.player.name,
          slug: slugify(candidate.player.name) + '-' + league.code.toLowerCase() + '-' + league.season,
          'api-player-id': candidateId,
          goals: cStats.goals.total || 0,
          assists: cStats.goals.assists || 0,
          nationality: candidate.player.nationality,
          photo: newPhotoUrl ? { url: newPhotoUrl } : null,
          season: String(league.season),
          league: league.webflow_id,
          team: teamWfId,
          rank: p + 1,
        },
      });
    }
  }

  console.log('\n========== ' + (CONFIRM ? 'UPDATING EXISTING' : 'WOULD UPDATE') + ' ==========\n');
  for (var k = 0; k < toWrite.length; k++) {
    var w = toWrite[k];
    console.log('[' + w.method + '] ' + w.league + ': "' + w.cmsName + '" -> api-player-id=' + w.fieldData['api-player-id'] +
      ', goals=' + w.fieldData.goals + ', assists=' + w.fieldData.assists + ', rank=' + w.fieldData.rank +
      (w.fieldData.photo ? '' : '  [NO PHOTO FOUND]'));

    if (CONFIRM) {
      try {
        await wfPatchItem(TOP_SCORERS_COLLECTION_ID, w.cmsId, w.fieldData);
        publishedIds.push(w.cmsId);
        console.log('  -> written OK');
      } catch (err) {
        console.error('  -> FAILED: ' + err.message);
      }
      await sleep(300);
    }
  }

  console.log('\n========== ' + (CONFIRM ? 'CREATING NEW ITEMS' : 'WOULD CREATE') + ' ==========\n');
  for (var c = 0; c < toCreate.length; c++) {
    var nc = toCreate[c];
    console.log('[NEW] ' + nc.league + ': "' + nc.cmsName + '" -> rank=' + nc.fieldData.rank +
      ', goals=' + nc.fieldData.goals + ', api-player-id=' + nc.fieldData['api-player-id']);

    if (CONFIRM) {
      try {
        var created = await wfCreateItem(TOP_SCORERS_COLLECTION_ID, nc.fieldData);
        publishedIds.push(created.id);
        console.log('  -> created OK');
      } catch (err) {
        console.error('  -> FAILED: ' + err.message);
      }
      await sleep(300);
    }
  }

  if (CONFIRM && publishedIds.length) {
    console.log('\nPublishing ' + publishedIds.length + ' item(s) so changes go live...');
    await wfPublishItems(TOP_SCORERS_COLLECTION_ID, publishedIds);
    console.log('Publish complete.');
  }

  console.log('\n========== SUMMARY ==========');
  console.log((CONFIRM ? 'Updated' : 'Would update') + ': ' + toWrite.length);
  console.log((CONFIRM ? 'Created' : 'Would create') + ': ' + toCreate.length);
  if (droppedOut.length) {
    console.log('\nDropped out of top N (still updated with real stats, but consider manually removing/archiving):');
    for (var d = 0; d < droppedOut.length; d++) {
      console.log('  - ' + droppedOut[d].cmsName + ' (' + droppedOut[d].league + '), now true rank ' + droppedOut[d].newRank);
    }
  }
  if (noMatch.length) {
    console.log('\nUnmatched (needs manual review, not touched):');
    for (var n = 0; n < noMatch.length; n++) {
      console.log('  - ' + noMatch[n].cmsName + ' (' + noMatch[n].league + ')');
    }
  }
  if (!CONFIRM) {
    console.log('\nThis was a preview. Re-run with CONFIRM=yes to actually write to Webflow.');
  }
}

main().catch(function(err) { console.error('Fatal error: ' + err.message); process.exit(1); });
