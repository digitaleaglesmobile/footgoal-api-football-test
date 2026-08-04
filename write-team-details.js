/**
 * write-team-details.js
 *
 * Pulls current Manager (coach) and Stadium Capacity from API-Football
 * and writes them into the Teams collection on Webflow (footgoal.co).
 *
 * Follows the same pattern as write-topscorers.js:
 *   - Dry-run by default. Set CONFIRM=yes to actually write to Webflow.
 *   - Matches teams by api-team-id first; falls back to name matching
 *     for the ~51 teams that don't have an api-team-id stored yet.
 *   - Only touches the `manager` and `capacity` fields — nothing else.
 *
 * Required env vars:
 *   API_FOOTBALL_KEY   - your API-Football (api-sports.io) key
 *   WEBFLOW_TOKEN       - Webflow API token (same one used elsewhere)
 *   CONFIRM=yes         - required to actually write (omit for dry-run)
 *
 * NOTE ON SQUAD VALUE: API-Football does not provide squad/market value
 * data. That field is intentionally left out of this script. If you want
 * it, you'd need a separate source (e.g. a licensed financial-data API) —
 * do not scrape Transfermarkt, it violates their ToS.
 */

const TEAMS_COLLECTION_ID = "6a20064807685f373db26660";
const WEBFLOW_API_BASE = "https://api.webflow.com/v2";
const API_FOOTBALL_BASE = "https://v3.football.api-sports.io";

const API_FOOTBALL_KEY = process.env.API_FOOTBALL_KEY;
const WEBFLOW_TOKEN = process.env.WEBFLOW_TOKEN;
const CONFIRM = process.env.CONFIRM === "yes";

if (!API_FOOTBALL_KEY || !WEBFLOW_TOKEN) {
  console.error("Missing API_FOOTBALL_KEY or WEBFLOW_TOKEN env vars.");
  process.exit(1);
}

// ---- helpers -------------------------------------------------------------

async function apiFootball(path) {
  const res = await fetch(`${API_FOOTBALL_BASE}${path}`, {
    headers: { "x-apisports-key": API_FOOTBALL_KEY },
  });
  if (!res.ok) {
    throw new Error(`API-Football ${path} -> ${res.status} ${res.statusText}`);
  }
  return res.json();
}

async function webflow(path, options = {}) {
  const res = await fetch(`${WEBFLOW_API_BASE}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${WEBFLOW_TOKEN}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Webflow ${path} -> ${res.status} ${res.statusText}: ${body}`);
  }
  return res.json();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Simple normalizer for fallback name matching (strip punctuation/case)
function normalize(name) {
  return name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // strip accents
    .replace(/[^a-z0-9]/g, "");
}

// ---- fetch all Webflow team items -----------------------------------------

async function getAllTeams() {
  let items = [];
  let offset = 0;
  const limit = 100;
  while (true) {
    const page = await webflow(
      `/collections/${TEAMS_COLLECTION_ID}/items?limit=${limit}&offset=${offset}`
    );
    items = items.concat(page.items);
    if (page.items.length < limit) break;
    offset += limit;
  }
  return items;
}

// ---- API-Football lookups ---------------------------------------------

// Returns the current coach's name for a given API-Football team id, or null.
async function getCurrentCoach(apiTeamId) {
  const data = await apiFootball(`/coachs?team=${apiTeamId}`);
  if (!data.response || data.response.length === 0) return null;

  // API-Football returns all coaches associated with the team historically.
  // Find the one whose career entry for this team has no "end" date (current).
  for (const coach of data.response) {
    const career = coach.career || [];
    const current = career.find(
      (c) => c.team && c.team.id === Number(apiTeamId) && c.end === null
    );
    if (current) return coach.name;
  }
  // Fallback: if nothing marked "current", just take the first result's name.
  return data.response[0].name || null;
}

// Returns stadium capacity for a given API-Football team id, or null.
async function getCapacity(apiTeamId) {
  const data = await apiFootball(`/teams?id=${apiTeamId}`);
  if (!data.response || data.response.length === 0) return null;
  const venue = data.response[0].venue;
  return venue && venue.capacity ? venue.capacity : null;
}

