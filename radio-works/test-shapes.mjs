#!/usr/bin/env node
/* Offline shape tests for the now-playing resolver.
 *
 * These are NOT live stations. Each fixture is a hand-built response in the
 * documented shape of that platform, served to the resolver through a stubbed
 * fetch. That still exercises the two things most likely to be wrong — how the
 * endpoint URL is derived from the stream URL, and where the song is dug out
 * of the payload — without needing network access.
 *
 * End-to-end: the resolver's raw string is then fed through a copy of the
 * page's own parseTrack()/validTrack(), so a fixture only passes if the whole
 * handoff produces the right artist and title, or correctly rejects an ident.
 *
 *   node test-shapes.mjs
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { fetchNowPlaying } = require('./nowplaying.js');

/* ===== copied verbatim from the page, so we test the real handoff ===== */
const fold = s => (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9 ]/g, '').trim();
function validTrack(p, stationName) {
  if (!p) return null;
  const norm = x => fold(x || '').replace(/[^a-z0-9]/g, '');
  const title = (p.title || '').trim(), artist = (p.artist || '').trim();
  if (title.length < 2) return null;
  if (/^https?:|^www\.|^tracklist\b/i.test(title)) return null;
  if (!/[a-z0-9\p{L}]/iu.test(title)) return null;
  if (stationName) {
    const sn = norm(stationName), nt = norm(title + artist);
    if (sn.length > 3 && nt.length > 3 && (nt.includes(sn) || sn.includes(nt))) return null;
    const na = norm(artist);
    if (sn.length > 3 && na.length > 3 && (na === sn || sn.includes(na) || na.includes(sn))) return null;
  }
  if (artist && norm(artist).length > 2 && norm(artist) === norm(title)) return null;
  if (/(^|\s)(www\.|https?:)|\.(com|net|org|fm|de|co\.uk|com\.au)(\s|$)/i.test(artist)) return null;
  return { title, artist };
}
function parseTrack(raw, stationName) {
  if (!raw) return null;
  let t = String(raw);
  try { if (/%[0-9a-f]{2}/i.test(t)) t = decodeURIComponent(t.replace(/\+/g, ' ')); } catch {}
  t = t.replace(/\s+/g, ' ').trim();
  if (!t) return null;
  t = t.replace(/\s*\|\s*[^|]*$/, '').trim();
  if (/\.(mp3|aac|m4a|wav|ogg)\b/i.test(t)) return null;
  if (/^\s*\d{2,3}[.,]?\d?\s*(FM|AM|MHz)/i.test(t)) return null;
  const by = t.match(/^(.*?)\s+by\s+(.+)$/i);
  if (by && by[1].length > 1 && by[2].length > 1) return validTrack({ title: by[1], artist: by[2] }, stationName);
  const dash = t.split(/\s+[-–—]\s+/);
  if (dash.length >= 2) return validTrack({ artist: dash[0].trim(), title: dash.slice(1).join(' - ').trim() }, stationName);
  return validTrack(t.length > 1 ? { title: t, artist: '' } : null, stationName);
}

/* ===== fixtures ===== */
const J = (o) => ({ status: 200, body: JSON.stringify(o), ct: 'application/json' });
const T = (s) => ({ status: 200, body: s, ct: 'text/plain' });

