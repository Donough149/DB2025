/* Airtime / Radio Works — serverless now-playing resolver.
 *
 * Drop-in replacement for fetchNowPlaying(). The old one called '/np?u=…',
 * a Pythonista endpoint that no longer exists in the self-contained build,
 * so every station reported "sends no song info". Nothing else was wrong:
 * parseTrack() is fine, it was simply never handed a string.
 *
 * This asks the station's own platform instead, the same way abcNowPlaying()
 * already does. Same contract as before:
 *
 *     const { raw, art } = await fetchNowPlaying(station, warm);
 *
 * 'raw' is an ICY-shaped string, so parseTrack() downstream is unchanged.
 *
 * Two rules that decide the whole design:
 *   1. CORS is the gate. A page can only read endpoints that send
 *      Access-Control-Allow-Origin. Anything else is invisible, no matter how
 *      good its JSON is — so the ladder is ordered by what actually answers a
 *      browser, and every rung fails silently.
 *   2. Mixed content. The page is https, so http:// endpoints are blocked
 *      outright. We upgrade and, failing that, skip.
 *
 * Run probe.mjs to re-measure which rungs are pulling their weight.
 */
'use strict';

const NP_TIMEOUT = 4500;
const rungMemo = new Map();   // stationuuid -> name of the rung that won
const negMemo  = new Map();   // stationuuid -> timestamp of last total miss

async function getJSON(url, signal) {
  const r = await fetch(url, { signal, mode: 'cors', cache: 'no-store', credentials: 'omit' });
  if (!r.ok) throw new Error(String(r.status));
  return r.json();
}
async function getText(url, signal) {
  const r = await fetch(url, { signal, mode: 'cors', cache: 'no-store', credentials: 'omit' });
  if (!r.ok) throw new Error(String(r.status));
  return r.text();
}

/* --- pull a song out of an arbitrary shape, so a platform we have never seen
       still works. Prefers an explicit artist+title pair over a combined
       string, because splitting on " - " is a guess and a pair is not. --- */
