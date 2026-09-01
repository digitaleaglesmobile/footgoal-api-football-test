// ============================================================
// sync-ucl-2026.js — footgoal.co
// SAFE production sync for UEFA Champions League 2026/27
//
// Key safety rules:
// - ONLY the 36-team League Phase ("Group Stage" in API-Football)
// - Existing domestic Team items are reused without changing league
// - FORM is calculated ONLY from finished UCL League Phase fixtures
// - Placeholder fixtures stay unpublished until 8 matchweeks exist
// - Unchanged Webflow items are NOT rewritten
// - Webflow requests are throttled and 429s use Retry-After/backoff
// - Nothing is written unless CONFIRM=yes
// ============================================================

const WEBFLOW_TOKEN = process.env.WEBFLOW_TOKEN;
const API_FOOTBALL_KEY = process.env.API_FOOTBALL_KEY;
const CONFIRM = process.env.CONFIRM === 'yes';

const WF = {
  LEAGUES: '6a32a8954e8d7db479514a79',
  TEAMS: '6a20064807685f373db26660',
  STANDINGS: '6a200649847c9fcb9278de02',
  MATCHES: '6a200649c668e2cb8f11e82b'
};

const UCL = {
  code: 'UCL',
  name: 'UEFA Champions League',
  api_id: 2,
  webflow_id: '6a32a9cb63396a5393212f3c',
  season: 2026,
  seasonLabel: '2026/27'
};

const EXPECTED_TEAMS = 36;
const EXPECTED_FIXTURES = 144;
const EXPECTED_MATCHWEEKS = 8;

const MATCHDAY_GAP_MS =
  4 * 24 * 60 * 60 * 1000;

// Conservative throttle because sync-live.js can also
// be talking to Webflow at the same time.
const WEBFLOW_REQUEST_GAP_MS = 1100;
const WEBFLOW_MAX_RETRIES = 8;

const LIVE_STATUSES = new Set([
  '1H',
  '2H',
  'HT',
  'ET',
  'BT',
  'P',
  'SUSP',
  'INT',
  'LIVE'
]);

const FINISHED_STATUSES = new Set([
  'FT',
  'AET',
  'PEN'
]);

function sleep(ms) {
  return new Promise(resolve =>
    setTimeout(resolve, ms)
  );
}

function normalizeName(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(
      /[\u0300-\u036f]/g,
      ''
    )
    .replace(
      /[^a-z0-9]+/g,
      ' '
    )
    .trim();
}

function slugify(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(
      /[\u0300-\u036f]/g,
      ''
    )
    .replace(
      /[^a-z0-9]+/g,
      '-'
    )
    .replace(
      /^-+|-+$/g,
      ''
    )
    .replace(
      /-+/g,
      '-'
    );
}

function getField(
  item,
  slug
) {
  return (
    item &&
    item.fieldData
      ? item.fieldData[slug]
      : null
  );
}

function isLeaguePhaseRound(
  round
) {
  return /(?:league\s*(stage|phase)|group\s*stage)/i
    .test(
      String(round || '')
    );
}

function mapMatchStatus(
  shortStatus
) {
  if (
    FINISHED_STATUSES.has(
      shortStatus
    )
  ) {
    return 'Played';
  }

  if (
    LIVE_STATUSES.has(
      shortStatus
    )
  ) {
    return 'Live';
  }

  return 'Upcoming';
}

function countryToFlagCode(
  countryName
) {
  const map = {
    England: 'gb-eng',
    Spain: 'es',
    France: 'fr',
    Germany: 'de',
    Italy: 'it',
    Netherlands: 'nl',
    Portugal: 'pt',
    Belgium: 'be',
    Scotland: 'gb-sct',
    Switzerland: 'ch',
    Austria: 'at',
    Denmark: 'dk',
    Croatia: 'hr',
    Serbia: 'rs',
    Turkey: 'tr',
    Türkiye: 'tr',
    'Czech-Republic': 'cz',
    Czechia: 'cz',
    Norway: 'no',
    Sweden: 'se',
    Poland: 'pl',
    Greece: 'gr',
    Ukraine: 'ua',
    Slovakia: 'sk',
    Azerbaijan: 'az'
  };

  return (
    map[countryName] ||
    String(
      countryName || ''
    )
      .toLowerCase()
      .replace(
        /\s+/g,
        '-'
      )
  );
}

function uniqueTeamsFromFixtures(
  fixtures
) {
  const teams =
    new Map();

  for (
    const fixture
    of fixtures
  ) {
    if (
      fixture.teams?.home
    ) {
      teams.set(
        String(
          fixture.teams.home.id
        ),
        fixture.teams.home
      );
    }

    if (
      fixture.teams?.away
    ) {
      teams.set(
        String(
          fixture.teams.away.id
        ),
        fixture.teams.away
      );
    }
  }

  return [
    ...teams.values()
  ];
}

