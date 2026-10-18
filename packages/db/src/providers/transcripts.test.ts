import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  SupadataTranscriptFetcher,
  YoutubeCaptionFetcher,
  chunkTranscriptCues,
  cleanCueText,
  createTranscriptFetcherFromEnv,
  extractAssignedJson,
  parseJson3Captions,
  transcriptProviderConfig,
  transcriptRequestBudget,
} from "./transcripts.js";
import { ProviderHttpError, type HttpResponse, type HttpTransport } from "./transport.js";

const WATCH_HTML = readFileSync(new URL("./fixtures/transcripts/youtube-watch.html", import.meta.url), "utf8");
const JSON3 = readFileSync(new URL("./fixtures/transcripts/youtube-captions.json3.json", import.meta.url), "utf8");
const VIDEO = "AbCdEfGhIj0";

function fakeTransport(responses: Array<HttpResponse | Error>) {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const transport: HttpTransport = {
    async fetch(url, init) {
      calls.push({ url, headers: init?.headers ?? {} });
      const next = responses.shift();
      if (!next) throw new Error("unexpected request");
      if (next instanceof Error) throw next;
      return next;
    },
  };
  return { transport, calls };
}

const ok = (bodyText: string): HttpResponse => ({ status: 200, headers: {}, bodyText });

describe("YoutubeCaptionFetcher", () => {
  it("reads the player response from a recorded watch page and prefers the manual English track", async () => {
    const { transport, calls } = fakeTransport([ok(WATCH_HTML), ok(JSON3)]);
    const result = await new YoutubeCaptionFetcher({ transport }).fetch(VIDEO);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.trackKind).toBe("manual");
    expect(result.lang).toBe("en");
    expect(calls).toHaveLength(2);
    expect(calls[0]!.url).toBe(`https://www.youtube.com/watch?v=${VIDEO}&hl=en`);
    expect(calls[0]!.headers["accept-language"]).toMatch(/^en/);
    const track = new URL(calls[1]!.url);
    expect(track.hostname).toBe("www.youtube.com");
    expect(track.pathname).toBe("/api/timedtext");
    expect(track.searchParams.get("fmt")).toBe("json3");
    expect(track.searchParams.get("name")).toBe("English");
    expect(result.cues[0]).toEqual({ text: "what is going on everybody", offsetMs: 1200, durationMs: 4100 });
    expect(result.cues.map((cue) => cue.text)).toContain("from scarlet & violet it will go up");
    // Newline-only appends and events without segments are dropped.
    expect(result.cues.every((cue) => cue.text.trim().length > 0)).toBe(true);
  });

  it("falls back to the auto-generated English track", async () => {
    const player = extractAssignedJson(WATCH_HTML, "ytInitialPlayerResponse") as {
      captions: { playerCaptionsTracklistRenderer: { captionTracks: Array<{ kind?: string }> } };
    };
    player.captions.playerCaptionsTracklistRenderer.captionTracks =
      player.captions.playerCaptionsTracklistRenderer.captionTracks.filter((track) => track.kind === "asr");
    const html = `<script>var ytInitialPlayerResponse = ${JSON.stringify(player)};</script>`;
    const { transport, calls } = fakeTransport([ok(html), ok(JSON3)]);
    const result = await new YoutubeCaptionFetcher({ transport }).fetch(VIDEO);
    expect(result.status === "ok" && result.trackKind).toBe("asr");
    expect(new URL(calls[1]!.url).searchParams.get("kind")).toBe("asr");
  });

  it("reports unavailable when the video has no captions, without a second request", async () => {
    const html = `<script>var ytInitialPlayerResponse = {"playabilityStatus":{"status":"OK"},"videoDetails":{"videoId":"${VIDEO}"}};</script>`;
    const { transport, calls } = fakeTransport([ok(html)]);
    expect(await new YoutubeCaptionFetcher({ transport }).fetch(VIDEO)).toEqual({
      status: "unavailable",
      reason: "no_captions",
    });
    expect(calls).toHaveLength(1);
  });

  it("treats a bot check, a consent page or a 429 as blocked", async () => {
    const bot = `<script>var ytInitialPlayerResponse = {"playabilityStatus":{"status":"LOGIN_REQUIRED","reason":"Sign in to confirm you’re not a bot"}};</script>`;
    const consent = `<html><form action="https://consent.youtube.com/save" method="POST"></form></html>`;
    for (const response of [ok(bot), ok(consent), { status: 429, headers: {}, bodyText: "" }]) {
      const { transport, calls } = fakeTransport([response]);
      expect(await new YoutubeCaptionFetcher({ transport }).fetch(VIDEO)).toEqual({
        status: "rate_limited",
        reason: "blocked",
      });
      expect(calls).toHaveLength(1);
    }
  });

  it("maps a private or removed video to unavailable and transport failures to safe error classes", async () => {
    const privateVideo = `<script>var ytInitialPlayerResponse = {"playabilityStatus":{"status":"LOGIN_REQUIRED","reason":"This video is private"}};</script>`;
    expect(await new YoutubeCaptionFetcher({ transport: fakeTransport([ok(privateVideo)]).transport }).fetch(VIDEO)).toEqual({
      status: "unavailable",
      reason: "playability_login_required",
    });
    const timeout = new ProviderHttpError({ status: 408, errorClass: "timeout" });
    expect(await new YoutubeCaptionFetcher({ transport: fakeTransport([timeout]).transport }).fetch(VIDEO)).toEqual({
      status: "error",
      reason: "timeout",
    });
    expect(
      await new YoutubeCaptionFetcher({ transport: fakeTransport([ok(WATCH_HTML), ok("")]).transport }).fetch(VIDEO),
    ).toEqual({ status: "error", reason: "empty_caption_body" });
    expect(await new YoutubeCaptionFetcher({ transport: fakeTransport([]).transport }).fetch("../../etc")).toEqual({
      status: "error",
      reason: "invalid_video_id",
    });
  });

  it("refuses a caption track hosted anywhere but YouTube", async () => {
    const html = `<script>var ytInitialPlayerResponse = {"playabilityStatus":{"status":"OK"},"captions":{"playerCaptionsTracklistRenderer":{"captionTracks":[{"baseUrl":"https://evil.example/api/timedtext?v=x","languageCode":"en"}]}}};</script>`;
    const { transport, calls } = fakeTransport([ok(html)]);
    expect(await new YoutubeCaptionFetcher({ transport }).fetch(VIDEO)).toEqual({
      status: "error",
      reason: "invalid_track_url",
    });
    expect(calls).toHaveLength(1);
  });
});

