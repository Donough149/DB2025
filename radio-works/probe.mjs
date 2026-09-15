#!/usr/bin/env node
/* Airtime / Radio Works — now-playing reachability probe.
 *
 * Picks N random live stations from radio-browser, then tries every
 * now-playing endpoint we know of against each one and reports, per station:
 *
 *   - which endpoint answered
 *   - WHICH JSON KEY the song was hiding in (the whole point: every platform
 *     buries it somewhere different)
 *   - the parsed artist and title
 *   - whether a BROWSER could have made that call, i.e. does the response
 *     carry Access-Control-Allow-Origin
 *
 * That last column is the one that matters. From Node every endpoint looks
 * reachable; in a page, anything without CORS is dead. Implementing a source
 * that is SERVER-ONLY buys nothing in a serverless build.
 *
 * Usage:  node probe.mjs [--count 20] [--timeout 8000] [--json out.json]
 * No dependencies. Node 18+.
 */

const args = process.argv.slice(2);
const argOf = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const COUNT   = +argOf('count', 20);
const TIMEOUT = +argOf('timeout', 8000);
const OUTJSON = argOf('json', null);

const MIRRORS = [
  'https://de1.api.radio-browser.info/json',
  'https://at1.api.radio-browser.info/json',
  'https://nl1.api.radio-browser.info/json',
];

/* ---------- tiny http helper: always reports the CORS header ---------- */
async function get(url, { accept = 'application/json', headers = {} } = {}) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), TIMEOUT);
  try {
    const r = await fetch(url, {
      signal: ac.signal,
      redirect: 'follow',
      headers: { accept, 'user-agent': 'AirtimeProbe/1.0', ...headers },
    });
    const acao = r.headers.get('access-control-allow-origin');
    const ct = r.headers.get('content-type') || '';
    const body = r.ok ? await r.text() : '';
    return { ok: r.ok, status: r.status, acao, ct, body, url };
  } catch (e) {
    return { ok: false, status: 0, acao: null, ct: '', body: '', url, err: e.name === 'AbortError' ? 'timeout' : e.message };
  } finally { clearTimeout(t); }
}
const json = (s) => { try { return JSON.parse(s); } catch { return null; } };

/* ---------- splitting "Artist - Title" ----------
 * Deliberately conservative. Some feeds give artist and title as separate
 * fields, in which case we never guess at all. */
const CJK = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af]/;
function normalizeIcy(s) {
  if (!s) return s;
  let t = String(s).replace(/\u3000/g, ' ').replace(/[\uff0d\u2010\u2012]/g, '-').replace(/\uff5e/g, '~').trim();
  if (CJK.test(t) && !/\s[-\u2013\u2014]\s/.test(t)) {
    const m = t.match(/^([^-\u2013\u2014]{2,})[-\u2013\u2014]([^-\u2013\u2014].*)$/);
    if (m) t = m[1].trim() + ' - ' + m[2].trim();
  }
  return t;
}
function splitPair(raw) {
  if (!raw) return null;
  let t = normalizeIcy(String(raw).replace(/\s+/g, ' ').trim());
  if (!t) return null;
  const m = t.split(/\s+[-–—]\s+/);
  if (m.length >= 2) return { artist: m[0].trim(), title: m.slice(1).join(' - ').trim() };
  const by = t.match(/^(.*?)\s+by\s+(.+)$/i);
  if (by) return { artist: by[2].trim(), title: by[1].trim() };
  return { artist: '', title: t };
}
/* A station ident is not a song. */
function looksLikeSong(p, stationName) {
  if (!p || !p.title || p.title.length < 2) return false;
  const norm = (x) => (x || '').toLowerCase().normalize('NFD').replace(/[^a-z0-9]/g, '');
  const sn = norm(stationName), nt = norm(p.title + p.artist);
  if (sn.length > 3 && nt.length > 3 && (nt.includes(sn) || sn.includes(nt))) return false;
  if (/^https?:|^www\./i.test(p.title)) return false;
  if (/\.(mp3|aac|m4a|ogg)$/i.test(p.title)) return false;
  if (/^\d{2,3}[.,]?\d?\s*(FM|AM|MHz)/i.test(p.title)) return false;
  return true;
}

