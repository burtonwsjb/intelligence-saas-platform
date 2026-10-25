"""Run with: python -m unittest test_sentiment_whisper (no GPU or faster-whisper needed)."""

import json
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace

import sentiment_whisper as sw


def az(hour, minute=0):
    # 07:00 UTC-7 == 14:00 UTC
    return datetime(2026, 10, 26, hour, minute, tzinfo=sw.ARIZONA).astimezone(timezone.utc)


class WindowTest(unittest.TestCase):
    def test_inside_the_nightly_window(self):
        deadline = sw.window_deadline(az(3, 5), "03:00", "07:00")
        self.assertEqual(deadline.astimezone(sw.ARIZONA).strftime("%H:%M"), "07:00")
        self.assertEqual(deadline.astimezone(sw.ARIZONA).day, 26)

    def test_outside_the_window_does_nothing(self):
        self.assertIsNone(sw.window_deadline(az(7, 0), "03:00", "07:00"))
        self.assertIsNone(sw.window_deadline(az(14, 30), "03:00", "07:00"))
        self.assertIsNone(sw.window_deadline(az(2, 59), "03:00", "07:00"))

    def test_window_across_midnight(self):
        deadline = sw.window_deadline(az(23, 30), "23:00", "05:00")
        self.assertEqual(deadline.astimezone(sw.ARIZONA).day, 27)
        self.assertIsNone(sw.window_deadline(az(12, 0), "23:00", "05:00"))


class CueTest(unittest.TestCase):
    def test_segments_become_cues(self):
        segments = [
            SimpleNamespace(text=" I would buy Charizard ", start=12.345, end=15.0),
            SimpleNamespace(text="   ", start=15.0, end=16.0),
        ]
        self.assertEqual(sw.to_cues(segments), [{"text": "I would buy Charizard", "start": 12.35, "end": 15.0}])

    def test_estimate_assumes_a_fast_gpu(self):
        self.assertAlmostEqual(sw.estimated_minutes(3600), 3600 / 40 / 60 + 2)
        self.assertEqual(sw.estimated_minutes(None), 10.0)


