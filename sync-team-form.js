// ============================================================
// sync-team-form.js — footgoal.co
//
// Calculates each club's FORM from ACTUAL finished matches
// in the CURRENT configured season.
//
// Examples:
// 0 played  -> ""
// 1 played  -> "W"
// 3 played  -> "WDL"
// 5+ played -> last 5 only, e.g. "WWDLW"
//
// This intentionally ignores API-Football's standings.form value,
// because it may contain stale results from the previous season.
// ============================================================

const WEBFLOW_TOKEN = process.env.WEBFLOW_TOKEN;
const API_FOOTBALL_KEY = process.env.API_FOOTBALL_KEY;


// ============================================================
// WEBFLOW COLLECTIONS
// ============================================================

const WF = {
  TEAMS: '6a20064807685f373db26660',
  STANDINGS: '6a200649847c9fcb9278de02'
};


// ============================================================
// LEAGUES
// ============================================================

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


const FINISHED_STATUSES = new Set([
  'FT',
  'AET',
  'PEN'
]);

const WEBFLOW_CONCURRENCY = 5;


// ============================================================
// HELPERS
// ============================================================

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}


async function pMap(
  items,
  mapper,
  concurrency
) {

  const results =
    new Array(items.length);

  let index = 0;


  async function worker() {

    while (index < items.length) {

      const current =
        index++;

      results[current] =
        await mapper(
          items[current],
          current
        );
    }
  }


  const workers = [];

  for (
    let i = 0;
    i <
    Math.min(
      concurrency,
      items.length
    );
    i++
  ) {

    workers.push(
      worker()
    );
  }


  await Promise.all(
    workers
  );

  return results;
}


// ============================================================
// API-FOOTBALL
// ============================================================

