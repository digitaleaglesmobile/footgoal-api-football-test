// ============================================================
// sync-top-scorers-2026.js — footgoal.co
//
// LIVE Top Scorers sync for ALL 8 leagues.
//
// SAFETY:
// Nothing is written unless CONFIRM=yes.
//
// Logic:
// - Fetch API-Football season 2026 top scorers
// - Target = Top 10 per league
// - Match existing CMS items by API Player ID first
// - Exact full-name fallback only
// - NO fuzzy surname matching
// - NO rank-based matching
// - Update/create current Top 10
// - Publish current Top 10
// - Unpublish stale scorers, but DO NOT delete them
//
// If a league has no 2026 scorer data yet:
// - its existing scorer items are unpublished
// - they remain saved in Webflow CMS
//
// If a write/team-resolution error occurs for a league:
// - current successful updates may still be published
// - stale items for that league are NOT unpublished
//
// ============================================================


const WEBFLOW_TOKEN = process.env.WEBFLOW_TOKEN;
const API_FOOTBALL_KEY = process.env.API_FOOTBALL_KEY;
const CONFIRM = process.env.CONFIRM === 'yes';


// ============================================================
// CONFIG
// ============================================================

const TOP_SCORERS_COLLECTION_ID =
  '6a32a89633c9bd6bea624094';

const TEAMS_COLLECTION_ID =
  '6a20064807685f373db26660';

const TARGET_TOP_N = 10;


const LEAGUES = [
  {
    code: 'PL',
    name: 'Premier League',
    api_id: 39,
    webflow_id: '6a32a9cb63396a5393212f3a',
    season: 2026
  },
  {
    code: 'LL',
    name: 'La Liga',
    api_id: 140,
    webflow_id: '6a32a9cb63396a5393212f3e',
    season: 2026
  },
  {
    code: 'BL',
    name: 'Bundesliga',
    api_id: 78,
    webflow_id: '6a32a9cb63396a5393212f40',
    season: 2026
  },
  {
    code: 'SA',
    name: 'Serie A',
    api_id: 135,
    webflow_id: '6a32a9cb63396a5393212f42',
    season: 2026
  },
  {
    code: 'ERE',
    name: 'Eredivisie',
    api_id: 88,
    webflow_id: '6a32a9cb63396a5393212f44',
    season: 2026
  },
  {
    code: 'L1',
    name: 'Ligue 1',
    api_id: 61,
    webflow_id: '6a32a9cb63396a5393212f46',
    season: 2026
  },
  {
    code: 'BSA',
    name: 'Brasileiro Série A',
    api_id: 71,
    webflow_id: '6a32a9cb63396a5393212f48',
    season: 2026
  },
  {
    code: 'UCL',
    name: 'UEFA Champions League',
    api_id: 2,
    webflow_id: '6a32a9cb63396a5393212f3c',
    season: 2026
  }
];


// ============================================================
// BASIC HELPERS
// ============================================================

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}


function normalizeName(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}


function slugify(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-+/g, '-');
}


function getField(item, slug) {
  return item && item.fieldData
    ? item.fieldData[slug]
    : null;
}


function looksAbbreviated(name) {
  const value = String(name || '').trim();

  return (
    /^[A-ZÀ-ÖØ-Ý]\.\s+/i.test(value) ||
    /\b[A-ZÀ-ÖØ-Ý]\.\s+/i.test(value)
  );
}


// ============================================================
// PLAYER DISPLAY NAME
// ============================================================

function getFullApiName(player) {
  if (!player) return '';

  const first = String(
    player.firstname || ''
  ).trim();

  const last = String(
    player.lastname || ''
  ).trim();

  const combined = [first, last]
    .filter(Boolean)
    .join(' ')
    .trim();

  if (
    combined &&
    combined.length >= 3 &&
    !looksAbbreviated(combined)
  ) {
    return combined;
  }

  return '';
}


function getPreferredPlayerName(player, existingItem = null) {
  const fullApiName = getFullApiName(player);

  if (fullApiName) {
    return fullApiName;
  }

  const apiName = String(
    player && player.name
      ? player.name
      : ''
  ).trim();

  const existingName = existingItem
    ? String(
        getField(existingItem, 'name') || ''
      ).trim()
    : '';

  if (
    existingName &&
    apiName &&
    looksAbbreviated(apiName) &&
    !looksAbbreviated(existingName)
  ) {
    return existingName;
  }

  return apiName || existingName;
}


