// ============================================================
// inspect-topscorers.js — footgoal.co
// READ-ONLY. Fetches one Top Scorers item and prints its real field
// keys, so we confirm the exact player-ID field slug before building
// the dry-run matcher / write script.
//
// USAGE: node inspect-topscorers.js
// ============================================================

const WEBFLOW_TOKEN = process.env.WEBFLOW_TOKEN;
const TOP_SCORERS_COLLECTION_ID = '6a32a89633c9bd6bea624094';

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

async function main() {
  console.log('Fetching Top Scorers items to show real field keys...\n');
  const items = await wfGetAllItems(TOP_SCORERS_COLLECTION_ID);
  if (items.length === 0) {
    console.log('No items found in this collection. Double check the collection ID.');
    return;
  }
  console.log('Total items in collection: ' + items.length + '\n');
  console.log('Sample item name: ' + (items[0].fieldData.name || '(no name field)'));
  console.log('\nFull fieldData keys and values (first item):\n');
  console.log(JSON.stringify(items[0].fieldData, null, 2));

  console.log('\n---');
  console.log('Look for the field holding a player-ID-shaped value (a number, likely empty/null right now since none are filled in yet).');
  console.log('Tell me that exact key name so I can build the matcher script correctly.');
}

main().catch(err => { console.error('Fatal error: ' + err.message); process.exit(1); });