class SettingsTest(unittest.TestCase):
    def test_requires_https_and_a_long_token(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "s.json"
            path.write_text(json.dumps({"api_url": "http://example.com", "token": "x" * 40}))
            with self.assertRaises(SystemExit):
                sw.load_settings(path)
            path.write_text(json.dumps({"api_url": "https://api.example.com/", "token": "short"}))
            with self.assertRaises(SystemExit):
                sw.load_settings(path)
            path.write_text(json.dumps({"api_url": "https://api.example.com/", "token": "x" * 40, "window_end": "06:30"}))
            settings = sw.load_settings(path)
            self.assertEqual((settings.api_url, settings.window_end, settings.model), ("https://api.example.com", "06:30", "large-v3-turbo"))


class RunTest(unittest.TestCase):
    """The whole nightly loop against a fake Sentiment API and podcast host on localhost."""

    def test_claims_downloads_transcribes_submits_and_deletes_audio(self):
        import http.server
        import threading

        submitted = []
        queue = [{"content_id": "sct_" + "a" * 32, "audio_url": None, "title": "Ep 1", "podcast": "Pack Talk", "duration_seconds": 600}]

        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_GET(self):
                self.send_response(200)
                self.end_headers()
                self.wfile.write(b"fake mp3 bytes")

            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers["content-length"])) or b"{}")
                assert self.headers["authorization"] == "Bearer " + "t" * 40
                if self.path.endswith("/tiktok/claim"):
                    reply = {"profiles": []}
                elif self.path.endswith("/claim"):
                    reply = {"jobs": [queue.pop()] if queue else []}
                else:
                    submitted.append((self.path, body))
                    reply = {"outcome": "ingested", "mentions": 1, "calls_created": 1}
                data = json.dumps(reply).encode()
                self.send_response(200)
                self.send_header("content-length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

        server = http.server.HTTPServer(("localhost", 0), Handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        base = f"http://localhost:{server.server_port}"
        queue[0]["audio_url"] = base + "/ep1.mp3"
        seen_audio = []

        def fake_transcribe(self, path, deadline):
            seen_audio.append(path)
            self.assert_exists = path.exists()
            return [{"text": "I would buy Charizard ex 006", "start": 1.0, "end": 3.0}]

        original = sw.Transcriber.transcribe
        sw.Transcriber.transcribe = fake_transcribe
        sw.LOG_PATH = Path(tempfile.gettempdir()) / "sentiment-whisper-test.log"
        try:
            settings = sw.Settings(api_url=base, token="t" * 40)
            self.assertEqual(sw.run(settings, ignore_window=True), 0)
        finally:
            sw.Transcriber.transcribe = original
            server.shutdown()
        self.assertEqual(len(submitted), 1)
        path, body = submitted[0]
        self.assertEqual(path, "/internal/local-transcripts/sct_" + "a" * 32)
        self.assertEqual(body["status"], "ok")
        self.assertEqual(body["cues"][0]["text"], "I would buy Charizard ex 006")
        # The audio was on disk while transcribing and is gone afterwards.
        self.assertFalse(seen_audio[0].exists())


class TikTokListingTest(unittest.TestCase):
    """Free TikTok listing: yt-dlp in metadata-only mode, results sent to Sentiment."""

    def test_command_never_downloads(self):
        settings = sw.Settings(api_url="https://api.example.com", token="t" * 40)
        command = sw.ytdlp_list_command(settings, "https://www.tiktok.com/@mitchy_stitchy", 60)
        self.assertEqual(command[1:3], ["-m", "yt_dlp"])
        self.assertIn("--skip-download", command)
        self.assertIn("--dump-json", command)
        self.assertEqual(command[command.index("--playlist-end") + 1], "60")
        self.assertEqual(command[-3:], ["--impersonate", "chrome", "https://www.tiktok.com/@mitchy_stitchy"])

    def test_parses_dump_json_lines(self):
        stdout = "\n".join([
            json.dumps({"id": "7700684124884962591", "description": "Who agrees? #pokemon", "timestamp": 1792955261, "duration": 172, "title": "x"}),
            "WARNING: something",
            json.dumps({"id": "not-a-tiktok-id", "description": "skip"}),
            json.dumps({"id": "7700589527026502942", "title": "only a title"}),
            "{broken json",
        ])
        self.assertEqual(sw.parse_ytdlp_listing(stdout), [
            {"id": "7700684124884962591", "caption": "Who agrees? #pokemon", "timestamp": 1792955261, "duration": 172},
            {"id": "7700589527026502942", "caption": "only a title", "timestamp": None, "duration": None},
        ])

    def test_lists_each_claimed_profile_and_reports_failures(self):
        class FakeApi:
            def __init__(self):
                self.batches = [[
                    {"source_account_id": "sac_1", "handle": "mitchy_stitchy", "profile_url": "https://www.tiktok.com/@mitchy_stitchy", "max_videos": 300},
                    {"source_account_id": "sac_2", "handle": "gone", "profile_url": "https://www.tiktok.com/@gone", "max_videos": 60},
                ]]
                self.sent = []

            def claim_tiktok(self):
                return self.batches.pop() if self.batches else []

            def submit_tiktok(self, account, body):
                self.sent.append((account, body))
                return 200, {"kept": 1, "skipped": 0}

        calls = []

        def runner(command, **kwargs):
            calls.append(command)
            if command[-1].endswith("@gone"):
                return SimpleNamespace(returncode=1, stdout="", stderr="ERROR: Unable to extract secondary user ID")
            line = json.dumps({"id": "7700684124884962591", "description": "#pokemon", "timestamp": 1792955261})
            return SimpleNamespace(returncode=0, stdout=line + "\n", stderr="")

        sw.LOG_PATH = Path(tempfile.gettempdir()) / "sentiment-whisper-test.log"
        api = FakeApi()
        settings = sw.Settings(api_url="https://api.example.com", token="t" * 40)
        deadline = datetime.now(timezone.utc) + sw.timedelta(hours=1)
        self.assertEqual(sw.list_tiktok_profiles(api, settings, deadline, runner=runner), 1)
        self.assertEqual(calls[0][calls[0].index("--playlist-end") + 1], "300")
        self.assertEqual(api.sent[0], ("sac_1", {"status": "ok", "videos": [
            {"id": "7700684124884962591", "caption": "#pokemon", "timestamp": 1792955261, "duration": None}
        ], "tool": "yt-dlp"}))
        self.assertEqual(api.sent[1], ("sac_2", {"status": "error", "reason": "ytdlp_exit_1", "tool": "yt-dlp"}))

    def test_missing_ytdlp_stops_listing(self):
        class FakeApi:
            sent = []

            def claim_tiktok(self):
                return [{"source_account_id": "sac_1", "handle": "a", "profile_url": "https://www.tiktok.com/@a"}]

            def submit_tiktok(self, account, body):
                self.sent.append(body)
                return 200, {}

        def runner(command, **kwargs):
            return SimpleNamespace(returncode=1, stdout="", stderr="No module named yt_dlp")

        sw.LOG_PATH = Path(tempfile.gettempdir()) / "sentiment-whisper-test.log"
        api = FakeApi()
        settings = sw.Settings(api_url="https://api.example.com", token="t" * 40)
        deadline = datetime.now(timezone.utc) + sw.timedelta(hours=1)
        self.assertEqual(sw.list_tiktok_profiles(api, settings, deadline, runner=runner), 0)
        self.assertEqual(api.sent, [{"status": "error", "reason": "ytdlp_missing", "tool": "yt-dlp"}])


if __name__ == "__main__":
    unittest.main()
