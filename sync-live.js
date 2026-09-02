// ============================================================
// sync-live.js — footgoal.co
// Lightweight live updater meant to run roughly every minute.
//
// IMPORTANT:
// - It NEVER re-syncs a whole season while a match is live.
// - It updates only live / just-finished matches that changed.
// - It updates standings only when needed (+ 10 min fallback).
// - Missing CMS fixtures/standings are left to league-sync-v2.js.
// ============================================================

const WEBFLOW_TOKEN = process.env.WEBFLOW_TOKEN;
const API_FOOTBALL_KEY = process.env.API_FOOTBALL_KEY;

if (!WEBFLOW_TOKEN) throw new Error('Missing WEBFLOW_TOKEN');
if (!API_FOOTBALL_KEY) throw new Error('Missing API_FOOTBALL_KEY');

const WF = {
  TEAMS: '6a20064807685f373db26660',
  STANDINGS: '6a200649847c9fcb9278de02',
  MATCHES: '6a200649c668e2cb8f11e82b',
};

const LEAGUES = [
  {
    code: 'PL',
    name: 'Premier League',
    api_id: 39,
    webflow_id: '6a32a9cb63396a5393212f3a',
    season: 2026,
  },
  {
    code: 'LL',
    name: 'La Liga',
    api_id: 140,
    webflow_id: '6a32a9cb63396a5393212f3e',
    season: 2026,
  },
  {
    code: 'BL',
    name: 'Bundesliga',
    api_id: 78,
    webflow_id: '6a32a9cb63396a5393212f40',
    season: 2026,
  },
  {
    code: 'SA',
    name: 'Serie A',
    api_id: 135,
    webflow_id: '6a32a9cb63396a5393212f42',
    season: 2026,
  },
  {
    code: 'ERE',
    name: 'Eredivisie',
    api_id: 88,
    webflow_id: '6a32a9cb63396a5393212f44',
    season: 2026,
  },
  {
    code: 'L1',
    name: 'Ligue 1',
    api_id: 61,
    webflow_id: '6a32a9cb63396a5393212f46',
    season: 2026,
  },
  {
    code: 'BSA',
    name: 'Brasileiro Série A',
    api_id: 71,
    webflow_id: '6a32a9cb63396a5393212f48',
    season: 2026,
  },
];

const LEAGUE_BY_API_ID = new Map(
  LEAGUES.map(league => [Number(league.api_id), league])
);

const STALE_LOOKUP_CONCURRENCY = 4;
const STANDINGS_FALLBACK_MINUTES = 10;


// ============================================================
// HELPERS
// ============================================================

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function getFormString(form) {
  return form ? String(form).slice(-5) : '';
}

function mapMatchStatus(shortStatus) {
  const finished = ['FT', 'AET', 'PEN'];

  const live = [
    '1H',
    '2H',
    'HT',
    'ET',
    'BT',
    'P',
    'SUSP',
    'INT',
    'LIVE',
  ];

  if (finished.includes(shortStatus)) {
    return 'Played';
  }

  if (live.includes(shortStatus)) {
    return 'Live';
  }

  return 'Upcoming';
}

function sameValue(a, b) {
  if (a == null && b == null) {
    return true;
  }

  return String(a) === String(b);
}

function getChangedFields(existing, desired) {
  const changed = {};

  for (const [key, value] of Object.entries(desired)) {
    if (value === undefined) {
      continue;
    }

    if (!sameValue(existing ? existing[key] : undefined, value)) {
      changed[key] = value;
    }
  }

  return changed;
}

function standingsFallbackDue() {
  const currentMinute = Math.floor(Date.now() / 60000);

  return currentMinute % STANDINGS_FALLBACK_MINUTES === 0;
}

async function mapWithConcurrency(
  items,
  concurrency,
  callback
) {
  let index = 0;

  async function worker() {
    while (index < items.length) {
      const item = items[index++];

      await callback(item);
    }
  }

  const workerCount = Math.min(
    concurrency,
    items.length
  );

  await Promise.all(
    Array.from(
      { length: workerCount },
      () => worker()
    )
  );
}


// ============================================================
// API-FOOTBALL
// ============================================================

