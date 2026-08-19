# patchpdf: Agent / programmatic API

**Audience:** coding agents and scripts that edit PDFs surgically.  
**Not for:** the human demo UI (unchanged look and flow).

The product goal is **safer than regenerating** a typeset PDF when you only need fact/label fixes: keep layout and pagination; replacement glyphs are Helvetica; change words by `id`. Prefer patch over regen for fidelity and risk, not because every wall-clock race wins.

Official engine (MIT): this repo’s `engine.js`.  
Hosted product UI on martialgames.net loads the same engine but **does not expose** these helpers in the browser chrome.

---

## Why this exists

Regenerating a research PDF re-runs the full layout engine (fonts, wrapping, page breaks) and can reflow or re-break pages.  
Agents should:

1. **`buildPatchmap`** once (stable line `id`s)  
2. **`patchPdfAgent`** / **`applyOperations(..., { failOnSkip: true })`** for small ops  
3. **`verifyPdfText`** for machine checks  

Only **regen** when the *generator program* is wrong (logic/schema), not for copyfixes.

---

## Speed honesty (bench, 2026-08)

**Claim to use:** patch is the right default for small fact/label fixes when you need the **original layout** or only have the PDF bytes.  
**Claim not to use:** “patch is always faster in milliseconds than regenerating.”

Measured on the OSS engine (`engine.js` in headless Chromium, pdf.js extract + pdf-lib apply). Medians, small fact edits only:

| Scenario | Patch (map + apply) | HTML → Chromium PDF | pdf-lib full redraw |
|----------|--------------------:|--------------------:|--------------------:|
| 1-page memo, ~6 ops | ~90–100 ms | ~20 ms | under 1 ms |
| 20-page dense, ~3 ops | ~150–160 ms | ~45 ms | ~20 ms |
| 50-page dense, ~3 ops | ~230–550 ms | ~90 ms | ~50–70 ms |

**Apply-only** (patchmap already built): ~50 ms (1p) / ~120 ms (50p), still usually slower than a minimal redraw.

### Why patch loses pure wall-clock races

- Every `buildPatchmap` runs a **full-document pdf.js extract**.
- Every apply **loads the whole PDF**, cover-paints, redraws glyphs, saves.
- Cost scales with pages/lines even when you touch three strings.
- A blank pdf-lib create or HTML `page.pdf()` has no extract/match overhead.

### When patch is still the right (and often “faster”) choice

| Situation | Prefer |
|-----------|--------|
| Re-running the real report pipeline (charts, LLM draft, LaTeX, multi-second job) | **Patch**: sub-second vs seconds to minutes |
| You only have the PDF (no HTML/template/generator) | **Patch** |
| Must keep layout and pagination (replacement glyphs are Helvetica) | **Patch** |
| You own a fast generator and only care about ms, layout may change | **Regen** |
| Forensic extract purity (old glyphs must vanish) | **Regen** or true stream rewrite (cover-paint is visual) |

**Bottleneck note for future work:** extract-all + full load/save dominate; scoped page extract / apply would shrink the gap. Until then, sell **fidelity and safety**, not always-on speed.

---

## Imports

```js
import {
  extractSnapshot,
  buildPatchmap,
  applyOperations,
  patchPdfAgent,
  verifyPdfText,
  validateOperations,
} from "./engine.js";
```

Browser demo still uses only `extractSnapshot` + `applyOperations(bytes, ops)` with **no** third argument.

---

## `buildPatchmap(pdfBytes, options?)`

Returns a JSON-serializable map of every text run:

| Field | Meaning |
|-------|---------|
| `lines[].id` | Stable id for this extract (use with `replace_line`) |
| `lines[].page` | 1-based page |
| `lines[].str` | Run text |
| `lines[].x/y/width/height/fontSize` | Box metrics |

```js
const map = await buildPatchmap(pdfBytes);
// write map next to the PDF as doc.patchmap.json for the next agent turn
```

Prefer **`id` + `find`** on `replace_line` so multi-match cannot hit the wrong cell.

---

## `applyOperations(pdfBytes, operations, options?)`

Third argument is **agent-only** (UI omits it).

| Option | Default | Effect |
|--------|---------|--------|
| `failOnSkip` | `false` | If `true`, **throw** when any op is SKIPPED / refused |
| `maxOps` | `200` | Hard cap on op list length |
| `requireApplied` | (none) | Require at least N successful applies |

Return value now includes **`skipped: string[]`** in addition to `applied` and `warnings`.

```js
const { bytes, applied, skipped, warnings } = await applyOperations(
  pdfBytes,
  ops,
  { failOnSkip: true, maxOps: 16, requireApplied: ops.length },
);
```

---

## `patchPdfAgent(pdfBytes, request)`: one-shot

Agent defaults: **`failOnSkip: true`**, **`maxOps: 32`**.

```js
const out = await patchPdfAgent(pdfBytes, {
  operations: [
    {
      op: "replace_line",
      page: 2,
      id: 172,
      find: "0.0%",
      replace: "1.1%",
      fit: true,
    },
  ],
  failOnSkip: true,
  maxOps: 8,
  requireApplied: 1,
  verify: {
    contains: ["1.1%"],
    // notContains is soft unless strictExtract: cover-paint leaves old glyphs
    notContains: ["0.0%"],
    strictExtract: false,
  },
});
// out.bytes → write PDF
```

Throws on skip/verify failure with `error.patchpdf` diagnostics.

---

## `verifyPdfText(pdfBytes, spec)`

| Spec | Meaning |
|------|---------|
| `contains[]` | Must appear in extracted text |
| `notContains[]` | Flagged if still present |
| `strictExtract` | If `true`, `notContains` hits fail `ok` |

**Important:** visual cover-paint edits often leave **old strings extractable**.  
For “looks right,” assert `contains` on the new text. For forensic extract purity, regenerate or wait for stream rewrite.

---

## Recommended agent loop (prefer over regen for fact fixes)

```
1. extractSnapshot / buildPatchmap  → save patchmap.json
2. Plan ≤ 8 replace_line ops using id + unique find
3. patchPdfAgent({ failOnSkip: true, verify: { contains: [...] } })
4. If throw (skip / fit refuse) → shorten replacement or fix generator + regen once
```

Reuse the saved patchmap across turns when line `id`s are still valid; still budget ~50–120 ms+ per apply on multi-page docs (full load/save).

**Do not** use the human UI for batch agent work.  
**Do not** change product CSS/HTML for agent features.

---

## Human UI contract

- `app.js` continues to call `applyOperations(bytes, ops)` only.  
- No new buttons, panels, or chrome.  
- Hosted martialgames.net look stays the same.

---

## Limits (unchanged product truth)

- Edits are **visual cover + redraw**, not content-stream delete.  
- Ambiguous matches **fail closed** without `id` / `itemIndex` / `all:true`.  
- Soft fit refuses below ~8pt unless `force: true`.
