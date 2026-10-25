"""Nightly podcast transcription for Sentiment, on the owner's own computer.

Claims podcast episodes from Sentiment's local transcription queue, downloads
each episode's audio from the podcast's own feed enclosure (the file the
podcast publishes for download), transcribes it with faster-whisper on the
GPU, sends back the timestamped text, and deletes the audio.

It only runs inside the nightly window (default 03:00-07:00 Arizona time) so
it never uses bandwidth or slows the computer during the day. A job that
cannot finish before the window closes is handed back and picked up the next
night. YouTube audio is never downloaded: the queue only holds podcast
episodes.

Before the episodes, it also lists the newest videos of the TikTok creators
followed on Admin -> Sources, with the free yt-dlp tool in metadata-only mode
(--skip-download: captions, ids and dates, never the videos), and sends them to
Sentiment, which keeps the card videos. No paid service is used.

Run with the Transcriber app's Python, which already has faster-whisper and
CUDA:

    "C:\\Users\\Brian\\Documents\\Business\\Transcriber\\venv\\Scripts\\python.exe" sentiment_whisper.py

Settings come from sentiment-whisper.json next to this file (see
sentiment-whisper.example.json). The token is never logged.
"""

from __future__ import annotations

import argparse
import json
import os
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
# Arizona does not observe daylight saving time: always UTC-7.
ARIZONA = timezone(timedelta(hours=-7), "MST")
USER_AGENT = "SentimentBot/1.0 podcast transcription (downloads published episode files for card-market research)"
MAX_AUDIO_BYTES = 1_500_000_000
DOWNLOAD_TIMEOUT_S = 60
API_TIMEOUT_S = 120
# Rough speed of large-v3-turbo on an RTX 3090: about 40x real time. Used only
# to avoid starting an episode that cannot finish before the window closes.
REALTIME_FACTOR = 40
SAFETY_MARGIN = timedelta(minutes=5)


@dataclass
class Settings:
    api_url: str
    token: str
    model: str = "large-v3-turbo"
    language: str = "en"
    window_start: str = "03:00"
    window_end: str = "07:00"
    worker: str = socket.gethostname()[:60]
    tiktok_listing: bool = True
    # Extra yt-dlp options, e.g. ["--cookies-from-browser", "chrome"] if TikTok starts refusing anonymous listing.
    ytdlp_args: tuple = ("--impersonate", "chrome")


def load_settings(path: Path) -> Settings:
    data = json.loads(path.read_text(encoding="utf-8"))
    api_url = str(data.get("api_url", "")).rstrip("/")
    token = str(data.get("token", ""))
    if not api_url.startswith("https://") and not api_url.startswith("http://localhost"):
        raise SystemExit("api_url must be the https address of Sentiment's API.")
    if len(token) < 32:
        raise SystemExit("token must be the LOCAL_TRANSCRIBER_TOKEN set on Sentiment's API (32+ characters).")
    known = {k: data[k] for k in ("model", "language", "window_start", "window_end", "worker") if k in data}
    if "tiktok_listing" in data:
        known["tiktok_listing"] = bool(data["tiktok_listing"])
    if "ytdlp_args" in data:
        if not isinstance(data["ytdlp_args"], list) or not all(isinstance(a, str) for a in data["ytdlp_args"]):
            raise SystemExit("ytdlp_args must be a list of strings.")
        known["ytdlp_args"] = tuple(data["ytdlp_args"])
    return Settings(api_url=api_url, token=token, **known)


def parse_clock(value: str) -> tuple[int, int]:
    hours, minutes = value.split(":")
    h, m = int(hours), int(minutes)
    if not (0 <= h < 24 and 0 <= m < 60):
        raise ValueError(f"bad time {value!r}")
    return h, m


def window_deadline(now: datetime, start: str, end: str) -> datetime | None:
    """When the window that `now` falls in closes, or None when `now` is outside it.

    The window is in Arizona time and may wrap past midnight (e.g. 23:00-05:00).
    """
    local = now.astimezone(ARIZONA)
    sh, sm = parse_clock(start)
    eh, em = parse_clock(end)
    start_today = local.replace(hour=sh, minute=sm, second=0, microsecond=0)
    end_today = local.replace(hour=eh, minute=em, second=0, microsecond=0)
    if start_today < end_today:
        return end_today if start_today <= local < end_today else None
    # Wraps midnight.
    if local >= start_today:
        return end_today + timedelta(days=1)
    if local < end_today:
        return end_today
    return None


