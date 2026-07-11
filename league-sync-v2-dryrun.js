// ============================================================
// league-sync-v2.js — footgoal.co
// LIVE MODE — writes real data to Webflow: Teams, Standings, Matches
// Premier League only for this rollout
// ============================================================

const DRY_RUN = false; // ⚠️ LIVE — this will write to Webflow and publish

// ── ENV ──────────────────────────────────────────────────────
const SUPABASE_URL  = process.env.SUPABASE_URL;
const SUPABASE_KEY  = process.env.SUPABASE_KEY;
const WEBFLOW_TOKEN = process.env.WEBFLOW_TOKEN;
const API_FOOTBALL_KEY = process.env.API_FOOTBALL_KEY;

// ── WEBFLOW COLLECTION IDs (unchanged) ─────────────────────────
const WF = {
  LEAGUES:     '6a32a8954e8d7db479514a79',
  TEAMS:       '6a20064807685f373db26660',
  STANDINGS:   '6a200649847c9fcb9278de02',
  MATCHES:     '6a200649c668e2cb8f11e82b',
  TOP_SCORERS: '6a32a89633c9bd6bea624094',
};

// ── LEAGUE CONFIG — Premier League only for now ────────────────
const LEAGUES = [
  { code: 'PL',  name: 'Premier League',        api_id: 39,  webflow_id: '6a32a9cb63396a5393212f3a', season: 2026 },
];

const DELAY_MS = 1000;
const WEBFLOW_WRITE_DELAY_MS = 1000; // Slowed down further — 1 full second between writes

// ── MANUAL ALIASES ──────────────────────────────────────────────
const MANUAL_ALIASES = {
  'atletico paranaense': 'paranaense',
  'atletico mg': 'mineiro',
  'inter': 'internazionale milano',
};

// ── HELPERS ───────────────────────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function slugify(str) {
  return str.toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s-]/g, '')
    .trim().replace(/\s+/g, '-').replace(/-+/g, '-');
}

function normalizeTeamName(name) {
  let n =