function getPossibleExactNames(player) {
  const values = new Set();

  if (player && player.name) {
    values.add(
      normalizeName(player.name)
    );
  }

  const fullName = getFullApiName(player);

  if (fullName) {
    values.add(
      normalizeName(fullName)
    );
  }

  return [...values].filter(Boolean);
}


// ============================================================
// API FOOTBALL
// ============================================================

async function apiFetch(path, retries = 3) {
  await sleep(250);

  const res = await fetch(
    'https://v3.football.api-sports.io' + path,
    {
      headers: {
        'x-apisports-key':
          API_FOOTBALL_KEY
      }
    }
  );

  if (
    res.status === 429 &&
    retries > 0
  ) {
    console.warn(
      'API-Football rate limited — waiting 30 seconds...'
    );

    await sleep(30000);

    return apiFetch(
      path,
      retries - 1
    );
  }

  if (!res.ok) {
    throw new Error(
      'API-Football ' +
      res.status +
      ': ' +
      await res.text()
    );
  }

  const data = await res.json();

  if (
    data.errors &&
    Object.keys(data.errors).length
  ) {
    throw new Error(
      'API-Football errors: ' +
      JSON.stringify(data.errors)
    );
  }

  return data;
}


// ============================================================
// WEBFLOW REQUEST HELPER
// ============================================================

async function wfRequest(
  url,
  options = {},
  retries = 4
) {
  const res = await fetch(
    url,
    options
  );

  if (
    res.status === 429 &&
    retries > 0
  ) {
    console.warn(
      'Webflow rate limited — waiting 5 seconds...'
    );

    await sleep(5000);

    return wfRequest(
      url,
      options,
      retries - 1
    );
  }

  if (!res.ok) {
    throw new Error(
      'Webflow ' +
      res.status +
      ': ' +
      await res.text()
    );
  }

  if (res.status === 204) {
    return null;
  }

  const text = await res.text();

  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}


// ============================================================
// WEBFLOW READ
// ============================================================

async function wfGetAllItems(collectionId) {
  const items = [];

  let offset = 0;
  const limit = 100;

  while (true) {
    const data = await wfRequest(
      'https://api.webflow.com/v2/collections/' +
        collectionId +
        '/items?limit=' +
        limit +
        '&offset=' +
        offset,
      {
        headers: {
          Authorization:
            'Bearer ' + WEBFLOW_TOKEN,

          accept:
            'application/json'
        }
      }
    );

    items.push(
      ...(data.items || [])
    );

    const total =
      data.pagination
        ? data.pagination.total
        : items.length;

    if (
      items.length >= total
    ) {
      break;
    }

    offset += limit;
  }

  return items;
}


// ============================================================
// WEBFLOW UPDATE / CREATE
// ============================================================

async function wfUpdateItem(
  collectionId,
  itemId,
  fieldData
) {
  return wfRequest(
    'https://api.webflow.com/v2/collections/' +
      collectionId +
      '/items/' +
      itemId,
    {
      method: 'PATCH',

      headers: {
        Authorization:
          'Bearer ' + WEBFLOW_TOKEN,

        accept:
          'application/json',

        'content-type':
          'application/json'
      },

      body: JSON.stringify({
        isArchived: false,
        isDraft: false,
        fieldData
      })
    }
  );
}


async function wfCreateItem(
  collectionId,
  fieldData
) {
  return wfRequest(
    'https://api.webflow.com/v2/collections/' +
      collectionId +
      '/items',
    {
      method: 'POST',

      headers: {
        Authorization:
          'Bearer ' + WEBFLOW_TOKEN,

        accept:
          'application/json',

        'content-type':
          'application/json'
      },

      body: JSON.stringify({
        isArchived: false,
        isDraft: false,
        fieldData
      })
    }
  );
}


// ============================================================
// WEBFLOW PUBLISH
// ============================================================

async function wfPublishItems(
  collectionId,
  itemIds
) {
  const uniqueIds =
    [...new Set(itemIds)];

  if (!uniqueIds.length) {
    return;
  }

  for (
    let i = 0;
    i < uniqueIds.length;
    i += 100
  ) {
    const batch =
      uniqueIds.slice(
        i,
        i + 100
      );

    await wfRequest(
      'https://api.webflow.com/v2/collections/' +
        collectionId +
        '/items/publish',
      {
        method: 'POST',

        headers: {
          Authorization:
            'Bearer ' + WEBFLOW_TOKEN,

          accept:
            'application/json',

          'content-type':
            'application/json'
        },

        body: JSON.stringify({
          itemIds: batch
        })
      }
    );

    await sleep(500);
  }
}