async function apiFetch(
  path,
  retries = 4
) {
  await sleep(100);

  const response = await fetch(
    'https://v3.football.api-sports.io' + path,
    {
      headers: {
        'x-apisports-key': API_FOOTBALL_KEY,
      },
    }
  );

  if (
    response.status === 429 &&
    retries > 0
  ) {
    console.warn(
      'API-Football rate limited. Waiting 15s...'
    );

    await sleep(15000);

    return apiFetch(
      path,
      retries - 1
    );
  }

  if (!response.ok) {
    throw new Error(
      `API-Football ${response.status}: ${await response.text()}`
    );
  }

  const data = await response.json();

  if (
    data.errors &&
    Object.keys(data.errors).length
  ) {
    console.warn(
      'API-Football errors:',
      data.errors
    );
  }

  return data;
}

async function getSupportedLiveFixtures() {
  const data = await apiFetch(
    '/fixtures?live=all'
  );

  return (data.response || []).filter(
    fixture =>
      fixture.league &&
      LEAGUE_BY_API_ID.has(
        Number(fixture.league.id)
      )
  );
}

async function getFixtureById(
  fixtureId
) {
  const data = await apiFetch(
    '/fixtures?id=' +
      encodeURIComponent(
        String(fixtureId)
      )
  );

  if (
    data.response &&
    data.response[0]
  ) {
    return data.response[0];
  }

  return null;
}


// ============================================================
// WEBFLOW
// ============================================================

async function wfFetch(
  url,
  options = {},
  retries = 4
) {
  const response = await fetch(
    url,
    {
      ...options,

      headers: {
        Authorization:
          'Bearer ' + WEBFLOW_TOKEN,

        accept: 'application/json',

        ...(options.headers || {}),
      },
    }
  );

  if (
    response.status === 429 &&
    retries > 0
  ) {
    const retryAfter = Number(
      response.headers.get('retry-after')
    );

    const delay =
      Number.isFinite(retryAfter) &&
      retryAfter > 0
        ? retryAfter * 1000
        : 10000;

    console.warn(
      `Webflow rate limited. Waiting ${delay}ms...`
    );

    await sleep(delay);

    return wfFetch(
      url,
      options,
      retries - 1
    );
  }

  if (
    response.status >= 500 &&
    retries > 0
  ) {
    await sleep(2000);

    return wfFetch(
      url,
      options,
      retries - 1
    );
  }

  if (!response.ok) {
    throw new Error(
      `Webflow ${response.status}: ${await response.text()}`
    );
  }

  if (response.status === 204) {
    return null;
  }

  return response.json();
}

function addFilters(
  params,
  filters
) {
  for (
    const [field, operators]
    of Object.entries(filters || {})
  ) {
    for (
      const [operator, rawValue]
      of Object.entries(
        operators || {}
      )
    ) {
      if (rawValue == null) {
        continue;
      }

      const value =
        Array.isArray(rawValue)
          ? rawValue.join(',')
          : String(rawValue);

      params.append(
        `filter[${field}][${operator}]`,
        value
      );
    }
  }
}

async function wfListFiltered(
  collectionId,
  filters
) {
  const items = [];

  let offset = 0;

  while (true) {
    const params =
      new URLSearchParams({
        limit: '100',
        offset: String(offset),
      });

    addFilters(
      params,
      filters
    );

    const data =
      await wfFetch(
        `https://api.webflow.com/v2/collections/${collectionId}/items?${params.toString()}`
      );

    const pageItems =
      data.items || [];

    items.push(
      ...pageItems
    );

    const total =
      data.pagination
        ? Number(
            data.pagination.total || 0
          )
        : items.length;

    if (
      !pageItems.length ||
      items.length >= total
    ) {
      break;
    }

    offset += 100;
  }

  return items;
}

async function wfBulkUpdate(
  collectionId,
  updates
) {
  if (!updates.length) {
    return;
  }

  for (
    let i = 0;
    i < updates.length;
    i += 100
  ) {
    const batch =
      updates.slice(
        i,
        i + 100
      );

    await wfFetch(
      `https://api.webflow.com/v2/collections/${collectionId}/items`,
      {
        method: 'PATCH',

        headers: {
          'Content-Type':
            'application/json',
        },

        body: JSON.stringify({
          items: batch,
        }),
      }
    );

    await sleep(300);
  }
}

