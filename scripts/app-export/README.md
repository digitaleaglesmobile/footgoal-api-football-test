# footgoal app data export

Turns published Webflow CMS content into JSON files for the footgoal mobile app.
It's **read-only on Webflow**: it only calls GET endpoints and never changes the site.

## What's in this folder

```
scripts/app-export/export-app-data.mjs   ← the export (Node 18+, no npm packages)
scripts/app-export/test/mock-webflow.mjs ← fake Webflow API for local testing
.github/workflows/export-app-data.yml    ← runs every 3 hours + manual button
```


## Setup (one time)

1. **Webflow token.** Uses the existing repo secret `WEBFLOW_TOKEN` (same one the league syncs use).
2. **Cloudflare (free plan, no credit card).** Create a free Cloudflare account, then an API token
   from the "Edit Cloudflare Workers" template (it includes Pages access).
3. **Repo secrets for Cloudflare:** `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.
   The first real run creates a Pages project called `footgoal-app-data` and the data appears at
   `https://footgoal-app-data.pages.dev/v1/manifest.json`. You can add a custom domain like
   `data.footgoal.co` later.
4. Open Actions → **Export app data** → Run workflow with **Dry run** ticked first.
   It fetches and validates everything, then uploads nothing.

## Output (served under `/v1/`)

Cloudflare Pages free plan: unlimited bandwidth, up to 20,000 files per deploy (this export is under 1,000).
Each deploy switches over all at once, so the app never sees half-updated data.

| File | Contents |
|---|---|
| `manifest.json` | Version, timestamp and a hash for every file. The app checks this first. |
| `leagues.json`, `authors.json`, `records.json` | Full lists |
| `teams/index.json` + `teams/<slug>.json` | Light list for menus; full club profile per team |
| `venues/index.json` + `venues/<slug>.json` | Light list for the map/list; full matchday guide per stadium |
| `matches/<league-slug>.json` | All fixtures and results for that league, sorted by date |
| `standings/<league-slug>.json` | Table for that league, sorted by position |
| `top-scorers/<league-slug>.json` | Ranked scorers for that league |
| `articles/{en,es,pt}/index.json` + `<slug>.json` | Newest-first article list; full article per file |

Conversions the app relies on:
- Option fields come out as readable names (`"status": "Played"`), not Webflow's ID hashes.
- References stay as Webflow item IDs. Every exported item has an `id` to match on.
- Images come out as `{ url, alt }`.
- Relative links inside rich text and link fields become absolute `https://footgoal.co/...` URLs.
- Every item gets a `webUrl` for share / open on web / App Links.
- SEO-only fields (meta description, SEO title, share image, page-URL helpers) are dropped.
- Only **published** items are exported. Drafts and archived items never reach the app.
- Comments are never exported because they're user-submitted and may contain personal data.

## Safety

- If any collection returns suspiciously few items (for example Webflow is down or the token
  has expired), the export **aborts and writes nothing**. The app keeps the last good data.
  Thresholds are the `minCount` values in the script.
- About 30–40 Webflow API calls per run, throttled under the 120/min limit, with retry on 429.

## Test locally

```bash
node scripts/app-export/test/mock-webflow.mjs &
WEBFLOW_API_BASE=http://localhost:8787/v2 WEBFLOW_API_TOKEN=test-token \
  node scripts/app-export/export-app-data.mjs --out /tmp/app-data
```