// ============================================================
// WEBFLOW UNPUBLISH
// ============================================================

async function wfUnpublishItems(
  collectionId,
  itemIds
) {
  const uniqueIds =
    [...new Set(itemIds)];

  if (!uniqueIds.length) {
    return;
  }

  for (
    let i = 0;
    i < uniqueIds.length;
    i += 100
  ) {
    const batch =
      uniqueIds.slice(
        i,
        i + 100
      );

    await wfRequest(
      'https://api.webflow.com/v2/collections/' +
        collectionId +
        '/items/live',
      {
        method: 'DELETE',

        headers: {
          Authorization:
            'Bearer ' + WEBFLOW_TOKEN,

          accept:
            'application/json',

          'content-type':
            'application/json'
        },

        body: JSON.stringify({
          items: batch.map(id => ({
            id
          }))
        })
      }
    );

    await sleep(500);
  }
}


// ============================================================
// TEAM LOOKUP
// ============================================================

function buildTeamLookup(allTeams) {
  const byApiId = new Map();
  const byName = new Map();

  for (const team of allTeams) {
    const apiId =
      getField(
        team,
        'api-team-id'
      );

    const name =
      getField(
        team,
        'name'
      );

    if (apiId) {
      byApiId.set(
        String(apiId),
        team
      );
    }

    if (name) {
      const normalized =
        normalizeName(name);

      if (
        !byName.has(normalized)
      ) {
        byName.set(
          normalized,
          []
        );
      }

      byName
        .get(normalized)
        .push(team);
    }
  }

  return {
    byApiId,
    byName
  };
}


function resolveTeam(
  apiTeam,
  teamLookup
) {
  if (!apiTeam) {
    return null;
  }

  const idMatch =
    teamLookup
      .byApiId
      .get(
        String(apiTeam.id)
      );

  if (idMatch) {
    return {
      item: idMatch,
      method: 'api-team-id'
    };
  }

  const normalized =
    normalizeName(
      apiTeam.name
    );

  const exact =
    teamLookup
      .byName
      .get(normalized) || [];

  if (
    exact.length === 1
  ) {
    return {
      item: exact[0],
      method: 'exact-name'
    };
  }

  return null;
}


// ============================================================
// EXISTING SCORER LOOKUP
// ============================================================

function buildExistingLookup(items) {
  const byApiPlayerId =
    new Map();

  const byExactName =
    new Map();

  for (const item of items) {
    const apiId =
      getField(
        item,
        'api-player-id'
      );

    const name =
      getField(
        item,
        'name'
      );

    if (apiId) {
      const key =
        String(apiId);

      if (
        !byApiPlayerId.has(key)
      ) {
        byApiPlayerId.set(
          key,
          []
        );
      }

      byApiPlayerId
        .get(key)
        .push(item);
    }

    if (name) {
      const normalized =
        normalizeName(name);

      if (
        !byExactName.has(
          normalized
        )
      ) {
        byExactName.set(
          normalized,
          []
        );
      }

      byExactName
        .get(normalized)
        .push(item);
    }
  }

  return {
    byApiPlayerId,
    byExactName
  };
}


// ============================================================
// PICK SAFEST ITEM FROM DUPLICATES
// ============================================================

function scoreExistingCandidate(
  item,
  player,
  season
) {
  let score = 0;

  const existingName =
    normalizeName(
      getField(
        item,
        'name'
      )
    );

  const possibleNames =
    getPossibleExactNames(player);

  if (
    possibleNames.includes(
      existingName
    )
  ) {
    score += 100;
  }

  if (
    String(
      getField(
        item,
        'season'
      ) || ''
    ) === String(season)
  ) {
    score += 20;
  }

  if (!item.isDraft) {
    score += 10;
  }

  if (!item.isArchived) {
    score += 5;
  }

  return score;
}


