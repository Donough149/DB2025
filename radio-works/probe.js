/* Radio Works — live now-playing probe.
 *
 * Pulls N random working stations from radio-browser and, for each one, tries
 * every rung the app would try. Prints what actually came back: which rung
 * answered, the raw string, and the artist/title the app's parseTrack would
 * derive from it.
 *
 * No dependencies, no install. Needs Node 18+ for global fetch.
 *     node probe.js            # 50 stations
 *     node probe.js 20         # 20 stations
 */
'use strict';

const COUNT   = Number(process.argv[2]) || 50;
const TIMEOUT = 6000;

/* ---------- fetch helpers ---------------------------------------------- */
async function grab(url, how) {
  const ac = new AbortController();
  const t  = setTimeout(() => ac.abort(), TIMEOUT);
  try {
    const r = await fetch(url, {
      signal: ac.signal,
      redirect: 'follow',
      headers: { 'User-Agent': 'RadioWorksProbe/1.0' },
    });
    const cors = r.headers.get('access-control-allow-origin') || '';
    if (!r.ok) return { err: 'HTTP ' + r.status, cors };
    return { body: how === 'json' ? await r.json() : await r.text(), cors };
  } catch (e) {
    return { err: (e.name === 'AbortError' ? 'timeout' : String(e.message || e)).slice(0, 40) };
  } finally { clearTimeout(t); }
}
const getJSON = (u) => grab(u, 'json');
const getText = (u) => grab(u, 'text');

/* ---------- shape walker: find a song in JSON we've never seen ---------- */
const SONG_KEYS  = /^(song_?title|songtitle|streamtitle|stream_title|now_?playing|nowplaying|currently_?playing|current_?song|current_?track|track_?title|song_?name|track_?name|title|song|track|text)$/i;
const TITLE_KEYS = /^(title|song|track|name|song_?name|track_?name|title_?name)$/i;
function deepSong(o, d = 0, seen = new Set()) {
  if (!o || d > 6 || typeof o !== 'object' || seen.has(o)) return null;
  seen.add(o);
  if (Array.isArray(o)) {
    for (const v of o.slice(0, 12)) { const h = deepSong(v, d + 1, seen); if (h) return h; }
    return null;
  }
  const keys = Object.keys(o);
  const ak = keys.find(k => /^artist(_?name)?$/i.test(k));
  const tk = keys.find(k => TITLE_KEYS.test(k));
  if (ak && tk) {
    const av = o[ak];
    const a = typeof av === 'string' ? av : (av && typeof av.name === 'string' ? av.name : '');
    const t = typeof o[tk] === 'string' ? o[tk] : '';
    if (t.trim()) return { s: (a.trim() ? a.trim() + ' - ' : '') + t.trim(), via: ak + '+' + tk };
  }
  for (const k of keys)
    if (typeof o[k] === 'string' && o[k].trim() && SONG_KEYS.test(k)) return { s: o[k].trim(), via: k };
  for (const k of keys)
    if (o[k] && typeof o[k] === 'object') { const h = deepSong(o[k], d + 1, seen); if (h) return h; }
  return null;
}

/* ---------- Triton wraps values in CDATA, not a value="" attribute ----- */
function tritonProp(xml, name) {
  const m = xml.match(new RegExp('name="' + name + '"[^>]*>\\s*(?:<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>|([^<]*))', 'i'));
  return m ? String(m[1] ?? m[2] ?? '').trim() : '';
}

/* ---------- the ladder -------------------------------------------------
 * IMPORTANT: each rung is tried on the stream's OWN scheme first. Forcing
 * https broke most Icecast/Shoutcast hosts, which are http-only. We record
 * which scheme worked so the app can copy that behaviour. */
