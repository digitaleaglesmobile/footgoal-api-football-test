/**
 * fix-alt-text.js
 *
 * Bulk-fixes missing image alt text on footgoal.co's Webflow CMS.
 * Covers:
 *   - Matches collection (home-badge / away-badge images)
 *   - Top Scorers collection (photo / scorer-badge images)
 *
 * Runs entirely outside of chat — uses the Webflow API directly with
 * your own API token, so it costs nothing but a few minutes of runtime.
 *
 * USAGE:
 *   1. npm install node-fetch  (only needed on Node < 18; Node 18+ has fetch built in)
 *   2. export WEBFLOW_API_TOKEN="your-token-here"
 *   3. node fix-alt-text.js
 *
 * Safe to re-run: it only touches items where alt is currently null/empty,
 * so running it twice won't duplicate or corrupt anything.
 */

const API_BASE = "https://api.webflow.com/v2";
const TOKEN = process.env.WEBFLOW_API_TOKEN;

if (!TOKEN) {
  console.error("ERROR: Set WEBFLOW_API_TOKEN environment variable first.");
  process.exit(1);
}

// ---- Collection IDs (footgoal.co / World Cup 26 site) ----
const SITE_ID = "69c3c0da2fd37856ad9e297a";
const TEAMS_COLLECTION_ID = "6a20064807685f373db26660";
const MATCHES_COLLECTION_ID = "6a200649c668e2cb8f11e82b";
const TOP_SCORERS_COLLECTION_ID = "6a32a89633c9bd6bea624094";

// ---- Simple helpers ----

async function webflowRequest(path, options = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Webflow API error ${res.status} on ${path}: ${body}`);
  }
  return res.json();
}

// Basic delay so we stay comfortably under Webflow's rate limits (60 req/min).
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function listAllItems(collectionId) {
  const all = [];
  let offset = 0;
  const limit = 100;
  while (true) {
    const data = await webflowRequest(
      `/collections/${collectionId}/items?limit=${limit}&offset=${offset}`
    );
    all.push(...data.items);
    if (data.items.length < limit) break;
    offset += limit;
    await sleep(600);
  }
  return all;
}

async function updateItemsBatch(collectionId, items) {
  // Webflow's bulk update endpoint accepts up to 100 items per call.
  return webflowRequest(`/collections/${collectionId}/items`, {
    method: "PATCH",
    body: JSON.stringify({ items }),
  });
}

async function publishItemsBatch(collectionId, itemIds) {
  return webflowRequest(`/collections/${collectionId}/items/publish`, {
    method: "POST",
    body: JSON.stringify({ itemIds }),
  });
}

async function processInBatches(items, batchSize, fn) {
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    await fn(batch, i);
    await sleep(800);
  }
}

// ---- Step 1: Fix Matches (home-badge / away-badge) ----

async function fixMatches() {
  console.log("\n=== Matches collection ===");
  console.log("Fetching all teams (to resolve badge names)...");
  const teams = await listAllItems(TEAMS_COLLECTION_ID);
  const teamNameById = new Map(teams.map((t) => [t.id, t.fieldData.name]));
  console.log(`Loaded ${teams.length} teams.`);

  console.log("Fetching all matches...");
  const matches = await listAllItems(MATCHES_COLLECTION_ID);
  console.log(`Loaded ${matches.length} matches.`);

  const updates = [];
  for (const item of matches) {
    const fd = item.fieldData;
    const homeName = teamNameById.get(fd["home-team"]) || null;
    const awayName = teamNameById.get(fd["away-team"]) || null;
    const changed = {};

    if (fd["home-badge"] && fd["home-badge"].alt == null && homeName) {
      changed["home-badge"] = { ...fd["home-badge"], alt: `${homeName} badge` };
    }
    if (fd["away-badge"] && fd["away-badge"].alt == null && awayName) {
      changed["away-badge"] = { ...fd["away-badge"], alt: `${awayName} badge` };
    }

    if (Object.keys(changed).length > 0) {
      updates.push({
        id: item.id,
        fieldData: { ...changed, name: fd.name, slug: fd.slug },
      });
    }
  }

  console.log(`${updates.length} matches need an alt-text update.`);
  if (updates.length === 0) return;

  const publishedIds = [];
  await processInBatches(updates, 100, async (batch, i) => {
    console.log(`Updating matches ${i + 1}-${i + batch.length} of ${updates.length}...`);
    await updateItemsBatch(MATCHES_COLLECTION_ID, batch);
    publishedIds.push(...batch.map((b) => b.id));
  });

  console.log("Publishing updated matches...");
  await processInBatches(publishedIds, 100, async (batch, i) => {
    console.log(`Publishing ${i + 1}-${i + batch.length} of ${publishedIds.length}...`);
    await publishItemsBatch(MATCHES_COLLECTION_ID, batch);
  });

  console.log("Matches collection done.");
}

// ---- Step 2: Fix Top Scorers (photo / scorer-badge) ----

async function fixTopScorers() {
  console.log("\n=== Top Scorers collection ===");
  const scorers = await listAllItems(TOP_SCORERS_COLLECTION_ID);
  console.log(`Loaded ${scorers.length} top scorers.`);

  const updates = [];
  for (const item of scorers) {
    const fd = item.fieldData;
    const changed = {};

    if (fd.photo && fd.photo.alt == null) {
      changed.photo = { ...fd.photo, alt: `${fd.name} photo` };
    }
    if (fd["scorer-badge"] && fd["scorer-badge"].alt == null) {
      changed["scorer-badge"] = { ...fd["scorer-badge"], alt: `${fd.name} team badge` };
    }

    if (Object.keys(changed).length > 0) {
      updates.push({
        id: item.id,
        fieldData: { ...changed, name: fd.name, slug: fd.slug },
      });
    }
  }

  console.log(`${updates.length} top scorers need an alt-text update.`);
  if (updates.length === 0) return;

  const publishedIds = [];
  await processInBatches(updates, 100, async (batch, i) => {
    console.log(`Updating top scorers ${i + 1}-${i + batch.length} of ${updates.length}...`);
    await updateItemsBatch(TOP_SCORERS_COLLECTION_ID, batch);
    publishedIds.push(...batch.map((b) => b.id));
  });

  console.log("Publishing updated top scorers...");
  await processInBatches(publishedIds, 100, async (batch, i) => {
    console.log(`Publishing ${i + 1}-${i + batch.length} of ${publishedIds.length}...`);
    await publishItemsBatch(TOP_SCORERS_COLLECTION_ID, batch);
  });

  console.log("Top Scorers collection done.");
}

// ---- Run ----

(async () => {
  try {
    await fixMatches();
    await fixTopScorers();
    console.log("\nAll done! Trigger a fresh Ahrefs crawl to confirm the missing-alt-text count has dropped.");
  } catch (err) {
    console.error("\nScript failed:", err.message);
    process.exit(1);
  }
})();