const SONG_KEYS = /^(song_?title|songtitle|streamtitle|stream_title|now_?playing|nowplaying|currently_?playing|current_?song|current_?track|track_?title|title|song|track|text)$/i;
function deepSong(obj, depth = 0, seen = new Set()) {
  if (!obj || depth > 6 || (typeof obj === 'object' && seen.has(obj))) return null;
  if (typeof obj === 'object') seen.add(obj);
  if (Array.isArray(obj)) {
    for (let i = 0; i < Math.min(obj.length, 12); i++) {
      const h = deepSong(obj[i], depth + 1, seen); if (h) return h;
    }
    return null;
  }
  if (typeof obj !== 'object') return null;

  const ak = Object.keys(obj).find(k => /^artist(_?name)?$/i.test(k));
  const tk = Object.keys(obj).find(k => /^(title|song|track|name)$/i.test(k));
  if (ak && tk) {
    const a = typeof obj[ak] === 'string' ? obj[ak]
            : (obj[ak] && typeof obj[ak].name === 'string' ? obj[ak].name : '');
    const t = typeof obj[tk] === 'string' ? obj[tk] : '';
    if (t.trim()) return (a.trim() ? a.trim() + ' - ' : '') + t.trim();
  }
  for (const [k, v] of Object.entries(obj))
    if (typeof v === 'string' && v.trim() && SONG_KEYS.test(k)) return v.trim();
  for (const v of Object.values(obj))
    if (v && typeof v === 'object') { const h = deepSong(v, depth + 1, seen); if (h) return h; }
  return null;
}
const artOf = (o) => {
  if (!o || typeof o !== 'object') return null;
  for (const [k, v] of Object.entries(o)) {
    if (typeof v === 'string' && /^(art|artwork|artwork_url|artwork_url_large|cover|cover_url|image|albumart|album_art|thumb)$/i.test(k)
        && /^https?:\/\//.test(v)) return v.replace(/^http:/, 'https:');
    if (v && typeof v === 'object') { const h = artOf(v); if (h) return h; }
  }
  return null;
};

/* ================= ABC (unchanged — their streams carry no ICY at all) ==== */
const ABC_SLUGS = [['triple j unearthed','unearthed'],['unearthed','unearthed'],
  ['double j','doublej'],['doublej','doublej'],['triple j','triplej'],['triplej','triplej'],
  ['abc jazz','jazz'],['abc classic','classic'],['abc country','country'],
  ['abc dig','dig'],['dig music','dig']];
function abcSlug(st) {
  const n = ((st && st.name) || '').toLowerCase();
  if (!n || !/\b(abc|triple j|triplej|double j|doublej|unearthed|dig)\b/.test(n)) return null;
  if (/news|radio national|\brn\b|grandstand|sport|conversations|local|extra/.test(n)) return null;
  for (const [m, slug] of ABC_SLUGS) if (n.includes(m)) return slug;
  return null;
}

/* ================= THE LADDER =================
 * claim() keeps us from firing nine requests at every station. Each rung
 * returns an ICY-shaped string, or null. */
const RUNGS = [
  { name: 'abc',
    claim: (u, st) => !!abcSlug(st),
    run: async (u, st, sig) => {
      const j = await getJSON('https://music.abcradio.net.au/api/v1/plays/search.json?station='
        + encodeURIComponent(abcSlug(st)) + '&order=desc&limit=1', sig);
      const rec = j?.items?.[0]?.recording;
      if (!rec?.title) return null;
      const a = rec.artists?.[0]?.name || '';
      return { raw: a ? `${a} - ${rec.title}` : rec.title, art: rec.releases?.[0]?.artwork?.[0]?.sizes?.slice(-1)[0]?.url || null };
    } },

  { name: 'azuracast',
    claim: (u) => /\/(listen|radio)\//.test(u.pathname) || /azura/i.test(u.host),
    run: async (u, st, sig) => {
      const m = u.pathname.match(/\/listen\/([^/]+)\//) || u.pathname.match(/\/radio\/\d+\/([^/]+)/);
      const tries = m ? [`${u.origin}/api/nowplaying_static/${m[1]}.json`, `${u.origin}/api/nowplaying`]
                      : [`${u.origin}/api/nowplaying`];
      for (const t of tries) {
        try {
          const j = await getJSON(t, sig);
          const np = Array.isArray(j) ? j[0]?.now_playing : j?.now_playing;
          const s = np?.song;
          if (s?.title) return { raw: s.artist ? `${s.artist} - ${s.title}` : (s.text || s.title), art: s.art || null };
        } catch {}
      }
      return null;
    } },

  { name: 'radio.co',
    claim: (u) => /radio\.co$/.test(u.host),
    run: async (u, st, sig) => {
      const id = (u.pathname.match(/\/(s[0-9a-z]+)\b/i) || [])[1]; if (!id) return null;
      const j = await getJSON(`https://public.radio.co/stations/${id}/status`, sig);
      const t = j?.current_track?.title;
      return t ? { raw: t, art: j.current_track.artwork_url_large || j.current_track.artwork_url || null } : null;
    } },

  { name: 'radioking',
    claim: (u) => /radioking/i.test(u.host),
    run: async (u, st, sig) => {
      const slug = (u.pathname.match(/\/(?:play|radio)\/([^/]+)/) || [])[1]; if (!slug) return null;
      const j = await getJSON(`https://api.radioking.io/widget/radio/${slug}/track/current`, sig);
      return j?.title ? { raw: j.artist ? `${j.artist} - ${j.title}` : j.title, art: j.cover || null } : null;
    } },

  { name: 'laut.fm',
    claim: (u) => /laut\.fm$/.test(u.host),
    run: async (u, st, sig) => {
      const n = u.pathname.replace(/^\//, '').split('/')[0]; if (!n) return null;
      const j = await getJSON(`https://api.laut.fm/station/${n}/current_song`, sig);
      return j?.title ? { raw: (j.artist?.name ? j.artist.name + ' - ' : '') + j.title, art: null } : null;
    } },

  { name: 'radiojar',
    claim: (u) => /radiojar/i.test(u.host),
    run: async (u, st, sig) => {
      const id = u.pathname.replace(/^\//, '').split('/')[0]; if (!id) return null;
      const j = await getJSON(`https://www.radiojar.com/api/stations/${id}/now_playing/`, sig);
      return j?.title ? { raw: (j.artist ? j.artist + ' - ' : '') + j.title, art: j.thumb || null } : null;
    } },

  { name: 'triton',
    claim: (u) => /streamtheworld|tritondigital/i.test(u.host),
    run: async (u, st, sig) => {
      const m = u.pathname.match(/([A-Z0-9_]+(?:AAC|MP3|_SC)?)(?:\.(?:mp3|aac))?$/i); if (!m) return null;
      const x = await getText(`https://np.tritondigital.com/public/nowplaying?mountName=${m[1]}&numberToFetch=1&eventType=track`, sig);
      const a = x.match(/name="track_artist_name"\s+value="([^"]*)"/i);
      const t = x.match(/name="cue_title"\s+value="([^"]*)"/i);
      return t?.[1] ? { raw: (a?.[1] ? a[1] + ' - ' : '') + t[1], art: null } : null;
    } },

  /* The generic self-hosted pair. Icecast 2.4+ serves status-json.xsl with
     Access-Control-Allow-Origin: * by default, which is why it is worth
     trying on literally everything. */
  { name: 'icecast',
    claim: () => true,
    run: async (u, st, sig) => {
      const j = await getJSON(`${u.origin}/status-json.xsl`, sig);
      const src = j?.icestats?.source; if (!src) return null;
      const arr = Array.isArray(src) ? src : [src];
      const mine = arr.find(s => typeof s.listenurl === 'string' && s.listenurl.endsWith(u.pathname)) || arr[0];
      if (!mine) return null;
      const raw = ['title', 'yp_currently_playing', 'song'].map(k => mine[k]).find(v => typeof v === 'string' && v.trim());
      return raw ? { raw: raw.trim(), art: null } : null;
    } },

  { name: 'shoutcast2',
    claim: () => true,
    run: async (u, st, sig) => {
      for (const t of [`${u.origin}/stats?json=1&sid=1`, `${u.origin}/statistics?json=1`]) {
        try {
          const j = await getJSON(t, sig);
          const raw = j?.songtitle || deepSong(j);
          if (raw) return { raw: String(raw).trim(), art: null };
        } catch {}
      }
      return null;
    } },

  /* Last rung: whatever the host serves at a few conventional paths, read by
     shape rather than by name. This is how a platform we have never heard of
     still lights up — and how probe.mjs discovers new shapes to hard-code. */
  { name: 'generic',
    claim: () => true,
    run: async (u, st, sig) => {
      for (const t of [`${u.origin}/api/nowplaying`, `${u.origin}/nowplaying.json`,
                       `${u.origin}/currentsong?sid=1`, `${u.origin}/api/live-info`]) {
        try {
          const body = await getText(t, sig);
          const j = (() => { try { return JSON.parse(body); } catch { return null; } })();
          const raw = j ? deepSong(j) : (body.trim().length > 1 && body.length < 200 ? body.trim() : null);
          if (raw) return { raw: String(raw).trim(), art: j ? artOf(j) : null };
        } catch {}
      }
      return null;
    } },
];

/* ================= the call the app makes ================= */
async function fetchNowPlaying(st, warm) {
  const stream = (st && (st.url_resolved || st.url)) || '';
  if (!stream) return { raw: null, art: null };

  let u;
  try { u = new URL(stream.replace(/^http:/, 'https:')); }
  catch { return { raw: null, art: null }; }

  const ac = ('AbortController' in globalThis) ? new AbortController() : null;
  const timer = ac ? setTimeout(() => ac.abort(), NP_TIMEOUT) : null;
  const sig = ac ? ac.signal : undefined;

  const id = st.stationuuid;
  const won = rungMemo.get(id);
  // once a station has told us which rung answers, stop asking the other eight
  const order = won ? RUNGS.filter(r => r.name === won).concat(RUNGS.filter(r => r.name !== won))
                    : RUNGS;

  try {
    for (const rung of order) {
      let claims = false;
      try { claims = rung.claim(u, st); } catch {}
      if (!claims) continue;
      try {
        const hit = await rung.run(u, st, sig);
        if (hit && hit.raw) {
          rungMemo.set(id, rung.name);
          negMemo.delete(id);
          if (!warm) fetchNowPlaying.source = rung.name;
          return { raw: hit.raw, art: hit.art || null };
        }
      } catch { /* CORS, 404, timeout — all the same to us: try the next rung */ }
      if (sig && sig.aborted) break;
    }
  } finally { if (timer) clearTimeout(timer); }

  if (won) rungMemo.delete(id);      // it used to answer; let it re-hunt next time
  negMemo.set(id, Date.now());
  if (!warm) fetchNowPlaying.source = 'none';
  return { raw: null, art: null };
}

if (typeof module !== 'undefined' && module.exports) module.exports = { fetchNowPlaying, deepSong };