function inferMatchweeks(
  fixtures
) {
  const dated =
    fixtures
      .filter(
        fixture =>
          fixture.fixture?.date
      )
      .map(
        fixture => ({
          id:
            String(
              fixture.fixture.id
            ),

          time:
            new Date(
              fixture.fixture.date
            ).getTime()
        })
      )
      .filter(
        item =>
          Number.isFinite(
            item.time
          )
      )
      .sort(
        (a, b) =>
          a.time - b.time
      );

  const byFixtureId =
    new Map();

  let matchweek = 0;
  let previousTime = null;

  for (
    const item
    of dated
  ) {
    if (
      previousTime === null ||
      item.time -
        previousTime >
        MATCHDAY_GAP_MS
    ) {
      matchweek++;
    }

    byFixtureId.set(
      item.id,
      matchweek
    );

    previousTime =
      item.time;
  }

  return {
    byFixtureId,
    count: matchweek
  };
}

// ============================================================
// UCL LEAGUE PHASE FORM
// ============================================================

function buildLeaguePhaseFormMap(
  fixtures
) {
  const formMap =
    new Map();

  const finishedFixtures =
    fixtures
      .filter(
        fixture =>
          FINISHED_STATUSES.has(
            fixture.fixture
              ?.status
              ?.short
          )
      )
      .sort(
        (a, b) =>
          new Date(
            a.fixture.date
          ).getTime() -
          new Date(
            b.fixture.date
          ).getTime()
      );

  function addResult(
    teamId,
    result
  ) {
    const key =
      String(teamId);

    const current =
      formMap.get(key) ||
      [];

    current.push(
      result
    );

    formMap.set(
      key,
      current.slice(-5)
    );
  }

  for (
    const fixture
    of finishedFixtures
  ) {
    const homeId =
      fixture.teams
        ?.home
        ?.id;

    const awayId =
      fixture.teams
        ?.away
        ?.id;

    const homeGoals =
      Number(
        fixture.goals
          ?.home
      );

    const awayGoals =
      Number(
        fixture.goals
          ?.away
      );

    if (
      !homeId ||
      !awayId ||
      !Number.isFinite(
        homeGoals
      ) ||
      !Number.isFinite(
        awayGoals
      )
    ) {
      continue;
    }

    if (
      homeGoals >
      awayGoals
    ) {
      addResult(
        homeId,
        'W'
      );

      addResult(
        awayId,
        'L'
      );
    } else if (
      homeGoals <
      awayGoals
    ) {
      addResult(
        homeId,
        'L'
      );

      addResult(
        awayId,
        'W'
      );
    } else {
      addResult(
        homeId,
        'D'
      );

      addResult(
        awayId,
        'D'
      );
    }
  }

  return formMap;
}

// ============================================================
// API-FOOTBALL
// ============================================================

