# sc-backend

Express API behind [statscrave.com](https://statscrave.com): Spotify metadata, kworb.net streaming numbers, Wikipedia streaming records, user favourites and reviews, plus a daily cron that stores streaming history for the priority artists in MongoDB.

## Run

```bash
npm ci
npm run dev        # nodemon
npm start          # production (pm2 uses ecosystem.config.js)
npm test           # unit + integration tests (first run downloads an in-memory MongoDB binary)
npm run smoke -- https://api.statscrave.com   # hit every public route and report status/latency
npm run cron:run   # run the daily kworb sync once, now (optionally pass Spotify artist ids)
```

`GET /api/v1/health` reports Mongo/Redis state, the HTTP and browser pool queues, and the last cron run.

## How data is fetched

| Source | Routes | Mechanism |
|---|---|---|
| kworb.net (static HTML) | `/daily/*`, `/others/mostStreamed*`, `/others/mostMonthlyListeners`, `/youtube/mostViewedVideos`, the cron | plain HTTP GET + cheerio (`scrapers/kworb.js`) |
| Wikipedia streaming records (static HTML) | `/others/mostStreamedSongsInSingle*`, `/others/mostStreamedAlbumsInSingle` | plain HTTP GET + cheerio, tables located by section heading (`scrapers/wikipedia.js`) |
| Chartmetric (JS app, login wall) | `/artist/social/:id` | headless Chromium via `utilities/browser.js`; **disabled by default**, returns `null` |
| Spotify / Last.fm / QQ Music | everything else | REST with 8s timeouts |

Scrape results are cached in Redis (6h for artist pages, 12h for leaderboards and records). Empty results are cached for 5 minutes only. Upstream failures answer `503` and are never cached.

## Environment

Required: `MONGO_URI`, `REDIS_URL`, `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET`, `LAST_FM_API_KEY`, `CLERK_SECRET_KEY`.

Optional (defaults in parentheses):

| Variable | Purpose |
|---|---|
| `DATA_SOURCE` (`https://kworb.net/`) | kworb base URL |
| `HTTP_TIMEOUT_MS` (20000), `HTTP_RETRIES` (2), `HTTP_MAX_CONCURRENCY` (6), `HTTP_QUEUE_TIMEOUT_MS` (30000) | outbound HTML fetches |
| `REQUEST_TIMEOUT_MS` (100000) | hard cap on any API request; must stay below the nginx proxy timeout (120s) |
| `CRON_SCHEDULE` (`22 02 * * *`), `CRON_TIMEZONE` (`Asia/Kolkata`), `CRON_ARTIST_DELAY_MS` (10000), `CRON_ARTIST_ATTEMPTS` (3) | daily sync |
| `CHARTMETRIC_SCRAPE_ENABLED` (`false`) | re-enable the Chartmetric browser scrape (needs working selectors) |
| `BROWSER_MAX_CONCURRENCY` (3), `BROWSER_QUEUE_TIMEOUT_MS` (20000), `BROWSER_JOB_TIMEOUT_MS` (60000), `BROWSER_NAV_TIMEOUT_MS` (30000) | Chromium pool |
| `PRODUCTION=true` + `PUPPETEER_EXECUTABLE_PATH` | use a system Chrome instead of the puppeteer download |

## Daily keys

Per-day stream counts are stored as `DD-MM-YYYY` keys inside `dailyStreams` / `dailyTotalStreams` objects. The key is the "Last updated" date printed on the kworb page minus one day (kworb stamps pages with the data day), which matches the historical convention of the cron and stays correct no matter when a run happens.

## Test fixtures

`test/fixtures/*.html` are trimmed copies of the live pages. Refresh them with `npm run fixtures:refresh` when a source changes its layout, then run `npm test`.