/* ---------- walk an object and find the first key that holds a song ----------
 * Used as the last resort so we LEARN new shapes instead of missing them.
 * Returns {path, value} so the report can show where it lived. */
const SONG_KEYS = /^(song_?title|songtitle|streamtitle|stream_title|now_?playing|nowplaying|currently_?playing|current_?song|current_?track|track_?title|song_?name|track_?name|title|song|track|text)$/i;
const TITLE_KEYS = /^(title|song|track|name|song_?name|track_?name|title_?name)$/i;
function deepFindSong(obj, stationName, path = '$', depth = 0, seen = new Set()) {
  if (!obj || depth > 6 || seen.has(obj)) return null;
  if (typeof obj === 'object') seen.add(obj);
  if (Array.isArray(obj)) {
    for (let i = 0; i < Math.min(obj.length, 12); i++) {
      const hit = deepFindSong(obj[i], stationName, `${path}[${i}]`, depth + 1, seen);
      if (hit) return hit;
    }
    return null;
  }
  if (typeof obj !== 'object') return null;

  // an explicit artist+title pair beats any combined string
  const ak = Object.keys(obj).find((k) => /^artist(_?name)?$/i.test(k));
  const tk = Object.keys(obj).find((k) => TITLE_KEYS.test(k));
  if (ak && tk && typeof obj[ak] === 'string' && typeof obj[tk] === 'string' && obj[tk].trim()) {
    const artist = typeof obj[ak] === 'string' ? obj[ak] : '';
    const p = { artist: artist.trim(), title: obj[tk].trim() };
    if (looksLikeSong(p, stationName)) return { path: `${path}.{${ak},${tk}}`, parsed: p, raw: `${p.artist} - ${p.title}` };
  }
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === 'string' && v.trim() && SONG_KEYS.test(k)) {
      const p = splitPair(v);
      if (looksLikeSong(p, stationName)) return { path: `${path}.${k}`, parsed: p, raw: v.trim() };
    }
  }
  for (const [k, v] of Object.entries(obj)) {
    if (v && typeof v === 'object') {
      const hit = deepFindSong(v, stationName, `${path}.${k}`, depth + 1, seen);
      if (hit) return hit;
    }
  }
  return null;
}

/* ================= THE LADDER =================
 * Each rung: can it claim this stream URL, what does it call, and where does
 * the song live in the answer. Ordered cheapest/most-specific first. */
