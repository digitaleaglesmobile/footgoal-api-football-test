// ============================================================
// sync-live.js — footgoal.co
//
// Lightweight live-score sync for the 7 active leagues.
// Intended to be triggered about once per minute by an external pinger.
//
// Normal minute:
// - 1 API-Football call: /fixtures?live=all
// - if no target-league match is live, no Webflow calls/writes
//
// Every 5th minute:
// - also checks recently finished fixtures (last 4 hours)
// - catches the final FT/AET/PEN score/status after a match disappears
//   from /fixtures?live=all
//
// IMPORTANT OPTIMIZATION:
// - NEVER fetches the whole 2,000+ Matches collection
// - looks up each relevant Webflow match by its exact deterministic slug
// - writes only if score/status actually changed
// - standings sync only when a match has just transitioned to Played
// - does NOT create missing match items; full sync is the safety net
//
// UPDATE (2026-08-22):
// - Full-site publish (wfPublishSite) disabled. Item-level publishing
//   (wfPublishItems) already pushes each updated match/standing item
//   live without a full site rebuild. wfPublishSite() was firing on
//   almost every tick during busy live windows, triggering a full site
//   rebuild that made CMS-heavy pages (e.g. /premier-league) render
//   several seconds slower for visitors during that time. Testing
//   whether item-level publishing alone keeps scores updating live;
//   if not, uncomment the wfPublishSite() call below.
// ============================================================
const WEBFLOW_TOKEN = process.env.WEBFLOW_TOKEN;
const API_FOOTBALL_KEY = process.env.API_FOOTBALL_KEY;
const WF = {
  TEAMS: '6a20064807685f373db26660',
  STANDINGS: '6a200649847c9fcb9278de02',
  MATCHES: '6a200649c668e2cb8f11e82b'
};
const SITE_ID = '69c3c0d82fd37856ad9e297a';
const CUSTOM_DOMAINS = [
  '69c4fc77a50ac7d07e84308a',
  '69c4fc76a50ac7d07e843018'
];
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
const LEAGUE_BY_API_ID = new Map(
  LEAGUES.map(league => [
    league.api_id,
    league
  ])
);
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
const RECENT_FINISHED_LOOKBACK_MS =
  4 * 60 * 60 * 1000;