async function apiFetch(
  path,
  retries = 3
) {
  await sleep(250);

  const res =
    await fetch(
      'https://v3.football.api-sports.io' +
        path,
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

  const data =
    await res.json();

  if (
    data.errors &&
    Object.keys(
      data.errors
    ).length
  ) {
    throw new Error(
      'API-Football errors: ' +
        JSON.stringify(
          data.errors
        )
    );
  }

  return data;
}

// ============================================================
// WEBFLOW — THROTTLED + RETRY SAFE
// ============================================================

let lastWebflowRequestAt = 0;

async function throttleWebflow() {
  const elapsed =
    Date.now() -
    lastWebflowRequestAt;

  const wait =
    WEBFLOW_REQUEST_GAP_MS -
    elapsed;

  if (
    wait > 0
  ) {
    await sleep(wait);
  }

  lastWebflowRequestAt =
    Date.now();
}

function parseRetryAfter(
  value
) {
  if (!value) {
    return null;
  }

  const seconds =
    Number(value);

  if (
    Number.isFinite(
      seconds
    )
  ) {
    return Math.max(
      1000,
      Math.ceil(
        seconds * 1000
      )
    );
  }

  const timestamp =
    Date.parse(value);

  if (
    Number.isFinite(
      timestamp
    )
  ) {
    return Math.max(
      1000,
      timestamp -
        Date.now()
    );
  }

  return null;
}

async function wfRequest(
  url,
  options = {},
  retries =
    WEBFLOW_MAX_RETRIES
) {
  await throttleWebflow();

  const res =
    await fetch(
      url,
      options
    );

  if (
    res.status === 429 &&
    retries > 0
  ) {
    const retryAfter =
      parseRetryAfter(
        res.headers.get(
          'retry-after'
        )
      );

    const attempt =
      WEBFLOW_MAX_RETRIES -
      retries;

    const fallbackWait =
      Math.min(
        120000,
        15000 *
          Math.pow(
            2,
            attempt
          )
      );

    const waitMs =
      Math.max(
        retryAfter || 0,
        fallbackWait
      );

    console.warn(
      'Webflow rate limited — waiting ' +
        Math.ceil(
          waitMs / 1000
        ) +
        ' seconds before retry (' +
        (attempt + 1) +
        '/' +
        WEBFLOW_MAX_RETRIES +
        ')...'
    );

    await sleep(waitMs);

    return wfRequest(
      url,
      options,
      retries - 1
    );
  }

  if (!res.ok) {
    const text =
      await res.text();

    if (
      retries > 0 &&
      res.status >= 500
    ) {
      const attempt =
        WEBFLOW_MAX_RETRIES -
        retries;

      const waitMs =
        Math.min(
          30000,
          3000 *
            Math.pow(
              2,
              attempt
            )
        );

      console.warn(
        'Webflow ' +
          res.status +
          ' — retrying in ' +
          Math.ceil(
            waitMs / 1000
          ) +
          ' seconds...'
      );

      await sleep(waitMs);

      return wfRequest(
        url,
        options,
        retries - 1
      );
    }

    throw new Error(
      'Webflow ' +
        res.status +
        ': ' +
        text
    );
  }

  if (
    res.status === 204
  ) {
    return null;
  }

  const text =
    await res.text();

  if (!text) {
    return null;
  }

  try {
    return JSON.parse(
      text
    );
  } catch {
    return text;
  }
}

function wfHeaders(
  contentType = false
) {
  const headers = {
    Authorization:
      'Bearer ' +
      WEBFLOW_TOKEN,

    accept:
      'application/json'
  };

  if (contentType) {
    headers[
      'content-type'
    ] =
      'application/json';
  }

  return headers;
}

async function wfGetAllItems(
  collectionId
) {
  const items = [];

  const limit = 100;

  let offset = 0;

  while (true) {
    const data =
      await wfRequest(
        'https://api.webflow.com/v2/collections/' +
          collectionId +
          '/items?limit=' +
          limit +
          '&offset=' +
          offset,
        {
          headers:
            wfHeaders()
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
      items.length >=
      total
    ) {
      break;
    }

    offset += limit;
  }

  return items;
}

async function wfGetCollection(
  collectionId
) {
  return wfRequest(
    'https://api.webflow.com/v2/collections/' +
      collectionId,
    {
      headers:
        wfHeaders()
    }
  );
}

async function wfGetItem(
  collectionId,
  itemId
) {
  return wfRequest(
    'https://api.webflow.com/v2/collections/' +
      collectionId +
      '/items/' +
      itemId,
    {
      headers:
        wfHeaders()
    }
  );
}

async function wfUpdateItem(
  collectionId,
  itemId,
  fieldData
) {
  if (
    !Object.keys(
      fieldData
    ).length
  ) {
    return null;
  }

  return wfRequest(
    'https://api.webflow.com/v2/collections/' +
      collectionId +
      '/items/' +
      itemId,
    {
      method:
        'PATCH',

      headers:
        wfHeaders(true),

      body:
        JSON.stringify({
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
      method:
        'POST',

      headers:
        wfHeaders(true),

      body:
        JSON.stringify({
          isArchived: false,
          isDraft: false,
          fieldData
        })
    }
  );
}

async function wfPublishItems(
  collectionId,
  itemIds
) {
  const uniqueIds = [
    ...new Set(itemIds)
  ].filter(Boolean);

  if (
    !uniqueIds.length
  ) {
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
        method:
          'POST',

        headers:
          wfHeaders(true),

        body:
          JSON.stringify({
            itemIds: batch
          })
      }
    );
  }
}

async function wfUnpublishItems(
  collectionId,
  itemIds
) {
  const uniqueIds = [
    ...new Set(itemIds)
  ].filter(Boolean);

  if (
    !uniqueIds.length
  ) {
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
        method:
          'DELETE',

        headers:
          wfHeaders(true),

        body:
          JSON.stringify({
            items:
              batch.map(
                id => ({
                  id
                })
              )
          })
      }
    );
  }
}

// ============================================================
// WEBFLOW CHANGE DETECTION
// ============================================================

function comparableValue(
  value
) {
  if (
    value === undefined ||
    value === null
  ) {
    return '';
  }

  if (
    typeof value ===
      'object' &&
    !Array.isArray(value)
  ) {
    // For Webflow image fields the URL is what matters.
    // Webflow may transform/omit alt metadata, so don't
    // generate a PATCH every run just because of alt text.
    if (
      'url' in value
    ) {
      return String(
        value.url || ''
      );
    }

    return JSON.stringify(
      value
    );
  }

  if (
    Array.isArray(value)
  ) {
    return JSON.stringify(
      value
    );
  }

  return String(value);
}

function valuesEqual(
  current,
  next
) {
  return (
    comparableValue(
      current
    ) ===
    comparableValue(
      next
    )
  );
}

function getChangedFields(
  itemOrFieldData,
  proposedFieldData
) {
  const current =
    itemOrFieldData
      ?.fieldData ||
    itemOrFieldData ||
    {};

  const changed = {};

  for (
    const [
      key,
      nextValue
    ]
    of Object.entries(
      proposedFieldData
    )
  ) {
    if (
      !valuesEqual(
        current[key],
        nextValue
      )
    ) {
      changed[key] =
        nextValue;
    }
  }

  return changed;
}

// ============================================================
// TEAM LOOKUP
// ============================================================

function buildTeamLookup(
  items
) {
  const byApiId =
    new Map();

  const byName =
    new Map();

  for (
    const item
    of items
  ) {
    const apiId =
      getField(
        item,
        'api-team-id'
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
        !byApiId.has(
          key
        )
      ) {
        byApiId.set(
          key,
          []
        );
      }

      byApiId
        .get(key)
        .push(item);
    }

    if (name) {
      const key =
        normalizeName(
          name
        );

      if (
        !byName.has(
          key
        )
      ) {
        byName.set(
          key,
          []
        );
      }

      byName
        .get(key)
        .push(item);
    }
  }

  return {
    byApiId,
    byName
  };
}