async function wfPublishItems(
  collectionId,
  itemIds
) {
  const ids = [
    ...new Set(
      itemIds.filter(Boolean)
    ),
  ];

  if (!ids.length) {
    return;
  }

  for (
    let i = 0;
    i < ids.length;
    i += 100
  ) {
    const batch =
      ids.slice(
        i,
        i + 100
      );

    await wfFetch(
      `https://api.webflow.com/v2/collections/${collectionId}/items/publish`,
      {
        method: 'POST',

        headers: {
          'Content-Type':
            'application/json',
        },

        body: JSON.stringify({
          itemIds: batch,
        }),
      }
    );

    await sleep(300);
  }
}


// ============================================================
// FETCH RELEVANT CMS MATCHES ONLY
// ============================================================

async function getCmsMatchesByFixtureIds(
  fixtureIds
) {
  const ids = [
    ...new Set(
      fixtureIds
        .map(String)
        .filter(Boolean)
    ),
  ];

  if (!ids.length) {
    return [];
  }

  const items = [];

  for (
    let i = 0;
    i < ids.length;
    i += 100
  ) {
    const batch =
      ids.slice(
        i,
        i + 100
      );

    const result =
      await wfListFiltered(
        WF.MATCHES,
        {
          'api-fixture-id': {
            in: batch,
          },
        }
      );

    items.push(
      ...result
    );
  }

  return items;
}

async function getCmsLiveMatches() {
  return wfListFiltered(
    WF.MATCHES,
    {
      status: {
        eq: 'Live',
      },
    }
  );
}


// ============================================================
// MATCH SYNC
// ============================================================

function desiredMatchFields(
  fixture
) {
  return {
    'home-score':
      fixture.goals
        ? fixture.goals.home
        : null,

    'away-score':
      fixture.goals
        ? fixture.goals.away
        : null,

    status:
      mapMatchStatus(
        fixture.fixture
          ?.status
          ?.short || ''
      ),
  };
}