const API_DELAY_MS = 200;
const WEBFLOW_WRITE_DELAY_MS = 500;
const MANUAL_ALIASES = {
  'atletico paranaense': 'paranaense',
  'atletico mg': 'mineiro',
  'inter': 'internazionale milano',
  'lyon': 'olympique lyonnais',
  'rennes': 'stade rennais',
  'estac troyes': 'es troyes'
};
// ============================================================
// HELPERS
// ============================================================
function sleep(ms) {
  return new Promise(resolve =>
    setTimeout(resolve, ms)
  );
}
function normalizeTeamName(name) {
  let value = String(name || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[.\-']/g, ' ')
    .replace(
      /\b(fc|afc|cf|sc|ac|rc|rcd|cd|ud|sv|vfl|vfb|tsg|ssc|us|as|ss|fsv|tsv|spvgg|bsc|bv|vfr|fk|nk|sk|gnk|ca|club|de|del|la|le|el|los|las|a|do|da)\b/gi,
      ''
    )
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return MANUAL_ALIASES[value] || value;
}
function slugify(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-');
}
function mapMatchStatus(shortStatus) {
  if (
    FINISHED_STATUSES.has(shortStatus)
  ) {
    return 'Played';
  }
  if (
    LIVE_STATUSES.has(shortStatus)
  ) {
    return 'Live';
  }
  return 'Upcoming';
}
function formatUtcDate(ms) {
  return new Date(ms)
    .toISOString()
    .slice(0, 10);
}
function sameValue(a, b) {
  if (
    a == null &&
    b == null
  ) {
    return true;
  }
  return String(a) === String(b);
}
// ============================================================
// API FOOTBALL
// ============================================================
async function apiFetch(
  path,
  retries = 3
) {
  await sleep(API_DELAY_MS);
  const res = await fetch(
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
// WEBFLOW REQUEST
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
async function wfGetAllItems(
  collectionId
) {
  const items = [];
  const limit = 100;
  let offset = 0;
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
            'Bearer ' +
            WEBFLOW_TOKEN,
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
async function wfGetItemBySlug(
  collectionId,
  slug
) {
  const data = await wfRequest(
    'https://api.webflow.com/v2/collections/' +
      collectionId +
      '/items?limit=2&slug=' +
      encodeURIComponent(slug),
    {
      headers: {
        Authorization:
          'Bearer ' +
          WEBFLOW_TOKEN,
        accept:
          'application/json'
      }
    }
  );
  const items =
    data.items || [];
  if (
    items.length > 1
  ) {
    console.warn(
      'Multiple Webflow items found for slug: ' +
      slug
    );
  }
  return items[0] || null;
}
// ============================================================
// WEBFLOW WRITE
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
          'Bearer ' +
          WEBFLOW_TOKEN,
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
          'Bearer ' +
          WEBFLOW_TOKEN,
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
async function wfPublishItems(
  collectionId,
  itemIds
) {
  const uniqueIds =
    [...new Set(itemIds)]
      .filter(Boolean);
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
            'Bearer ' +
            WEBFLOW_TOKEN,
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
    await sleep(
      WEBFLOW_WRITE_DELAY_MS
    );
  }
}
async function wfPublishSite() {
  await wfRequest(
    'https://api.webflow.com/v2/sites/' +
      SITE_ID +
      '/publish',
    {
      method: 'POST',
      headers: {
        Authorization:
          'Bearer ' +
          WEBFLOW_TOKEN,
        accept:
          'application/json',
        'content-type':
          'application/json'
      },
      body: JSON.stringify({
        customDomains:
          CUSTOM_DOMAINS,
        publishToWebflowSubdomain:
          true
      })
    }
  );
  console.log(
    'Site published to footgoal.co / [www.footgoal.co](https://www.footgoal.co).'
  );
}
// ============================================================
// TEAM LOOKUP
// ============================================================
function buildTeamLookup(
  allTeams
) {
  const byApiId =
    new Map();
  const byName =
    new Map();
  for (
    const team
    of allTeams
  ) {
    const fieldData =
      team.fieldData || {};
    const apiId =
      fieldData['api-team-id'];
    const name =
      fieldData.name;
    if (
      apiId != null &&
      apiId !== ''
    ) {
      byApiId.set(
        String(apiId),
        team
      );
    }
    if (name) {
      const normalized =
        normalizeTeamName(name);
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
  const byId =
    teamLookup
      .byApiId
      .get(
        String(apiTeam.id)
      );
  if (byId) {
    return byId;
  }
  const normalized =
    normalizeTeamName(
      apiTeam.name
    );
  const exact =
    teamLookup
      .byName
      .get(normalized) || [];
  if (
    exact.length === 1
  ) {
    return exact[0];
  }
  return null;
}
// ============================================================
// LIVE / RECENT FIXTURES
// ============================================================
async function getLiveTargetFixtures() {
  const data =
    await apiFetch(
      '/fixtures?live=all'
    );
  const fixtures =
    data.response || [];
  return fixtures.filter(
    fixture =>
      LEAGUE_BY_API_ID.has(
        fixture.league.id
      ) &&
      LIVE_STATUSES.has(
        fixture.fixture.status.short
      )
  );
}
async function getRecentFinishedTargetFixtures(
  nowMs
) {
  const fromMs =
    nowMs -
    RECENT_FINISHED_LOOKBACK_MS;
  const dates =
    [...new Set([
      formatUtcDate(nowMs),
      formatUtcDate(fromMs)
    ])];
  const byFixtureId =
    new Map();
  for (
    const date
    of dates
  ) {
    const data =
      await apiFetch(
        '/fixtures?date=' +
        date +
        '&timezone=UTC'
      );
    for (
      const fixture
      of data.response || []
    ) {
      if (
        !LEAGUE_BY_API_ID.has(
          fixture.league.id
        )
      ) {
        continue;
      }
      if (
        !FINISHED_STATUSES.has(
          fixture.fixture.status.short
        )
      ) {
        continue;
      }
      const kickoffMs =
        Number(
          fixture.fixture.timestamp
        ) * 1000;
      if (
        Number.isFinite(kickoffMs) &&
        kickoffMs >= fromMs &&
        kickoffMs <= nowMs
      ) {
        byFixtureId.set(
          String(
            fixture.fixture.id
          ),
          fixture
        );
      }
    }
  }
  return [
    ...byFixtureId.values()
  ];
}
// ============================================================
// MATCH FIELD DATA
// ============================================================
function buildMatchSlug(
  apiFixture,
  homeTeam,
  awayTeam
) {
  return (
    slugify(
      homeTeam.fieldData.name
    ) +
    '-vs-' +
    slugify(
      awayTeam.fieldData.name
    ) +
    '-' +
    apiFixture.fixture.id
  );
}
function buildMatchFieldData(
  apiFixture,
  league,
  homeTeam,
  awayTeam
) {
  const roundText =
    apiFixture.league.round || '';
  const roundMatch =
    roundText.match(
      /(\d+)/
    );
  const matchweek =
    roundMatch
      ? parseInt(
          roundMatch[1],
          10
        )
      : null;
  return {
    name:
      homeTeam.fieldData.name +
      ' vs ' +
      awayTeam.fieldData.name,
    slug:
      buildMatchSlug(
        apiFixture,
        homeTeam,
        awayTeam
      ),
    league:
      league.webflow_id,
    'home-team':
      homeTeam.id,
    'away-team':
      awayTeam.id,
    'home-badge':
      homeTeam.fieldData.badge ||
      null,
    'away-badge':
      awayTeam.fieldData.badge ||
      null,
    'match-date':
      apiFixture.fixture.date,
    'round-label':
      roundText,
    matchweek,
    'home-score':
      apiFixture.goals.home,
    'away-score':
      apiFixture.goals.away,
    status:
      mapMatchStatus(
        apiFixture.fixture.status.short
      ),
    venue:
      apiFixture.fixture.venue &&
      apiFixture.fixture.venue.name
        ? apiFixture.fixture.venue.name
        : '',
    'api-fixture-id':
      apiFixture.fixture.id
  };
}
function matchNeedsLiveUpdate(
  existingItem,
  newFieldData
) {
  const old =
    existingItem.fieldData || {};
  return (
    !sameValue(
      old['home-score'],
      newFieldData['home-score']
    ) ||
    !sameValue(
      old['away-score'],
      newFieldData['away-score']
    ) ||
    !sameValue(
      old.status,
      newFieldData.status
    )
  );
}
// ============================================================
// MATCH SYNC
// ============================================================
async function syncRelevantMatches(
  fixtures,
  teamLookup
) {
  const publishIds = [];
  const newlyFinishedLeagueIds =
    new Set();
  let updated = 0;
  let unchanged = 0;
  let missing = 0;
  let skipped = 0;
  let failed = 0;
  for (
    const fixture
    of fixtures
  ) {
    const league =
      LEAGUE_BY_API_ID.get(
        fixture.league.id
      );
    if (!league) {
      continue;
    }
    const homeTeam =
      resolveTeam(
        fixture.teams.home,
        teamLookup
      );
    const awayTeam =
      resolveTeam(
        fixture.teams.away,
        teamLookup
      );
    if (
      !homeTeam ||
      !awayTeam
    ) {
      skipped++;
      console.warn(
        'TEAM MATCH FAILED: ' +
        fixture.teams.home.name +
        ' vs ' +
        fixture.teams.away.name
      );
      continue;
    }
    const fieldData =
      buildMatchFieldData(
        fixture,
        league,
        homeTeam,
        awayTeam
      );
    const existing =
      await wfGetItemBySlug(
        WF.MATCHES,
        fieldData.slug
      );
    if (!existing) {
      missing++;
      console.warn(
        'MATCH NOT FOUND IN WEBFLOW: ' +
        fieldData.name +
        ' | fixture ' +
        fixture.fixture.id +
        ' — skipping safely; Full League Sync can repair it.'
      );
      continue;
    }
    const oldStatus =
      existing.fieldData
        ? existing.fieldData.status
        : null;
    const needsUpdate =
      matchNeedsLiveUpdate(
        existing,
        fieldData
      );
    if (!needsUpdate) {
      unchanged++;
      continue;
    }
    try {
      await wfUpdateItem(
        WF.MATCHES,
        existing.id,
        fieldData
      );
      publishIds.push(
        existing.id
      );
      updated++;
      if (
        fieldData.status ===
          'Played' &&
        oldStatus !==
          'Played'
      ) {
        newlyFinishedLeagueIds.add(
          league.api_id
        );
      }
      console.log(
        '[' +
        fieldData.status.toUpperCase() +
        '] ' +
        homeTeam.fieldData.name +
        ' ' +
        fixture.goals.home +
        '-' +
        fixture.goals.away +
        ' ' +
        awayTeam.fieldData.name
      );
    } catch (err) {
      failed++;
      console.error(
        'MATCH WRITE FAILED ' +
        fixture.fixture.id +
        ': ' +
        err.message
      );
    }
  }
  await wfPublishItems(
    WF.MATCHES,
    publishIds
  );
  console.log(
    'Matches: ' +
    updated +
    ' updated, ' +
    unchanged +
    ' unchanged, ' +
    missing +
    ' missing, ' +
    skipped +
    ' team-skipped, ' +
    failed +
    ' failed'
  );
  return {
    changed:
      publishIds.length,
    failed,
    newlyFinishedLeagueIds
  };
}
// ============================================================
// STANDINGS
// ============================================================
function buildStandingIndex(
  allStandings,
  leagueWebflowId
) {
  const index =
    new Map();
  for (
    const item
    of allStandings
  ) {
    const fieldData =
      item.fieldData || {};
    if (
      fieldData.team &&
      fieldData.league ===
        leagueWebflowId
    ) {
      index.set(
        fieldData.team,
        item
      );
    }
  }
  return index;
}
async function syncStandingsForLeague(
  league,
  teamLookup,
  allStandings
) {
  console.log(
    '[FINAL] Syncing standings for ' +
    league.name
  );
  const data =
    await apiFetch(
      '/standings?league=' +
      league.api_id +
      '&season=' +
      league.season
    );
  const table =
    data.response &&
    data.response[0] &&
    data.response[0].league &&
    data.response[0].league.standings &&
    data.response[0].league.standings[0]
      ? data.response[0]
          .league
          .standings[0]
      : [];
  if (!table.length) {
    console.log(
      'No standings table yet for ' +
      league.name
    );
    return 0;
  }
  const standingIndex =
    buildStandingIndex(
      allStandings,
      league.webflow_id
    );
  const publishIds = [];
  for (
    const entry
    of table
  ) {
    const team =
      resolveTeam(
        entry.team,
        teamLookup
      );
    if (!team) {
      console.warn(
        'STANDING TEAM MATCH FAILED: ' +
        entry.team.name
      );
      continue;
    }
    const fieldData = {
      name:
        team.fieldData.name,
      slug:
        normalizeTeamName(
          team.fieldData.name
        )
          .replace(
            /\s+/g,
            '-'
          ) +
        '-' +
        league.code.toLowerCase() +
        '-standing',
      team:
        team.id,
      league:
        league.webflow_id,
      position:
        entry.rank,
      played:
        entry.all.played,
      won:
        entry.all.win,
      drawn:
        entry.all.draw,
      lost:
        entry.all.lose,
      'goals-for':
        entry.all.goals.for,
      'goals-against':
        entry.all.goals.against,
      'goal-difference':
        entry.goalsDiff,
      points:
        entry.points,
      form:
        entry.form
          ? entry.form.slice(-5)
          : ''
    };
    const existing =
      standingIndex.get(
        team.id
      );
    if (existing) {
      await wfUpdateItem(
        WF.STANDINGS,
        existing.id,
        fieldData
      );
      publishIds.push(
        existing.id
      );
    } else {
      const created =
        await wfCreateItem(
          WF.STANDINGS,
          fieldData
        );
      if (
        created &&
        created.id
      ) {
        publishIds.push(
          created.id
        );
      }
    }
  }
  await wfPublishItems(
    WF.STANDINGS,
    publishIds
  );
  console.log(
    league.name +
    ' standings: ' +
    publishIds.length +
    ' item(s) published'
  );
  return publishIds.length;
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
  const now =
    new Date();
  const nowMs =
    now.getTime();
  console.log(
    'sync-live.js tick @ ' +
    now.toISOString()
  );
  const liveFixtures =
    await getLiveTargetFixtures();
  console.log(
    'Target live fixtures right now: ' +
    liveFixtures.length
  );
  let recentFinishedFixtures = [];
  if (
    now.getUTCMinutes() %
      5 ===
    0
  ) {
    console.log(
      '5-minute final-score check...'
    );
    recentFinishedFixtures =
      await getRecentFinishedTargetFixtures(
        nowMs
      );
    console.log(
      'Recently finished target fixtures: ' +
      recentFinishedFixtures.length
    );
  }
  const relevantByFixtureId =
    new Map();
  for (
    const fixture
    of liveFixtures
  ) {
    relevantByFixtureId.set(
      String(
        fixture.fixture.id
      ),
      fixture
    );
  }
  for (
    const fixture
    of recentFinishedFixtures
  ) {
    relevantByFixtureId.set(
      String(
        fixture.fixture.id
      ),
      fixture
    );
  }
  const relevantFixtures =
    [
      ...relevantByFixtureId.values()
    ];
  if (
    !relevantFixtures.length
  ) {
    console.log(
      'No relevant live/recently-finished matches — exiting without Webflow calls.'
    );
    return;
  }
  console.log(
    'Relevant fixtures to inspect: ' +
    relevantFixtures.length
  );
  const allTeams =
    await wfGetAllItems(
      WF.TEAMS
    );
  const teamLookup =
    buildTeamLookup(
      allTeams
    );
  const matchResult =
    await syncRelevantMatches(
      relevantFixtures,
      teamLookup
    );
  let standingChanges = 0;
  if (
    matchResult
      .newlyFinishedLeagueIds
      .size
  ) {
    const allStandings =
      await wfGetAllItems(
        WF.STANDINGS
      );
    for (
      const leagueId
      of matchResult
        .newlyFinishedLeagueIds
    ) {
      const league =
        LEAGUE_BY_API_ID.get(
          leagueId
        );
      if (!league) {
        continue;
      }
      try {
        standingChanges +=
          await syncStandingsForLeague(
            league,
            teamLookup,
            allStandings
          );
      } catch (err) {
        console.error(
          league.name +
          ' standings failed: ' +
          err.message
        );
      }
    }
  }
  if (
    matchResult.changed > 0 ||
    standingChanges > 0
  ) {
    console.log(
      'Changes detected — skipping full site publish (testing item-level publish only).'
    );
    // await wfPublishSite();
  } else {
    console.log(
      'No Webflow changes detected — site publish skipped.'
    );
  }
  console.log(
    'sync-live.js tick complete.'
  );
}
// ============================================================
// START
// ============================================================
main().catch(err => {
  console.error(
    'Fatal error: ' +
    err.message
  );
  process.exit(1);
});
