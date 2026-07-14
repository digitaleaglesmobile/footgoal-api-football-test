// ============================================================
// sync-live-wc.js — footgoal.co
// World Cup 2026 companion to sync-live.js. Same 1-min-safe pattern:
// one cheap live-check call, only touches items that are both (a) live
// right now and (b) already have a fixture_id filled in.
//
// TWO MODES:
//   node sync-live-wc.js inspect   -> READ-ONLY. Fetches one Team Matches
//                                      item and prints its real field keys,
//                                      so we can confirm the exact slugs
//                                      before enabling live writes below.
//   node sync-live-wc.js           -> normal run (live-check + update).
//                                      Do NOT run this until the FIELDS
//                                      block below has been confirmed
//                                      against inspect mode's output.
// ============================================================

const WEBFLOW_TOKEN = process.env.WEBFLOW_TOKEN;
const API_FOOTBALL_KEY = process.env.API_FOOTBALL_KEY;

const WC_COLLECTION_ID = '69d602cd83a7134a6382aede'; // Team Matches
const WC_LEAGUE_ID = 1;    // World Cup
const WC_SEASON = 2026;

// ⚠️ UNCONFIRMED GUESSES based on Webflow's default label->slug pattern.
// Run `node sync-live-wc.js inspect` first and compare against real output
// before trusting these for a live run.
const FIELDS = {
  fixtureId: 'fixture-id-3',
  team1Score: 'team-1-score',
  team2Score: 'team-2-score',
  matchStatus: 'match-status',
};

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function apiFetch(path) {
  await sleep(200);
  const res = await fetch('https://v3.football.api-sports.io' + path, {
    headers: { 'x-apisports-key': API_FOOTBALL_KEY }
  });
  if (res.status === 429) {
    console.warn('API-Football rate limited - waiting 30s');
    await sleep(30000);
    return apiFetch(path);
  }
  if (!res.ok) throw new Error('API-Football ' + res.status + ': ' + (await res.text()));
  return res.json();
}

async function wfGetAllItems(collectionId) {
  let items = [];
  let offset = 0;
  const limit = 100;
  while (true) {
    const res = await fetch(
      `https://api.webflow.com/v2/collections/${collectionId}/items?limit=${limit}&offset=${offset}`,
      { headers: { Authorization: 'Bearer ' + WEBFLOW_TOKEN, accept: 'application/json' } }
    );
    if (!res.ok) throw new Error('Webflow GET items: ' + res.status);
    const data = await res.json();
    items = items.concat(data.items || []);
    if (items.length >= (data.pagination ? data.pagination.total : 0)) break;
    offset += limit;
  }
  return items;
}

async function wfUpdateItem(collectionId, itemId, fieldData) {
  const res = await fetch(`https://api.webflow.com/v2/collections/${collectionId}/items/${itemId}`, {
    method: 'PATCH',
    headers: { Authorization: 'Bearer ' + WEBFLOW_TOKEN, 'Content-Type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ fieldData })
  });
  if (!res.ok) throw new Error('Webflow PATCH: ' + (await res.text()));
  return res.json();
}

async function wfPublishItems(collectionId, itemIds) {
  if (!itemIds.length) return;
  const res = await fetch(`https://api.webflow.com/v2/collections/${collectionId}/items/publish`, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + WEBFLOW_TOKEN, 'Content-Type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ itemIds })
  });
  if (!res.ok) console.warn('Publish warning: ' + (await res.text()));
}

// ── INSPECT MODE ────────────────────────────────────────────
async function runInspect() {
  console.log('Fetching one item from Team Matches to show real field keys...\n');
  const items = await wfGetAllItems(WC_COLLECTION_ID);
  if (items.length === 0) {
    console.log('No items found in this collection. Check WC_COLLECTION_ID.');
    return;
  }
  // Prefer an item that already has a fixture_id set, if any, so score
  // fields are more likely visible/relevant; otherwise just use the first.
  const sample = items.find(i => i.fieldData && i.fieldData[FIELDS.fixtureId]) || items[0];
  console.log('Sample item name: ' + (sample.fieldData.name || '(no name field)'));
  console.log('\nFull fieldData keys and values:\n');
  console.log(JSON.stringify(sample.fieldData, null, 2));
  console.log('\n---');
  console.log('Compare the keys above to the FIELDS block near the top of this file.');
  console.log('Update FIELDS to match exactly, then re-run without "inspect" for a real sync.');
}

// ── LIVE-CHECK + UPDATE MODE ────────────────────────────────
async function runSync() {
  console.log('sync-live-wc.js tick @ ' + new Date().toISOString());

  const liveData = await apiFetch('/fixtures?live=all');
  const liveFixtures = (liveData.response || []).filter(f => f.league.id === WC_LEAGUE_ID);

  if (liveFixtures.length === 0) {
    console.log('No live World Cup matches right now - exiting (1 API call used).');
    return;
  }

  console.log('LIVE World Cup fixtures right now: ' + liveFixtures.map(f => f.teams.home.name + ' vs ' + f.teams.away.name).join(', '));

  const wcItems = await wfGetAllItems(WC_COLLECTION_ID);
  const itemByFixtureId = new Map();
  for (const item of wcItems) {
    const fid = item.fieldData ? item.fieldData[FIELDS.fixtureId] : null;
    if (fid) itemByFixtureId.set(String(fid), item);
  }

  const updatedIds = [];
  for (const fixture of liveFixtures) {
    const match = itemByFixtureId.get(String(fixture.fixture.id));
    if (!match) {
      console.log('Fixture ' + fixture.fixture.id + ' is live but no matching CMS item found (fixture_id not filled in yet for this match) - skipping.');
      continue;
    }
    const statusMap = { '1H': 'Live', '2H': 'Live', 'HT': 'Live', 'ET': 'Live', 'P': 'Live', 'FT': 'Played', 'AET': 'Played', 'PEN': 'Played' };
    const status = statusMap[fixture.fixture.status.short] || 'Upcoming';

    const fieldData = {
      [FIELDS.team1Score]: fixture.goals.home,
      [FIELDS.team2Score]: fixture.goals.away,
      [FIELDS.matchStatus]: status,
    };
    try {
      await wfUpdateItem(WC_COLLECTION_ID, match.id, fieldData);
      updatedIds.push(match.id);
      console.log('Updated: ' + fixture.teams.home.name + ' ' + fixture.goals.home + '-' + fixture.goals.away + ' ' + fixture.teams.away.name + ' (' + status + ')');
    } catch (err) {
      console.error('Failed to update ' + fixture.fixture.id + ': ' + err.message);
    }
  }
  await wfPublishItems(WC_COLLECTION_ID, updatedIds);
  console.log('sync-live-wc.js tick complete. ' + updatedIds.length + ' item(s) updated.');
}

async function main() {
  const mode = process.argv[2];
  if (mode === 'inspect') {
    await runInspect();
  } else {
    await runSync();
  }
}

main().catch(err => { console.error('Fatal error: ' + err.message); process.exit(1); });
