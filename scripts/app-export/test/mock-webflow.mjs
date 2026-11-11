// Minimal mock of the Webflow Data API v2 read endpoints used by the export.
// Schemas mirror the real footgoal.co collections (slugs/types); items follow the
// exact shapes returned by Webflow (image objects, reference IDs, option hashes).
import http from 'node:http';

const L = { pl: 'lg_pl', laliga: 'lg_laliga', ucl: 'lg_ucl', sa: 'lg_sa', bl: 'lg_bl', l1: 'lg_l1' };
const img = (n) => ({ fileId: 'f_' + n, url: `https://cdn.prod.website-files.com/x/${n}.png`, alt: n + ' badge' });
const STATUS = { Upcoming: '06496e65ce4253beaff81cb87181f6e4', Live: 'fc9117826d7a9e41c397c343cbe1d896', Played: '6d0267f305b270ca7a5dcfd8a5cc780e' };
const VTYPE = { 'Club Stadium': '3d360d67d6e1fe5c4cefcaa0510232a0', 'World Cup': '2b00026d3acf860d3ccc838175c7b195' };

const f = (slug, type, extra = {}) => ({ slug, type, ...extra });
const base = [f('name', 'PlainText'), f('slug', 'PlainText')];

const schemas = {
  '6a32a8954e8d7db479514a79': { slug: 'leagues', fields: [...base, f('country', 'PlainText'), f('logo', 'Image'), f('season', 'PlainText'), f('is-active', 'Switch')] },
  '6a20064807685f373db26660': { slug: 'team', fields: [...base, f('api-team-id', 'PlainText'), f('badge', 'Image'), f('short-name', 'PlainText'), f('league', 'Reference'), f('club-profile', 'RichText'), f('rivals', 'MultiReference'), f('seo-title', 'PlainText'), f('meta-description', 'PlainText'), f('team-page-url', 'Link'), f('website', 'Link'), f('venue', 'Reference'), f('also-in-champions-league', 'Switch'), f('capacity', 'Number')] },
  '6a200649847c9fcb9278de02': { slug: 'standings', fields: [...base, f('team', 'Reference'), f('league', 'Reference'), f('position', 'Number'), f('points', 'Number'), f('page-url', 'Link')] },
  '6a200649c668e2cb8f11e82b': { slug: 'matches', fields: [...base, f('home-team', 'Reference'), f('away-team', 'Reference'), f('match-date', 'DateTime'), f('home-score', 'Number'), f('away-score', 'Number'), f('status', 'Option', { validations: { options: Object.entries(STATUS).map(([name, id]) => ({ name, id })) } }), f('league', 'Reference'), f('home-badge', 'Image'), f('teams', 'MultiReference'), f('match-date-iso', 'PlainText'), f('broadcaster-url', 'Link')] },
  '6a32a89633c9bd6bea624094': { slug: 'top-scorers', fields: [...base, f('goals', 'Number'), f('rank', 'Number'), f('league', 'Reference'), f('team', 'Reference'), f('photo', 'Image')] },
  '69c4f95e9b0adb96456bf53b': { slug: 'venues', fields: [...base, f('city', 'PlainText'), f('capacity', 'PlainText'), f('venue-type', 'Option', { validations: { options: Object.entries(VTYPE).map(([name, id]) => ({ name, id })) } }), f('transport----train', 'RichText'), f('photo-gallery', 'MultiImage'), f('home-teams', 'MultiReference'), f('coordinates', 'PlainText'), f('venue-images', 'Image'), f('venue-page-url', 'Link')] },
  '6a32a89594643f6e4b78ee05': { slug: 'authors', fields: [...base, f('avatar', 'Image'), f('role', 'PlainText')] },
  '6ae3320ba376e9c8a49f65f3': { slug: 'football-records', fields: [...base, f('category', 'Option', { validations: { options: [{ name: 'Trophy', id: 'opt_trophy' }] } }), f('value', 'PlainText')] },
  '69c3c0da2fd37856ad9e2ab1': { slug: 'blog-posts', fields: [...base, f('short-description', 'PlainText'), f('main-image', 'Image'), f('blog-details', 'RichText'), f('league', 'Reference'), f('author', 'Reference'), f('translation-es', 'Reference'), f('is-sponsored', 'Switch'), f('meta-description', 'PlainText'), f('share-image', 'Image')] },
  '69e5f0c0b01760ebae450b91': { slug: 'blog-posts-es', fields: [...base, f('blog-details', 'RichText'), f('translation-en', 'Reference')] },
  '69e5f0c15c882b408ab73240': { slug: 'blog-posts-pt', fields: [...base, f('blog-details', 'RichText'), f('translation-en', 'Reference')] },
};

const item = (id, fieldData, createdOn = '2026-08-01T10:00:00.000Z') => ({
  id, cmsLocaleId: 'loc', lastPublished: '2026-11-11T07:10:26.822Z', lastUpdated: '2026-11-11T07:10:26.822Z',
  createdOn, isArchived: false, isDraft: false, fieldData,
});
const range = (n, fn) => Array.from({ length: n }, (_, i) => fn(i));
const leagueIds = Object.values(L);

