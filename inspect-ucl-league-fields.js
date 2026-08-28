// ============================================================
// inspect-ucl-league-fields.js — footgoal.co
// READ ONLY
//
// Prints the Webflow Leagues collection schema + current
// Champions League CMS field values.
//
// DOES NOT WRITE ANYTHING.
// ============================================================

const WEBFLOW_TOKEN = process.env.WEBFLOW_TOKEN;

const LEAGUES_COLLECTION_ID =
  '6a32a8954e8d7db479514a79';

const UCL_ITEM_ID =
  '6a32a9cb63396a5393212f3c';

function headers() {
  return {
    Authorization: `Bearer ${WEBFLOW_TOKEN}`,
    accept: 'application/json'
  };
}

async function wfFetch(url) {
  const res = await fetch(url, {
    headers: headers()
  });

  if (!res.ok) {
    throw new Error(
      `Webflow ${res.status}: ${await res.text()}`
    );
  }

  return res.json();
}

async function main() {
  if (!WEBFLOW_TOKEN) {
    throw new Error(
      'Missing WEBFLOW_TOKEN'
    );
  }

  console.log(
    '============================================================'
  );

  console.log(
    'UCL LEAGUE FIELD INSPECTION — READ ONLY'
  );

  console.log(
    '============================================================\n'
  );

  const [schema, item] =
    await Promise.all([
      wfFetch(
        `https://api.webflow.com/v2/collections/${LEAGUES_COLLECTION_ID}`
      ),

      wfFetch(
        `https://api.webflow.com/v2/collections/${LEAGUES_COLLECTION_ID}/items/${UCL_ITEM_ID}`
      )
    ]);

  const fields =
    schema.fields || [];

  const fieldData =
    item.fieldData || {};

  console.log(
    'UCL ITEM'
  );

  console.log(
    'Name:',
    fieldData.name
  );

  console.log(
    'Item ID:',
    item.id
  );

  console.log(
    '\n============================================================'
  );

  console.log(
    'ALL LEAGUE CMS FIELDS'
  );

  console.log(
    '============================================================\n'
  );

  for (const field of fields) {
    const value =
      fieldData[field.slug];

    console.log(
      `DISPLAY NAME: ${field.displayName}`
    );

    console.log(
      `SLUG:         ${field.slug}`
    );

    console.log(
      `TYPE:         ${field.type}`
    );

    console.log(
      'VALUE:       ',
      value === undefined
        ? '(empty / undefined)'
        : value
    );

    console.log(
      '------------------------------------------------------------'
    );
  }

  console.log(
    '\n============================================================'
  );

  console.log(
    'POTENTIALLY RELEVANT FIELDS'
  );

  console.log(
    '============================================================\n'
  );

  const keywords = [
    'match',
    'round',
    'start',
    'end',
    'date',
    'season'
  ];

  for (const field of fields) {
    const haystack =
      (
        String(field.displayName || '') +
        ' ' +
        String(field.slug || '')
      ).toLowerCase();

    if (
      keywords.some(
        keyword =>
          haystack.includes(keyword)
      )
    ) {
      console.log(
        `${field.displayName} | ${field.slug} | ${field.type} |`,
        fieldData[field.slug]
      );
    }
  }

  console.log(
    '\n============================================================'
  );

  console.log(
    'INSPECTION COMPLETE — NOTHING WAS CHANGED'
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