def to_cues(segments) -> list[dict]:
    """faster-whisper segments as the cue list Sentiment accepts."""
    cues = []
    for segment in segments:
        text = (segment.text or "").strip()
        if text:
            cues.append({"text": text, "start": round(float(segment.start), 2), "end": round(float(segment.end), 2)})
    return cues


def estimated_minutes(duration_seconds: float | None) -> float:
    if not duration_seconds:
        return 10.0
    return duration_seconds / REALTIME_FACTOR / 60 + 2  # plus download and model warm-up


class Api:
    def __init__(self, settings: Settings):
        self.settings = settings

    def post(self, path: str, body: dict) -> tuple[int, dict]:
        request = urllib.request.Request(
            self.settings.api_url + path,
            data=json.dumps(body).encode("utf-8"),
            method="POST",
            headers={
                "authorization": f"Bearer {self.settings.token}",
                "content-type": "application/json",
                "user-agent": USER_AGENT,
            },
        )
        try:
            with urllib.request.urlopen(request, timeout=API_TIMEOUT_S) as response:
                return response.status, json.loads(response.read() or b"{}")
        except urllib.error.HTTPError as error:
            try:
                return error.code, json.loads(error.read() or b"{}")
            except ValueError:
                return error.code, {}

    def claim(self) -> dict | None:
        status, body = self.post("/internal/local-transcripts/claim", {"limit": 1, "worker": self.settings.worker})
        if status != 200:
            raise RuntimeError(f"claim failed: HTTP {status}")
        jobs = body.get("jobs") or []
        return jobs[0] if jobs else None

    def submit(self, content_id: str, body: dict) -> tuple[int, dict]:
        return self.post(f"/internal/local-transcripts/{urllib.parse.quote(content_id)}", body)

    def claim_tiktok(self) -> list[dict]:
        status, body = self.post("/internal/local-transcripts/tiktok/claim", {"limit": 10, "worker": self.settings.worker})
        if status == 404:
            return []  # an older Sentiment without TikTok listing
        if status != 200:
            raise RuntimeError(f"TikTok claim failed: HTTP {status}")
        return body.get("profiles") or []

    def submit_tiktok(self, source_account_id: str, body: dict) -> tuple[int, dict]:
        return self.post(f"/internal/local-transcripts/tiktok/{urllib.parse.quote(source_account_id)}", body)


TIKTOK_LIST_TIMEOUT_S = 600


def ytdlp_list_command(settings: Settings, profile_url: str, max_videos: int) -> list[str]:
    """yt-dlp in metadata-only mode: prints one JSON line per video, downloads nothing."""
    return [
        sys.executable, "-m", "yt_dlp",
        "--skip-download", "--dump-json", "--ignore-errors", "--no-warnings", "--no-progress",
        "--playlist-end", str(max(1, min(int(max_videos), 1000))),
        *settings.ytdlp_args,
        profile_url,
    ]


def parse_ytdlp_listing(stdout: str) -> list[dict]:
    """The videos in yt-dlp's --dump-json output, as Sentiment's listing format."""
    videos = []
    for line in stdout.splitlines():
        line = line.strip()
        if not line.startswith("{"):
            continue
        try:
            item = json.loads(line)
        except ValueError:
            continue
        video_id = str(item.get("id") or "")
        if not video_id.isdigit():
            continue
        videos.append({
            "id": video_id,
            "caption": str(item.get("description") or item.get("title") or "")[:2200],
            "timestamp": item.get("timestamp"),
            "duration": item.get("duration"),
        })
    return videos


