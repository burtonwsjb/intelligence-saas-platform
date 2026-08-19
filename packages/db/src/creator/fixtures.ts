import type { SourceContentRecordInput } from "../source/identity.js";

export function creatorCallSourceFixtures(): SourceContentRecordInput[] {
  return [
    {
      provider: "youtube",
      provider_record_id: "yt_vid_en_greninja_buy",
      event_type: "source.content.ingested",
      account: {
        external_account_id: "yt_ch_alpha",
        handle: "AlphaTCG",
        display_name: "Alpha TCG",
        canonical_url: "https://youtube.com/@alphatcg",
      },
      content: {
        external_content_id: "yt_vid_en_greninja_buy",
        content_type: "video",
        published_at: "2026-01-02T12:00:00.000Z",
        title: "I would buy English Twilight Masquerade Greninja 214 normal",
        summary: "This will go up. Target $100 in 30 days.",
        canonical_url: "https://youtube.com/watch?v=yt_vid_en_greninja_buy",
        language: "en",
        excerpt: "I would buy English Twilight Masquerade Greninja 214 normal. This will go up. Target $100 in 30 days.",
      },
      segments: [
        {
          kind: "timestamp_range",
          start_ref: "00:02:00",
          end_ref: "00:02:20",
          excerpt: "I would buy English Twilight Masquerade Greninja 214 normal. This will go up. Target $100 in 30 days.",
        },
      ],
      mentions: [
        {
          raw_entity_text: "English Twilight Masquerade Greninja 214 normal",
          mention_context: "recommendation",
          candidate_direction: "bullish",
          candidate_timeframe: "30d",
          candidate_price: 100,
          sentiment: "positive",
          segment_index: 0,
        },
      ],
    },
    {
      provider: "youtube",
      provider_record_id: "yt_vid_en_greninja_sell",
      event_type: "source.content.ingested",
      account: {
        external_account_id: "yt_ch_alpha",
        handle: "AlphaTCG",
        display_name: "Alpha TCG",
        canonical_url: "https://youtube.com/@alphatcg",
      },
      content: {
        external_content_id: "yt_vid_en_greninja_sell",
        content_type: "video",
        published_at: "2026-01-02T16:00:00.000Z",
        title: "Sell now English Twilight Masquerade Greninja 214 normal",
        summary: "This is overpriced.",
        canonical_url: "https://youtube.com/watch?v=yt_vid_en_greninja_sell",
        language: "en",
        excerpt: "Sell now. English Twilight Masquerade Greninja 214 normal is overpriced.",
      },
      segments: [
        {
          kind: "timestamp_range",
          start_ref: "00:03:00",
          end_ref: "00:03:10",
          excerpt: "Sell now. English Twilight Masquerade Greninja 214 normal is overpriced.",
        },
      ],
      mentions: [
        {
          raw_entity_text: "English Twilight Masquerade Greninja 214 normal",
          mention_context: "recommendation",
          sentiment: "negative",
          segment_index: 0,
        },
      ],
    },
    {
      provider: "youtube",
      provider_record_id: "yt_vid_ja_greninja_buy",
      event_type: "source.content.ingested",
      account: {
        external_account_id: "yt_ch_kana",
        handle: "KanaTCG",
        display_name: "Kana TCG",
        canonical_url: "https://youtube.com/@kanatcg",
      },
      content: {
        external_content_id: "yt_vid_ja_greninja_buy",
        content_type: "video",
        published_at: "2026-01-02T15:00:00.000Z",
        title: "Japanese Twilight Masquerade ゲッコウガ 214 normal 買う",
        summary: "上がる",
        canonical_url: "https://youtube.com/watch?v=yt_vid_ja_greninja_buy",
        language: "ja",
        excerpt: "Japanese Twilight Masquerade ゲッコウガ 214 normal は上がる。買う。",
      },
      segments: [
        {
          kind: "timestamp_range",
          start_ref: "00:01:00",
          end_ref: "00:01:12",
          excerpt: "Japanese Twilight Masquerade ゲッコウガ 214 normal は上がる。買う。",
        },
      ],
      mentions: [
        {
          raw_entity_text: "Japanese Twilight Masquerade ゲッコウガ 214 normal",
          mention_context: "recommendation",
          sentiment: "positive",
          segment_index: 0,
        },
      ],
    },
    {
      provider: "reddit",
      provider_record_id: "rd_post_percent",
      event_type: "source.content.ingested",
      account: {
        external_account_id: "rd_u_beta",
        handle: "u/beta_tcg",
        display_name: "beta_tcg",
        canonical_url: "https://reddit.com/user/beta_tcg",
      },
      content: {
        external_content_id: "rd_post_percent",
        content_type: "post",
        published_at: "2026-01-02T18:00:00.000Z",
        title: "Buy English Twilight Masquerade Greninja 214 normal",
        summary: "I would buy. Expect 20% without a stated horizon.",
        canonical_url: "https://reddit.com/r/pokemon/comments/rd_post_percent",
        language: "en",
        excerpt: "I would buy English Twilight Masquerade Greninja 214 normal. Expect 20%.",
      },
      segments: [
        {
          kind: "paragraph",
          start_ref: "body:0",
          end_ref: "body:0",
          excerpt: "I would buy English Twilight Masquerade Greninja 214 normal. Expect 20%.",
        },
      ],
      mentions: [
        {
          raw_entity_text: "English Twilight Masquerade Greninja 214 normal",
          mention_context: "recommendation",
          candidate_percent: 20,
          sentiment: "positive",
          segment_index: 0,
        },
      ],
    },
    {
      provider: "reddit",
      provider_record_id: "rd_post_custom_horizon",
      event_type: "source.content.ingested",
      account: {
        external_account_id: "rd_u_beta",
        handle: "u/beta_tcg",
        display_name: "beta_tcg",
        canonical_url: "https://reddit.com/user/beta_tcg",
      },
      content: {
        external_content_id: "rd_post_custom_horizon",
        content_type: "post",
        published_at: "2026-01-02T19:00:00.000Z",
        title: "Buy English Twilight Masquerade Greninja 214 normal in 14 days",
        summary: "I would buy in 14 days.",
        canonical_url: "https://reddit.com/r/pokemon/comments/rd_post_custom_horizon",
        language: "en",
        excerpt: "I would buy English Twilight Masquerade Greninja 214 normal in 14 days.",
      },
      segments: [
        {
          kind: "paragraph",
          start_ref: "body:0",
          end_ref: "body:0",
          excerpt: "I would buy English Twilight Masquerade Greninja 214 normal in 14 days.",
        },
      ],
      mentions: [
        {
          raw_entity_text: "English Twilight Masquerade Greninja 214 normal",
          mention_context: "recommendation",
          sentiment: "positive",
          segment_index: 0,
        },
      ],
    },
    {
      provider: "reddit",
      provider_record_id: "rd_post_unresolved_name",
      event_type: "source.content.ingested",
      account: {
        external_account_id: "rd_u_beta",
        handle: "u/beta_tcg",
        display_name: "beta_tcg",
        canonical_url: "https://reddit.com/user/beta_tcg",
      },
      content: {
        external_content_id: "rd_post_unresolved_name",
        content_type: "post",
        published_at: "2026-01-02T20:00:00.000Z",
        title: "I would buy Mysteryblobex",
        summary: "This will go up.",
        canonical_url: "https://reddit.com/r/pokemon/comments/rd_post_unresolved_name",
        language: "en",
        excerpt: "I would buy Mysteryblobex. This will go up.",
      },
      segments: [
        {
          kind: "paragraph",
          start_ref: "body:0",
          end_ref: "body:0",
          excerpt: "I would buy Mysteryblobex. This will go up.",
        },
      ],
      mentions: [
        {
          raw_entity_text: "Mysteryblobex",
          mention_context: "recommendation",
          sentiment: "positive",
          segment_index: 0,
        },
      ],
    },
  ];
}
