You are running ON MY MAC with full control of it: Terminal, apps, mouse, keyboard, and iPhone Mirroring. Do everything yourself. Never ask me anything and never wait for me. After every step, pop a macOS notification so I can see you're moving:
  osascript -e 'display notification "<what you just did>" with title "Amber fix"'

## The goal
My radio app "Amber 2.0" must work perfectly on my iPhone, snappy and reliable, including away from home with this Mac switched off. Amber is a Pythonista app launched by the "Amber 2.0" shortcut. Its files are in iCloud:
  ~/Library/Mobile Documents/iCloud~com~omz-software~Pythonista3/Documents
(main engine: amber_engine.py; search ~ for "amber" to find every related file and copy.)

## What's wrong right now (on the phone)
- Tapping a station does nothing, and nothing plays.
- Amber keeps quitting.
- The layout doesn't fit the screen.
- The song, artist and album-art matching I used to have is gone, and so is the fast queuing.
- An earlier Claude session edited amber_engine.py and was cut off partway through (usage limit), so the file may be half-edited. It was told to make .bak backups first.

## How it USED to work (this is the standard to meet or beat)
The reference is my "Radio Works" web app. Its full working source is in this repo:
  git clone https://github.com/Donough149/DB2025 && cd DB2025 && git checkout claude/radio-works-shortcut-wfaed6
  radio-works/RadioWorks-FIXED.html   <- full working app (read this properly)
  radio-works/fix-block.js            <- now-playing ladder
  radio-works/RESULTS.md              <- live 50-station test results
What it did well:

1. SONG + ARTIST MATCHING: it asks each station's own platform for what's playing, trying these in order and remembering per station which one worked:
   ABC (music.abcradio.net.au plays API), AzuraCast (/api/nowplaying_static/<shortcode>.json, /api/nowplaying), Radio.co (public.radio.co/stations/<id>/status), RadioKing (api.radioking.io/widget/radio/<slug>/track/current), laut.fm (api.laut.fm/station/<name>/current_song), RadioJar, Triton (np.tritondigital.com nowplaying XML; values are in CDATA inside <property name="cue_title"> / "track_artist_name"), Icecast (<origin>/status-json.xsl -> icestats.source[].title, matched on listenurl), Shoutcast v2 (/stats?json=1&sid=1 songtitle, /statistics?json=1), Shoutcast v1 (/7.html field 7), then a generic JSON "shape walker" that finds an artist+title pair or a song-ish key in any JSON.
   parseTrack(): splits "Artist - Title", "Title by Artist", "~" and "*" and "|" delimited feeds, XML ARTIST/TITLE, drops trailing "| STATION" and URLs, rejects filenames and frequency idents.
   validTrack(): rejects station idents (the station's own name in the title or artist slot, "ANTENA 1 - ANTENA 1"), URLs, lone dashes. Careful: non-Latin text must not be thrown away.
   JUNK filter: rejects placeholders like "Now Playing info goes here", "no track info", "stream offline", "unknown", "n/a".
   CJK: normalise full-width dashes (U+FF0D) and ideographic spaces so Japanese, Chinese and Korean feeds split into artist and title. Only split an unspaced hyphen when the text contains CJK, so "Jean-Michel Jarre" stays intact.
   In Python there are no CORS limits, so use the stream's own http/https scheme and hit any endpoint.

2. ALBUM ART:
   - The platform's own cover wins (AzuraCast art, Radio.co artwork_url_large, Triton track_album_art, ABC release artwork).
   - Otherwise iTunes Search: https://itunes.apple.com/search?limit=1&entity=song&term=<artist title>, with artworkUrl100 upsized to 600x600bb. It also corrects the artist and title spelling from the iTunes result.
   - Station logo fallback: the station favicon, then a same-name "twin" station's favicon, then a generated two-tone monogram cover. Never an empty ring.

3. FAST, SNAPPY QUEUING (keep this):
   - Two players. The next station in the queue buffers silently (muted) on a SPARE player, and Next PROMOTES the spare instantly instead of starting a fresh load.
   - The next station's artwork and track are pre-warmed so they show immediately on skip.
   - Only one generation of metadata requests at a time. Changing station cancels the old station's reads, otherwise they pile up and everything times out after 2-3 skips.
   - Track polling every ~18s, plus quick retries (4s, 8s, 12s) for a quiet station at first. Polling re-arms when the app returns to foreground, and a watchdog restarts it if nothing has arrived for 45s.
   - A dead stream: try a same-name mirror with the best bitrate. Never jump to a different station on failure.
   - Resume last station on open (saveLast / resumeLast).

## Do this
1. Back up every current Amber file (copy with a timestamp suffix) before touching anything.
2. Find the LAST WORKING version of Amber: .bak files, iCloud version history, other copies anywhere in ~, and copies left by earlier Claude sessions (for example ~/Desktop, /tmp, git repos). Restore it as the base.
3. Make sure Amber has NO dependency on this Mac or my home network (no calls to the Mac's IP, localhost on the Mac, and so on). Everything must run on the phone.
4. Bring Amber up to the standard above: the matching, art and snappy queuing described in "How it USED to work". Port anything it lacks from the reference. Keep changes clean and don't break Amber's UI.
5. Fix the three live bugs: station tap does nothing, app quits, layout doesn't fit. Find the real causes.
6. Add: Amber reopens on the last-played station and starts playing it. Save the station (name, stream URL, ids) to a small JSON file on each play. Handle a missing or corrupt file.
7. python3 -m py_compile every file.
8. TEST ON MY IPHONE through iPhone Mirroring (open -a "iPhone Mirroring"; if it shows "iPhone in Use", wait 30s and retry, up to ~10 minutes). Take your own screenshots (screencapture -x) and Read them to see the phone. Click by coordinates inside the Mirroring window. Kill Pythonista from the app switcher, launch Amber 2.0, and check:
   - it opens on the last station and plays,
   - tapping stations plays them,
   - Next is near-instant,
   - song, artist and album art appear and are correct,
   - the layout fits,
   - it doesn't quit.
   Try at least 8 stations of different types and countries. Fix anything that fails and test again.
9. Copy the final Amber files into the repo at radio-works/amber/ and push to branch claude/radio-works-shortcut-wfaed6 (if the push fails, say so).
10. Finish with at most 8 lines: what was wrong, what you changed, and for each station tested: station / song / artist / art yes-no / played yes-no.
