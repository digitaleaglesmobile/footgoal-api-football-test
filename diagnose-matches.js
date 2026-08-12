// ============================================================
// diagnose-matches.js — READ-ONLY diagnostic for footgoal.co
//
// Does NOT write anything to Webflow or Supabase. Just fetches
// the Matches collection and reports:
//   1. Duplicate api-fixture-id values (same fixture written twice)
//   2. Duplicate home/away team pairs with different match-dates
//      (could indicate stale items from an earlier round/season
//      that never got cleaned up)
//   3. What's currently marked status="Upcoming" for Brasileirão,
//      sorted by match-date — i.e. exactly what the front-end's
//      "Upcoming Matches" panel should be pulling, so you can
//      compare it directly against what's rendering on the site.
//
// Run with: node diagnose-matches.js
// Needs: WEBFLOW_TOKEN env var (same one used by league-sync-v2.js)
// ============================================================

const WEBFLOW_TOKEN = process.env.WEBFLOW_TOKEN;
const MATCHES_COLLECTION_ID = '6a200649c668e2cb8f11e82b';
const BSA_LEAGUE_WEBFLOW_ID = '6a32a9cb63396a5393212f48'; // Brasileiro Série A

if (!WEBFLOW_TOKEN) {
  console.error('Missing WEBFLOW_TOKEN env var. Run like:');
  console.error('  WEBFLOW_TOKEN=xxx node diagnose-matches.js');
  process.exit(1);
}

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

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
    if (!res.ok) throw new Error('Webflow GET items: ' + res.status + ' ' + (await res.text()));
    var data = await res.json();
    items = items.concat(data.items || []);
    if (items.length >= (data.pagination ? data.pagination.total : 0)) break;
    offset += limit;
    await sleep(200);
  }
  return items;
}

function fmtDate(d) {
  try { return new Date(d).toISOString(); } catch (e) { return String(d); }
}

async function main() {
  console.log('Fetching Matches collection (read-only)...\n');
  var allMatches = await wfGetAllItems(MATCHES_COLLECTION_ID);
  console.log('Total match items in collection: ' + allMatches.length + '\n');

  // ── Check 1: duplicate api-fixture-id ──────────────────────
  var byFixtureId = new Map();
  var missingFixtureId = 0;
  for (var it of allMatches) {
    var fid = it.fieldData ? it.fieldData['api-fixture-id'] : null;
    if (!fid) { missingFixtureId++; continue; }
    var key = String(fid);
    if (!byFixtureId.has(key)) byFixtureId.set(key, []);
    byFixtureId.get(key).push(it);
  }
  var dupeFixtureIds = [...byFixtureId.entries()].filter(function (e) { return e[1].length > 1; });

  console.log('=== CHECK 1: Duplicate api-fixture-id ===');
  console.log('Items missing api-fixture-id entirely: ' + missingFixtureId);
  if (dupeFixtureIds.length === 0) {
    console.log('No duplicate api-fixture-id values found.\n');
  } else {
    console.log('Found ' + dupeFixtureIds.length + ' fixture IDs with duplicate CMS items:');
    for (var d of dupeFixtureIds) {
      console.log('  fixture-id ' + d[0] + ':');
      for (var dup of d[1]) {
        console.log('    - item ' + dup.id + ' | ' + (dup.fieldData.name || '?') +
          ' | status=' + dup.fieldData.status + ' | date=' + fmtDate(dup.fieldData['match-date']));
      }
    }
    console.log('');
  }

  // ── Check 2: same home/away team pair appearing multiple times ──
  var byTeamPair = new Map();
  for (var it2 of allMatches) {
    var fd = it2.fieldData || {};
    if (!fd['home-team'] || !fd['away-team']) continue;
    var pairKey = fd['home-team'] + '__' + fd['away-team'];
    if (!byTeamPair.has(pairKey)) byTeamPair.set(pairKey, []);
    byTeamPair.get(pairKey).push(it2);
  }
  var dupePairs = [...byTeamPair.entries()].filter(function (e) { return e[1].length > 1; });

  console.log('=== CHECK 2: Same home/away team-ID pair on multiple items ===');
  console.log('(Legit for teams that play each other twice a season — home leg + away leg');
  console.log(' is a DIFFERENT pair since home/away flip, so real dupes here are more likely bugs)');
  if (dupePairs.length === 0) {
    console.log('None found.\n');
  } else {
    console.log('Found ' + dupePairs.length + ' team-ID pairs with multiple match items:');
    for (var p of dupePairs) {
      console.log('  pair ' + p[0] + ':');
      for (var pm of p[1]) {
        console.log('    - item ' + pm.id + ' | ' + (pm.fieldData.name || '?') +
          ' | status=' + pm.fieldData.status + ' | date=' + fmtDate(pm.fieldData['match-date']) +
          ' | fixture-id=' + pm.fieldData['api-fixture-id']);
      }
    }
    console.log('');
  }

  // ── Check 3: what's actually "Upcoming" for Brasileirão, sorted by date ──
  var bsaUpcoming = allMatches.filter(function (it3) {
    var fd = it3.fieldData || {};
    return fd.league === BSA_LEAGUE_WEBFLOW_ID && fd.status === 'Upcoming';
  });
  bsaUpcoming.sort(function (a, b) {
    return new Date(a.fieldData['match-date']) - new Date(b.fieldData['match-date']);
  });

  console.log('=== CHECK 3: Brasileirão items with status="Upcoming", sorted by match-date ===');
  console.log('(This is what the front-end SHOULD be showing in the Upcoming Matches panel)\n');
  if (bsaUpcoming.length === 0) {
    console.log('No Brasileirão items found with status=Upcoming. That itself would explain');
    console.log('a broken panel — check whether mapMatchStatus() is producing "Upcoming" at all,');
    console.log('or whether the CMS field is actually named/valued differently than expected.\n');
  } else {
    for (var u of bsaUpcoming.slice(0, 15)) {
      var fd3 = u.fieldData;
      console.log('  ' + fmtDate(fd3['match-date']) + '  |  round: ' + fd3['round-label'] +
        '  |  ' + fd3.name + '  |  fixture-id=' + fd3['api-fixture-id'] + '  |  item=' + u.id);
    }
    if (bsaUpcoming.length > 15) console.log('  ... and ' + (bsaUpcoming.length - 15) + ' more');
    console.log('');
  }

  // ── Check 4: all Brasileirão matches around "now", regardless of status ──
  var now = Date.now();
  var weekMs = 7 * 24 * 60 * 60 * 1000;
  var nearNow = allMatches.filter(function (it4) {
    var fd = it4.fieldData || {};
    if (fd.league !== BSA_LEAGUE_WEBFLOW_ID) return false;
    var t = new Date(fd['match-date']).getTime();
    return Math.abs(t - now) < weekMs;
  });
  nearNow.sort(function (a, b) { return new Date(a.fieldData['match-date']) - new Date(b.fieldData['match-date']); });

  console.log('=== CHECK 4: ALL Brasileirão match items within +/- 7 days of now (any status) ===');
  for (var n of nearNow) {
    var fd4 = n.fieldData;
    console.log('  ' + fmtDate(fd4['match-date']) + '  |  status=' + fd4.status +
      '  |  round: ' + fd4['round-label'] + '  |  ' + fd4.name +
      '  |  score: ' + fd4['home-score'] + '-' + fd4['away-score'] +
      '  |  fixture-id=' + fd4['api-fixture-id']);
  }
  console.log('');

  console.log('Done. This script made zero writes to Webflow or Supabase.');
}

main().catch(function (err) {
  console.error('Diagnostic failed: ' + err.message);
  process.exit(1);
});
