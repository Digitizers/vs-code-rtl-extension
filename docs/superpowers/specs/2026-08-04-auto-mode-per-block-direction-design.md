# Auto Mode: Per-Block Direction Detection

**Date:** 2026-08-04
**Status:** Approved
**Scope:** `src/content.ts` only (Auto mode CSS + JS)

## Problem

In Auto mode, once a bubble is tagged `.YBYrtl`, response paragraphs get
`unicode-bidi: plaintext`, which sets each paragraph's base direction from its
**first strong character**. In a Hebrew conversation this causes:

1. Paragraphs that start with an English word flip to LTR and align left.
2. List markers (bullets/dots) follow that direction and land on the wrong side.
3. Mixed Hebrew/English lines scramble punctuation and word order, hard to read.

## Decision

Direction is decided **per block element** by *presence* of RTL characters, not
by first character:

- Block **contains** Hebrew/Arabic/Persian → `dir="rtl"` → right-aligned,
  bullet on right, embedded English isolated inline.
- Block has **no** RTL characters (pure English heading, free-standing code-ish
  line) → `dir="ltr"` → left-aligned, natural.

User-approved trade-off: a lone English word on its own line goes left; a Hebrew
paragraph containing lots of English still goes right.

## Mechanism

### JS (extends the existing Auto-mode observer in `RTL_AUTO_JS_CODE`)

- For each `.YBYrtl` bubble, walk block elements — `p`, `li`, `h1`–`h6`,
  `blockquote` — **only inside markdown containers** (`[class*="root_"]`);
  tool/thinking/todo UI reuses the same tags and must not be tagged.
- Additionally skip anything inside every container the LTR overrides protect:
  `pre`, `code`, `codeBlockWrapper_`, `thinking_`/`thinkingContent_`,
  `toolUse_`/`toolSummary_`/`toolBody_`/`toolResult_`/`toolReference_`,
  `todoList_`/`todoListContainer_` — a native `dir` attribute on a child is not
  neutralized by direction rules on its container.
- Set `dir="rtl"` or `dir="ltr"` per the RTL-char test
  (`/[֐-׿؀-ۿݐ-ݿﭐ-﷿ﹰ-﻾]/`).
- Re-scan on mutations, debounced — same pattern as the BiDi stripper — so a
  streamed line that starts in English flips right once Hebrew arrives.

### CSS (in `AUTO_RTL_RULES`)

- Remove `unicode-bidi: plaintext` and the blanket `text-align: right` from
  response-paragraph rules.
- Add:
  - `[dir="rtl"]` blocks → `direction: rtl; text-align: right; unicode-bidi: isolate`.
  - `[dir="ltr"]` blocks → `direction: ltr; text-align: left`.
- Bubble-level `direction: rtl` layout rules stay (bubble alignment unchanged).
- Prompt input rules stay as-is (first-char live detection is correct while
  typing).

## Out of Scope

- Active / Always / LTR-Always modes (their semantics are explicit, not
  detected).
- Plan Preview.
- Input field.

## Verification

- `npm run build` clean; `npm test` (concurrency) still passes.
- Manual: in Auto mode with a mixed Hebrew/English response confirm —
  English-first mixed line right-aligned and readable, bullets on the right,
  pure-English heading stays left, code blocks untouched, streaming reply
  settles correctly.