async function syncMatches(
  liveFixtures
) {
  const liveIds =
    liveFixtures.map(
      fixture =>
        String(
          fixture.fixture.id
        )
    );

  const liveIdSet =
    new Set(liveIds);

  /*
   * Only get CMS matches that
   * correspond to current live fixtures.
   */
  const currentCmsMatches =
    await getCmsMatchesByFixtureIds(
      liveIds
    );

  const cmsByFixtureId =
    new Map();

  for (
    const item
    of currentCmsMatches
  ) {
    const fixtureId =
      item.fieldData
        ?.['api-fixture-id'];

    if (fixtureId != null) {
      cmsByFixtureId.set(
        String(fixtureId),
        item
      );
    }
  }

  /*
   * Also get matches that Webflow
   * currently thinks are Live.
   *
   * This is needed so when a match
   * becomes FT it doesn't stay stuck
   * as Live forever.
   */
  const cmsMarkedLive =
    await getCmsLiveMatches();

  const updates =
    new Map();

  const affectedLeagueIds =
    new Set();


  // ----------------------------------------------------------
  // CURRENT LIVE MATCHES
  // ----------------------------------------------------------

  for (
    const fixture
    of liveFixtures
  ) {
    const fixtureId =
      String(
        fixture.fixture.id
      );

    const cmsItem =
      cmsByFixtureId.get(
        fixtureId
      );

    if (!cmsItem) {
      console.warn(
        `[MATCH] ${fixtureId} not found in Webflow CMS. Full sync will handle it.`
      );

      continue;
    }

    const diff =
      getChangedFields(
        cmsItem.fieldData,
        desiredMatchFields(
          fixture
        )
      );

    if (
      Object.keys(diff).length
    ) {
      updates.set(
        cmsItem.id,
        {
          id: cmsItem.id,
          fieldData: diff,
        }
      );

      affectedLeagueIds.add(
        Number(
          fixture.league.id
        )
      );

      console.log(
        `[MATCH] ${cmsItem.fieldData.name || fixtureId}`,
        diff
      );
    }
  }


  // ----------------------------------------------------------
  // LIVE -> FT / AET / PEN TRANSITIONS
  // ----------------------------------------------------------

  const staleLiveItems =
    cmsMarkedLive.filter(
      item => {
        const fixtureId =
          item.fieldData
            ?.['api-fixture-id'];

        return (
          fixtureId != null &&
          !liveIdSet.has(
            String(fixtureId)
          )
        );
      }
    );

  await mapWithConcurrency(
    staleLiveItems,
    STALE_LOOKUP_CONCURRENCY,

    async cmsItem => {
      const fixtureId =
        cmsItem.fieldData[
          'api-fixture-id'
        ];

      try {
        /*
         * The match disappeared from
         * /fixtures?live=all.
         *
         * Fetch ONLY this fixture,
         * not the entire league season.
         */
        const fixture =
          await getFixtureById(
            fixtureId
          );

        if (!fixture) {
          return;
        }

        if (
          !LEAGUE_BY_API_ID.has(
            Number(
              fixture.league
                ?.id
            )
          )
        ) {
          return;
        }

        const diff =
          getChangedFields(
            cmsItem.fieldData,
            desiredMatchFields(
              fixture
            )
          );

        if (
          Object.keys(diff)
            .length
        ) {
          updates.set(
            cmsItem.id,
            {
              id: cmsItem.id,
              fieldData: diff,
            }
          );

          affectedLeagueIds.add(
            Number(
              fixture.league.id
            )
          );

          console.log(
            `[MATCH TRANSITION] ${cmsItem.fieldData.name || fixtureId}`,
            diff
          );
        }
      } catch (error) {
        console.error(
          `[MATCH TRANSITION] ${fixtureId}: ${error.message}`
        );
      }
    }
  );


  // ----------------------------------------------------------
  // WRITE ONLY IF SOMETHING CHANGED
  // ----------------------------------------------------------

  const updateList = [
    ...updates.values(),
  ];

  if (
    !updateList.length
  ) {
    console.log(
      '[MATCHES] No score/status changes. No Webflow writes.'
    );

    return affectedLeagueIds;
  }

  await wfBulkUpdate(
    WF.MATCHES,
    updateList
  );

  await wfPublishItems(
    WF.MATCHES,
    updateList.map(
      item => item.id
    )
  );

  console.log(
    `[MATCHES] Updated ${updateList.length} changed CMS match item(s).`
  );

  return affectedLeagueIds;
}


// ============================================================
// STANDINGS
// ============================================================

async function getTeamsByApiIds(
  apiIds
) {
  const ids = [
    ...new Set(
      apiIds.map(String)
    ),
  ];

  const teams = [];

  for (
    let i = 0;
    i < ids.length;
    i += 100
  ) {
    const batch =
      ids.slice(
        i,
        i + 100
      );

    const result =
      await wfListFiltered(
        WF.TEAMS,
        {
          'api-team-id': {
            in: batch,
          },
        }
      );

    teams.push(
      ...result
    );
  }

  const map =
    new Map();

  for (
    const team
    of teams
  ) {
    const apiId =
      team.fieldData
        ?.['api-team-id'];

    if (apiId != null) {
      map.set(
        String(apiId),
        team
      );
    }
  }

  return map;
}

