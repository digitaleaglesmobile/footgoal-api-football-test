// ============================================================
// sync-league-metadata.js — footgoal.co
//
// Updates the Webflow "Leagues" CMS metadata from API-Football.
//
// IMPORTANT:
// "Current Matchday" is calculated ONLY from matches that have
// actually started or finished.
//
// Therefore:
// - Premier League pre-season = 0
// - La Liga pre-season = 0
// - Bundesliga pre-season = 0
// - etc.
// - Brasileirão can correctly be mid-season.
// ============================================================

const WEBFLOW_TOKEN = process.env.WEBFLOW_TOKEN;
const API_FOOTBALL_KEY = process.env.API_FOOTBALL_KEY;

const LEAGUES_COLLECTION_ID = '6a32a8954e8d7db479514a79';

const LEAGUES = [
  {
    code: 'PL',
    name: 'Premier League',
    api_id: 39,
    webflow_id: '6a32a9cb63396a5393212f3a',
    season: 2026,
    seasonLabel: '2026/27'
  },
  {
    code: 'LL',
    name: 'La Liga',
    api_id: 140,
    webflow_id: '6a32a9cb63396a5393212f3e',
    season: 2026,
    seasonLabel: '2026/27'
  },
  {
    code: 'BL',
    name: 'Bundesliga',
    api_id: 78,
    webflow_id: '6a32a9cb63396a5393212f40',
    season: 2026,
    seasonLabel: '2026/27'
  },
  {
    code: 'SA',
    name: 'Serie A',
    api_id: 135,
    webflow_id: '6a32a9cb63396a5393212f42',
    season: 2026,
    seasonLabel: '2026/27'
  },
  {
    code: 'ERE',
    name: 'Eredivisie',
    api_id: 88,
    webflow_id: '6a32a9cb63396a5393212f44',
    season: 2026,
    seasonLabel: '2026/27'
  },
  {
    code: 'L1',
    name: 'Ligue 1',
    api_id: 61,
    webflow_id: '6a32a9cb63396a5393212f46',
    season: 2026,
    seasonLabel: '2026/27'
  },
  {
    code: 'BSA',
    name: 'Brasileiro Série A',
    api_id: 71,
    webflow_id: '6a32a9cb63396a5393212f48',
    season: 2026,
    seasonLabel: '2026'
  }
];

const FINISHED_STATUSES = new Set([
  'FT',
  'AET',
  'PEN'
]);

const LIVE_STATUSES = new Set([
  '1H',
  '2H',
  'HT',
  'ET',
  'BT',
  'P',
  'LIVE',
  'SUSP',
  'INT'
]);

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function normalize(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}


// ============================================================
// API-FOOTBALL
// ============================================================

async function apiFetch(path, retries = 3) {

  const res = await fetch(
    'https://v3.football.api-sports.io' + path,
    {
      headers: {
        'x-apisports-key': API_FOOTBALL_KEY
      }
    }
  );

  if (res.status === 429 && retries > 0) {

    console.warn(
      'API-Football rate limited — waiting 60 seconds...'
    );

    await sleep(60000);

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
      'API-Football returned errors: ' +
      JSON.stringify(data.errors)
    );
  }

  return data;
}


// ============================================================
// WEBFLOW
// ============================================================

async function webflowFetch(
  url,
  options = {},
  retries = 4
) {

  options.headers = {
    Authorization:
      'Bearer ' +
      WEBFLOW_TOKEN,

    accept: 'application/json',

    ...(options.headers || {})
  };

  const res = await fetch(
    url,
    options
  );

  if (
    res.status === 429 &&
    retries > 0
  ) {

    console.warn(
      'Webflow rate limited — waiting 15 seconds...'
    );

    await sleep(15000);

    return webflowFetch(
      url,
      options,
      retries - 1
    );
  }

  return res;
}