const FIXTURES = [
  { label: 'AzuraCast — now_playing.song.{artist,title}',
    st: { name: 'Jazz FM', stationuuid: 'a1', url_resolved: 'https://radio.example.com/listen/jazz_fm/radio.mp3' },
    routes: { 'https://radio.example.com/api/nowplaying_static/jazz_fm.json':
      J({ now_playing: { song: { text: 'Miles Davis - So What', artist: 'Miles Davis', title: 'So What', art: 'https://x/a.jpg' } } }) },
    expect: { artist: 'Miles Davis', title: 'So What' } },

  { label: 'Icecast — icestats.source[] matched by listenurl',
    st: { name: 'Radio Nova', stationuuid: 'a2', url_resolved: 'https://ice.example.org:8000/stream.mp3' },
    routes: { 'https://ice.example.org:8000/status-json.xsl':
      J({ icestats: { source: [
        { listenurl: 'http://ice.example.org:8000/other.mp3', title: 'WRONG - Wrong' },
        { listenurl: 'http://ice.example.org:8000/stream.mp3', title: 'Fleetwood Mac - Dreams' } ] } }) },
    expect: { artist: 'Fleetwood Mac', title: 'Dreams' } },

  { label: 'Icecast — single source object, yp_currently_playing',
    st: { name: 'Klassik', stationuuid: 'a3', url_resolved: 'https://ice2.example.org/live' },
    routes: { 'https://ice2.example.org/status-json.xsl':
      J({ icestats: { source: { listenurl: 'http://ice2.example.org/live', yp_currently_playing: 'Chopin - Nocturne Op. 9 No. 2' } } }) },
    expect: { artist: 'Chopin', title: 'Nocturne Op. 9 No. 2' } },

  { label: 'Shoutcast v2 — songtitle',
    st: { name: 'Dance Wave', stationuuid: 'a4', url_resolved: 'https://sc.example.net:8010/;' },
    routes: { 'https://sc.example.net:8010/stats?json=1&sid=1':
      J({ songtitle: 'Daft Punk - Around the World', bitrate: '128' }) },
    expect: { artist: 'Daft Punk', title: 'Around the World' } },

  { label: 'Radio.co — current_track.title',
    st: { name: 'Soho Radio', stationuuid: 'a5', url_resolved: 'https://streamer.radio.co/s1234abcd/listen' },
    routes: { 'https://public.radio.co/stations/s1234abcd/status':
      J({ current_track: { title: 'Nina Simone - Feeling Good', artwork_url_large: 'https://x/b.jpg' } }) },
    expect: { artist: 'Nina Simone', title: 'Feeling Good' } },

  { label: 'RadioKing — artist and title as separate fields',
    st: { name: 'My Station', stationuuid: 'a6', url_resolved: 'https://www.radioking.com/play/my-station' },
    routes: { 'https://api.radioking.io/widget/radio/my-station/track/current':
      J({ title: 'Hotel California', artist: 'Eagles', cover: 'https://x/c.jpg' }) },
    expect: { artist: 'Eagles', title: 'Hotel California' } },

  { label: 'laut.fm — artist is a nested object',
    st: { name: 'technoradio', stationuuid: 'a7', url_resolved: 'https://stream.laut.fm/technoradio' },
    routes: { 'https://api.laut.fm/station/technoradio/current_song':
      J({ title: 'Strobe', artist: { name: 'Deadmau5' } }) },
    expect: { artist: 'Deadmau5', title: 'Strobe' } },

  { label: 'Triton — XML with CDATA properties',
    st: { name: 'KIIS', stationuuid: 'a8', url_resolved: 'https://playerservices.streamtheworld.com/api/livestream-redirect/KIISFMAAC.mp3' },
    routes: { 'https://np.tritondigital.com/public/nowplaying?mountName=KIISFMAAC&numberToFetch=1&eventType=track':
      T(`<?xml version="1.0"?><nowplaying-info-list><nowplaying-info mountName="KIISFMAAC" type="track">` +
        `<property name="cue_title"><![CDATA[Blinding Lights]]></property>` +
        `<property name="track_artist_name"><![CDATA[The Weeknd]]></property>` +
        `</nowplaying-info></nowplaying-info-list>`) },
    expect: { artist: 'The Weeknd', title: 'Blinding Lights' } },

  { label: 'ABC — plays/search.json recording',
    st: { name: 'Triple J', stationuuid: 'a9', url_resolved: 'https://live-radio01.mediahubaustralia.com/2TJW/aac/' },
    routes: { 'https://music.abcradio.net.au/api/v1/plays/search.json?station=triplej&order=desc&limit=1':
      J({ items: [{ recording: { title: 'Elephant', artists: [{ name: 'Tame Impala' }] } }] }) },
    expect: { artist: 'Tame Impala', title: 'Elephant' } },

  { label: 'Unknown platform — nested song_name/artist_name',
    st: { name: 'Mystery FM', stationuuid: 'b1', url_resolved: 'https://odd.example.io/live.aac' },
    routes: { 'https://odd.example.io/status-json.xsl': { status: 404, body: '' },
              'https://odd.example.io/stats?json=1&sid=1': { status: 404, body: '' },
              'https://odd.example.io/statistics?json=1': { status: 404, body: '' },
              'https://odd.example.io/api/nowplaying':
      J({ data: { current: { song_name: 'Teardrop', artist_name: 'Massive Attack' } } }) },
    expect: { artist: 'Massive Attack', title: 'Teardrop' } },

  { label: 'Unknown platform — bare streamTitle string',
    st: { name: 'Zeno Station', stationuuid: 'b2', url_resolved: 'https://stream.zeno.fm/abc123' },
    routes: { 'https://stream.zeno.fm/status-json.xsl': { status: 404, body: '' },
              'https://stream.zeno.fm/stats?json=1&sid=1': { status: 404, body: '' },
              'https://stream.zeno.fm/statistics?json=1': { status: 404, body: '' },
              'https://stream.zeno.fm/api/nowplaying':
      J({ streamTitle: 'Bonobo - Kerala' }) },
    expect: { artist: 'Bonobo', title: 'Kerala' } },

  { label: 'http:// stream is upgraded to https before deriving the endpoint',
    st: { name: 'Old School', stationuuid: 'b3', url_resolved: 'http://legacy.example.com/stream' },
    routes: { 'https://legacy.example.com/status-json.xsl':
      J({ icestats: { source: { listenurl: 'http://legacy.example.com/stream', title: 'A Tribe Called Quest - Can I Kick It' } } }) },
    expect: { artist: 'A Tribe Called Quest', title: 'Can I Kick It' } },

  /* ---- must be REJECTED ---- */
  { label: 'REJECT: station ident in songtitle',
    st: { name: 'KIIS FM', stationuuid: 'c1', url_resolved: 'https://sc2.example.net/live' },
    routes: { 'https://sc2.example.net/status-json.xsl': { status: 404, body: '' },
              'https://sc2.example.net/stats?json=1&sid=1': J({ songtitle: 'KIIS FM' }) },
    expect: null },

  { label: 'REJECT: station billing itself in the artist slot',
    st: { name: 'Sunshine Live', stationuuid: 'c2', url_resolved: 'https://sc3.example.net/live' },
    routes: { 'https://sc3.example.net/status-json.xsl': { status: 404, body: '' },
              'https://sc3.example.net/stats?json=1&sid=1': J({ songtitle: 'SUNSHINE LIVE - 90s' }) },
    expect: null },

  { label: 'REJECT: a filename is not a song',
    st: { name: 'Auto DJ', stationuuid: 'c3', url_resolved: 'https://sc4.example.net/live' },
    routes: { 'https://sc4.example.net/status-json.xsl':
      J({ icestats: { source: { listenurl: 'http://sc4.example.net/live', title: 'jingle_04_final.mp3' } } }) },
    expect: null },

  { label: 'REJECT: nothing anywhere',
    st: { name: 'Silent FM', stationuuid: 'c4', url_resolved: 'https://quiet.example.net/live' },
    routes: {},
    expect: null },
];

