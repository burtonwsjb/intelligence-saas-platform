# Local Whisper helper

Transcribes podcast episodes for Sentiment on the owner's own computer, at night.

Sentiment reads the podcast feeds registered on **Admin → Sources → Podcasts** and
queues each episode from the last year. Every night at 03:00 Arizona time this
helper claims episodes one at a time, downloads the audio file the podcast
publishes in its feed, transcribes it with faster-whisper (large-v3-turbo on the
GPU), sends the timestamped text to Sentiment and deletes the audio. It stops
taking work so it is done by 07:00, and hands back anything it could not finish.

Before the episodes, it lists the newest videos of the TikTok creators followed
on **Admin → Sources → TikTok creators**, using the free yt-dlp tool in
metadata-only mode (`--skip-download`: captions, ids and dates, never the
videos). Sentiment keeps the videos whose caption is about cards and gets their
transcripts from the transcript service. Listing costs nothing; each creator is
listed at most every 12 hours, the first time back a year.

Only podcast audio is downloaded. YouTube audio is never downloaded, because that
breaks YouTube's terms; YouTube videos need captions or a transcript service.

## What Sentiment keeps

The same as for YouTube transcripts: only the ~60-second windows that name a
catalog card, as short excerpts with their timestamps. The rest of the transcript
is discarded after card detection.

## Setup (Windows)

1. On Sentiment's API service, set `LOCAL_TRANSCRIBER_TOKEN` to a random string of
   32+ characters. The API's `/internal/local-transcripts/*` routes are off until
   it is set.
2. On the worker, `PROVIDER_WEB_FEED_MODE=live` (already used for influencer
   websites). Optional: `PODCAST_BACKFILL_DAYS` (default 365) and
   `PODCAST_FEED_REQUESTS_PER_DAY` (default 100).
3. Register podcast RSS feeds on Admin → Sources → Podcasts.
4. On the computer, in this folder:

   ```powershell
   powershell -ExecutionPolicy Bypass -File .\install-nightly-task.ps1
   ```

   For TikTok listing, install yt-dlp into the Transcriber venv once:

   ```powershell
   & "$env:USERPROFILE\Documents\Business\Transcriber\venv\Scripts\python.exe" -m pip install -U "yt-dlp[default,curl-cffi]"
   ```

   Keep it current (TikTok changes often) by running the same command now and then.
   If TikTok starts refusing anonymous listing, add
   `"ytdlp_args": ["--impersonate", "chrome", "--cookies-from-browser", "chrome"]`
   to `sentiment-whisper.json`; set `"tiktok_listing": false` to turn listing off.

   The installer asks for the API address and token once, saves them in
   `sentiment-whisper.json` (ignored by git), and schedules the nightly task.

Test one episode right away, outside the window:

```powershell
& "$env:USERPROFILE\Documents\Business\Transcriber\venv\Scripts\python.exe" .\sentiment_whisper.py --ignore-window --max-jobs 1
```

Progress is written to `sentiment-whisper.log` next to the script. Episode
counts per podcast (episodes, transcribed, waiting) show on Admin → Sources.

## Tests

```
python -m unittest test_sentiment_whisper
```

No GPU or faster-whisper needed; the end-to-end test uses a fake API on localhost.