async function getLeagueCollectionSchema() {

  const res = await webflowFetch(
    'https://api.webflow.com/v2/collections/' +
    LEAGUES_COLLECTION_ID
  );

  if (!res.ok) {

    throw new Error(
      'Webflow collection schema error: ' +
      res.status +
      ' ' +
      await res.text()
    );
  }

  return res.json();
}


function findField(
  fields,
  aliases
) {

  const wanted =
    aliases.map(normalize);

  for (const field of fields) {

    const displayName =
      normalize(field.displayName);

    const slug =
      normalize(field.slug);

    if (
      wanted.includes(displayName) ||
      wanted.includes(slug)
    ) {

      return field;
    }
  }

  return null;
}


// ============================================================
// MATCH / LEAGUE CALCULATIONS
// ============================================================

function getRoundNumber(roundLabel) {

  const match =
    String(roundLabel || '')
      .match(/(\d+)/);

  return match
    ? parseInt(match[1], 10)
    : 0;
}


function isStartedFixture(fixture) {

  const status =
    fixture?.fixture?.status?.short || '';

  return (
    FINISHED_STATUSES.has(status) ||
    LIVE_STATUSES.has(status)
  );
}


function calculateMetadata(
  fixtures,
  teamCount,
  seasonLabel
) {

  const started =
    fixtures.filter(
      isStartedFixture
    );

  const finished =
    started.filter(fixture =>
      FINISHED_STATUSES.has(
        fixture.fixture.status.short
      )
    );


  // ------------------------------
  // CURRENT MATCHDAY
  // ------------------------------

  let currentMatchday = 0;

  for (const fixture of started) {

    const round =
      getRoundNumber(
        fixture?.league?.round
      );

    currentMatchday =
      Math.max(
        currentMatchday,
        round
      );
  }


  // ------------------------------
  // TOTAL GOALS
  // ------------------------------

  let totalGoals = 0;

  for (const fixture of started) {

    const home =
      Number.isFinite(
        fixture?.goals?.home
      )
        ? fixture.goals.home
        : 0;

    const away =
      Number.isFinite(
        fixture?.goals?.away
      )
        ? fixture.goals.away
        : 0;

    totalGoals +=
      home + away;
  }


  // ------------------------------
  // GOALS PER GAME
  // ------------------------------

  const goalsPerGame =
    started.length
      ? Number(
          (
            totalGoals /
            started.length
          ).toFixed(2)
        )
      : 0;


  return {

    season: seasonLabel,

    totalClubs:
      teamCount,

    currentMatchday,

    totalGoals,

    goalsPerGame,

    matchesPlayed:
      finished.length
  };
}


// ============================================================
// WEBFLOW UPDATE
// ============================================================

async function updateLeagueItem(
  league,
  fieldData
) {

  const res =
    await webflowFetch(

      'https://api.webflow.com/v2/collections/' +
      LEAGUES_COLLECTION_ID +
      '/items/' +
      league.webflow_id,

      {
        method: 'PATCH',

        headers: {
          'Content-Type':
            'application/json'
        },

        body: JSON.stringify({
          fieldData
        })
      }
    );

  if (!res.ok) {

    throw new Error(
      'Webflow PATCH ' +
      league.name +
      ': ' +
      res.status +
      ' ' +
      await res.text()
    );
  }
}