/* ===== a mix from around the world =====
 * Regional stations are where parsers die: non-Latin scripts, full-width
 * punctuation, URL-encoded ICY strings, and separators that are not the
 * ASCII hyphen. Each of these is modelled on a real platform in that market. */
const ice = (host, path, title) => ({
  st: { name: 'x', stationuuid: 'w' + (ice.n = (ice.n || 0) + 1), url_resolved: `https://${host}${path}` },
  routes: { [`https://${host}/status-json.xsl`]:
    J({ icestats: { source: { listenurl: `http://${host}${path}`, title } } }) },
});
const world = (label, stationName, host, path, title, expect) => {
  const f = ice(host, path, title);
  f.st.name = stationName; f.label = label; f.expect = expect;
  return f;
};

const WORLD = [
  world('RU — Cyrillic, artist and title both non-Latin', 'Nashe Radio',
    'ru.example.net', '/nashe',
    'АГАТА КРИСТИ - ПОЗОРНАЯ ЗВЕЗДА',
    { artist: 'АГАТА КРИСТИ', title: 'ПОЗОРНАЯ ЗВЕЗДА' }),

  world('GR — Greek script', 'Sfera',
    'gr.example.net', '/sfera',
    'ΑΝΝΑ ΒΙΣΣΗ - ΚΑΛΟΚΑΙΡΙ',
    { artist: 'ΑΝΝΑ ΒΙΣΣΗ', title: 'ΚΑΛΟΚΑΙΡΙ' }),

  world('JP — full-width hyphen as the separator', 'J-Wave',
    'jp.example.net', '/jwave',
    '宇多ヒカル－First Love',
    { artist: '宇多ヒカル', title: 'First Love' }),

  world('CN — no spaces at all around an ASCII hyphen', 'Hit FM Taipei',
    'tw.example.net', '/hitfm',
    '\u5468\u6770\u502B-\u9752\u82B1\u74F7',
    { artist: '\u5468\u6770\u502B', title: '\u9752\u82B1\u74F7' }),

  world('KR — Hangul', 'MBC FM',
    'kr.example.net', '/mbc',
    '아이유 - 밤편지',
    { artist: '아이유', title: '밤편지' }),

  world('CN — Chinese, no spaces around the dash', 'CNR Music',
    'cn.example.net', '/cnr',
    '周杰倫 - 青花瓷',
    { artist: '周杰倫', title: '青花瓷' }),

  world('IN — Devanagari', 'Radio Mirchi',
    'in.example.net', '/mirchi',
    'अरिजीत सिंह - तुम ही हो',
    { artist: 'अरिजीत सिंह', title: 'तुम ही हो' }),

  world('EG — Arabic, right-to-left', 'Nogoum FM',
    'eg.example.net', '/nogoum',
    'عمرو دياب - تملي معاك',
    { artist: 'عمرو دياب', title: 'تملي معاك' }),

  world('BR — accented Portuguese', 'Radio MPB',
    'br.example.net', '/mpb',
    'Caétano Veloso - Sozinho',
    { artist: 'Caétano Veloso', title: 'Sozinho' }),

  world('DE — umlauts, and a hyphenated BAND name', 'Schlager Radio',
    'de.example.net', '/schlager',
    'Jean-Michel Jarre - Oxygène',
    { artist: 'Jean-Michel Jarre', title: 'Oxygène' }),

  world('FR — en-dash separator', 'FIP',
    'fr.example.net', '/fip',
    'Christine and the Queens – Tilted',
    { artist: 'Christine and the Queens', title: 'Tilted' }),

  world('MX — regional, song title contains its own dash', 'Los 40',
    'mx.example.net', '/los40',
    'Juan Gabriel - Querida - En Vivo',
    { artist: 'Juan Gabriel', title: 'Querida - En Vivo' }),

  world('PL — URL-encoded ICY string', 'RMF FM',
    'pl.example.net', '/rmf',
    'Czes%C5%82aw%20Niemen%20-%20Dziwny%20jest%20ten%20%C5%9Bwiat',
    { artist: 'Czesław Niemen', title: 'Dziwny jest ten świat' }),

  world('TH — Thai, no artist given at all', 'Cool Fahrenheit',
    'th.example.net', '/cool',
    'คนไม่สำคัญ',
    { artist: '', title: 'คนไม่สำคัญ' }),

  world('IT — "Title by Artist" phrasing', 'Radio Italia',
    'it.example.net', '/italia',
    'Volare by Domenico Modugno',
    { artist: 'Domenico Modugno', title: 'Volare' }),

  world('ZA — trailing station tail after a pipe', 'Metro FM',
    'za.example.net', '/metro',
    'Black Coffee - Drive | METRO FM 96.4',
    { artist: 'Black Coffee', title: 'Drive' }),

  world('NG — REJECT: pure station ident', 'Cool FM Lagos',
    'ng.example.net', '/coolfm',
    'Cool FM Lagos', null),
];
for (const w of WORLD) FIXTURES.push(w);