async function syncStandingsForLeague(
  league
) {
  console.log(
    `[STANDINGS] Checking ${league.name}`
  );

  const data =
    await apiFetch(
      `/standings?league=${league.api_id}&season=${league.season}`
    );

  const table =
    data.response
      ?.[0]
      ?.league
      ?.standings
      ?.[0] || [];

  if (!table.length) {
    console.log(
      `[STANDINGS] ${league.name}: no table yet.`
    );

    return;
  }

  /*
   * Fetch ONLY the teams
   * present in this standings table.
   */
  const teamByApiId =
    await getTeamsByApiIds(
      table.map(
        row =>
          row.team.id
      )
    );

  /*
   * Fetch ONLY standings
   * belonging to this league.
   */
  const cmsStandings =
    await wfListFiltered(
      WF.STANDINGS,
      {
        league: {
          eq:
            league.webflow_id,
        },
      }
    );

  const standingByTeamRef =
    new Map();

  for (
    const item
    of cmsStandings
  ) {
    const teamRef =
      item.fieldData
        ?.team;

    if (teamRef) {
      standingByTeamRef.set(
        String(teamRef),
        item
      );
    }
  }

  const updates = [];

  for (
    const row
    of table
  ) {
    const wfTeam =
      teamByApiId.get(
        String(
          row.team.id
        )
      );

    if (!wfTeam) {
      continue;
    }

    const cmsStanding =
      standingByTeamRef.get(
        String(
          wfTeam.id
        )
      );

    if (!cmsStanding) {
      continue;
    }

    const desired = {
      position:
        row.rank,

      played:
        row.all.played,

      won:
        row.all.win,

      drawn:
        row.all.draw,

      lost:
        row.all.lose,

      'goals-for':
        row.all.goals.for,

      'goals-against':
        row.all.goals.against,

      'goal-difference':
        row.goalsDiff,

      points:
        row.points,

      form:
        getFormString(
          row.form
        ),
    };

    const diff =
      getChangedFields(
        cmsStanding.fieldData,
        desired
      );

    if (
      Object.keys(diff)
        .length
    ) {
      updates.push({
        id:
          cmsStanding.id,

        fieldData:
          diff,
      });
    }
  }

  if (!updates.length) {
    console.log(
      `[STANDINGS] ${league.name}: no changes.`
    );

    return;
  }

  await wfBulkUpdate(
    WF.STANDINGS,
    updates
  );

  await wfPublishItems(
    WF.STANDINGS,
    updates.map(
      item => item.id
    )
  );

  console.log(
    `[STANDINGS] ${league.name}: updated ${updates.length} item(s).`
  );
}

async function syncRelevantStandings(
  liveFixtures,
  affectedLeagueIds
) {
  const leagueIds =
    new Set(
      affectedLeagueIds
    );

  /*
   * Normally standings update only
   * when a match score/status changed.
   *
   * Every 10 min during live matches,
   * refresh anyway as a safety net.
   */
  if (
    standingsFallbackDue()
  ) {
    for (
      const fixture
      of liveFixtures
    ) {
      leagueIds.add(
        Number(
          fixture.league.id
        )
      );
    }
  }

  if (!leagueIds.size) {
    console.log(
      '[STANDINGS] Nothing to refresh this tick.'
    );

    return;
  }

  for (
    const leagueId
    of leagueIds
  ) {
    const league =
      LEAGUE_BY_API_ID.get(
        Number(leagueId)
      );

    if (!league) {
      continue;
    }

    try {
      await syncStandingsForLeague(
        league
      );
    } catch (error) {
      console.error(
        `[STANDINGS] ${league.name}: ${error.message}`
      );
    }
  }
}


// ============================================================
// MAIN
// ============================================================

async function main() {
  const started =
    Date.now();

  console.log(
    `sync-live.js tick @ ${new Date().toISOString()}`
  );

  /*
   * ONE API call tells us
   * every live match right now.
   */
  const liveFixtures =
    await getSupportedLiveFixtures();

  if (
    liveFixtures.length
  ) {
    console.log(
      `[LIVE] ${liveFixtures.length} supported live match(es):`
    );

    for (
      const fixture
      of liveFixtures
    ) {
      console.log(
        `  ${
          fixture.teams
            ?.home
            ?.name || '?'
        } ${
          fixture.goals
            ?.home ?? '-'
        }-${
          fixture.goals
            ?.away ?? '-'
        } ${
          fixture.teams
            ?.away
            ?.name || '?'
        }`
      );
    }
  } else {
    console.log(
      '[LIVE] No supported live matches. Checking Live -> FT transitions only.'
    );
  }

  /*
   * Only affected live matches
   * get written to Webflow.
   */
  const affectedLeagueIds =
    await syncMatches(
      liveFixtures
    );

  /*
   * Standings refresh only
   * for affected leagues.
   */
  await syncRelevantStandings(
    liveFixtures,
    affectedLeagueIds
  );

  console.log(
    `sync-live.js finished in ${
      (
        (
          Date.now() -
          started
        ) /
        1000
      ).toFixed(1)
    }s.`
  );
}

main().catch(
  error => {
    console.error(
      'Fatal error:',
      error
    );

    process.exit(1);
  }
);