// Look up an API-Football team id by name when api-team-id is missing.
// Uses API-Football's /teams?search= endpoint and picks the closest name match.
async function findTeamIdByName(teamName) {
  const data = await apiFootball(`/teams?search=${encodeURIComponent(teamName)}`);
  if (!data.response || data.response.length === 0) return null;

  const target = normalize(teamName);
  let best = null;
  for (const entry of data.response) {
    const candidate = normalize(entry.team.name);
    if (candidate === target) return entry.team.id; // exact match, done
    if (!best && (candidate.includes(target) || target.includes(candidate))) {
      best = entry.team.id; // loose match, keep looking for exact
    }
  }
  return best;
}

// ---- main ------------------------------------------------------------

async function main() {
  console.log(CONFIRM ? "=== LIVE RUN ===" : "=== DRY RUN (set CONFIRM=yes to write) ===");

  const teams = await getAllTeams();
  console.log(`Fetched ${teams.length} teams from Webflow.\n`);

  const updates = [];
  const unresolved = [];

  for (const item of teams) {
    const fd = item.fieldData;
    let apiTeamId = fd["api-team-id"];

    // Fallback: resolve via name search if api-team-id is missing.
    if (!apiTeamId) {
      try {
        const resolvedId = await findTeamIdByName(fd.name);
        if (!resolvedId) {
          unresolved.push(fd.name);
          continue;
        }
        apiTeamId = resolvedId;
        await sleep(250); // be polite to the API
      } catch (err) {
        console.error(`Name lookup failed for "${fd.name}": ${err.message}`);
        unresolved.push(fd.name);
        continue;
      }
    }

    try {
      const [manager, capacity] = await Promise.all([
        fd.manager ? Promise.resolve(fd.manager) : getCurrentCoach(apiTeamId),
        fd.capacity ? Promise.resolve(fd.capacity) : getCapacity(apiTeamId),
      ]);
      await sleep(250); // rate-limit friendliness

      const patch = {};
      if (!fd.manager && manager) patch.manager = manager;
      if (!fd.capacity && capacity) patch.capacity = capacity;

      if (Object.keys(patch).length > 0) {
        updates.push({ id: item.id, name: fd.name, apiTeamId, patch });
      }
    } catch (err) {
      console.error(`Lookup failed for "${fd.name}" (id ${apiTeamId}): ${err.message}`);
      unresolved.push(fd.name);
    }
  }

  console.log(`\n${updates.length} teams have new data to write:`);
  for (const u of updates) {
    console.log(
      `  ${u.name}: ${JSON.stringify(u.patch)}`
    );
  }

  if (unresolved.length > 0) {
    console.log(`\n${unresolved.length} teams could not be resolved / had no data found:`);
    unresolved.forEach((n) => console.log(`  - ${n}`));
  }

  if (!CONFIRM) {
    console.log("\nDry run complete. Re-run with CONFIRM=yes to write these changes.");
    return;
  }

  // Write in batches of 100 (Webflow's bulk update limit).
  for (let i = 0; i < updates.length; i += 100) {
    const batch = updates.slice(i, i + 100);
    await webflow(`/collections/${TEAMS_COLLECTION_ID}/items`, {
      method: "PATCH",
      body: JSON.stringify({
        items: batch.map((u) => ({ id: u.id, fieldData: u.patch })),
      }),
    });
    console.log(`Wrote batch of ${batch.length} items (staged as drafts).`);
  }

  // Publish everything that was updated.
  const allIds = updates.map((u) => u.id);
  for (let i = 0; i < allIds.length; i += 100) {
    const batch = allIds.slice(i, i + 100);
    await webflow(`/collections/${TEAMS_COLLECTION_ID}/items/publish`, {
      method: "POST",
      body: JSON.stringify({ itemIds: batch }),
    });
    console.log(`Published batch of ${batch.length} items.`);
  }

  console.log("\nDone.");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
