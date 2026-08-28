// ============================================================
// ucl-2026-dryrun.js — footgoal.co
// SAFE / READ-ONLY
//
// Does NOT write anything to Webflow.
// Checks what API-Football currently exposes for
// UEFA Champions League 2026/27.
// ============================================================

const API_FOOTBALL_KEY = process.env.API_FOOTBALL_KEY;

const UCL = {
  api_id: 2,
  season: 2026
};

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

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

  if (res.status === 429 && retries > 0) {
    console.warn('Rate limited — waiting 30 seconds...');
    await sleep(30000);
    return apiFetch(path, retries - 1);
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
      'API errors: ' +
      JSON.stringify(data.errors)
    );
  }

  return data;
}

function uniqueTeamsFromFixtures(fixtures) {
  const teams = new Map();

  for (const match of fixtures) {
    if (match.teams?.home) {
      teams.set(
        String(match.teams.home.id),
        match.teams.home
      );
    }

    if (match.teams?.away) {
      teams.set(
        String(match.teams.away.id),
        match.teams.away
      );
    }
  }

  return [...teams.values()];
}

function uniqueTeamsFromStandings(data) {
  const groups =
    data.response?.[0]?.league?.standings || [];

  const teams = new Map();

  for (const group of groups) {
    for (const row of group || []) {
      if (row.team) {
        teams.set(
          String(row.team.id),
          row.team
        );
      }
    }
  }

  return [...teams.values()];
}

async function main() {
  if (!API_FOOTBALL_KEY) {
    throw new Error(
      'Missing API_FOOTBALL_KEY'
    );
  }

  console.log(
    '============================================================'
  );

  console.log(
    'UCL 2026/27 — SAFE DRY RUN'
  );

  console.log(
    'READ ONLY — NOTHING WILL BE CHANGED'
  );

  console.log(
    '============================================================\n'
  );

  const [
    teamsData,
    standingsData,
    fixturesData
  ] = await Promise.all([
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

  const allTeams =
    teamsData.response || [];

  const fixtures =
    fixturesData.response || [];

  console.log(
    'API /teams returned: ' +
    allTeams.length
  );

  console.log(
    'API /fixtures returned: ' +
    fixtures.length
  );

  // ----------------------------------------------------------
  // ROUNDS
  // ----------------------------------------------------------

  const roundCounts =
    new Map();

  for (const match of fixtures) {
    const round =
      match.league?.round ||
      '(no round)';

    roundCounts.set(
      round,
      (roundCounts.get(round) || 0) + 1
    );
  }

  console.log(
    '\nROUNDS CURRENTLY IN API:'
  );

  for (
    const [round, count]
    of [...roundCounts.entries()].sort()
  ) {
    console.log(
      '  ' +
      round +
      ': ' +
      count
    );
  }

  // ----------------------------------------------------------
  // LEAGUE STAGE FIXTURES
  // ----------------------------------------------------------

  const leagueStageFixtures =
    fixtures.filter(match => {
      const round =
        match.league?.round || '';

      return /league\s*(stage|phase)/i.test(
        round
      );
    });

  const fixtureTeams =
    uniqueTeamsFromFixtures(
      leagueStageFixtures
    );

  const standingTeams =
    uniqueTeamsFromStandings(
      standingsData
    );

  console.log(
    '\nLeague Stage fixtures found: ' +
    leagueStageFixtures.length
  );

  console.log(
    'Unique teams from League Stage fixtures: ' +
    fixtureTeams.length
  );

  console.log(
    'Unique teams from standings: ' +
    standingTeams.length
  );

  // ----------------------------------------------------------
  // DETERMINE SAFE 36
  // ----------------------------------------------------------

  let finalTeams = [];
  let source = '';

  if (standingTeams.length === 36) {
    finalTeams = standingTeams;
    source = 'standings';
  }

  else if (fixtureTeams.length === 36) {
    finalTeams = fixtureTeams;
    source = 'League Stage fixtures';
  }

  if (finalTeams.length !== 36) {
    console.log(
      '\n============================================================'
    );

    console.log(
      'NOT READY FOR PRODUCTION SYNC YET'
    );

    console.log(
      '============================================================'
    );

    console.log(
      'Could not safely identify exactly 36 League Phase teams.'
    );

    console.log(
      'Do NOT use the full /teams result because it may include qualifying teams.'
    );

    console.log(
      '\nNothing was changed.'
    );

    return;
  }

  // ----------------------------------------------------------
  // PRINT FINAL 36
  // ----------------------------------------------------------

  console.log(
    '\n============================================================'
  );

  console.log(
    'CONFIRMED 36 LEAGUE PHASE TEAMS'
  );

  console.log(
    'Source: ' + source
  );

  console.log(
    '============================================================\n'
  );

  const sorted =
    [...finalTeams].sort(
      (a, b) =>
        a.name.localeCompare(b.name)
    );

  sorted.forEach(
    (team, index) => {
      console.log(
        String(index + 1).padStart(2, '0') +
        '. ' +
        team.name +
        ' | API ID: ' +
        team.id
      );
    }
  );

  console.log(
    '\n============================================================'
  );

  console.log(
    'DRY RUN COMPLETE — NOTHING WAS CHANGED'
  );

  console.log(
    '============================================================'
  );
}

main().catch(err => {
  console.error(
    'FATAL:',
    err.message
  );

  process.exit(1);
});