function resolveTeam(
  apiTeam,
  lookup
) {
  if (!apiTeam) {
    return null;
  }

  const idMatches =
    lookup.byApiId.get(
      String(
        apiTeam.id
      )
    ) || [];

  if (
    idMatches.length === 1
  ) {
    return {
      item:
        idMatches[0],

      method:
        'api-team-id'
    };
  }

  if (
    idMatches.length > 1
  ) {
    const exactName =
      idMatches.filter(
        item =>
          normalizeName(
            getField(
              item,
              'name'
            )
          ) ===
          normalizeName(
            apiTeam.name
          )
      );

    if (
      exactName.length === 1
    ) {
      return {
        item:
          exactName[0],

        method:
          'api-team-id+name'
      };
    }
  }

  const nameMatches =
    lookup.byName.get(
      normalizeName(
        apiTeam.name
      )
    ) || [];

  if (
    nameMatches.length === 1
  ) {
    return {
      item:
        nameMatches[0],

      method:
        'exact-name'
    };
  }

  return null;
}

function buildApiTeamMetadataMap(
  teamsData
) {
  const map =
    new Map();

  for (
    const entry
    of teamsData.response ||
      []
  ) {
    if (
      entry.team?.id
    ) {
      map.set(
        String(
          entry.team.id
        ),
        entry
      );
    }
  }

  return map;
}

// ============================================================
// TEAMS
// ============================================================

async function syncTeams(
  finalTeams,
  teamsData
) {
  console.log(
    '\n=== TEAMS ==='
  );

  let allTeams =
    await wfGetAllItems(
      WF.TEAMS
    );

  let lookup =
    buildTeamLookup(
      allTeams
    );

  const apiMetadata =
    buildApiTeamMetadataMap(
      teamsData
    );

  const publishIds = [];

  let reused = 0;
  let updated = 0;
  let unchanged = 0;
  let created = 0;

  for (
    const apiTeam
    of finalTeams
  ) {
    const match =
      resolveTeam(
        apiTeam,
        lookup
      );

    const meta =
      apiMetadata.get(
        String(
          apiTeam.id
        )
      );

    if (match) {
      reused++;

      // IMPORTANT:
      // Never change existing Team item's league.
      const proposed = {
        'api-team-id':
          String(
            apiTeam.id
          )
      };

      if (
        meta?.team?.code
      ) {
        proposed[
          'short-name'
        ] =
          meta.team.code;
      }

      if (
        meta?.team?.country
      ) {
        proposed.country =
          meta.team.country;
      }

      if (
        meta?.team?.founded != null
      ) {
        proposed.founded =
          meta.team.founded;
      }

      if (
        meta?.venue?.city
      ) {
        proposed.city =
          meta.venue.city;
      }

      if (
        meta?.venue?.name
      ) {
        proposed.stadium =
          meta.venue.name;
      }

      if (
        meta?.team?.logo
      ) {
        proposed.badge = {
          url:
            meta.team.logo,

          alt:
            getField(
              match.item,
              'name'
            ) +
            ' badge'
        };
      }

      if (
        meta?.team?.country
      ) {
        proposed.flag =
          'https://media.api-sports.io/flags/' +
          countryToFlagCode(
            meta.team.country
          ) +
          '.svg';
      }

      const changed =
        getChangedFields(
          match.item,
          proposed
        );

      if (
        Object.keys(
          changed
        ).length
      ) {
        await wfUpdateItem(
          WF.TEAMS,
          match.item.id,
          changed
        );

        publishIds.push(
          match.item.id
        );

        updated++;

        console.log(
          'UPDATE: ' +
            apiTeam.name +
            ' -> ' +
            getField(
              match.item,
              'name'
            ) +
            ' [' +
            Object.keys(
              changed
            ).join(', ') +
            ']'
        );
      } else {
        unchanged++;

        console.log(
          'REUSE: ' +
            apiTeam.name +
            ' -> ' +
            getField(
              match.item,
              'name'
            ) +
            ' [' +
            match.method +
            ', no changes]'
        );
      }

      continue;
    }

    if (!meta) {
      throw new Error(
        'No /teams metadata found for missing League Phase club: ' +
          apiTeam.name
      );
    }

    const fieldData = {
      name:
        meta.team.name,

      slug:
        slugify(
          meta.team.name
        ),

      'short-name':
        meta.team.code ||
        meta.team.name
          .slice(0, 3)
          .toUpperCase(),

      league:
        UCL.webflow_id,

      'api-team-id':
        String(
          meta.team.id
        ),

      country:
        meta.team.country ||
        '',

      city:
        meta.venue?.city ||
        '',

      stadium:
        meta.venue?.name ||
        '',

      founded:
        meta.team.founded ||
        null
    };

    if (
      meta.team.logo
    ) {
      fieldData.badge = {
        url:
          meta.team.logo,

        alt:
          meta.team.name +
          ' badge'
      };
    }

    if (
      meta.team.country
    ) {
      fieldData.flag =
        'https://media.api-sports.io/flags/' +
        countryToFlagCode(
          meta.team.country
        ) +
        '.svg';
    }

    const newItem =
      await wfCreateItem(
        WF.TEAMS,
        fieldData
      );

    publishIds.push(
      newItem.id
    );

    created++;

    console.log(
      'CREATE: ' +
        meta.team.name
    );

    allTeams.push(
      newItem
    );

    lookup =
      buildTeamLookup(
        allTeams
      );
  }

  await wfPublishItems(
    WF.TEAMS,
    publishIds
  );

  console.log(
    'Teams complete: ' +
      reused +
      ' reused, ' +
      updated +
      ' updated, ' +
      unchanged +
      ' unchanged, ' +
      created +
      ' created'
  );

  allTeams =
    await wfGetAllItems(
      WF.TEAMS
    );

  lookup =
    buildTeamLookup(
      allTeams
    );

  return {
    allTeams,
    lookup
  };
}