/* ===== stubbed fetch ===== */
let served = [];
globalThis.fetch = async (url, opts) => {
  const u = String(url);
  served.push(u);
  const hit = CURRENT.routes[u];
  if (!hit) {
    const e = new Error('ECONNREFUSED (no fixture for ' + u + ')');
    throw e;                                   // stands in for CORS/404/offline
  }
  return {
    ok: hit.status >= 200 && hit.status < 300,
    status: hit.status,
    headers: { get: (k) => (k.toLowerCase() === 'content-type' ? (hit.ct || '') : (k.toLowerCase() === 'access-control-allow-origin' ? '*' : null)) },
    async text() { return hit.body; },
    async json() { return JSON.parse(hit.body); },
  };
};

let CURRENT = null;
const eq = (a, b) => (a || '').trim().toLowerCase() === (b || '').trim().toLowerCase();

let pass = 0, fail = 0;
for (const fx of FIXTURES) {
  CURRENT = fx; served = [];
  const { raw } = await fetchNowPlaying(fx.st);
  const got = parseTrack(raw, fx.st.name);

  let ok;
  if (fx.expect === null) ok = got === null;
  else ok = !!got && eq(got.artist, fx.expect.artist) && eq(got.title, fx.expect.title);

  if (ok) { pass++; console.log(`  PASS  ${fx.label}`); }
  else {
    fail++;
    console.log(`  FAIL  ${fx.label}`);
    console.log(`        expected : ${fx.expect ? `${fx.expect.artist} — ${fx.expect.title}` : '(rejected)'}`);
    console.log(`        raw      : ${raw === null ? '(none)' : JSON.stringify(raw)}`);
    console.log(`        parsed   : ${got ? `${got.artist} — ${got.title}` : '(rejected)'}`);
    console.log(`        fetched  : ${served.join(', ') || '(nothing)'}`);
  }
}
console.log(`\n${pass} passed, ${fail} failed, ${FIXTURES.length} total`);
process.exit(fail ? 1 : 0);