async function publishLeagueItems(
  itemIds
) {

  const res =
    await webflowFetch(

      'https://api.webflow.com/v2/collections/' +
      LEAGUES_COLLECTION_ID +
      '/items/publish',

      {
        method: 'POST',

        headers: {
          'Content-Type':
            'application/json'
        },

        body: JSON.stringify({
          itemIds
        })
      }
    );

  if (!res.ok) {

    throw new Error(
      'Webflow publish leagues: ' +
      res.status +
      ' ' +
      await res.text()
    );
  }
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
    'Reading Webflow Leagues collection schema...'
  );


  const schema =
    await getLeagueCollectionSchema();

  const fields =
    schema.fields || [];


  // Automatically find the Webflow field slugs
  // based on their display names.

  const fieldMap = {

    season:
      findField(
        fields,
        ['Season']
      ),

    totalClubs:
      findField(
        fields,
        [
          'Total Clubs',
          'Clubs',
          'Teams',
          'Total Teams'
        ]
      ),

    currentMatchday:
      findField(
        fields,
        [
          'Current Matchday',
          'Current Match Day',
          'Current Round',
          'Current Matchweek'
        ]
      ),

    totalGoals:
      findField(
        fields,
        [
          'Total Goals',
          'Goals'
        ]
      ),

    goalsPerGame:
      findField(
        fields,
        [
          'Goals Per Game',
          'Average Goals Per Game',
          'Avg Goals Per Game'
        ]
      ),

    matchesPlayed:
      findField(
        fields,
        [
          'Matches Played',
          'Games Played',
          'Total Matches Played'
        ]
      )
  };


  console.log(
    '\nDetected Webflow fields:'
  );


  for (
    const [
      key,
      field
    ]
    of Object.entries(fieldMap)
  ) {

    console.log(
      '  ' +
      key +
      ': ' +
      (
        field
          ? field.slug
          : 'NOT FOUND — will skip'
      )
    );
  }


  const updatedLeagueIds = [];


  for (
    const league
    of LEAGUES
  ) {

    console.log(
      '\n--------------------------------'
    );

    console.log(
      'Syncing: ' +
      league.name
    );


    // Get all fixtures for CURRENT season
    const fixtureData =
      await apiFetch(

        '/fixtures?league=' +
        league.api_id +
        '&season=' +
        league.season
      );


    // Get teams for CURRENT season
    const teamData =
      await apiFetch(

        '/teams?league=' +
        league.api_id +
        '&season=' +
        league.season
      );


    const fixtures =
      fixtureData.response || [];

    const teams =
      teamData.response || [];


    const meta =
      calculateMetadata(

        fixtures,

        teams.length,

        league.seasonLabel
      );


    console.log(
      'Fixtures: ' +
      fixtures.length
    );

    console.log(
      'Teams: ' +
      teams.length
    );

    console.log(
      'Started matches: ' +
      fixtures.filter(
        isStartedFixture
      ).length
    );

    console.log(
      'Calculated metadata:',
      meta
    );


    // Only update fields that actually exist
    // in the Webflow collection.

    const update = {};


    if (fieldMap.season) {

      update[
        fieldMap.season.slug
      ] = meta.season;
    }


    if (fieldMap.totalClubs) {

      update[
        fieldMap.totalClubs.slug
      ] = meta.totalClubs;
    }


    if (fieldMap.currentMatchday) {

      update[
        fieldMap.currentMatchday.slug
      ] = meta.currentMatchday;
    }


    if (fieldMap.totalGoals) {

      update[
        fieldMap.totalGoals.slug
      ] = meta.totalGoals;
    }


    if (fieldMap.goalsPerGame) {

      update[
        fieldMap.goalsPerGame.slug
      ] = String(meta.goalsPerGame);
    }


    if (fieldMap.matchesPlayed) {

      update[
        fieldMap.matchesPlayed.slug
      ] = meta.matchesPlayed;
    }


    if (
      Object.keys(update).length === 0
    ) {

      console.warn(
        'No metadata fields recognized for ' +
        league.name +
        ' — skipping'
      );

      continue;
    }


    console.log(
      'Writing to Webflow:',
      update
    );


    await updateLeagueItem(
      league,
      update
    );


    updatedLeagueIds.push(
      league.webflow_id
    );


    await sleep(500);
  }


  if (
    updatedLeagueIds.length
  ) {

    console.log(
      '\nPublishing League CMS items...'
    );


    await publishLeagueItems(
      updatedLeagueIds
    );
  }


  console.log(
    '\n================================'
  );

  console.log(
    'League metadata sync complete.'
  );

  console.log(
    'Updated leagues: ' +
    updatedLeagueIds.length
  );
}


main().catch(err => {

  console.error(
    'Fatal metadata sync error:',
    err.message
  );

  process.exit(1);
});