// ============================================================
// STANDINGS
// ============================================================

function getApiStandingsTable(
  standingsData
) {
  const groups =
    standingsData
      .response?.[0]
      ?.league
      ?.standings ||
    [];

  for (
    const group
    of groups
  ) {
    if (
      Array.isArray(
        group
      ) &&
      group.length ===
        EXPECTED_TEAMS
    ) {
      return group;
    }
  }

  return [];
}

async function syncStandings(
  finalTeams,
  teamLookup,
  standingsData,
  leagueFixtures
) {
  console.log(
    '\n=== STANDINGS ==='
  );

  const leaguePhaseFormMap =
    buildLeaguePhaseFormMap(
      leagueFixtures
    );

  const finishedLeaguePhase =
    leagueFixtures.filter(
      fixture =>
        FINISHED_STATUSES.has(
          fixture.fixture
            ?.status
            ?.short
        )
    );

  console.log(
    'UCL League Phase form calculated from ' +
      finishedLeaguePhase.length +
      ' finished League Phase fixtures.'
  );

  const allStandings =
    await wfGetAllItems(
      WF.STANDINGS
    );

  const currentUclStandings =
    allStandings.filter(
      item =>
        getField(
          item,
          'league'
        ) ===
        UCL.webflow_id
    );

  const existingByTeamRef =
    new Map();

  for (
    const item
    of currentUclStandings
  ) {
    const teamRef =
      getField(
        item,
        'team'
      );

    if (
      teamRef &&
      !existingByTeamRef.has(
        teamRef
      )
    ) {
      existingByTeamRef.set(
        teamRef,
        item
      );
    }
  }

  const apiTable =
    getApiStandingsTable(
      standingsData
    );

  const rows = [];

  if (
    apiTable.length ===
    EXPECTED_TEAMS
  ) {
    console.log(
      'Using live API UCL standings: 36 rows'
    );

    rows.push(
      ...apiTable
    );
  } else {
    console.log(
      'No 36-row API standings yet — writing safe zeroed League Phase table'
    );

    const sortedTeams =
      [...finalTeams]
        .sort(
          (a, b) =>
            a.name.localeCompare(
              b.name
            )
        );

    sortedTeams.forEach(
      (team, index) => {
        rows.push({
          team,

          rank:
            index + 1,

          all: {
            played: 0,
            win: 0,
            draw: 0,
            lose: 0,

            goals: {
              for: 0,
              against: 0
            }
          },

          goalsDiff: 0,
          points: 0,
          form: null
        });
      }
    );
  }

  const currentTeamRefs =
    new Set();

  const publishIds = [];

  let updated = 0;
  let unchanged = 0;
  let created = 0;

  for (
    const entry
    of rows
  ) {
    const teamMatch =
      resolveTeam(
        entry.team,
        teamLookup
      );

    if (!teamMatch) {
      throw new Error(
        'Cannot resolve UCL standing team: ' +
          entry.team.name
      );
    }

    const wfTeam =
      teamMatch.item;

    currentTeamRefs.add(
      wfTeam.id
    );

    const all =
      entry.all ||
      {};

    const goals =
      all.goals ||
      {};

    const uclForm =
      (
        leaguePhaseFormMap.get(
          String(
            entry.team.id
          )
        ) || []
      ).join('');

    const fieldData = {
      name:
        getField(
          wfTeam,
          'name'
        ),

      slug:
        slugify(
          getField(
            wfTeam,
            'name'
          )
        ) +
        '-ucl-standing',

      team:
        wfTeam.id,

      league:
        UCL.webflow_id,

      position:
        Number(
          entry.rank ||
          0
        ),

      played:
        Number(
          all.played ||
          0
        ),

      won:
        Number(
          all.win ||
          0
        ),

      drawn:
        Number(
          all.draw ||
          0
        ),

      lost:
        Number(
          all.lose ||
          0
        ),

      'goals-for':
        Number(
          goals.for ||
          0
        ),

      'goals-against':
        Number(
          goals.against ||
          0
        ),

      'goal-difference':
        Number(
          entry.goalsDiff ||
          0
        ),

      points:
        Number(
          entry.points ||
          0
        ),

      // IMPORTANT:
      // Never use entry.form here.
      // This is ONLY UCL League Phase form.
      form:
        uclForm
    };

    const existing =
      existingByTeamRef.get(
        wfTeam.id
      );

    if (existing) {
      const changed =
        getChangedFields(
          existing,
          fieldData
        );

      if (
        Object.keys(
          changed
        ).length
      ) {
        await wfUpdateItem(
          WF.STANDINGS,
          existing.id,
          changed
        );

        publishIds.push(
          existing.id
        );

        updated++;

        console.log(
          'STANDING UPDATE: ' +
            getField(
              wfTeam,
              'name'
            ) +
            ' [' +
            Object.keys(
              changed
            ).join(', ') +
            ']'
        );
      } else {
        unchanged++;
      }
    } else {
      const newItem =
        await wfCreateItem(
          WF.STANDINGS,
          fieldData
        );

      publishIds.push(
        newItem.id
      );

      created++;
    }
  }

  await wfPublishItems(
    WF.STANDINGS,
    publishIds
  );

  const staleLiveIds =
    currentUclStandings
      .filter(
        item => {
          const teamRef =
            getField(
              item,
              'team'
            );

          return (
            teamRef &&
            !currentTeamRefs.has(
              teamRef
            ) &&
            !item.isDraft
          );
        }
      )
      .map(
        item =>
          item.id
      );

  if (
    staleLiveIds.length
  ) {
    console.log(
      'Unpublishing stale old UCL standings: ' +
        staleLiveIds.length
    );

    await wfUnpublishItems(
      WF.STANDINGS,
      staleLiveIds
    );
  }

  console.log(
    'Standings complete: ' +
      updated +
      ' updated, ' +
      unchanged +
      ' unchanged, ' +
      created +
      ' created, ' +
      staleLiveIds.length +
      ' stale unpublished'
  );
}

