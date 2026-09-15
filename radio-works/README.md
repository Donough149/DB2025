# Radio Works — why the song and artist stopped appearing

## The bug

Every now-playing read in the page funnels through one line:

```js
const r = await fetch('/np?u=' + enc(streamOf(st)), opt);   // fetchNowPlaying
```

`/np` is a **relative path to a local server that no longer exists**. It was
served by Airtime.py under Pythonista. The build's own comments record the
removal — *"There is no server in this build - it is a self-contained page"* —
but the metadata reads were never repointed.

So the fetch throws or 404s, `npSource` becomes `'none'`, and `renderNP()`
prints *"this station sends no song info"* for every station on earth.

It is **not** the stations and **not** the parser. `parseTrack()` is good; it
is simply never handed a string.

Three sibling endpoints died the same death:

| endpoint   | what it did                                    | visible symptom |
|------------|------------------------------------------------|-----------------|
| `/np`      | read ICY metadata off the stream               | no song, no artist |
| `/art`     | scraped the station homepage for a logo        | generated monogram covers only |
| `/img`     | CORS proxy so the ambient sampler could read a logo | washed-out default colours |
| `/pagelog` | device telemetry                               | silent (debug only) |

The one metadata path that still works is `abcNowPlaying()` — and it works
precisely because it calls a public, CORS-open JSON API directly. That is the
template for the fix.

## The two constraints that decide the design

1. **CORS is the gate.** A browser can only read an endpoint that sends
   `Access-Control-Allow-Origin`. From Node almost everything looks reachable,
   so a naive test will have you implement ten sources and ship one that works.
2. **Mixed content.** The page is https, so `http://` endpoints are blocked
   outright. Upgrade, then skip.

## `probe.mjs` — the measurement

Pulls N **random** live stations from radio-browser (`order=random`) and tries
every known now-playing endpoint against each, reporting per station:

- which platform answered
- **which JSON key the song was hiding in** — different on every platform,
  which is the whole reason to measure rather than guess
- the parsed artist and song
- `BROWSER-OK` vs `server-only`, from the actual CORS header

```bash
node probe.mjs --count 20 --json sweep.json
```

It ends with two summaries: which rung won how often, and which JSON paths
turned up — i.e. exactly which shapes are worth hard-coding.

A generic shape-walker runs after the hand-written parsers, so a platform
nobody has heard of still resolves, and the report names the path it found it
at. That is the feedback loop: the probe discovers shapes, they graduate into
the ladder.

## `nowplaying.js` — the fix

Drop-in replacement keeping the original contract, so `parseTrack()` and every
caller stay untouched:

```js
const { raw, art } = await fetchNowPlaying(station, warm);
```

Rungs, most specific first: ABC · AzuraCast · Radio.co · RadioKing · laut.fm ·
RadioJar · Triton/StreamTheWorld · Icecast `status-json.xsl` · Shoutcast v2 ·
generic shape-walk.

Two things keep it cheap: `claim()` means a station only fires the requests
that could plausibly answer it, and the winning rung is memoised per
`stationuuid`, so the 18-second poll afterwards costs exactly one request.

Icecast's `status-json.xsl` is tried against *everything* — 2.4+ serves it with
`Access-Control-Allow-Origin: *` by default, which makes it the single highest-
yield rung for self-hosted stations.

### Wiring it in

Replace the body of `fetchNowPlaying` in the page with this module's version.
Everything downstream — `pollTrack`, `warmTrackFor`, `parseTrack`, `showTrack`
— is unchanged.

## Status

`probe.mjs` has not been run against the live directory yet: the container it
was written in denies outbound egress to `api.radio-browser.info`, so the
20-station sweep must be run somewhere with normal network access. The script
is syntax-clean and fails cleanly at exactly that point.
