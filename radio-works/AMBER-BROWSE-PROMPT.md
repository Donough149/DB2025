You are running ON MY MAC with full control of it. Do everything yourself; never wait for me. After each step:
  osascript -e 'display notification "<what you just did>" with title "Amber"'

App: "Amber 2.0" (Pythonista, launched by the "Amber 2.0" shortcut). Files in
  ~/Library/Mobile Documents/iCloud~com~omz-software~Pythonista3/Documents  (main: amber_engine.py)
Back up every file you touch (timestamped copy) first. Station data comes from the radio-browser API (~70,000 stations).
Reference web build (older, for logic only): github.com/Donough149/DB2025 branch claude/radio-works-shortcut-wfaed6, radio-works/RadioWorks-FIXED.html

## Task 1 — Browse: rebuild it so it is beautiful and intuitive
Right now it works but the layout is ugly and getting out of things / going back feels clumsy.
- One clean screen: a search field at the top (searches station name, tags, country and language as you type, debounced, against radio-browser), then rows of discovery shelves you scroll through.
- Navigation: drilling into a genre/shelf pushes a page with a clear back control and swipe-back; filters are removable chips (tap the x), never modal dead ends. No "clear everything and start again" steps.
- Genres: show many more, but no junk or duplicates. Build the list from radio-browser /json/tags, merge synonyms (e.g. "hip hop"/"hiphop"/"hip-hop", "electronic"/"electronica"), drop non-genres (country names, station names, "radio", "fm", "music", "news" duplicates, years), and keep tags with real station counts. Aim for ~40–60 genuinely distinct genres, grouped (Electronic, Rock, Jazz/Soul, World, Talk, etc.).
- Keep the good shelves: Gems, Trending, Random, Most loved.

## Task 2 — Gems / Trending / Random / Loved must actually refresh
Bug: e.g. Browse → Pop → Gems always shows the same "chocolate" station first, every hour of every day. Find the cause (likely a cached/persisted result or a deterministic sort with no rotation) and fix it.
- Never persist these lists across sessions; re-fetch on open and on pull-to-refresh.
- Score, don't just sort: e.g. gem = good votes per click, working stream (lastcheckok=1), bitrate >= 96, has favicon. Then sample from the top few hundred with weighted randomness, seeded by the current hour, so the list rotates every visit and each hour but stays high quality.
- Don't show stations the user has seen in the last N sessions at the top (keep a small seen-list).

## Task 3 — Fable: replace the current shelves with real discovery algorithms
Fable's job is to surface great, surprising, enjoyable stations out of 70,000 through interesting blends and combinations. I don't like the current titles (e.g. "house for right now" feels dumb). Keep only the good ideas ("unexpected origins", "never been", maybe "wild"). Build several algorithms that pull from the API in new ways and refresh every visit, for example:
- Unexpected origins: a genre from a country not known for it (jazz from Mongolia, reggae from Finland).
- Blends: two of the user's played/loved tags combined (station tagged both).
- Neighbours of loved: stations sharing 2+ tags with the user's loved stations, in a different country/language.
- Rising: high recent click trend relative to total votes.
- Never been: countries/languages the user has never played, best-rated station from each.
- Time-aware: shelf that fits local time of day (but with a better name and real logic, not a fixed title).
Give each shelf a short generated title that describes the actual blend ("Finnish reggae", "Lagos jazz and soul"), not fixed marketing copy. Every station must pass the playable/quality filter.

## Task 4 — Lock screen, AirPlay, CarPlay (do after 1–3 work)
- Lock screen / Control Center: via objc_util set MPNowPlayingInfoCenter (title, artist, station, album art as MPMediaItemArtwork) and wire MPRemoteCommandCenter play/pause/next/previous to Amber's queue (next/previous = next/previous station, using the existing instant spare-player promote).
- AirPlay (HomePod/Sonos with AirPlay 2): use the audio session category Playback, allow external playback on the AVPlayer, and add an AVRoutePickerView button so output can go to any AirPlay speaker, like Safari video does. Confirm it shows up in the Control Center route picker.
- CarPlay: Pythonista can't get CarPlay's own app entitlement, but CarPlay's Now Playing screen will show the art and the next/previous/play controls if the Remote Command Center is wired up. Verify that and report honestly.
- Rewind/fast-forward: live streams can't seek by default. If it's feasible, keep a rolling buffer (~10 min) of the current stream and enable skip-back/skip-forward commands within it. If not, say why.

## Test
py_compile everything. Test on my iPhone through iPhone Mirroring (screencapture -x and Read the screenshots): search, genre drill-in and back, Gems rotating between two visits, Fable shelves with sensible titles and playable stations, lock screen art and controls, AirPlay picker. Fix anything that fails.
Copy the final files to the repo at radio-works/amber/ and push to claude/radio-works-shortcut-wfaed6.
Finish in at most 10 lines: what changed, what was tested, what doesn't work and why.