const RUNGS = [
  { name: 'azuracast',
    claim: u => /\/(listen|radio)\//.test(u.pathname) || /azura/i.test(u.host),
    run: async (u) => {
      const m = u.pathname.match(/\/listen\/([^/]+)\//) || u.pathname.match(/\/radio\/\d+\/([^/]+)/);
      const tries = m ? [`${u.origin}/api/nowplaying_static/${m[1]}.json`, `${u.origin}/api/nowplaying`]
                      : [`${u.origin}/api/nowplaying`];
      for (const t of tries) {
        const r = await getJSON(t); if (r.err) continue;
        const j = r.body;
        const np = Array.isArray(j) ? j[0]?.now_playing : j?.now_playing;
        const s = np?.song;
        if (s?.title) return { raw: s.artist ? `${s.artist} - ${s.title}` : (s.text || s.title), key: 'now_playing.song', cors: r.cors, url: t };
      }
      return null;
    } },
  { name: 'radio.co',
    claim: u => /radio\.co$/.test(u.host),
    run: async (u) => {
      const id = (u.pathname.match(/\/(s[0-9a-z]+)\b/i) || [])[1]; if (!id) return null;
      const r = await getJSON(`https://public.radio.co/stations/${id}/status`); if (r.err) return null;
      const t = r.body?.current_track?.title;
      return t ? { raw: t, key: 'current_track.title', cors: r.cors } : null;
    } },
  { name: 'radioking',
    claim: u => /radioking/i.test(u.host),
    run: async (u) => {
      const s = (u.pathname.match(/\/(?:play|radio)\/([^/]+)/) || [])[1]; if (!s) return null;
      const r = await getJSON(`https://api.radioking.io/widget/radio/${s}/track/current`); if (r.err) return null;
      const j = r.body;
      return j?.title ? { raw: j.artist ? `${j.artist} - ${j.title}` : j.title, key: 'artist+title', cors: r.cors } : null;
    } },
  { name: 'laut.fm',
    claim: u => /laut\.fm$/.test(u.host),
    run: async (u) => {
      const n = u.pathname.replace(/^\//, '').split('/')[0]; if (!n) return null;
      const r = await getJSON(`https://api.laut.fm/station/${n}/current_song`); if (r.err) return null;
      const j = r.body;
      return j?.title ? { raw: (j.artist?.name ? j.artist.name + ' - ' : '') + j.title, key: 'artist.name+title', cors: r.cors } : null;
    } },
  { name: 'radiojar',
    claim: u => /radiojar/i.test(u.host),
    run: async (u) => {
      const id = u.pathname.replace(/^\//, '').split('/')[0]; if (!id) return null;
      const r = await getJSON(`https://www.radiojar.com/api/stations/${id}/now_playing/`); if (r.err) return null;
      const j = r.body;
      return j?.title ? { raw: (j.artist ? j.artist + ' - ' : '') + j.title, key: 'artist+title', cors: r.cors } : null;
    } },
  { name: 'triton',
    claim: u => /streamtheworld|tritondigital/i.test(u.host),
    run: async (u) => {
      const m = u.pathname.match(/([A-Z0-9_]+(?:AAC|MP3|_SC)?)(?:\.(?:mp3|aac))?$/i); if (!m) return null;
      const r = await getText(`https://np.tritondigital.com/public/nowplaying?mountName=${m[1]}&numberToFetch=1&eventType=track`);
      if (r.err) return null;
      const a = tritonProp(r.body, 'track_artist_name'), t = tritonProp(r.body, 'cue_title');
      return t ? { raw: (a ? a + ' - ' : '') + t, key: 'cue_title(CDATA)', cors: r.cors } : null;
    } },
  { name: 'icecast',
    claim: () => true,
    run: async (u) => {
      const r = await getJSON(`${u.origin}/status-json.xsl`); if (r.err) return null;
      const src = r.body?.icestats?.source; if (!src) return null;
      const arr = Array.isArray(src) ? src : [src];
      const mine = arr.find(s => typeof s.listenurl === 'string' && s.listenurl.endsWith(u.pathname)) || arr[0];
      if (!mine) return null;
      const k = ['title', 'yp_currently_playing', 'song'].find(k => typeof mine[k] === 'string' && mine[k].trim());
      return k ? { raw: mine[k].trim(), key: 'icestats.source.' + k, cors: r.cors } : null;
    } },
  { name: 'shoutcast2',
    claim: () => true,
    run: async (u) => {
      for (const t of [`${u.origin}/stats?json=1&sid=1`, `${u.origin}/statistics?json=1`]) {
        const r = await getJSON(t); if (r.err) continue;
        const j = r.body;
        if (j?.songtitle) return { raw: String(j.songtitle).trim(), key: 'songtitle', cors: r.cors, url: t };
        const h = deepSong(j);
        if (h) return { raw: h.s, key: h.via, cors: r.cors, url: t };
      }
      return null;
    } },
  { name: 'shoutcast1',
    claim: () => true,
    run: async (u) => {
      const r = await getText(`${u.origin}/7.html`); if (r.err) return null;
      const m = String(r.body).match(/<body>([^<]*)</i); if (!m) return null;
      const f = m[1].split(','); if (f.length < 7) return null;
      const raw = f.slice(6).join(',').trim();
      return raw ? { raw, key: '7.html field 7', cors: r.cors } : null;
    } },
  { name: 'generic',
    claim: () => true,
    run: async (u) => {
      for (const t of [`${u.origin}/api/nowplaying`, `${u.origin}/nowplaying.json`,
                       `${u.origin}/currentsong?sid=1`, `${u.origin}/api/live-info`,
                       `${u.origin}/status.xsl`]) {
        const r = await getText(t); if (r.err) continue;
        let j = null; try { j = JSON.parse(r.body); } catch {}
        if (j) { const h = deepSong(j); if (h) return { raw: h.s, key: h.via, cors: r.cors, url: t }; }
        else {
          const b = String(r.body).trim();
          if (b && b.length < 200 && !/^</.test(b)) return { raw: b, key: 'plain text', cors: r.cors, url: t };
        }
      }
      return null;
    } },
];

/* ---------- the app's own parser, verbatim enough to be meaningful ----- */
function splitPair(raw) {
  let t = String(raw).replace(/\s+/g, ' ').trim();
  t = t.replace(/\s*\|\s*[^|]*$/, '').trim();
  const by = t.match(/^(.*?)\s+by\s+(.+)$/i);
  if (by) return { title: by[1].trim(), artist: by[2].trim() };
  const d = t.split(/\s+[-–—]\s+/);
  if (d.length >= 2) return { artist: d[0].trim(), title: d.slice(1).join(' - ').trim() };
  return { artist: '', title: t };
}

/* ---------- run -------------------------------------------------------- */
const pad = (s, n) => (String(s ?? '').length > n ? String(s).slice(0, n - 1) + '…' : String(s ?? '').padEnd(n));

(async () => {
  process.stdout.write(`Fetching ${COUNT} random stations…\n`);
  let list = null;
  for (const host of ['de1.api.radio-browser.info', 'nl1.api.radio-browser.info', 'at1.api.radio-browser.info']) {
    const r = await getJSON(`https://${host}/json/stations/search?limit=${COUNT}&hidebroken=true&order=random&has_extended_info=false`);
    if (!r.err && Array.isArray(r.body) && r.body.length) { list = r.body; break; }
    process.stdout.write(`  ${host}: ${r.err || 'empty'}\n`);
  }
  if (!list) { console.log('Could not reach radio-browser at all. Stop here and paste this output.'); return; }

  const tally = {}, schemeTally = { http: 0, https: 0 };
  let hits = 0;

  console.log('');
  console.log(pad('STATION', 26) + pad('CC', 3) + pad('RUNG', 12) + pad('SCHEME', 7) + pad('CORS', 6) + pad('KEY', 20) + 'ARTIST  /  TITLE');
  console.log('-'.repeat(140));

  for (const st of list) {
    const stream = st.url_resolved || st.url || '';
    let base; try { base = new URL(stream); } catch { continue; }

    // try the stream's own scheme first, then the other one
    const schemes = base.protocol === 'http:' ? ['http:', 'https:'] : ['https:', 'http:'];
    let got = null, gotRung = '', gotScheme = '';

    outer:
    for (const scheme of schemes) {
      const u = new URL(base.href); u.protocol = scheme;
      for (const rung of RUNGS) {
        let c = false; try { c = rung.claim(u, st); } catch {}
        if (!c) continue;
        let hit = null; try { hit = await rung.run(u, st); } catch {}
        if (hit && hit.raw) { got = hit; gotRung = rung.name; gotScheme = scheme.replace(':', ''); break outer; }
      }
    }

    const name = (st.name || '').replace(/\s+/g, ' ').trim();
    if (got) {
      hits++;
      tally[gotRung] = (tally[gotRung] || 0) + 1;
      schemeTally[gotScheme]++;
      const p = splitPair(got.raw);
      console.log(pad(name, 26) + pad(st.countrycode, 3) + pad(gotRung, 12) + pad(gotScheme, 7)
        + pad(got.cors === '*' ? 'yes' : (got.cors ? got.cors.slice(0, 5) : 'NO'), 6)
        + pad(got.key, 20) + (p.artist || '—') + '  /  ' + p.title);
    } else {
      console.log(pad(name, 26) + pad(st.countrycode, 3) + pad('-', 12) + pad('-', 7) + pad('-', 6) + pad('-', 20)
        + 'nothing   [' + stream.slice(0, 60) + ']');
    }
  }

  console.log('-'.repeat(140));
  console.log(`\n${hits}/${list.length} stations returned a song.`);
  console.log('By rung:   ' + (Object.entries(tally).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join('  ') || 'none'));
  console.log('By scheme: http=' + schemeTally.http + '  https=' + schemeTally.https
    + '   <- if http wins often, forcing https in the app is the bug');
  const noCors = 'CORS "NO" means a browser could NOT read it even though node can.';
  console.log(noCors);
})();