function pickBestCandidate(
  candidates,
  player,
  season,
  alreadyMatchedIds
) {
  const available =
    candidates.filter(
      item =>
        !alreadyMatchedIds.has(
          item.id
        )
    );

  if (!available.length) {
    return null;
  }

  return [...available].sort(
    (a, b) =>
      scoreExistingCandidate(
        b,
        player,
        season
      ) -
      scoreExistingCandidate(
        a,
        player,
        season
      )
  )[0];
}


// ============================================================
// EXACT NAME FALLBACK
// ============================================================

function findExactNameCandidates(
  player,
  lookup,
  alreadyMatchedIds
) {
  const result = [];
  const seen = new Set();

  const names =
    getPossibleExactNames(player);

  for (
    const normalizedName
    of names
  ) {
    const matches =
      lookup
        .byExactName
        .get(
          normalizedName
        ) || [];

    for (
      const item
      of matches
    ) {
      if (
        seen.has(item.id) ||
        alreadyMatchedIds.has(
          item.id
        )
      ) {
        continue;
      }

      seen.add(item.id);
      result.push(item);
    }
  }

  return result;
}


// ============================================================
// BUILD CURRENT FIELD DATA
// ============================================================

function buildCurrentFieldData({
  player,
  stats,
  league,
  rank,
  teamMatch,
  existingItem
}) {
  const preferredName =
    getPreferredPlayerName(
      player,
      existingItem
    );

  const goals =
    stats.goals &&
    stats.goals.total != null
      ? Number(
          stats.goals.total
        )
      : 0;

  const assists =
    stats.goals &&
    stats.goals.assists != null
      ? Number(
          stats.goals.assists
        )
      : 0;

  const fieldData = {
    name:
      preferredName,

    'api-player-id':
      String(player.id),

    goals,

    assists,

    nationality:
      player.nationality || '',

    season:
      String(
        league.season
      ),

    league:
      league.webflow_id,

    team:
      teamMatch.item.id,

    rank
  };

  const photoUrl =
    player.photo ||
    (
      !existingItem &&
      stats.team &&
      stats.team.logo
        ? stats.team.logo
        : null
    );

  if (photoUrl) {
    fieldData.photo = {
      url: photoUrl
    };
  }

  return fieldData;
}


// ============================================================
// MAIN
// ============================================================

