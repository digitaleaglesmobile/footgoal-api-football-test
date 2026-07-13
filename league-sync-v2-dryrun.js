// ============================================================
// cleanup-stale-matches.js — footgoal.co
// One-off utility: deletes stale "Played" matches left over from the old
// 2025-26 season for leagues whose 2026-27 season hasn't started yet.
// Brasileirão is intentionally excluded — it's genuinely mid-season, so
// its "Played" matches are real, current data and must NOT be touched.
//
// SAFETY: DRY_RUN defaults to true. It will only log what it WOULD delete.
// Set DRY_RUN to false only after reviewing that log and confirming the
// counts/leagues look right.
// ============================================================

const DRY_RUN = true;

const WEBFLOW_TOKEN = process.env.WEBFLOW_TOKEN;
const MATCHES_COLLECTION_ID = '6a200649c668e2cb8f11e82b';

// Every pre-season league's webflow_id EXCEPT Brasileirão — those are the
// only leagues where a "Played" match right now can only be stale leftover
// data, since none of them have started their 2026-27 season yet.
const PRESEASON_LEAGUE_IDS = new Map([
  ['6a32a9cb63396a5393212f3a', 'Premier League'],
  ['6a32a9cb63396a5393212f3e', 'La Liga'],
  ['6a32a9cb63396a5393212f40', 'Bundesliga'],
  ['6a32a9cb63396a5393212f42', 'Serie A'],
  ['6a32a9cb63396a5393212f44', 'Eredivisie'],
  ['6a32a9cb63396a5393212f46', 'Ligue 1'],
]);

const DELETE_CONCURRENCY = 6;

function sleep(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }

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

async function wfDeleteItem(collectionId, itemId, retries) {
  if (retries === undefined) retries = 3;
  var res = await fetch('https://api.webflow.com/v2/collections/' + collectionId + '/items/' + itemId, {
    method: 'DELETE',
    headers: { Authorization: 'Bearer ' + WEBFLOW_TOKEN, accept: 'application/json' }
  });
  if (res.status === 429) {
    if (retries <= 0) throw new Error('Webflow DELETE: gave up after repeated rate limiting');
    await sleep(15000);
    return wfDeleteItem(collectionId, itemId, retries - 1);
  }
  if (!res.ok && res.status !== 404) {
    if (retries > 0) { await sleep(2000); return wfDeleteItem(collectionId, itemId, retries - 1); }
    throw new Error('Webflow DELETE ' + itemId + ': ' + (await res.text()));
  }
  return true;
}

async function main() {
  console.log('DRY_RUN = ' + DRY_RUN + (DRY_RUN ? ' (nothing will actually be deleted)' : ' (DELETIONS ARE LIVE)'));
  console.log('Fetching all Matches items...');
  var allMatches = await wfGetAllItems(MATCHES_COLLECTION_ID);
  console.log('Total matches in collection: ' + allMatches.length);

  var toDelete = allMatches.filter(function(m) {
    var fd = m.fieldData || {};
    return PRESEASON_LEAGUE_IDS.has(fd.league) && fd.status === 'Played';
  });

  // Breakdown per league so you can sanity-check counts before committing.
  var byLeague = {};
  for (var item of toDelete) {
    var leagueName = PRESEASON_LEAGUE_IDS.get(item.fieldData.league);
    byLeague[leagueName] = (byLeague[leagueName] || 0) + 1;
  }
  console.log('Stale "Played" matches found per league:');
  for (var name of PRESEASON_LEAGUE_IDS.values()) {
    console.log('  ' + name + ': ' + (byLeague[name] || 0));
  }
  console.log('Total to delete: ' + toDelete.length);

  if (toDelete.length === 0) { console.log('Nothing to delete.'); return; }

  if (DRY_RUN) {
    console.log('DRY_RUN is true — stopping here. Set DRY_RUN = false to actually delete.');
    return;
  }

  var deleted = 0, failed = 0;
  await pMap(toDelete, async function(item) {
    try {
      await wfDeleteItem(MATCHES_COLLECTION_ID, item.id);
      deleted++;
      if (deleted % 50 === 0) console.log('...' + deleted + '/' + toDelete.length + ' deleted');
    } catch (err) {
      failed++;
      console.error('Failed to delete ' + item.id + ': ' + err.message);
    }
  }, DELETE_CONCURRENCY);

  console.log('Done. Deleted: ' + deleted + ', Failed: ' + failed);
}

main().catch(function(err) { console.error('Fatal error: ' + err.message); process.exit(1); });