const RUNGS = [
  {
    name: 'azuracast',
    claim: (u) => /\/(listen|radio)\//.test(u.pathname) || /azura/i.test(u.host),
    urls: (u) => {
      const m = u.pathname.match(/\/listen\/([^/]+)\//) || u.pathname.match(/\/radio\/\d+\/([^/]+)/);
      const out = [`${u.origin}/api/nowplaying`];
      if (m) out.unshift(`${u.origin}/api/nowplaying_static/${m[1]}.json`);
      return out;
    },
    // now_playing.song.{artist,title}, or .text as "Artist - Title"
  },
  {
    name: 'icecast',
    claim: () => true, // the default for anything self-hosted
    urls: (u) => [`${u.origin}/status-json.xsl`],
    pick: (data, u) => {
      const src = data?.icestats?.source;
      if (!src) return null;
      const arr = Array.isArray(src) ? src : [src];
      const mine = arr.find((s) => typeof s.listenurl === 'string' && s.listenurl.endsWith(u.pathname)) || arr[0];
      if (!mine) return null;
      const key = ['title', 'yp_currently_playing', 'song'].find((k) => typeof mine[k] === 'string' && mine[k].trim());
      return key ? { path: `$.icestats.source.${key}`, raw: mine[key].trim() } : null;
    },
  },
  {
    name: 'shoutcast2',
    claim: () => true,
    urls: (u) => [`${u.origin}/stats?json=1&sid=1`, `${u.origin}/statistics?json=1`],
    // songtitle
  },
  {
    name: 'radio.co',
    claim: (u) => /radio\.co$/.test(u.host),
    urls: (u) => {
      const id = (u.pathname.match(/\/(s[0-9a-z]+)\b/i) || [])[1];
      return id ? [`https://public.radio.co/stations/${id}/status`] : [];
    },
    // current_track.title = "Artist - Title"
  },
  {
    name: 'radioking',
    claim: (u) => /radioking/i.test(u.host),
    urls: (u) => {
      const slug = (u.pathname.match(/\/(?:play|radio)\/([^/]+)/) || [])[1];
      return slug ? [`https://api.radioking.io/widget/radio/${slug}/track/current`] : [];
    },
    // {artist, title}
  },
  {
    name: 'laut.fm',
    claim: (u) => /laut\.fm$/.test(u.host),
    urls: (u) => {
      const n = u.pathname.replace(/^\//, '').split('/')[0];
      return n ? [`https://api.laut.fm/station/${n}/current_song`] : [];
    },
    // {title, artist:{name}}
  },
  {
    name: 'radiojar',
    claim: (u) => /radiojar/i.test(u.host),
    urls: (u) => {
      const id = u.pathname.replace(/^\//, '').split('/')[0];
      return id ? [`https://www.radiojar.com/api/stations/${id}/now_playing/`] : [];
    },
  },
  {
    name: 'triton',
    claim: (u) => /streamtheworld|tritondigital/i.test(u.host),
    urls: (u) => {
      const m = u.pathname.match(/([A-Z0-9_]+(?:AAC|MP3|_SC)?)(?:\.mp3|\.aac)?$/i);
      return m ? [`https://np.tritondigital.com/public/nowplaying?mountName=${m[1]}&numberToFetch=1&eventType=track`] : [];
    },
    xml: true,
  },
  {
    name: 'centova',
    claim: () => true,
    urls: (u) => {
      const mount = u.pathname.replace(/^\//, '').split('/')[0].replace(/\.(mp3|aac)$/i, '');
      return mount ? [`${u.origin}/rpc/${mount}/streaminfo.get`] : [];
    },
  },
];

/* Triton wraps every field as <property name="X"><![CDATA[...]]></property>.
   There is no value="..." attribute; looking for one found nothing, ever. */
function tritonProp(xml, name) {
  const re = new RegExp('name="' + name + '"[^>]*>\\s*(?:<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>|([^<]*))', 'i');
  const m = xml.match(re);
  return m ? String(m[1] ?? m[2] ?? '').trim() : '';
}
function parseXmlTrack(body) {
  const t = tritonProp(body, 'cue_title');
  if (!t) return null;
  const a = tritonProp(body, 'track_artist_name');
  return { path: '$.nowplaying-info.property[cue_title]', parsed: { artist: a, title: t }, raw: (a ? a + ' - ' : '') + t };
}

async function probeStation(st) {
  const stream = st.url_resolved || st.url;
  let u;
  try { u = new URL(stream); } catch { return { st, stream, result: null, tried: [] }; }

  const tried = [];
  for (const rung of RUNGS) {
    if (!rung.claim(u)) continue;
    let urls = [];
    try { urls = rung.urls(u) || []; } catch { urls = []; }
    for (const target of urls) {
      const r = await get(target);
      const rec = { rung: rung.name, url: target, status: r.status, acao: r.acao, err: r.err || null };
      tried.push(rec);
      if (!r.ok || !r.body) continue;

      let hit = null;
      if (rung.xml) hit = parseXmlTrack(r.body);
      else {
        const data = json(r.body);
        if (!data) continue;
        if (rung.pick) {
          const p = rung.pick(data, u);
          if (p) { const parsed = splitPair(p.raw); if (looksLikeSong(parsed, st.name)) hit = { ...p, parsed }; }
        }
        // generic sweep: finds the shapes we did not hand-code, and tells us where
        if (!hit) hit = deepFindSong(data, st.name);
      }
      if (hit) {
        return {
          st, stream, tried,
          result: {
            rung: rung.name, endpoint: target, path: hit.path,
            raw: hit.raw, artist: hit.parsed.artist, title: hit.parsed.title,
            acao: r.acao,
            browserOk: r.acao === '*' || (r.acao && r.acao !== 'null'),
          },
        };
      }
    }
  }
  return { st, stream, result: null, tried };
}

/* ---------- main ---------- */
async function apiGet(path) {
  for (const b of MIRRORS) {
    const r = await get(b + path);
    if (r.ok) { const d = json(r.body); if (d) return d; }
  }
  throw new Error('radio-browser unreachable from this machine');
}

const pad = (s, n) => String(s ?? '').replace(/\s+/g, ' ').slice(0, n).padEnd(n);

(async () => {
  console.log(`Pulling ${COUNT} RANDOM live stations from radio-browser…\n`);
  const stations = await apiGet(
    `/stations/search?hidebroken=true&order=random&limit=${COUNT}&has_extended_info=false`
  );
  const live = stations.filter((s) => (s.url_resolved || s.url) && s.lastcheckok !== 0).slice(0, COUNT);

  const rows = [];
  for (let i = 0; i < live.length; i++) {
    const st = live[i];
    process.stdout.write(`[${String(i + 1).padStart(2)}/${live.length}] ${st.name.slice(0, 38)} … `);
    const out = await probeStation(st);
    rows.push(out);
    if (out.result) {
      const { artist, title, rung, browserOk } = out.result;
      console.log(`${rung}${browserOk ? '' : ' (SERVER-ONLY)'} → ${artist ? artist + ' — ' : ''}${title}`);
    } else {
      console.log(`no metadata (${out.tried.length} endpoints tried)`);
    }
  }

  /* ---- the table you actually read ---- */
  console.log('\n' + '='.repeat(150));
  console.log(pad('STATION', 30) + pad('COUNTRY', 8) + pad('SOURCE', 12) + pad('WHERE THE SONG LIVED', 34) + pad('ARTIST', 26) + pad('SONG', 30) + 'CORS');
  console.log('='.repeat(150));
  for (const r of rows) {
    const x = r.result;
    console.log(
      pad(r.st.name, 30) + pad(r.st.countrycode, 8) +
      pad(x ? x.rung : '—', 12) + pad(x ? x.path : '—', 34) +
      pad(x ? (x.artist || '(none given)') : '—', 26) +
      pad(x ? x.title : '—', 30) +
      (x ? (x.browserOk ? 'BROWSER-OK' : 'server-only') : '—')
    );
  }

  const got = rows.filter((r) => r.result);
  const browser = got.filter((r) => r.result.browserOk);
  console.log('='.repeat(150));
  console.log(`\n${got.length}/${rows.length} stations gave up a song.`);
  console.log(`${browser.length}/${rows.length} did so from a page with NO server (CORS present).`);

  const byRung = {};
  got.forEach((r) => {
    const k = r.result.rung + (r.result.browserOk ? '' : ' [server-only]');
    byRung[k] = (byRung[k] || 0) + 1;
  });
  console.log('\nWhich rung won, and how often:');
  Object.entries(byRung).sort((a, b) => b[1] - a[1])
    .forEach(([k, v]) => console.log(`  ${pad(k, 28)} ${v}`));

  console.log('\nWhere the song lived (the shapes to hard-code):');
  const paths = {};
  got.forEach((r) => { paths[r.result.path] = (paths[r.result.path] || 0) + 1; });
  Object.entries(paths).sort((a, b) => b[1] - a[1])
    .forEach(([k, v]) => console.log(`  ${pad(k, 40)} ${v}`));

  if (OUTJSON) {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(OUTJSON, JSON.stringify(rows.map((r) => ({
      station: r.st.name, countrycode: r.st.countrycode, stream: r.stream,
      result: r.result, tried: r.tried,
    })), null, 2));
    console.log(`\nFull detail (including every endpoint tried and why it failed) → ${OUTJSON}`);
  }
})().catch((e) => { console.error('\n' + e.message); process.exit(1); });
