import type { SourceContentRecordInput } from "./identity.js";

export function sourceIntelligenceFixtures(): SourceContentRecordInput[] {
  return [
    {
      provider: "youtube",
      provider_record_id: "yt_vid_en_greninja",
      event_type: "source.content.ingested",
      account: {
        external_account_id: "yt_ch_alpha",
        handle: "AlphaTCG",
        display_name: "Alpha TCG",
        canonical_url: "https://youtube.com/@alphatcg",
      },
      content: {
        external_content_id: "yt_vid_en_greninja",
        content_type: "video",
        published_at: "2026-01-02T12:00:00.000Z",
        title: "Twilight Masquerade Greninja 214 pickup",
        summary: "Talking about English Greninja ex 214/167.",
        canonical_url: "https://youtube.com/watch?v=yt_vid_en_greninja",
        language: "en",
        license_status: "bounded_excerpt",
        retention_policy: "bounded_excerpt",
        transcript_available: true,
        excerpt: "At 01:12 I mention Greninja 214 from Twilight Masquerade.",
      },
      segments: [
        {
          kind: "timestamp_range",
          start_ref: "00:01:10",
          end_ref: "00:01:20",
          excerpt: "Greninja 214 from Twilight Masquerade.",
        },
      ],
      mentions: [
        {
          raw_entity_text: "Greninja 214",
          mention_context: "identity",
          sentiment: "neutral",
          sentiment_confidence: 0.4,
          segment_index: 0,
        },
      ],
      engagement: {
        observed_at: "2026-01-03T00:00:00.000Z",
        views: 12000,
        likes: 430,
        comments: 88,
      },
    },
    {
      provider: "youtube",
      provider_record_id: "yt_vid_ja_greninja",
      event_type: "source.content.ingested",
      account: {
        external_account_id: "yt_ch_kana",
        handle: "KanaTCG",
        display_name: "Kana TCG",
        canonical_url: "https://youtube.com/@kanatcg",
      },
      content: {
        external_content_id: "yt_vid_ja_greninja",
        content_type: "video",
        published_at: "2026-01-02T15:00:00.000Z",
        title: "ゲッコウガ 214",
        summary: "Japanese printing discussion.",
        canonical_url: "https://youtube.com/watch?v=yt_vid_ja_greninja",
        language: "ja",
        license_status: "bounded_excerpt",
        retention_policy: "bounded_excerpt",
        transcript_available: true,
        excerpt: "01:40 でゲッコウガ 214 に触れています。",
      },
      segments: [
        {
          kind: "timestamp_range",
          start_ref: "00:01:38",
          end_ref: "00:01:48",
          excerpt: "ゲッコウガ 214",
        },
      ],
      mentions: [
        {
          raw_entity_text: "ゲッコウガ 214",
          mention_context: "identity",
          sentiment: "neutral",
          segment_index: 0,
        },
      ],
      engagement: {
        observed_at: "2026-01-03T00:00:00.000Z",
        views: 5400,
        likes: 210,
        comments: 40,
      },
    },
    {
      provider: "reddit",
      provider_record_id: "rd_post_en_greninja",
      event_type: "source.content.ingested",
      account: {
        external_account_id: "rd_u_beta",
        handle: "u/beta_tcg",
        display_name: "beta_tcg",
        canonical_url: "https://reddit.com/user/beta_tcg",
      },
      content: {
        external_content_id: "rd_post_en_greninja",
        content_type: "post",
        published_at: "2026-01-04T08:00:00.000Z",
        title: "Pulled English Greninja 214",
        summary: "Just a pull post.",
        canonical_url: "https://reddit.com/r/pokemon/comments/rd_post_en_greninja",
        language: "en",
        license_status: "bounded_excerpt",
        retention_policy: "bounded_excerpt",
        transcript_available: false,
        excerpt: "I pulled this English Greninja 214 today.",
      },
      segments: [
        {
          kind: "paragraph",
          start_ref: "body:0",
          end_ref: "body:0",
          excerpt: "I pulled this English Greninja 214 today.",
        },
        {
          kind: "comment",
          start_ref: "comment:abc",
          end_ref: "comment:abc",
          excerpt: "Price is $40 on TCGPlayer.",
        },
      ],
      mentions: [
        {
          raw_entity_text: "English Greninja 214",
          mention_context: "pull",
          sentiment: "neutral",
          segment_index: 0,
        },
        {
          raw_entity_text: "Greninja 214",
          mention_context: "price",
          candidate_price: 40,
          sentiment: "unknown",
          segment_index: 1,
        },
      ],
      engagement: {
        observed_at: "2026-01-04T18:00:00.000Z",
        upvotes: 92,
        score: 88,
        comments: 14,
        reply_count: 6,
      },
    },
  ];
}
