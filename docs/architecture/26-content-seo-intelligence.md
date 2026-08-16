# Content and SEO intelligence

This is an **evidence-driven** publishing system, not a generic AI blog spammer.

## Required flow

```text
Data
  → observations
    → signals
      → market intelligence
        → content candidate
          → evidence package
            → generation
              → validation
                → approval / publishing
```

No generation step without an evidence package that cites observations, signals, scores, and (when used) creator calls.

## Output types

- SEO article
- market report
- card analysis
- newsletter
- email
- social post
- YouTube outline
- push notification
- customer / tenant report

Each type has a template, minimum evidence rules, and a thin-content blocker.

## Evidence package

Must include:

- entity / printing / language
- as-of market snapshot
- material signals with magnitudes
- recommendation or `insufficient_data`
- prediction (if any) with horizon and confidence
- sources (URLs / observation ids)
- “what would falsify this”

If evidence is thin, the candidate is rejected or becomes a stub that is **not** indexable.

## Validation

Automated checks before approval:

- every numeric claim resolves to an observation
- language of the printing matches the page language strategy
- no cross-language price merge unless the piece is explicitly comparative
- duplicate/canonical URL rules pass
- minimum length/substance for the template
- model version recorded

Human approval is required for first commercial SEO at scale. Later, high-confidence templates may auto-publish inside entitlements.

## SEO structure (future)

Support:

- exact card / printing pages (language-segmented)
- set pages
- market trend pages
- creator pages
- market indices
- historical statistics
- evergreen URLs
- internal links between related analyses
- structured data
- canonicalization
- **controlled** programmatic SEO

Prevent:

- thin pages
- duplicated card/language doorway pages
- AI spam
- index bloat

Rules:

- One canonical URL per printing+language (or a clearly marked comparative page)
- `noindex` when `insufficient_data` or duplicate
- Do not generate N near-identical language copies without unique series
- Change frequency follows real market-state change, not a daily rewrite

## Tenant privacy

Customer reports may include holdings. Those outputs are not public SEO. Public content uses platform market data and public creator calls only.