// ============================================================
// FIXTURE SAFETY
// ============================================================

async function unpublishUclFixturesUntilScheduleReady() {
  console.log(
    '\n=== FIXTURES SAFETY ==='
  );

  const allMatches =
    await wfGetAllItems(
      WF.MATCHES
    );

  const liveUclMatches =
    allMatches.filter(
      item =>
        getField(
          item,
          'league'
        ) ===
          UCL.webflow_id &&
        !item.isDraft
    );

  const ids =
    liveUclMatches.map(
      item =>
        item.id
    );

  if (
    !ids.length
  ) {
    console.log(
      'No live UCL fixtures to unpublish.'
    );

    return;
  }

  console.log(
    'Schedule is not finalized — unpublishing ' +
      ids.length +
      ' UCL fixtures.'
  );

  await wfUnpublishItems(
    WF.MATCHES,
    ids
  );

  console.log(
    'Placeholder UCL fixtures removed from live site.'
  );
}

// ============================================================
// MATCHES
// ============================================================

async function syncMatches(
  leagueFixtures,
  teamLookup,
  matchweekInfo
) {
  console.log(
    '\n=== MATCHES ==='
  );

  const allMatches =
    await wfGetAllItems(
      WF.MATCHES
    );

  const uclMatches =
    allMatches.filter(
      item =>
        getField(
          item,
          'league'
        ) ===
        UCL.webflow_id
    );

  const existingByApiId =
    new Map();

  for (
    const item
    of uclMatches
  ) {
    const apiId =
      getField(
        item,
        'api-fixture-id'
      );

    if (
      apiId &&
      !existingByApiId.has(
        String(apiId)
      )
    ) {
      existingByApiId.set(
        String(apiId),
        item
      );
    }
  }

  const currentFixtureIds =
    new Set(
      leagueFixtures.map(
        fixture =>
          String(
            fixture.fixture.id
          )
      )
    );

  const publishIds = [];

  let updated = 0;
  let unchanged = 0;
  let created = 0;

  for (
    const fixture
    of leagueFixtures
  ) {
    const home =
      resolveTeam(
        fixture.teams?.home,
        teamLookup
      );

    const away =
      resolveTeam(
        fixture.teams?.away,
        teamLookup
      );

    if (
      !home ||
      !away
    ) {
      throw new Error(
        'Cannot resolve fixture teams: ' +
          (
            fixture.teams
              ?.home
              ?.name ||
            '?'
          ) +
          ' vs ' +
          (
            fixture.teams
              ?.away
              ?.name ||
            '?'
          )
      );
    }

    const fixtureId =
      String(
        fixture.fixture.id
      );

    const matchweek =
      matchweekInfo
        .byFixtureId
        .get(
          fixtureId
        ) ||
      null;

    const homeName =
      getField(
        home.item,
        'name'
      );

    const awayName =
      getField(
        away.item,
        'name'
      );

    const fieldData = {
      name:
        homeName +
        ' vs ' +
        awayName,

      slug:
        slugify(
          homeName
        ) +
        '-vs-' +
        slugify(
          awayName
        ) +
        '-' +
        fixtureId,

      league:
        UCL.webflow_id,

      'home-team':
        home.item.id,

      'away-team':
        away.item.id,

      'home-badge':
        getField(
          home.item,
          'badge'
        ) ||
        null,

      'away-badge':
        getField(
          away.item,
          'badge'
        ) ||
        null,

      'match-date':
        fixture.fixture.date,

      'round-label':
        fixture.league
          ?.round ||
        'Group Stage',

      matchweek,

      'home-score':
        fixture.goals
          ?.home ??
        null,

      'away-score':
        fixture.goals
          ?.away ??
        null,

      status:
        mapMatchStatus(
          fixture.fixture
            .status
            ?.short
        ),

      venue:
        fixture.fixture
          .venue
          ?.name ||
        '',

      'api-fixture-id':
        fixture.fixture.id
    };

    const existing =
      existingByApiId.get(
        fixtureId
      );

    if (existing) {
      const changed =
        getChangedFields(
          existing,
          fieldData
        );

      if (
        Object.keys(
          changed
        ).length
      ) {
        await wfUpdateItem(
          WF.MATCHES,
          existing.id,
          changed
        );

        publishIds.push(
          existing.id
        );

        updated++;
      } else {
        unchanged++;
      }
    } else {
      const newItem =
        await wfCreateItem(
          WF.MATCHES,
          fieldData
        );

      publishIds.push(
        newItem.id
      );

      created++;
    }
  }

  await wfPublishItems(
    WF.MATCHES,
    publishIds
  );

  const staleLiveIds =
    uclMatches
      .filter(
        item => {
          const apiId =
            getField(
              item,
              'api-fixture-id'
            );

          return (
            apiId &&
            !currentFixtureIds.has(
              String(apiId)
            ) &&
            !item.isDraft
          );
        }
      )
      .map(
        item =>
          item.id
      );

  if (
    staleLiveIds.length
  ) {
    console.log(
      'Unpublishing old/non-League-Phase UCL matches: ' +
        staleLiveIds.length
    );

    await wfUnpublishItems(
      WF.MATCHES,
      staleLiveIds
    );
  }

  console.log(
    'Matches complete: ' +
      updated +
      ' updated, ' +
      unchanged +
      ' unchanged, ' +
      created +
      ' created, ' +
      staleLiveIds.length +
      ' stale unpublished'
  );
}