def list_tiktok_profiles(api: "Api", settings: Settings, deadline: datetime, runner=subprocess.run) -> int:
    """Lists every claimed TikTok profile and sends the videos to Sentiment. Returns profiles listed."""
    listed = 0
    while True:
        remaining = (deadline - datetime.now(timezone.utc) - SAFETY_MARGIN).total_seconds()
        if remaining <= 60:
            return listed
        profiles = api.claim_tiktok()
        if not profiles:
            return listed
        for profile in profiles:
            remaining = (deadline - datetime.now(timezone.utc) - SAFETY_MARGIN).total_seconds()
            account = profile["source_account_id"]
            handle = profile.get("handle") or account
            command = ytdlp_list_command(settings, profile["profile_url"], profile.get("max_videos", 60))
            started = time.monotonic()
            try:
                done = runner(command, capture_output=True, text=True, encoding="utf-8", errors="replace",
                              timeout=min(TIKTOK_LIST_TIMEOUT_S, max(60, remaining)))
            except FileNotFoundError:
                api.submit_tiktok(account, {"status": "error", "reason": "ytdlp_missing", "tool": "yt-dlp"})
                log("yt-dlp is not installed in this Python; TikTok listing skipped (pip install \"yt-dlp[default,curl-cffi]\")")
                return listed
            except subprocess.TimeoutExpired:
                api.submit_tiktok(account, {"status": "error", "reason": "ytdlp_timeout", "tool": "yt-dlp"})
                log(f"TikTok @{handle}: listing timed out")
                continue
            videos = parse_ytdlp_listing(done.stdout or "")
            if not videos and done.returncode != 0:
                if "No module named yt_dlp" in (done.stderr or ""):
                    api.submit_tiktok(account, {"status": "error", "reason": "ytdlp_missing", "tool": "yt-dlp"})
                    log("yt-dlp is not installed in this Python; TikTok listing skipped (pip install \"yt-dlp[default,curl-cffi]\")")
                    return listed
                api.submit_tiktok(account, {"status": "error", "reason": f"ytdlp_exit_{done.returncode}", "tool": "yt-dlp"})
                log(f"TikTok @{handle}: yt-dlp failed (exit {done.returncode})")
                continue
            status, body = api.submit_tiktok(account, {"status": "ok", "videos": videos, "tool": "yt-dlp"})
            listed += 1
            log(
                f"TikTok @{handle}: {len(videos)} videos read in {time.monotonic() - started:.0f}s; "
                f"Sentiment kept {body.get('kept', '?')}, skipped {body.get('skipped', '?')} (HTTP {status})"
            )


class DownloadGone(Exception):
    pass


def download(url: str, folder: Path) -> Path:
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme not in ("http", "https"):
        raise DownloadGone("not_http")
    suffix = Path(parsed.path).suffix[:6] or ".audio"
    request = urllib.request.Request(url, headers={"user-agent": USER_AGENT})
    target = folder / f"episode{suffix}"
    try:
        with urllib.request.urlopen(request, timeout=DOWNLOAD_TIMEOUT_S) as response, open(target, "wb") as out:
            size = 0
            while True:
                chunk = response.read(1 << 20)
                if not chunk:
                    break
                size += len(chunk)
                if size > MAX_AUDIO_BYTES:
                    raise DownloadGone("too_large")
                out.write(chunk)
    except urllib.error.HTTPError as error:
        if error.code in (401, 403, 404, 410):
            raise DownloadGone(f"http_{error.code}") from error
        raise
    return target


class Transcriber:
    def __init__(self, settings: Settings):
        self.settings = settings
        self.model = None

    def load(self):
        if self.model is None:
            from faster_whisper import WhisperModel  # the Transcriber venv has it

            try:
                self.model = WhisperModel(self.settings.model, device="cuda", compute_type="float16")
            except Exception:  # no usable GPU: slower, still correct
                log("GPU not available, falling back to CPU int8")
                self.model = WhisperModel(self.settings.model, device="cpu", compute_type="int8")
        return self.model

    def transcribe(self, path: Path, deadline: datetime) -> list[dict] | None:
        """Cues, or None when the window closed before the episode finished."""
        segments, _info = self.load().transcribe(
            str(path), language=self.settings.language, beam_size=5, vad_filter=True
        )
        collected = []
        for segment in segments:
            collected.append(segment)
            if datetime.now(timezone.utc) >= deadline:
                return None
        return to_cues(collected)


LOG_PATH = HERE / "sentiment-whisper.log"


def log(message: str) -> None:
    line = f"{datetime.now(ARIZONA):%Y-%m-%d %H:%M:%S} {message}"
    print(line, flush=True)
    try:
        if LOG_PATH.exists() and LOG_PATH.stat().st_size > 5_000_000:
            LOG_PATH.replace(LOG_PATH.with_suffix(".old.log"))
        with open(LOG_PATH, "a", encoding="utf-8") as handle:
            handle.write(line + "\n")
    except OSError:
        pass