const items = {
  '6a32a8954e8d7db479514a79': Object.entries(L).map(([k, id]) => item(id, { name: k.toUpperCase(), slug: k === 'pl' ? 'premier-league' : k, country: 'X', logo: img(k), season: '2026-27', 'is-active': true })),
  '6a20064807685f373db26660': range(120, (i) => item('team_' + i, {
    name: 'Team ' + i, slug: 'team-' + i, 'api-team-id': String(1000 + i), badge: i % 10 ? img('t' + i) : null,
    'short-name': 'T' + i, league: leagueIds[i % 6],
    'club-profile': `<h4>About</h4><p>See <a href="/team/team-${i + 1}">rival</a> and <a href="https://x.com">x</a>.</p>`,
    rivals: i % 3 ? null : ['team_' + (i + 1)], 'seo-title': 'SEO', 'meta-description': 'META',
    'team-page-url': '/team/team-' + i, website: 'https://club' + i + '.com', venue: 'venue_' + (i % 60),
    'also-in-champions-league': i % 4 === 0 ? true : null, capacity: 20000 + i,
  })),
  '6a200649847c9fcb9278de02': range(120, (i) => item('st_' + i, { name: 'S' + i, slug: 's-' + i, team: 'team_' + i, league: leagueIds[i % 6], position: 20 - (Math.floor(i / 6) % 20), points: 50 - i % 40, 'page-url': '/standings/s-' + i })),
  '6a200649c668e2cb8f11e82b': range(612, (i) => item('m_' + i, {
    name: `Team ${i % 120} vs Team ${(i + 1) % 120}`, slug: 'match-' + i, 'home-team': 'team_' + (i % 120), 'away-team': 'team_' + ((i + 1) % 120),
    'match-date': new Date(Date.UTC(2026, 7, 1) + ((i * 7919) % 300) * 86400000).toISOString(), 'home-score': i % 2 ? 2 : null, 'away-score': i % 2 ? 1 : null,
    status: i % 2 ? STATUS.Played : STATUS.Upcoming, league: i === 5 ? null : leagueIds[i % 6], 'home-badge': img('h' + i),
    teams: ['team_' + (i % 120), 'team_' + ((i + 1) % 120)], 'match-date-iso': 'x', 'broadcaster-url': null,
  })),
  '6a32a89633c9bd6bea624094': range(30, (i) => item('ts_' + i, { name: 'Player ' + i, slug: 'p-' + i, goals: 20 - (i % 10), rank: (i % 10) + 1, league: leagueIds[i % 3], team: 'team_' + i, photo: img('p' + i) })),
  '69c4f95e9b0adb96456bf53b': range(60, (i) => item('venue_' + i, {
    name: 'Stadium ' + i, slug: 'stadium-' + i, city: 'City', capacity: '22,514', 'venue-type': i < 50 ? VTYPE['Club Stadium'] : VTYPE['World Cup'],
    'transport----train': '<p>Take the <a href="/venues/stadium-1">train</a>.</p>', 'photo-gallery': i % 2 ? [img('g1'), img('g2')] : null,
    'home-teams': ['team_' + i], coordinates: '43.47639,-3.79333', 'venue-images': img('v' + i), 'venue-page-url': '/venues/stadium-' + i,
  })),
  '6a32a89594643f6e4b78ee05': [item('author_1', { name: 'Marcus Delgado', slug: 'marcus-delgado', avatar: img('a1'), role: 'Contributor' })],
  '6ae3320ba376e9c8a49f65f3': [item('rec_1', { name: 'Most league titles', slug: 'most-titles', category: 'opt_trophy', value: '36 titles' })],
  '69c3c0da2fd37856ad9e2ab1': range(205, (i) => item('blog_' + i, {
    name: 'Article ' + i, slug: 'article-' + i, 'short-description': 'Short ' + i, 'main-image': img('b' + i),
    'blog-details': `<p>Body ${i} <a href="/team/team-1">Team 1</a> <img src="/images/x.png"></p>`, league: leagueIds[i % 6], author: 'author_1',
    'translation-es': i === 0 ? 'es_0' : null, 'is-sponsored': i === 3, 'meta-description': 'm', 'share-image': img('s'),
  }, new Date(Date.UTC(2026, 3, 1) + i * 86400000).toISOString())),
  '69e5f0c0b01760ebae450b91': [item('es_0', { name: 'Artículo 0', slug: 'articulo-0', 'blog-details': '<p>Hola</p>', 'translation-en': 'blog_0' })],
  '69e5f0c15c882b408ab73240': [],
};

let served429 = false;
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const send = (code, body, headers = {}) => { res.writeHead(code, { 'content-type': 'application/json', ...headers }); res.end(JSON.stringify(body)); };

  if (req.headers.authorization !== 'Bearer test-token') return send(401, { message: 'bad token' });
  // Simulate one rate-limit hit to exercise retry logic.
  if (!served429 && url.pathname.includes('/items/live') && url.searchParams.get('offset') === '200') {
    served429 = true;
    return send(429, { message: 'Too Many Requests' }, { 'retry-after': '1' });
  }
  let m;
  if ((m = url.pathname.match(/^\/v2\/collections\/([^/]+)\/items\/live$/))) {
    const all = items[m[1]];
    if (!all) return send(404, { message: 'not found' });
    const limit = Number(url.searchParams.get('limit') || 100), offset = Number(url.searchParams.get('offset') || 0);
    return send(200, { items: all.slice(offset, offset + limit), pagination: { limit, offset, total: all.length } });
  }
  if ((m = url.pathname.match(/^\/v2\/collections\/([^/]+)$/))) {
    const s = schemas[m[1]];
    return s ? send(200, { id: m[1], ...s }) : send(404, { message: 'not found' });
  }
  send(404, { message: 'no route' });
});

const port = Number(process.env.PORT || 8787);
server.listen(port, () => console.log('mock webflow on ' + port));