// ============================================================
// LEAGUE METADATA
// ============================================================

function normalizeDisplayName(
  value
) {
  return String(value || '')
    .toLowerCase()
    .replace(
      /[^a-z0-9]+/g,
      ' '
    )
    .trim();
}

function findFieldByNames(
  collection,
  names
) {
  const wanted =
    new Set(
      names.map(
        normalizeDisplayName
      )
    );

  return (
    (
      collection.fields ||
      []
    ).find(
      field =>
        wanted.has(
          normalizeDisplayName(
            field.displayName
          )
        )
    ) ||
    null
  );
}

async function syncLeagueMetadata(
  leagueFixtures,
  matchweekInfo
) {
  console.log(
    '\n=== LEAGUE METADATA ==='
  );

  // Keep these sequential so Webflow calls
  // cannot race our own throttle.
  const collection =
    await wfGetCollection(
      WF.LEAGUES
    );

  const leagueItem =
    await wfGetItem(
      WF.LEAGUES,
      UCL.webflow_id
    );

  const seasonField =
    findFieldByNames(
      collection,
      [
        'Season'
      ]
    );

  const clubsField =
    findFieldByNames(
      collection,
      [
        'Total Clubs',
        'Clubs'
      ]
    );

  const matchdayField =
    findFieldByNames(
      collection,
      [
        'Current Matchday',
        'Matchday'
      ]
    );

  const goalsField =
    findFieldByNames(
      collection,
      [
        'Total Goals'
      ]
    );

  const gpgField =
    findFieldByNames(
      collection,
      [
        'Goals Per Game'
      ]
    );

  const startedOrFinished =
    leagueFixtures.filter(
      fixture => {
        const status =
          fixture.fixture
            .status
            ?.short;

        return (
          LIVE_STATUSES.has(
            status
          ) ||
          FINISHED_STATUSES.has(
            status
          )
        );
      }
    );

  const finished =
    leagueFixtures.filter(
      fixture =>
        FINISHED_STATUSES.has(
          fixture.fixture
            .status
            ?.short
        )
    );

  let currentMatchday = 0;
  let totalGoals = 0;

  for (
    const fixture
    of startedOrFinished
  ) {
    const mw =
      matchweekInfo
        .byFixtureId
        .get(
          String(
            fixture.fixture.id
          )
        );

    if (
      mw &&
      mw >
        currentMatchday
    ) {
      currentMatchday =
        mw;
    }
  }

  for (
    const fixture
    of finished
  ) {
    const home =
      Number(
        fixture.goals
          ?.home
      );

    const away =
      Number(
        fixture.goals
          ?.away
      );

    if (
      Number.isFinite(
        home
      )
    ) {
      totalGoals += home;
    }

    if (
      Number.isFinite(
        away
      )
    ) {
      totalGoals += away;
    }
  }

  const goalsPerGame =
    finished.length
      ? (
          totalGoals /
          finished.length
        )
          .toFixed(2)
          .replace(
            /\.00$/,
            ''
          )
      : '0';

  const proposed = {};

  if (seasonField) {
    proposed[
      seasonField.slug
    ] =
      UCL.seasonLabel;
  }

  if (clubsField) {
    proposed[
      clubsField.slug
    ] =
      EXPECTED_TEAMS;
  }

  if (matchdayField) {
    proposed[
      matchdayField.slug
    ] =
      currentMatchday;
  }

  if (goalsField) {
    proposed[
      goalsField.slug
    ] =
      totalGoals;
  }

  if (gpgField) {
    proposed[
      gpgField.slug
    ] =
      String(
        goalsPerGame
      );
  }

  const changed =
    getChangedFields(
      leagueItem,
      proposed
    );

  if (
    !Object.keys(
      changed
    ).length
  ) {
    console.log(
      'League metadata unchanged — skipping Webflow write.'
    );

    return;
  }

  console.log(
    'Metadata changes:',
    changed
  );

  await wfUpdateItem(
    WF.LEAGUES,
    UCL.webflow_id,
    changed
  );

  await wfPublishItems(
    WF.LEAGUES,
    [
      UCL.webflow_id
    ]
  );
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
    '============================================================'
  );

  console.log(
    'UCL 2026/27 PRODUCTION SYNC'
  );

  console.log(
    'League Phase only'
  );

  console.log(
    'Rate-limit-safe mode enabled'
  );

  console.log(
    '============================================================\n'
  );

  console.log(
    'Fetching API-Football UCL data...'
  );

  const [
    teamsData,
    standingsData,
    fixturesData
  ] =
    await Promise.all([
      apiFetch(
        '/teams?league=' +
          UCL.api_id +
          '&season=' +
          UCL.season
      ),

      apiFetch(
        '/standings?league=' +
          UCL.api_id +
          '&season=' +
          UCL.season
      ),

      apiFetch(
        '/fixtures?league=' +
          UCL.api_id +
          '&season=' +
          UCL.season
      )
    ]);

  const allFixtures =
    fixturesData.response ||
    [];

  const leagueFixtures =
    allFixtures.filter(
      fixture =>
        isLeaguePhaseRound(
          fixture.league
            ?.round
        )
    );

  const finalTeams =
    uniqueTeamsFromFixtures(
      leagueFixtures
    );

  console.log(
    'API all UCL teams: ' +
      (
        teamsData.response ||
        []
      ).length
  );

  console.log(
    'API all UCL fixtures: ' +
      allFixtures.length
  );

  console.log(
    'League Phase fixtures: ' +
      leagueFixtures.length
  );

  console.log(
    'League Phase unique teams: ' +
      finalTeams.length
  );

  // HARD SAFETY GATE:
  // Qualifiers cannot leak into production.
  if (
    finalTeams.length !==
      EXPECTED_TEAMS ||
    leagueFixtures.length !==
      EXPECTED_FIXTURES
  ) {
    throw new Error(
      'SAFETY STOP: expected exactly 36 League Phase teams and 144 fixtures, got ' +
        finalTeams.length +
        ' teams / ' +
        leagueFixtures.length +
        ' fixtures.'
    );
  }

  const matchweekInfo =
    inferMatchweeks(
      leagueFixtures
    );

  console.log(
    'Inferred League Phase matchweeks: ' +
      matchweekInfo.count
  );

  if (
    matchweekInfo.count !==
    EXPECTED_MATCHWEEKS
  ) {
    console.warn(
      'WARNING: expected 8 matchweek date clusters, got ' +
        matchweekInfo.count +
        '. Placeholder fixtures will remain unpublished until the schedule is finalized.'
    );
  }

  if (!CONFIRM) {
    console.log(
      '\nSAFETY STOP: CONFIRM is not yes. Nothing was written.'
    );

    return;
  }

  console.log(
    '\nCONFIRM=yes — beginning Webflow writes.'
  );

  const {
    lookup:
      teamLookup
  } =
    await syncTeams(
      finalTeams,
      teamsData
    );

  await syncStandings(
    finalTeams,
    teamLookup,
    standingsData,
    leagueFixtures
  );

  if (
    matchweekInfo.count ===
    EXPECTED_MATCHWEEKS
  ) {
    console.log(
      '\nFinal UCL schedule detected: 8 matchweeks.'
    );

    await syncMatches(
      leagueFixtures,
      teamLookup,
      matchweekInfo
    );
  } else {
    console.log(
      '\nUCL schedule is not finalized yet.'
    );

    console.log(
      'Detected matchweek clusters: ' +
        matchweekInfo.count +
        ' / ' +
        EXPECTED_MATCHWEEKS
    );

    await unpublishUclFixturesUntilScheduleReady();
  }

  await syncLeagueMetadata(
    leagueFixtures,
    matchweekInfo
  );

  console.log(
    '\n============================================================'
  );

  console.log(
    'UCL 2026/27 SYNC COMPLETE'
  );

  console.log(
    '============================================================'
  );

  console.log(
    'Top scorers intentionally NOT synced yet.'
  );
}

main().catch(
  err => {
    console.error(
      'FATAL:',
      err.message
    );

    process.exit(1);
  }
);