def lower_priority() -> None:
    """Below-normal priority, so anything else on the computer comes first."""
    if sys.platform == "win32":
        import ctypes

        BELOW_NORMAL_PRIORITY_CLASS = 0x4000
        ctypes.windll.kernel32.SetPriorityClass(ctypes.windll.kernel32.GetCurrentProcess(), BELOW_NORMAL_PRIORITY_CLASS)
    else:
        try:
            os.nice(10)
        except OSError:
            pass


def run(settings: Settings, ignore_window: bool = False, max_jobs: int = 1000) -> int:
    now = datetime.now(timezone.utc)
    deadline = window_deadline(now, settings.window_start, settings.window_end)
    if deadline is None:
        if not ignore_window:
            log(f"outside the {settings.window_start}-{settings.window_end} Arizona window; nothing to do")
            return 0
        deadline = now + timedelta(hours=4)
    lower_priority()
    api = Api(settings)
    transcriber = Transcriber(settings)
    done = 0
    log(f"started; window closes {deadline.astimezone(ARIZONA):%H:%M} Arizona time")
    if settings.tiktok_listing:
        try:
            list_tiktok_profiles(api, settings, deadline)
        except Exception as error:  # listing trouble never blocks the podcast episodes
            log(f"TikTok listing stopped: {type(error).__name__}: {error}")
    while done < max_jobs:
        remaining = deadline - datetime.now(timezone.utc) - SAFETY_MARGIN
        if remaining <= timedelta(0):
            break
        job = api.claim()
        if job is None:
            log("queue is empty")
            break
        content_id = job["content_id"]
        label = f"{job.get('podcast') or '?'} / {job.get('title') or content_id}"
        if timedelta(minutes=estimated_minutes(job.get("duration_seconds"))) > remaining:
            api.submit(content_id, {"status": "release"})
            log(f"not enough time left for {label}; handed back for tomorrow")
            break
        started = time.monotonic()
        with tempfile.TemporaryDirectory(prefix="sentiment-whisper-") as folder:
            try:
                audio = download(job["audio_url"], Path(folder))
            except DownloadGone as gone:
                api.submit(content_id, {"status": "unavailable", "reason": str(gone)})
                log(f"audio unavailable ({gone}) for {label}")
                continue
            except Exception as error:  # network trouble: retried another night
                api.submit(content_id, {"status": "error", "reason": f"download_{type(error).__name__}"})
                log(f"download failed ({type(error).__name__}) for {label}")
                continue
            try:
                cues = transcriber.transcribe(audio, deadline)
            except Exception as error:
                api.submit(content_id, {"status": "error", "reason": f"whisper_{type(error).__name__}"})
                log(f"transcription failed ({type(error).__name__}) for {label}")
                continue
        # The temporary folder, and the audio in it, is deleted here.
        if cues is None:
            api.submit(content_id, {"status": "release"})
            log(f"window closed during {label}; handed back for tomorrow")
            break
        status, body = api.submit(
            content_id, {"status": "ok", "lang": settings.language, "model": settings.model, "cues": cues}
        )
        minutes = (time.monotonic() - started) / 60
        if status == 200:
            done += 1
            log(
                f"done {label}: {len(cues)} cues, {body.get('mentions', 0)} card mentions, "
                f"{body.get('calls_created', 0)} calls, {minutes:.1f} min"
            )
        else:
            log(f"Sentiment refused the transcript for {label}: HTTP {status}")
    log(f"finished; {done} episodes transcribed")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--config", type=Path, default=HERE / "sentiment-whisper.json")
    parser.add_argument("--ignore-window", action="store_true", help="run now even outside the nightly window (testing)")
    parser.add_argument("--max-jobs", type=int, default=1000)
    args = parser.parse_args(argv)
    settings = load_settings(args.config)
    try:
        return run(settings, ignore_window=args.ignore_window, max_jobs=args.max_jobs)
    except Exception as error:
        log(f"stopped: {type(error).__name__}: {error}")
        return 1


if __name__ == "__main__":
    sys.exit(main())
