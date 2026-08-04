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

async function apiFootball(path, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    const res = await fetch(`${API_FOOTBALL_BASE}${path}`, {
      headers: { "x-apisports-key": API_FOOTBALL_KEY },
    });

    if (res.status === 429) {
      // Rate limited — back off and retry.
      const wait = attempt * 2000;
      console.warn(`Rate limited on ${path}, waiting ${wait}ms (attempt ${attempt}/${retries})`);
      await sleep(wait);
      continue;
    }

    if (!res.ok) {
      if (attempt < retries) {
        const wait = attempt * 1000;
        console.warn(
          `API-Football ${path} -> ${res.status}, retrying in ${wait}ms (attempt ${attempt}/${retries})`
        );
        await sleep(wait);
        continue;
      }
      throw new Error(`API-Football ${path} -> ${res.status} ${res.statusText}`);
    }

    const data = await res.json();
    // API-Football sometimes returns 200 with an "errors" object (e.g. quota,
    // invalid params) instead of an HTTP error code — treat that as a failure too.
    if (data.errors && Object.keys(data.errors).length > 0) {
      if (attempt < retries) {
        const wait = attempt * 1000;
        console.warn(
          `API-Football ${path} returned errors: ${JSON.stringify(data.errors)}, retrying in ${wait}ms`
        );
        await sleep(wait);
        continue;
      }
      throw new Error(`API-Football ${path} returned errors: ${JSON.stringify(data.errors)}`);
    }

    return data;
  }
  throw new Error(`API-Football ${path} failed after ${retries} attempts`);
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
//
// IMPORTANT: API-Football sometimes has more than one career entry marked
// end:null for the same team (stale/duplicate data on their side) — e.g.
// it returned "J. Heynckes" for Bayern Munich, who left in 2018. Trusting
// end:null alone is not reliable. Instead, collect ALL end:null entries for
// this team across all coaches, then pick the one with the most recent
// "start" date — that's the actual current appointment.
async function getCurrentCoach(apiTeamId) {
  const data = await apiFootball(`/coachs?team=${apiTeamId}`);
  if (!data.response || data.response.length === 0) return null;

  let best = null; // { name, start }
  for (const coach of data.response) {
    const career = coach.career || [];
    for (const c of career) {
      if (!c.team || c.team.id !== Number(apiTeamId)) continue;
      if (c.end !== null) continue; // only open-ended (current) stints
      if (!c.start) continue;
      if (!best || new Date(c.start) > new Date(best.start)) {
        best = { name: coach.name, start: c.start };
      }
    }
  }
  if (best) return best.name;

  // Fallback: nothing marked current at all — take the entry with the most
  // recent start date regardless of end, better than a random pick.
  let mostRecent = null;
  for (const coach of data.response) {
    const career = coach.career || [];
    for (const c of career) {
      if (!c.team || c.team.id !== Number(apiTeamId) || !c.start) continue;
      if (!mostRecent || new Date(c.start) > new Date(mostRecent.start)) {
        mostRecent = { name: coach.name, start: c.start };
      }
    }
  }
  return mostRecent ? mostRecent.name : null;
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
        await sleep(600); // be polite to the API
      } catch (err) {
        console.error(`Name lookup failed for "${fd.name}": ${err.message}`);
        unresolved.push(fd.name);
        continue;
      }
    }

    try {
      // Sequential, not Promise.all — keeps request pacing predictable and
      // avoids bursts that trip rate limiting.
      const manager = fd.manager ? fd.manager : await getCurrentCoach(apiTeamId);
      await sleep(600);
      const capacity = fd.capacity ? fd.capacity : await getCapacity(apiTeamId);
      await sleep(600); // rate-limit friendliness

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