async function apiFetch(
  path,
  retries = 3
) {

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


  const data =
    await res.json();


  if (
    data.errors &&
    Object.keys(
      data.errors
    ).length > 0
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
// WEBFLOW
// ============================================================

async function wfGetAllItems(
  collectionId,
  retries = 5
) {

  const items = [];

  let offset = 0;

  const limit = 100;


  while (true) {

    const res =
      await fetch(

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


    if (
      res.status === 429
    ) {

      if (
        retries <= 0
      ) {

        throw new Error(
          'Webflow GET rate limit retries exhausted'
        );
      }


      console.warn(
        'Webflow GET rate limited — waiting 15 seconds...'
      );

      await sleep(15000);

      return wfGetAllItems(
        collectionId,
        retries - 1
      );
    }


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


async function wfUpdateItem(
  collectionId,
  itemId,
  fieldData,
  retries = 4
) {

  const res =
    await fetch(

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

          'Content-Type':
            'application/json',

          accept:
            'application/json'
        },

        body:
          JSON.stringify({
            fieldData
          })
      }
    );


  if (
    res.status === 429 &&
    retries > 0
  ) {

    console.warn(
      'Webflow PATCH rate limited — waiting 15 seconds...'
    );

    await sleep(15000);

    return wfUpdateItem(
      collectionId,
      itemId,
      fieldData,
      retries - 1
    );
  }


  if (!res.ok) {

    throw new Error(
      'Webflow PATCH ' +
      itemId +
      ': ' +
      res.status +
      ' ' +
      await res.text()
    );
  }


  return res.json();
}


async function wfPublishItems(
  collectionId,
  itemIds
) {

  if (
    !itemIds ||
    itemIds.length === 0
  ) {

    return;
  }


  for (
    let i = 0;
    i < itemIds.length;
    i += 100
  ) {

    const batch =
      itemIds.slice(
        i,
        i + 100
      );


    const res =
      await fetch(

        'https://api.webflow.com/v2/collections/' +
        collectionId +
        '/items/publish',

        {
          method: 'POST',

          headers: {
            Authorization:
              'Bearer ' +
              WEBFLOW_TOKEN,

            'Content-Type':
              'application/json',

            accept:
              'application/json'
          },

          body:
            JSON.stringify({
              itemIds: batch
            })
        }
      );


    if (!res.ok) {

      throw new Error(
        'Webflow publish: ' +
        res.status +
        ' ' +
        await res.text()
      );
    }


    await sleep(1000);
  }
}


// ============================================================
// FORM CALCULATION
// ============================================================

function getResultForTeam(
  fixture,
  teamId
) {

  const homeId =
    fixture?.teams?.home?.id;

  const awayId =
    fixture?.teams?.away?.id;


  const homeGoals =
    fixture?.goals?.home;

  const awayGoals =
    fixture?.goals?.away;


  if (
    !Number.isFinite(
      homeGoals
    ) ||
    !Number.isFinite(
      awayGoals
    )
  ) {

    return null;
  }


  // DRAW
  if (
    homeGoals === awayGoals
  ) {

    return 'D';
  }


  // HOME TEAM
  if (
    teamId === homeId
  ) {

    return homeGoals > awayGoals
      ? 'W'
      : 'L';
  }


  // AWAY TEAM
  if (
    teamId === awayId
  ) {

    return awayGoals > homeGoals
      ? 'W'
      : 'L';
  }


  return null;
}


function calculateForms(
  fixtures
) {

  const forms =
    new Map();


  // Only actual completed games
  const finished =
    fixtures
      .filter(fixture => {

        const status =
          fixture
            ?.fixture
            ?.status
            ?.short || '';

        return FINISHED_STATUSES.has(
          status
        );
      })
      .sort((a, b) => {

        const aDate =
          new Date(
            a.fixture.date
          ).getTime();

        const bDate =
          new Date(
            b.fixture.date
          ).getTime();

        return aDate - bDate;
      });


  for (
    const fixture
    of finished
  ) {

    const homeId =
      fixture
        ?.teams
        ?.home
        ?.id;

    const awayId =
      fixture
        ?.teams
        ?.away
        ?.id;


    if (
      homeId
    ) {

      const homeResult =
        getResultForTeam(
          fixture,
          homeId
        );


      if (
        homeResult
      ) {

        if (
          !forms.has(
            homeId
          )
        ) {

          forms.set(
            homeId,
            []
          );
        }


        forms
          .get(homeId)
          .push(
            homeResult
          );
      }
    }


    if (
      awayId
    ) {

      const awayResult =
        getResultForTeam(
          fixture,
          awayId
        );


      if (
        awayResult
      ) {

        if (
          !forms.has(
            awayId
          )
        ) {

          forms.set(
            awayId,
            []
          );
        }


        forms
          .get(awayId)
          .push(
            awayResult
          );
      }
    }
  }


  const finalForms =
    new Map();


  for (
    const [
      teamId,
      results
    ]
    of forms.entries()
  ) {

    finalForms.set(
      teamId,
      results
        .slice(-5)
        .join('')
    );
  }


  return finalForms;
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
    'Loading Webflow Teams...'
  );


  const allTeams =
    await wfGetAllItems(
      WF.TEAMS
    );


  console.log(
    'Loaded Teams: ' +
    allTeams.length
  );


  console.log(
    'Loading Webflow Standings...'
  );


  const allStandings =
    await wfGetAllItems(
      WF.STANDINGS
    );


  console.log(
    'Loaded Standings: ' +
    allStandings.length
  );


  // --------------------------------
  // Standing lookup:
  // league ID + team Webflow item ID
  // --------------------------------

  const standingByLeagueAndTeam =
    new Map();


  for (
    const standing
    of allStandings
  ) {

    const teamRef =
      standing
        ?.fieldData
        ?.team;

    const leagueRef =
      standing
        ?.fieldData
        ?.league;


    if (
      teamRef &&
      leagueRef
    ) {

      standingByLeagueAndTeam.set(

        leagueRef +
        ':' +
        teamRef,

        standing
      );
    }
  }


  for (
    const league
    of LEAGUES
  ) {

    console.log(
      '\n================================'
    );

    console.log(
      'Calculating form: ' +
      league.name
    );


    const fixturesData =
      await apiFetch(

        '/fixtures?league=' +
        league.api_id +
        '&season=' +
        league.season
      );


    const fixtures =
      fixturesData.response || [];


    const forms =
      calculateForms(
        fixtures
      );


    const finishedCount =
      fixtures.filter(
        fixture =>

          FINISHED_STATUSES.has(
            fixture
              ?.fixture
              ?.status
              ?.short || ''
          )
      ).length;


    console.log(
      'Fixtures: ' +
      fixtures.length
    );

    console.log(
      'Finished matches: ' +
      finishedCount
    );


    // Only teams belonging to THIS league
    const leagueTeams =
      allTeams.filter(
        team =>

          team
            ?.fieldData
            ?.league ===
          league.webflow_id
      );


    console.log(
      'Webflow teams: ' +
      leagueTeams.length
    );


    const updatedIds = [];


    await pMap(

      leagueTeams,

      async team => {

        const apiTeamIdRaw =
          team
            ?.fieldData
            ?.[
              'api-team-id'
            ];


        const apiTeamId =
          apiTeamIdRaw
            ? Number(
                apiTeamIdRaw
              )
            : null;


        if (
          !apiTeamId
        ) {

          console.warn(
            'Missing API Team ID: ' +
            (
              team
                ?.fieldData
                ?.name ||
              team.id
            )
          );

          return;
        }


        const form =
          forms.get(
            apiTeamId
          ) || '';


        const standing =
          standingByLeagueAndTeam.get(

            league.webflow_id +
            ':' +
            team.id
          );


        if (
          !standing
        ) {

          console.warn(
            'No standing item found for: ' +
            team.fieldData.name
          );

          return;
        }


        console.log(
          team.fieldData.name +
          ' → "' +
          form +
          '"'
        );


        await wfUpdateItem(
          WF.STANDINGS,
          standing.id,
          {
            form
          }
        );


        updatedIds.push(
          standing.id
        );
      },

      WEBFLOW_CONCURRENCY
    );


    await wfPublishItems(
      WF.STANDINGS,
      updatedIds
    );


    console.log(
      league.name +
      ': updated ' +
      updatedIds.length +
      ' forms'
    );
  }


  console.log(
    '\n================================'
  );

  console.log(
    'Team form sync complete.'
  );
}


main().catch(err => {

  console.error(
    'Fatal team form sync error:',
    err.message
  );

  process.exit(1);
});