describe("SupadataTranscriptFetcher", () => {
  const body = JSON.stringify({
    lang: "en",
    availableLangs: ["en"],
    content: [
      { text: "charizard ex 006 is a buy", offset: 61_000, duration: 3_000, lang: "en" },
      { text: "Tom &amp; Jerry", offset: "64000", duration: 2_000, lang: "en" },
      { text: 42, offset: 1 },
      { text: "no offset" },
    ],
  });

  it("sends the key as a header, never in the URL, and parses millisecond cues defensively", async () => {
    const { transport, calls } = fakeTransport([ok(body)]);
    const result = await new SupadataTranscriptFetcher({ apiKey: "secret-key", transport }).fetch(VIDEO);
    expect(calls[0]!.url).toBe(`https://api.supadata.ai/v1/youtube/transcript?videoId=${VIDEO}&lang=en`);
    expect(calls[0]!.url).not.toContain("secret-key");
    expect(calls[0]!.headers["x-api-key"]).toBe("secret-key");
    expect(result).toEqual({
      status: "ok",
      lang: "en",
      trackKind: "unknown",
      cues: [
        { text: "charizard ex 006 is a buy", offsetMs: 61_000, durationMs: 3_000 },
        { text: "Tom & Jerry", offsetMs: 64_000, durationMs: 2_000 },
      ],
    });
  });

  it("maps status codes without leaking the key", async () => {
    const cases: Array<[number, unknown]> = [
      [404, { status: "unavailable", reason: "no_transcript" }],
      [206, { status: "unavailable", reason: "no_transcript" }],
      [429, { status: "rate_limited", reason: "rate_limited" }],
      [401, { status: "error", reason: "auth" }],
      [500, { status: "error", reason: "http_500" }],
    ];
    for (const [status, expected] of cases) {
      const { transport } = fakeTransport([{ status, headers: {}, bodyText: "{}" }]);
      const result = await new SupadataTranscriptFetcher({ apiKey: "secret-key", transport }).fetch(VIDEO);
      expect(result).toEqual(expected);
      expect(JSON.stringify(result)).not.toContain("secret-key");
    }
    const { transport } = fakeTransport([ok("{\"content\":\"plain text\"}")]);
    expect(await new SupadataTranscriptFetcher({ apiKey: "k", transport }).fetch(VIDEO)).toEqual({
      status: "error",
      reason: "invalid_payload",
    });
  });
});

