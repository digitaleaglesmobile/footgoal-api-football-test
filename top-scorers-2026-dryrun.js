// ============================================================
// top-scorers-2026-dryrun.js — footgoal.co
//
// SAFE / READ-ONLY.
// Does NOT write, delete, archive or publish anything in Webflow.
//
// For ALL 7 leagues:
// 1. Fetches current API-Football top scorers for season 2026.
// 2. Compares them with existing Webflow Top Scorers CMS items.
// 3. Matches safely by API Player ID first.
// 4. Falls back ONLY to exact normalized full-name match.
// 5. Prints what should be:
//      UPDATE
//      RELINK + UPDATE
//      CREATE
//      STALE / REMOVE FROM CURRENT LIST
//
// No fuzzy surname matching.
// No rank-based matching.
// ============================================================

const WEBFLOW_TOKEN = process.env.WEBFLOW_TOKEN;
const API_FOOTBALL_KEY = process.env.API_FOOTBALL_KEY;


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
  }
];


// ============================================================
// HELPERS
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


function getField(item, slug) {
  return item &&
    item.fieldData
    ? item.fieldData[slug]
    : null;
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
        'x-apisports-key': API_FOOTBALL_KEY
      }
    }
  );


  if (
    res.status === 429 &&
    retries > 0
  ) {

    console.warn(
      'API-Football rate limited — waiting 30s...'
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
// WEBFLOW READ
// ============================================================

async function wfGetAllItems(collectionId) {

  const items = [];

  let offset = 0;

  const limit = 100;


  while (true) {

    const res = await fetch(

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


    if (!res.ok) {

      throw new Error(
        'Webflow GET ' +
        collectionId +
        ': ' +
        res.status +
        ' ' +
        await res.text()
      );
    }


    const data =
      await res.json();


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
// TEAM LOOKUP
// ============================================================

function buildTeamLookup(allTeams) {

  const byApiId =
    new Map();

  const byName =
    new Map();


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


  // SAFEST:
  // API team ID
  const byId =
    teamLookup.byApiId.get(
      String(apiTeam.id)
    );


  if (byId) {

    return {
      item: byId,
      method: 'api-team-id'
    };
  }


  // Fallback:
  // exact normalized full team name
  const normalized =
    normalizeName(
      apiTeam.name
    );


  const exact =
    teamLookup.byName.get(
      normalized
    ) || [];


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
// EXISTING TOP SCORER LOOKUP
// ============================================================

function buildExistingLookup(items) {

  const byApiPlayerId =
    new Map();

  const byExactName =
    new Map();


  for (const item of items) {

    const apiPlayerId =
      getField(
        item,
        'api-player-id'
      );


    const name =
      getField(
        item,
        'name'
      );


    if (apiPlayerId) {

      byApiPlayerId.set(
        String(apiPlayerId),
        item
      );
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


  console.log(
    '*** SAFE DRY RUN — NOTHING WILL BE WRITTEN ***\n'
  );


  console.log(
    'Loading existing Webflow Top Scorers...'
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


  // ----------------------------------------
  // GLOBAL TOTALS
  // ----------------------------------------

  let totalUpdate = 0;
  let totalRelink = 0;
  let totalCreate = 0;
  let totalStale = 0;
  let totalTeamMissing = 0;


  // ==========================================================
  // EACH LEAGUE
  // ==========================================================

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
      '============================================================\n'
    );


    // Existing CMS items for this league
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


    // Build safe lookup ONLY inside this league
    const existingLookup =
      buildExistingLookup(
        leagueItems
      );


    // Current API data
    console.log(
      'Fetching API top scorers...'
    );


    const data =
      await apiFetch(

        '/players/topscorers?league=' +
        league.api_id +
        '&season=' +
        league.season
      );


    const apiList =
      data.response || [];


    const currentTop =
      apiList.slice(
        0,
        TARGET_TOP_N
      );


    console.log(
      'API returned: ' +
      apiList.length +
      ' scorers'
    );


    console.log(
      'Current target list: top ' +
      currentTop.length
    );


    // ----------------------------------------
    // API HAS NO CURRENT DATA
    // ----------------------------------------

    if (
      currentTop.length === 0
    ) {

      console.log(
        '\nAPI has no 2026 scorer data for this league.'
      );


      if (
        leagueItems.length === 0
      ) {

        console.log(
          'CMS is already empty — nothing to do.'
        );

        continue;
      }


      console.log(
        '\nSTALE / SHOULD NOT BE IN CURRENT 2026 LIST:'
      );


      for (
        const oldItem
        of leagueItems
      ) {

        console.log(
          '  [STALE] ' +
          getField(
            oldItem,
            'name'
          ) +
          ' | CMS season=' +
          (
            getField(
              oldItem,
              'season'
            ) || 'empty'
          )
        );


        totalStale++;
      }


      continue;
    }


    // IDs of old CMS items that belong
    // to the current API top 10
    const matchedCmsIds =
      new Set();


    console.log(
      '\nCURRENT API TOP ' +
      TARGET_TOP_N +
      ':'
    );


    // ----------------------------------------
    // CURRENT API TOP N
    // ----------------------------------------

    for (
      let i = 0;
      i < currentTop.length;
      i++
    ) {

      const apiEntry =
        currentTop[i];


      const player =
        apiEntry.player;


      const stats =
        apiEntry.statistics &&
        apiEntry.statistics[0]
          ? apiEntry.statistics[0]
          : {};


      const apiPlayerId =
        String(
          player.id
        );


      const apiName =
        player.name;


      const apiTeam =
        stats.team || null;


      const goals =
        stats.goals &&
        Number.isFinite(
          stats.goals.total
        )
          ? stats.goals.total
          : 0;


      const assists =
        stats.goals &&
        Number.isFinite(
          stats.goals.assists
        )
          ? stats.goals.assists
          : 0;


      const rank =
        i + 1;


      // --------------------------------------
      // TEAM MATCH
      // --------------------------------------

      const teamMatch =
        resolveTeam(
          apiTeam,
          teamLookup
        );


      if (!teamMatch) {

        totalTeamMissing++;

        console.log(
          '\n  [TEAM MATCH WARNING]'
        );

        console.log(
          '  Player: ' +
          apiName
        );

        console.log(
          '  API team: ' +
          (
            apiTeam
              ? apiTeam.name
              : 'unknown'
          )
        );
      }


      // --------------------------------------
      // 1. PLAYER ID MATCH
      // --------------------------------------

      const idMatch =
        existingLookup
          .byApiPlayerId
          .get(
            apiPlayerId
          );


      if (idMatch) {

        matchedCmsIds.add(
          idMatch.id
        );


        totalUpdate++;


        console.log(
          '\n  [UPDATE]'
        );

        console.log(
          '  Rank: ' +
          rank
        );

        console.log(
          '  Player: ' +
          apiName
        );

        console.log(
          '  API Player ID: ' +
          apiPlayerId
        );

        console.log(
          '  Goals: ' +
          goals +
          ' | Assists: ' +
          assists
        );

        console.log(
          '  Existing CMS: ' +
          getField(
            idMatch,
            'name'
          )
        );

        console.log(
          '  Team match: ' +
          (
            teamMatch
              ? teamMatch.item.fieldData.name +
                ' (' +
                teamMatch.method +
                ')'
              : 'MISSING'
          )
        );


        continue;
      }


      // --------------------------------------
      // 2. EXACT FULL NAME FALLBACK
      // --------------------------------------

      const normalizedName =
        normalizeName(
          apiName
        );


      const exactNameMatches =
        existingLookup
          .byExactName
          .get(
            normalizedName
          ) || [];


      if (
        exactNameMatches.length === 1
      ) {

        const nameMatch =
          exactNameMatches[0];


        matchedCmsIds.add(
          nameMatch.id
        );


        totalRelink++;


        console.log(
          '\n  [RELINK + UPDATE]'
        );

        console.log(
          '  Rank: ' +
          rank
        );

        console.log(
          '  Player: ' +
          apiName
        );

        console.log(
          '  API Player ID: ' +
          apiPlayerId
        );

        console.log(
          '  Existing CMS: ' +
          getField(
            nameMatch,
            'name'
          )
        );

        console.log(
          '  Reason: exact full-name match, but API Player ID was missing/different'
        );

        console.log(
          '  Goals: ' +
          goals +
          ' | Assists: ' +
          assists
        );

        console.log(
          '  Team match: ' +
          (
            teamMatch
              ? teamMatch.item.fieldData.name +
                ' (' +
                teamMatch.method +
                ')'
              : 'MISSING'
          )
        );


        continue;
      }


      // --------------------------------------
      // 3. CREATE
      // --------------------------------------

      totalCreate++;


      console.log(
        '\n  [CREATE]'
      );

      console.log(
        '  Rank: ' +
        rank
      );

      console.log(
        '  Player: ' +
        apiName
      );

      console.log(
        '  API Player ID: ' +
        apiPlayerId
      );

      console.log(
        '  Goals: ' +
        goals +
        ' | Assists: ' +
        assists
      );

      console.log(
        '  Team match: ' +
        (
          teamMatch
            ? teamMatch.item.fieldData.name +
              ' (' +
              teamMatch.method +
              ')'
            : 'MISSING'
        )
      );


      if (
        exactNameMatches.length > 1
      ) {

        console.log(
          '  WARNING: multiple exact-name CMS items exist; refusing to guess.'
        );
      }
    }


    // ----------------------------------------
    // STALE CMS ITEMS
    // ----------------------------------------

    const staleItems =
      leagueItems.filter(
        item =>
          !matchedCmsIds.has(
            item.id
          )
      );


    console.log(
      '\nSTALE CMS ITEMS:'
    );


    if (
      staleItems.length === 0
    ) {

      console.log(
        '  None.'
      );
    }


    for (
      const stale
      of staleItems
    ) {

      console.log(
        '  [STALE] ' +
        getField(
          stale,
          'name'
        ) +
        ' | api-player-id=' +
        (
          getField(
            stale,
            'api-player-id'
          ) || 'missing'
        ) +
        ' | season=' +
        (
          getField(
            stale,
            'season'
          ) || 'empty'
        )
      );


      totalStale++;
    }
  }


  // ==========================================================
  // FINAL SUMMARY
  // ==========================================================

  console.log(
    '\n\n============================================================'
  );

  console.log(
    'FINAL DRY-RUN SUMMARY'
  );

  console.log(
    '============================================================'
  );


  console.log(
    'UPDATE by API Player ID: ' +
    totalUpdate
  );


  console.log(
    'RELINK + UPDATE by exact full name: ' +
    totalRelink
  );


  console.log(
    'CREATE: ' +
    totalCreate
  );


  console.log(
    'STALE / remove from current list: ' +
    totalStale
  );


  console.log(
    'Missing team references: ' +
    totalTeamMissing
  );


  console.log(
    '\nNO WEBFLOW DATA WAS CHANGED.'
  );
}


main().catch(err => {

  console.error(
    '\nFatal dry-run error:',
    err.message
  );

  process.exit(1);
});