async function main() {
  if (
    !WEBFLOW_TOKEN ||
    !API_FOOTBALL_KEY
  ) {
    throw new Error(
      'Missing WEBFLOW_TOKEN or API_FOOTBALL_KEY'
    );
  }

  if (!CONFIRM) {
    console.log(
      'SAFETY STOP: nothing was written.'
    );

    console.log(
      'Run with CONFIRM=yes to execute the live sync.'
    );

    return;
  }

  console.log(
    '============================================================'
  );

  console.log(
    'LIVE TOP SCORERS 2026 SYNC'
  );

  console.log(
    'ALL 8 LEAGUES'
  );

  console.log(
    '============================================================\n'
  );

  console.log(
    'Loading Webflow Top Scorers...'
  );

  const allScorers =
    await wfGetAllItems(
      TOP_SCORERS_COLLECTION_ID
    );

  console.log(
    'Top Scorers CMS items: ' +
    allScorers.length
  );

  console.log(
    '\nLoading Webflow Teams...'
  );

  const allTeams =
    await wfGetAllItems(
      TEAMS_COLLECTION_ID
    );

  console.log(
    'Teams CMS items: ' +
    allTeams.length
  );

  const teamLookup =
    buildTeamLookup(
      allTeams
    );

  let totalUpdated = 0;
  let totalCreated = 0;
  let totalRelinked = 0;
  let totalUnpublished = 0;
  let totalRepublished = 0;
  let totalErrors = 0;


  for (
    const league
    of LEAGUES
  ) {
    console.log(
      '\n\n============================================================'
    );

    console.log(
      league.name +
      ' — season ' +
      league.season
    );

    console.log(
      '============================================================'
    );

    const leagueItems =
      allScorers.filter(
        item =>
          getField(
            item,
            'league'
          ) ===
          league.webflow_id
      );

    console.log(
      'Existing CMS scorer items: ' +
      leagueItems.length
    );

    const existingLookup =
      buildExistingLookup(
        leagueItems
      );

    console.log(
      'Fetching current API Top Scorers...'
    );

    let apiData;

    try {
      apiData =
        await apiFetch(
          '/players/topscorers?league=' +
            league.api_id +
            '&season=' +
            league.season
        );
    } catch (err) {
      totalErrors++;

      console.error(
        'API ERROR — skipping league safely:',
        err.message
      );

      continue;
    }

    const apiList =
      apiData.response || [];

    const currentTop =
      apiList.slice(
        0,
        TARGET_TOP_N
      );

    console.log(
      'API scorers returned: ' +
      apiList.length
    );

    console.log(
      'Target current list: ' +
      currentTop.length
    );

    if (
      currentTop.length === 0
    ) {
      console.log(
        'No 2026 scorer data yet.'
      );

      const liveOldIds =
        leagueItems
          .filter(
            item =>
              !item.isDraft
          )
          .map(
            item => item.id
          );

      if (!liveOldIds.length) {
        console.log(
          'No live stale scorer items to unpublish.'
        );

        continue;
      }

      console.log(
        'Unpublishing ' +
        liveOldIds.length +
        ' stale scorer item(s)...'
      );

      try {
        await wfUnpublishItems(
          TOP_SCORERS_COLLECTION_ID,
          liveOldIds
        );

        totalUnpublished +=
          liveOldIds.length;

        console.log(
          'Stale scorers unpublished successfully.'
        );
      } catch (err) {
        totalErrors++;

        console.error(
          'UNPUBLISH ERROR:',
          err.message
        );
      }

      continue;
    }

    const matchedCmsIds =
      new Set();

    const publishIds = [];

    let leagueHadError = false;


    for (
      let index = 0;
      index < currentTop.length;
      index++
    ) {
      const apiEntry =
        currentTop[index];

      const player =
        apiEntry.player;

      const stats =
        apiEntry.statistics &&
        apiEntry.statistics[0]
          ? apiEntry.statistics[0]
          : {};

      const rank =
        index + 1;

      const apiPlayerId =
        String(
          player.id
        );

      console.log(
        '\n----------------------------------------'
      );

      console.log(
        '#' +
        rank +
        ' ' +
        (
          player.name ||
          apiPlayerId
        )
      );

      const teamMatch =
        resolveTeam(
          stats.team || null,
          teamLookup
        );

      if (!teamMatch) {
        totalErrors++;
        leagueHadError = true;

        console.error(
          'TEAM MATCH FAILED:',
          stats.team
            ? stats.team.name
            : 'unknown team'
        );

        console.error(
          'Skipping this player safely.'
        );

        continue;
      }

      const idCandidates =
        existingLookup
          .byApiPlayerId
          .get(
            apiPlayerId
          ) || [];

      let existingItem =
        pickBestCandidate(
          idCandidates,
          player,
          league.season,
          matchedCmsIds
        );

      let matchMethod =
        existingItem
          ? 'api-player-id'
          : null;

      if (!existingItem) {
        const exactCandidates =
          findExactNameCandidates(
            player,
            existingLookup,
            matchedCmsIds
          );

        if (
          exactCandidates.length === 1
        ) {
          existingItem =
            exactCandidates[0];

          matchMethod =
            'exact-name';
        }

        if (
          exactCandidates.length > 1
        ) {
          console.warn(
            'Multiple exact-name CMS matches found.'
          );

          console.warn(
            'Refusing to guess — a clean new item will be created.'
          );
        }
      }

      if (existingItem) {
        matchedCmsIds.add(
          existingItem.id
        );

        const fieldData =
          buildCurrentFieldData({
            player,
            stats,
            league,
            rank,
            teamMatch,
            existingItem
          });

        console.log(
          'Match: ' +
          matchMethod
        );

        console.log(
          'CMS item: ' +
          (
            getField(
              existingItem,
              'name'
            ) || existingItem.id
          )
        );

        console.log(
          'New display name: ' +
          fieldData.name
        );

        console.log(
          'Goals: ' +
          fieldData.goals +
          ' | Assists: ' +
          fieldData.assists
        );

        console.log(
          'Team: ' +
          teamMatch.item.fieldData.name
        );

        try {
          await wfUpdateItem(
            TOP_SCORERS_COLLECTION_ID,
            existingItem.id,
            fieldData
          );

          publishIds.push(
            existingItem.id
          );

          if (
            matchMethod ===
            'exact-name'
          ) {
            totalRelinked++;
          } else {
            totalUpdated++;
          }

          console.log(
            'UPDATED OK'
          );
        } catch (err) {
          totalErrors++;
          leagueHadError = true;

          console.error(
            'UPDATE FAILED:',
            err.message
          );
        }

        await sleep(300);

        continue;
      }

      const fieldData =
        buildCurrentFieldData({
          player,
          stats,
          league,
          rank,
          teamMatch,
          existingItem: null
        });

      fieldData.slug =
        slugify(
          fieldData.name
        ) +
        '-' +
        league.code.toLowerCase() +
        '-' +
        league.season +
        '-' +
        apiPlayerId;

      console.log(
        'No safe existing match.'
      );

      console.log(
        'Creating: ' +
        fieldData.name
      );

      console.log(
        'Goals: ' +
        fieldData.goals +
        ' | Assists: ' +
        fieldData.assists
      );

      console.log(
        'Team: ' +
        teamMatch.item.fieldData.name
      );

      try {
        const created =
          await wfCreateItem(
            TOP_SCORERS_COLLECTION_ID,
            fieldData
          );

        if (
          !created ||
          !created.id
        ) {
          throw new Error(
            'Webflow create response had no item ID'
          );
        }

        matchedCmsIds.add(
          created.id
        );

        publishIds.push(
          created.id
        );

        totalCreated++;

        console.log(
          'CREATED OK'
        );
      } catch (err) {
        totalErrors++;
        leagueHadError = true;

        console.error(
          'CREATE FAILED:',
          err.message
        );
      }

      await sleep(300);
    }


    if (publishIds.length) {
      console.log(
        '\nPublishing ' +
        publishIds.length +
        ' current scorer item(s)...'
      );

      try {
        await wfPublishItems(
          TOP_SCORERS_COLLECTION_ID,
          publishIds
        );

        totalRepublished +=
          publishIds.length;

        console.log(
          'Current Top Scorers published.'
        );
      } catch (err) {
        totalErrors++;
        leagueHadError = true;

        console.error(
          'PUBLISH ERROR:',
          err.message
        );
      }
    }


    if (leagueHadError) {
      console.warn(
        '\nLeague had one or more errors.'
      );

      console.warn(
        'SAFETY: stale scorer items will NOT be unpublished for this league.'
      );

      continue;
    }

    const staleItems =
      leagueItems.filter(
        item =>
          !matchedCmsIds.has(
            item.id
          )
      );

    const liveStaleItems =
      staleItems.filter(
        item =>
          !item.isDraft
      );

    console.log(
      '\nStale CMS items: ' +
      staleItems.length
    );

    if (!liveStaleItems.length) {
      console.log(
        'No live stale items need unpublishing.'
      );

      continue;
    }

    console.log(
      'Unpublishing ' +
      liveStaleItems.length +
      ' stale item(s)...'
    );

    for (
      const stale
      of liveStaleItems
    ) {
      console.log(
        '  STALE: ' +
        (
          getField(
            stale,
            'name'
          ) || stale.id
        )
      );
    }

    try {
      await wfUnpublishItems(
        TOP_SCORERS_COLLECTION_ID,
        liveStaleItems.map(
          item => item.id
        )
      );

      totalUnpublished +=
        liveStaleItems.length;

      console.log(
        'Stale items unpublished.'
      );
    } catch (err) {
      totalErrors++;

      console.error(
        'STALE UNPUBLISH ERROR:',
        err.message
      );
    }
  }


  console.log(
    '\n\n============================================================'
  );

  console.log(
    'LIVE SYNC COMPLETE'
  );

  console.log(
    '============================================================'
  );

  console.log(
    'Updated by API Player ID: ' +
    totalUpdated
  );

  console.log(
    'Relinked by exact name: ' +
    totalRelinked
  );

  console.log(
    'Created: ' +
    totalCreated
  );

  console.log(
    'Published current items: ' +
    totalRepublished
  );

  console.log(
    'Unpublished stale items: ' +
    totalUnpublished
  );

  console.log(
    'Errors: ' +
    totalErrors
  );

  if (totalErrors > 0) {
    console.log(
      '\nCompleted with warnings/errors. Review the log.'
    );

    process.exitCode = 1;
  } else {
    console.log(
      '\nEverything completed successfully.'
    );
  }
}


// ============================================================
// START
// ============================================================

main().catch(err => {
  console.error(
    '\nFATAL ERROR:',
    err.message
  );

  process.exit(1);
});