describe("transcript configuration", () => {
  it("enables nothing by default and needs a key for Supadata", () => {
    expect(transcriptProviderConfig({})).toEqual({ enabled: false, reason: "disabled" });
    expect(transcriptProviderConfig({ TRANSCRIPT_PROVIDER: "none" })).toEqual({ enabled: false, reason: "disabled" });
    expect(transcriptProviderConfig({ TRANSCRIPT_PROVIDER: "supadata" })).toEqual({ enabled: false, reason: "missing_key" });
    expect(transcriptProviderConfig({ TRANSCRIPT_PROVIDER: "other" })).toEqual({
      enabled: false,
      reason: "invalid_provider",
    });
    expect(createTranscriptFetcherFromEnv({})).toBeNull();
    expect(createTranscriptFetcherFromEnv({ TRANSCRIPT_PROVIDER: "youtube_captions" })?.provider).toBe("youtube_captions");
    expect(createTranscriptFetcherFromEnv({ TRANSCRIPT_PROVIDER: "supadata", SUPADATA_API_KEY: "k" })?.provider).toBe(
      "supadata",
    );
  });

  it("bounds the daily request budget", () => {
    expect(transcriptRequestBudget({})).toBe(50);
    expect(transcriptRequestBudget({ YOUTUBE_TRANSCRIPT_REQUESTS_PER_DAY: "0" })).toBe(0);
    expect(transcriptRequestBudget({ YOUTUBE_TRANSCRIPT_REQUESTS_PER_DAY: "120" })).toBe(120);
    expect(() => transcriptRequestBudget({ YOUTUBE_TRANSCRIPT_REQUESTS_PER_DAY: "-1" })).toThrow();
    expect(() => transcriptRequestBudget({ YOUTUBE_TRANSCRIPT_REQUESTS_PER_DAY: "1e9" })).toThrow();
  });
});

describe("transcript parsing helpers", () => {
  it("finds the assigned JSON even with braces and quotes inside strings", () => {
    const player = extractAssignedJson(WATCH_HTML, "ytInitialPlayerResponse") as { videoDetails: { title: string } };
    expect(player.videoDetails.title).toBe('The Pokemon Market Is CRASHING! {buy} or "sell"?');
    expect(extractAssignedJson('window["ytInitialPlayerResponse"] = {"a":1};', "ytInitialPlayerResponse")).toEqual({ a: 1 });
    expect(extractAssignedJson("no player here", "ytInitialPlayerResponse")).toBeNull();
  });

  it("decodes entities and rejects a non-json3 body", () => {
    expect(cleanCueText("it&#39;s  &quot;mint&quot;\n")).toBe('it\'s "mint"');
    expect(parseJson3Captions({ nope: true })).toBeNull();
  });

  it("chunks cues into windows of about a minute", () => {
    const windows = chunkTranscriptCues([
      { text: "b", offsetMs: 30_000, durationMs: 2_000 },
      { text: "a", offsetMs: 0, durationMs: 2_000 },
      { text: "c", offsetMs: 61_000, durationMs: 4_000 },
    ]);
    expect(windows).toEqual([
      { startMs: 0, endMs: 32_000, text: "a b", cueStarts: [{ charStart: 0, offsetMs: 0 }, { charStart: 2, offsetMs: 30_000 }] },
      { startMs: 61_000, endMs: 65_000, text: "c", cueStarts: [{ charStart: 0, offsetMs: 61_000 }] },
    ]);
  });
});
