/**
 * patchpdf engine — browser-side surgical PDF editor
 * Copyright (c) 2026 Martial Systems LLC.
 *
 * Fully client-side: extract → plan → apply. No server PDF processing.
 * OpenAI-compatible planning calls the user's provider (direct or thin proxy).
 */

import {
  PDFDocument,
  StandardFonts,
  rgb,
  degrees,
} from "https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/+esm";
import * as pdfjs from "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.min.mjs";
import {
  Document,
  Packer,
  Paragraph,
  TextRun,
  AlignmentType,
  Table,
  TableRow,
  TableCell,
  WidthType,
  BorderStyle,
  VerticalAlign,
} from "https://cdn.jsdelivr.net/npm/docx@9.5.1/+esm";

pdfjs.GlobalWorkerOptions.workerSrc =
  "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.worker.min.mjs";

/** Built-in OpenAI-compatible profiles (keys stay in the browser). */
export const BUILTIN_PROFILES = {
  local: {
    id: "local",
    label: "Local patterns only",
    kind: "local",
    notes: "No network. replace / watermark / delete / meta patterns.",
  },
  openai: {
    id: "openai",
    label: "OpenAI",
    kind: "openai-compatible",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-4.1-mini",
    apiKeyEnv: "OPENAI_API_KEY",
  },
  xai: {
    id: "xai",
    label: "xAI (Grok)",
    kind: "openai-compatible",
    baseUrl: "https://api.x.ai/v1",
    model: "grok-3-mini",
    apiKeyEnv: "XAI_API_KEY",
  },
  openrouter: {
    id: "openrouter",
    label: "OpenRouter",
    kind: "openai-compatible",
    baseUrl: "https://openrouter.ai/api/v1",
    model: "openai/gpt-4.1-mini",
    apiKeyEnv: "OPENROUTER_API_KEY",
    headers: {
      "HTTP-Referer": "https://martialgames.net/tools/patchpdf/",
      "X-Title": "patchpdf",
    },
  },
  groq: {
    id: "groq",
    label: "Groq",
    kind: "openai-compatible",
    baseUrl: "https://api.groq.com/openai/v1",
    model: "llama-3.3-70b-versatile",
    apiKeyEnv: "GROQ_API_KEY",
  },
  together: {
    id: "together",
    label: "Together AI",
    kind: "openai-compatible",
    baseUrl: "https://api.together.xyz/v1",
    model: "meta-llama/Meta-Llama-3.1-70B-Instruct-Turbo",
    apiKeyEnv: "TOGETHER_API_KEY",
  },
  ollama: {
    id: "ollama",
    label: "Ollama (local)",
    kind: "openai-compatible",
    baseUrl: "http://127.0.0.1:11434/v1",
    model: "llama3.2",
    defaultApiKey: "ollama",
    notes: "Enable CORS on Ollama. Keys optional.",
  },
  custom: {
    id: "custom",
    label: "Custom OpenAI-compatible",
    kind: "openai-compatible",
    baseUrl: "http://127.0.0.1:8000/v1",
    model: "local-model",
    notes: "Set base URL + model in the UI.",
  },
};

export function listProfiles() {
  return Object.values(BUILTIN_PROFILES).map((p) => ({ ...p }));
}

function copyBytes(pdfBytes) {
  const out = new Uint8Array(pdfBytes.byteLength);
  out.set(pdfBytes);
  return out;
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function hexToRgb(hex) {
  if (!hex) return rgb(0.1, 0.1, 0.1);
  const h = String(hex).replace("#", "").trim();
  const full =
    h.length === 3
      ? h
          .split("")
          .map((c) => c + c)
          .join("")
      : h;
  if (full.length !== 6) return rgb(0.1, 0.1, 0.1);
  const n = parseInt(full, 16);
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
}

function pageIndex(page, pageCount) {
  if (page < 1 || page > pageCount) return null;
  return page - 1;
}

function parsePageList(s) {
  const out = [];
  for (const part of String(s).split(",")) {
    const t = part.trim();
    if (!t) continue;
    if (t.includes("-")) {
      const [a, b] = t.split("-").map((x) => parseInt(x.trim(), 10));
      if (!Number.isNaN(a) && !Number.isNaN(b)) {
        for (let i = Math.min(a, b); i <= Math.max(a, b); i++) out.push(i);
      }
    } else {
      const n = parseInt(t, 10);
      if (!Number.isNaN(n)) out.push(n);
    }
  }
  return out;
}

/* ─── Schema validation (no zod in browser build) ─── */

const OP_KINDS = new Set([
  "replace_text",
  "replace_line",
  "cover",
  "redact", // alias → cover (deprecated name)
  "add_text",
  "watermark",
  "set_metadata",
  "fill_form",
  "delete_pages",
  "rotate_pages",
  "draw_rect",
]);

const MAX_OPS = 200;

/**
 * Validate and normalize plan operations. Rejects unknown shapes.
 * @param {unknown} rawOps
 * @param {{ maxOps?: number }} [options] Agent/API only — browser UI ignores.
 * @returns {{ operations: object[], warnings: string[] }}
 */
export function validateOperations(rawOps, options = {}) {
  const warnings = [];
  if (!Array.isArray(rawOps)) {
    throw new Error("Plan operations must be an array");
  }
  const maxOps = options.maxOps != null ? Number(options.maxOps) : MAX_OPS;
  if (!Number.isFinite(maxOps) || maxOps < 1) {
    throw new Error("maxOps must be a positive number");
  }
  if (rawOps.length > maxOps) {
    throw new Error(`Too many operations (${rawOps.length}); max ${maxOps}`);
  }
  const operations = [];
  for (let i = 0; i < rawOps.length; i++) {
    const op = rawOps[i];
    if (!op || typeof op !== "object" || typeof op.op !== "string") {
      warnings.push(`SKIPPED op[${i}]: not an object with op`);
      continue;
    }
    let kind = op.op;
    if (kind === "redact") {
      kind = "cover";
      warnings.push(`op[${i}]: "redact" renamed to "cover" (visual cover only)`);
    }
    if (!OP_KINDS.has(kind) && kind !== "cover") {
      warnings.push(`SKIPPED op[${i}]: unknown op "${op.op}"`);
      continue;
    }
    const n = { ...op, op: kind };
    // Light field checks
    if (kind === "replace_line") {
      if (typeof n.find !== "string" || typeof n.replace !== "string") {
        warnings.push(`SKIPPED op[${i}]: replace_line needs find/replace strings`);
        continue;
      }
      if (n.page != null) n.page = Number(n.page);
      if (n.id != null) n.id = Number(n.id);
      if (n.itemIndex != null) n.itemIndex = Number(n.itemIndex);
      n.fit = n.fit !== false;
      n.force = n.force === true;
    } else if (kind === "replace_text" || kind === "cover") {
      if (typeof n.find !== "string") {
        warnings.push(`SKIPPED op[${i}]: ${kind} needs find string`);
        continue;
      }
      if (kind === "replace_text" && typeof n.replace !== "string") {
        warnings.push(`SKIPPED op[${i}]: replace_text needs replace string`);
        continue;
      }
      if (n.page != null) n.page = Number(n.page);
      if (n.id != null) n.id = Number(n.id);
      if (n.itemIndex != null) n.itemIndex = Number(n.itemIndex);
      // default: fail closed on multi-match unless all:true or id/itemIndex
      if (n.all == null) n.all = false;
      if (kind === "replace_text") {
        n.fit = n.fit !== false;
        n.force = n.force === true;
      }
    } else if (kind === "add_text") {
      n.page = Number(n.page);
      n.x = Number(n.x);
      n.y = Number(n.y);
      if (!n.text || Number.isNaN(n.page)) {
        warnings.push(`SKIPPED op[${i}]: add_text invalid`);
        continue;
      }
    } else if (kind === "watermark") {
      if (!n.text) {
        warnings.push(`SKIPPED op[${i}]: watermark needs text`);
        continue;
      }
    } else if (kind === "delete_pages" || kind === "rotate_pages") {
      if (!Array.isArray(n.pages) || !n.pages.length) {
        warnings.push(`SKIPPED op[${i}]: needs pages array`);
        continue;
      }
      n.pages = n.pages.map(Number).filter((p) => p >= 1);
      if (kind === "rotate_pages") {
        const d = Number(n.degrees);
        if (![90, 180, 270].includes(d)) {
          warnings.push(`SKIPPED op[${i}]: rotate degrees must be 90|180|270`);
          continue;
        }
        n.degrees = d;
      }
    } else if (kind === "draw_rect") {
      n.page = Number(n.page);
      n.x = Number(n.x);
      n.y = Number(n.y);
      n.width = Number(n.width);
      n.height = Number(n.height);
    } else if (kind === "fill_form") {
      if (!n.fields || typeof n.fields !== "object") {
        warnings.push(`SKIPPED op[${i}]: fill_form needs fields object`);
        continue;
      }
    }
    operations.push(n);
  }
  return { operations, warnings };
}

export function parsePlan(raw) {
  let text = String(raw ?? "").trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) text = fence[1].trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1) {
    throw new Error(`Model did not return JSON plan. Got: ${text.slice(0, 200)}`);
  }
  const json = JSON.parse(text.slice(start, end + 1));
  if (!Array.isArray(json.operations)) {
    throw new Error("Plan missing operations array");
  }
  const { operations, warnings } = validateOperations(json.operations);
  return {
    summary: json.summary || "Applied edits",
    operations,
    parseWarnings: warnings,
  };
}

/* ─── Extract ─── */

export async function extractSnapshot(pdfBytes) {
  const forLib = copyBytes(pdfBytes);
  const forText = copyBytes(pdfBytes);

  const doc = await PDFDocument.load(forLib, {
    ignoreEncryption: true,
    updateMetadata: false,
  });
  const pageCount = doc.getPageCount();
  const pageSizes = doc.getPages().map((p) => {
    const { width, height } = p.getSize();
    return { width, height };
  });

  let formFields = [];
  try {
    const form = doc.getForm();
    formFields = form.getFields().map((f) => {
      let value = "";
      try {
        if (typeof f.getText === "function") value = String(f.getText() ?? "");
        else if (typeof f.isChecked === "function") value = String(f.isChecked());
        else if (typeof f.getSelected === "function") {
          const sel = f.getSelected();
          value = Array.isArray(sel) ? sel.join(", ") : String(sel ?? "");
        }
      } catch {
        /* ignore */
      }
      return {
        name: f.getName(),
        type: f.constructor?.name?.replace(/^PDF/, "") ?? "Field",
        value,
      };
    });
  } catch {
    formFields = [];
  }

  const metadata = {
    title: doc.getTitle() || undefined,
    author: doc.getAuthor() || undefined,
    subject: doc.getSubject() || undefined,
    keywords: doc.getKeywords() || undefined,
    creator: doc.getCreator() || undefined,
    producer: doc.getProducer() || undefined,
  };

  let fullText = "";
  let textByPage = [];
  let textItems = [];

  try {
    const loadingTask = pdfjs.getDocument({ data: forText, useSystemFonts: true });
    const pdf = await loadingTask.promise;
    textByPage = [];
    textItems = [];
    let id = 0;

    for (let p = 1; p <= pdf.numPages; p++) {
      const page = await pdf.getPage(p);
      const content = await page.getTextContent();
      const strings = [];
      const pageItems = [];

      for (const item of content.items) {
        if (!item || typeof item.str !== "string" || !item.str.trim()) continue;
        // pdf.js transform: [scaleX, skewY, skewX, scaleY, tx, ty]
        const t = item.transform || [1, 0, 0, 1, 0, 0];
        const x = t[4];
        const y = t[5];
        const fontSize = Math.hypot(t[0], t[1]) || item.height || 12;
        const width = item.width ?? fontSize * item.str.length * 0.5;
        const height = item.height || fontSize;
        pageItems.push({
          id: id++,
          str: item.str,
          x,
          y,
          width,
          height,
          fontSize,
          page: p,
        });
        strings.push(item.str);
      }

      pageItems.sort((a, b) => {
        const dy = Math.abs(a.y - b.y) > 2 ? b.y - a.y : 0;
        if (dy !== 0) return dy > 0 ? 1 : -1;
        return a.x - b.x;
      });
      // re-id after sort for stable reading order in UI
      for (const it of pageItems) {
        it.id = textItems.length;
        textItems.push(it);
      }
      textByPage.push(strings.join(" "));
    }

    fullText = textByPage.join("\n\n--- page break ---\n\n");
  } catch (err) {
    fullText = `(text extraction failed: ${err instanceof Error ? err.message : String(err)})`;
    textByPage = Array.from({ length: pageCount }, () => "");
  }

  return {
    pageCount,
    pageSizes,
    textByPage,
    fullText,
    textItems,
    formFields,
    metadata,
  };
}

/**
 * Compact snapshot for LLM context.
 * No hard product character cap — only a soft safety ceiling for API body size
 * (default 400k chars ≈ large invoices). Pass maxChars: Infinity to disable.
 */
export function snapshotForPrompt(snapshot, maxChars = 400_000) {
  const lines = [];
  lines.push(`Pages: ${snapshot.pageCount}`);
  lines.push(
    `Page sizes: ${snapshot.pageSizes.map((s, i) => `p${i + 1}=${Math.round(s.width)}x${Math.round(s.height)}`).join(", ")}`,
  );
  if (Object.values(snapshot.metadata || {}).some(Boolean)) {
    lines.push(`Metadata: ${JSON.stringify(snapshot.metadata)}`);
  }
  if (snapshot.formFields?.length) {
    lines.push(
      `Form fields: ${snapshot.formFields.map((f) => `${f.name}(${f.type})=${JSON.stringify(f.value)}`).join("; ")}`,
    );
  }

  if (snapshot.textItems?.length) {
    // All numbered lines — no 200-line cap for client-side (user pays own tokens)
    const numbered = snapshot.textItems
      .map(
        (t) =>
          `#${t.id} [p${t.page} size=${Math.round(t.fontSize)}] ${JSON.stringify(String(t.str).slice(0, 200))}`,
      )
      .join("\n");
    lines.push(
      `\nEditable lines (reading order: top→bottom, left→right). ` +
        `Format: #id [pN size=S] "text". ` +
        `If the same text appears more than once, replace_line MUST set id (or itemIndex among matches on that page) or apply will SKIP:\n${numbered}`,
    );
  }

  let textBudget =
    maxChars === Infinity
      ? Number.MAX_SAFE_INTEGER
      : maxChars - lines.join("\n").length - 200;

  for (let i = 0; i < snapshot.textByPage.length; i++) {
    const pageText = snapshot.textByPage[i] || "(empty)";
    const header = `\n--- Page ${i + 1} ---\n`;
    if (textBudget <= 0) {
      lines.push(`\n... (${snapshot.textByPage.length - i} more pages truncated for prompt size)`);
      break;
    }
    const chunk = pageText.slice(0, textBudget);
    lines.push(header + chunk);
    textBudget -= header.length + chunk.length;
  }

  return lines.join("\n");
}

export function opsFromHumanEdits(input) {
  const operations = [];
  let changed = 0;
  for (const row of input.items || []) {
    if (row.edited === row.original) continue;
    operations.push({
      op: "replace_line",
      id: row.id,
      page: row.page,
      find: row.original,
      replace: row.edited,
      fit: true,
    });
    changed++;
  }
  if (input.metadata && input.originalMetadata) {
    const patch = { op: "set_metadata" };
    let any = false;
    for (const key of ["title", "author", "subject"]) {
      if (
        input.metadata[key] != null &&
        input.metadata[key] !== (input.originalMetadata[key] || "")
      ) {
        patch[key] = input.metadata[key];
        any = true;
      }
    }
    if (any) {
      operations.push(patch);
      changed++;
    }
  }
  return { operations, changed };
}

/* ─── Apply ─── */

function findMatches(items, find, page) {
  const needle = find.toLowerCase();
  return items.filter((it) => {
    if (page != null && it.page !== page) return false;
    return it.str.toLowerCase().includes(needle);
  });
}

/** Absolute minimum draw size when force:true */
const FIT_ABSOLUTE_FLOOR_PT = 5.5;
/** Refuse soft fit below this unless force:true */
const FIT_MIN_READABLE_PT = 8;

/**
 * Measure how small text must go to fit the original run box.
 * Does not draw.
 */
function measureFit(font, item, newText, fit) {
  let size = item.fontSize || 12;
  const origSize = size;
  const boxW = Math.max(item.width, 4);
  if (!newText || fit === false) {
    const w = newText ? font.widthOfTextAtSize(newText, size) : 0;
    return {
      size,
      origSize,
      boxW,
      stillOverflows: w > boxW * 1.02,
      needsBelowReadable: false,
      hitAbsoluteFloor: false,
    };
  }
  let guard = 0;
  while (
    guard++ < 80 &&
    size > FIT_ABSOLUTE_FLOOR_PT &&
    font.widthOfTextAtSize(newText, size) > boxW * 1.02
  ) {
    size -= 0.2;
  }
  if (size < FIT_ABSOLUTE_FLOOR_PT) size = FIT_ABSOLUTE_FLOOR_PT;
  const stillOverflows = font.widthOfTextAtSize(newText, size) > boxW * 1.02;
  const needsBelowReadable =
    size + 0.05 < FIT_MIN_READABLE_PT ||
    (stillOverflows && size <= FIT_MIN_READABLE_PT + 0.05);
  return {
    size,
    origSize,
    boxW,
    stillOverflows,
    needsBelowReadable,
    hitAbsoluteFloor: size <= FIT_ABSOLUTE_FLOOR_PT + 0.05,
  };
}

/**
 * Cover original glyphs and redraw text.
 * When fit=true, cover width stays at the original run box so table cells
 * do not creep into the next column.
 * @param {number} [opts.forcedSize] precomputed size
 */
function coverAndWrite(page, font, item, newText, opts = {}) {
  const pad = 1.2;
  const fit = opts.fit !== false;
  const measured =
    opts.measured ||
    measureFit(font, item, newText, fit && !opts.coverOnly);
  const size =
    opts.forcedSize != null
      ? opts.forcedSize
      : !opts.coverOnly && newText && fit
        ? measured.size
        : item.fontSize || 12;
  const boxW = Math.max(item.width, 4);

  const textWidth =
    newText && !opts.coverOnly ? font.widthOfTextAtSize(newText, size) : 0;
  const coverW = (fit ? boxW : Math.max(boxW, textWidth)) + pad * 2;
  const coverH = Math.max(item.height, item.fontSize || size, size) + pad * 2;

  page.drawRectangle({
    x: item.x - pad,
    y: item.y - pad * 0.6,
    width: coverW,
    height: coverH,
    color: rgb(1, 1, 1),
    borderWidth: 0,
  });

  if (!opts.coverOnly && newText) {
    page.drawText(newText, {
      x: item.x,
      y: item.y,
      size,
      font,
      color: hexToRgb(opts.color),
    });
  }

  return {
    size,
    origSize: measured.origSize,
    stillOverflows:
      !opts.coverOnly &&
      Boolean(newText) &&
      font.widthOfTextAtSize(newText, size) > boxW * 1.02,
    forced: Boolean(opts.force),
  };
}

function describeIds(arr) {
  return (
    arr
      .slice(0, 8)
      .map((t) => `#${t.id}`)
      .join(", ") + (arr.length > 8 ? ", …" : "")
  );
}

/**
 * Resolve which text run a replace_line op targets.
 * Fail closed: multiple matches without id/itemIndex → target null + skipped reason.
 */
function resolveLineTarget(textItems, op) {
  const warnings = [];
  const page = op.page != null ? Number(op.page) : null;
  const find = op.find != null ? String(op.find) : "";
  const findLower = find.toLowerCase();

  const onPage = (t) => page == null || t.page === page;
  const exactFind = (t) => t.str === find;
  const softFind = (t) => find && t.str.toLowerCase().includes(findLower);

  // 1) If id is set and that run exists, id is authoritative: apply only
  //    when find matches that run. Never fall through to another cell.
  if (op.id != null) {
    const byId = textItems.find((t) => t.id === op.id);
    if (byId) {
      if (exactFind(byId) || softFind(byId)) {
        return { target: byId, warnings, skipped: null };
      }
      return {
        target: null,
        warnings,
        skipped: `SKIPPED replace_line: id #${op.id} text did not match find "${find}"`,
      };
    }
  }

  // 2) exact string match on page
  const same = textItems.filter((t) => onPage(t) && exactFind(t));
  if (same.length) {
    if (op.itemIndex != null && same[op.itemIndex]) {
      return { target: same[op.itemIndex], warnings, skipped: null };
    }
    if (same.length === 1) {
      return { target: same[0], warnings, skipped: null };
    }
    // Fail closed — do not silently pick same[0]
    return {
      target: null,
      warnings,
      skipped: `SKIPPED replace_line: ${same.length} exact matches for "${find}" on page ${page ?? "any"} (ids ${describeIds(same)}). Pass id or itemIndex for one cell, or replace_text with all:true to change every match.`,
    };
  }

  // 3) substring match
  const soft = textItems.filter((t) => onPage(t) && softFind(t));
  if (!soft.length) return { target: null, warnings, skipped: null };
  if (op.itemIndex != null && soft[op.itemIndex]) {
    return { target: soft[op.itemIndex], warnings, skipped: null };
  }
  if (soft.length === 1) return { target: soft[0], warnings, skipped: null };
  return {
    target: null,
    warnings,
    skipped: `SKIPPED replace_line: ${soft.length} substring matches for "${find}" on page ${page ?? "any"} (ids ${describeIds(soft)}). Pass id or itemIndex to disambiguate.`,
  };
}

/**
 * Decide whether to draw after measureFit.
 * Returns { ok, size, refuseReason, metrics }.
 */
function decideFit(font, item, newText, op) {
  const fit = op.fit !== false;
  const force = op.force === true;
  const metrics = measureFit(font, item, newText, fit);
  if (!fit || !newText) {
    return { ok: true, size: metrics.size, refuseReason: null, metrics };
  }
  if (metrics.needsBelowReadable && !force) {
    return {
      ok: false,
      size: metrics.size,
      refuseReason: `SKIPPED: replacement needs ~${metrics.size.toFixed(1)}pt to fit (min readable ${FIT_MIN_READABLE_PT}pt). Shorten the text, use a wider field, or set force:true to allow crush.`,
      metrics,
    };
  }
  // force path: clamp draw size to absolute floor
  let size = metrics.size;
  if (force && size < FIT_ABSOLUTE_FLOOR_PT) size = FIT_ABSOLUTE_FLOOR_PT;
  if (force && metrics.needsBelowReadable) {
    // draw at min(readable floor attempt, absolute) — use computed size
    size = Math.max(metrics.size, FIT_ABSOLUTE_FLOOR_PT);
  }
  return { ok: true, size, refuseReason: null, metrics, force };
}

/** Build replacement string: splice find→replace inside the run; never drop labels. */
function lineReplaceText(runStr, find, replace) {
  if (runStr == null) return replace;
  const s = String(runStr);
  const f = String(find ?? "");
  const r = String(replace ?? "");
  if (!f) return r;
  if (s === f) return r;
  if (s.toLowerCase().includes(f.toLowerCase())) {
    return s.replace(new RegExp(escapeRegExp(f), "gi"), r);
  }
  // No substring match — only then replace the whole run
  return r;
}

/**
 * Apply surgical ops to a PDF.
 *
 * @param {Uint8Array} pdfBytes
 * @param {object[]} operations
 * @param {object} [options] **Agent / programmatic API only** (human UI passes nothing).
 * @param {boolean} [options.failOnSkip=false] Throw if any SKIPPED / refused op
 * @param {number} [options.maxOps] Cap op count (default 200)
 * @param {number} [options.requireApplied] Require at least N applied ops
 * @returns {Promise<{ bytes: Uint8Array, applied: string[], warnings: string[], skipped: string[] }>}
 */
export async function applyOperations(pdfBytes, operations, options = {}) {
  const failOnSkip = options.failOnSkip === true;
  const requireApplied =
    options.requireApplied != null ? Number(options.requireApplied) : null;
  const { operations: ops, warnings: valWarnings } = validateOperations(
    operations,
    { maxOps: options.maxOps },
  );
  const applied = [];
  const warnings = [...valWarnings];
  const skipped = [];

  const recordSkip = (msg) => {
    const text = String(msg);
    if (!warnings.includes(text)) warnings.push(text);
    if (!skipped.includes(text)) skipped.push(text);
  };

  for (const w of valWarnings) {
    if (typeof w === "string" && /skipped/i.test(w)) recordSkip(w);
  }

  const snapshot = await extractSnapshot(pdfBytes);
  const textItems = snapshot.textItems;
  const source = copyBytes(pdfBytes);

  const doc = await PDFDocument.load(source, { ignoreEncryption: true });
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const fontBold = await doc.embedFont(StandardFonts.HelveticaBold);

  const contentOps = ops.filter((o) => o.op !== "delete_pages");
  const deleteOps = ops.filter((o) => o.op === "delete_pages");

  for (const op of contentOps) {
    const appliedBefore = applied.length;
    const skippedBefore = skipped.length;
    try {
      switch (op.op) {
        case "replace_line": {
          const resolved = resolveLineTarget(textItems, op);
          warnings.push(...resolved.warnings);
          if (resolved.skipped) {
            warnings.push(resolved.skipped);
            skipped.push(resolved.skipped);
            break;
          }
          const target = resolved.target;
          if (!target) {
            const msg =
              `SKIPPED replace_line: no match for "${op.find}" on page ${op.page}` +
              (op.id != null ? ` (id #${op.id} text did not match find)` : "");
            warnings.push(msg);
            skipped.push(msg);
            break;
          }
          if (
            op.id != null &&
            target.id !== op.id &&
            textItems.some((t) => t.id === op.id)
          ) {
            warnings.push(
              `replace_line: id #${op.id} did not match find "${op.find}"; used #${target.id} by text`,
            );
          }
          const idx = pageIndex(target.page, doc.getPageCount());
          if (idx == null) break;
          const newStr = lineReplaceText(target.str, op.find, op.replace);
          const decision = decideFit(font, target, newStr, op);
          if (!decision.ok) {
            const msg = `SKIPPED replace_line #${target.id}: ${decision.refuseReason}`;
            warnings.push(msg);
            skipped.push(msg);
            break;
          }
          const metrics = coverAndWrite(doc.getPage(idx), font, target, newStr, {
            fit: op.fit !== false,
            force: op.force === true,
            forcedSize: decision.size,
            measured: decision.metrics,
          });
          if (op.force && decision.metrics?.needsBelowReadable) {
            warnings.push(
              `replace_line #${target.id}: force:true drew at ${metrics.size.toFixed(1)}pt (below ${FIT_MIN_READABLE_PT}pt readable min)`,
            );
          } else if (metrics.size < (decision.metrics?.origSize || metrics.size) - 1.5) {
            warnings.push(
              `replace_line #${target.id}: shrunk ${decision.metrics.origSize.toFixed(1)}pt → ${metrics.size.toFixed(1)}pt to fit`,
            );
          }
          applied.push(
            `replace_line #${target.id} p${target.page}: "${String(target.str).slice(0, 48)}" → "${String(newStr).slice(0, 48)}"`,
          );
          break;
        }
        case "replace_text": {
          const matches = findMatches(textItems, op.find, op.page);
          if (!matches.length) {
            const msg = `SKIPPED replace_text: no match for "${op.find}"`;
            warnings.push(msg);
            skipped.push(msg);
            break;
          }
          // Fail closed: multiple hits require all:true (every match) or use replace_line + id
          if (matches.length > 1 && op.all !== true) {
            const msg =
              `SKIPPED replace_text: ${matches.length} matches for "${op.find}" (ids ${describeIds(matches)}). Set all:true to change every occurrence, or use replace_line with id/itemIndex for one cell.`;
            warnings.push(msg);
            skipped.push(msg);
            break;
          }
          const targets = matches;
          let hit = 0;
          for (const m of targets) {
            const idx = pageIndex(m.page, doc.getPageCount());
            if (idx == null) continue;
            let newStr = m.str;
            if (m.str.toLowerCase().includes(op.find.toLowerCase())) {
              const re = new RegExp(escapeRegExp(op.find), "gi");
              newStr = m.str.replace(re, op.replace);
            } else {
              newStr = op.replace;
            }
            const decision = decideFit(font, m, newStr, op);
            if (!decision.ok) {
              warnings.push(`replace_text #${m.id}: ${decision.refuseReason}`);
              continue;
            }
            const metrics = coverAndWrite(doc.getPage(idx), font, m, newStr, {
              fit: op.fit !== false,
              force: op.force === true,
              forcedSize: decision.size,
              measured: decision.metrics,
            });
            if (op.force && decision.metrics?.needsBelowReadable) {
              warnings.push(
                `replace_text #${m.id}: force:true drew at ${metrics.size.toFixed(1)}pt`,
              );
            }
            hit++;
          }
          if (hit) {
            applied.push(
              `replace_text "${op.find}" → "${op.replace}" (${hit} hits)`,
            );
          }
          break;
        }
        case "cover": {
          const matches = findMatches(textItems, op.find, op.page);
          if (!matches.length) {
            warnings.push(`cover: no match for "${op.find}"`);
            break;
          }
          let targets = matches;
          if (op.id != null) {
            targets = matches.filter((m) => m.id === op.id);
            if (!targets.length) {
              const msg = `SKIPPED cover: id #${op.id} did not match find "${op.find}"`;
              warnings.push(msg);
              skipped.push(msg);
              break;
            }
          } else if (op.itemIndex != null) {
            if (matches[op.itemIndex]) {
              targets = [matches[op.itemIndex]];
            } else {
              const msg =
                `SKIPPED cover: itemIndex ${op.itemIndex} out of range for "${op.find}" (${matches.length} hits)`;
              warnings.push(msg);
              skipped.push(msg);
              break;
            }
          } else if (matches.length > 1 && op.all !== true) {
            const msg =
              `SKIPPED cover: ${matches.length} matches for "${op.find}" (ids ${describeIds(matches)}). Set all:true to cover every occurrence, or pass id/itemIndex for one cell.`;
            warnings.push(msg);
            skipped.push(msg);
            break;
          }
          for (const m of targets) {
            const idx = pageIndex(m.page, doc.getPageCount());
            if (idx == null) continue;
            coverAndWrite(doc.getPage(idx), font, m, "", { coverOnly: true });
          }
          applied.push(
            `cover "${op.find}" (${targets.length} hits: visual only, not forensic redaction)`,
          );
          break;
        }
        case "add_text": {
          const idx = pageIndex(op.page, doc.getPageCount());
          if (idx == null) {
            warnings.push(`add_text: invalid page ${op.page}`);
            break;
          }
          doc.getPage(idx).drawText(op.text, {
            x: op.x,
            y: op.y,
            size: op.size ?? 12,
            font,
            color: hexToRgb(op.color),
          });
          applied.push(`add_text on page ${op.page}`);
          break;
        }
        case "watermark": {
          const text = op.text;
          const size = op.size ?? 48;
          const angle = op.angle ?? -35;
          const opacity = op.opacity ?? 0.15;
          for (const page of doc.getPages()) {
            const { width, height } = page.getSize();
            const tw = fontBold.widthOfTextAtSize(text, size);
            page.drawText(text, {
              x: Math.max(24, (width - tw) / 2),
              y: height / 2,
              size,
              font: fontBold,
              color: rgb(0.5, 0.5, 0.5),
              opacity,
              rotate: degrees(angle),
            });
          }
          applied.push(`watermark "${text}"`);
          break;
        }
        case "set_metadata": {
          if (op.title != null) doc.setTitle(op.title);
          if (op.author != null) doc.setAuthor(op.author);
          if (op.subject != null) doc.setSubject(op.subject);
          if (op.keywords != null) doc.setKeywords(op.keywords);
          if (op.creator != null) doc.setCreator(op.creator);
          doc.setModificationDate(new Date());
          applied.push("set_metadata");
          break;
        }
        case "fill_form": {
          try {
            const form = doc.getForm();
            let filled = 0;
            for (const [name, value] of Object.entries(op.fields)) {
              try {
                const field = form.getField(name);
                if (typeof value === "boolean" && typeof field.check === "function") {
                  if (value) field.check();
                  else field.uncheck?.();
                  filled++;
                } else if (typeof field.setText === "function") {
                  field.setText(String(value));
                  filled++;
                } else if (typeof field.select === "function") {
                  field.select(String(value));
                  filled++;
                } else {
                  warnings.push(`fill_form: unsupported field type for "${name}"`);
                }
              } catch {
                warnings.push(`fill_form: field not found "${name}"`);
              }
            }
            if (filled) {
              applied.push(`fill_form (${filled} fields)`);
            } else {
              recordSkip("SKIPPED fill_form: no fields changed");
            }
          } catch (e) {
            recordSkip(
              `SKIPPED fill_form: ${e instanceof Error ? e.message : String(e)}`,
            );
          }
          break;
        }
        case "rotate_pages": {
          let rotated = 0;
          for (const p of op.pages) {
            const idx = pageIndex(p, doc.getPageCount());
            if (idx == null) {
              warnings.push(`rotate_pages: invalid page ${p}`);
              continue;
            }
            const page = doc.getPage(idx);
            const current = page.getRotation().angle;
            page.setRotation(degrees((current + op.degrees) % 360));
            rotated++;
          }
          if (rotated) {
            applied.push(`rotate_pages ${op.pages.join(",")} by ${op.degrees}°`);
          } else {
            recordSkip("SKIPPED rotate_pages: no pages changed");
          }
          break;
        }
        case "draw_rect": {
          const idx = pageIndex(op.page, doc.getPageCount());
          if (idx == null) {
            warnings.push(`draw_rect: invalid page ${op.page}`);
            break;
          }
          const color = hexToRgb(op.color ?? "#000000");
          doc.getPage(idx).drawRectangle({
            x: op.x,
            y: op.y,
            width: op.width,
            height: op.height,
            color: op.fill !== false ? color : undefined,
            borderColor: color,
            borderWidth: op.fill === false ? 1 : 0,
            opacity: op.opacity ?? 1,
          });
          applied.push(`draw_rect on page ${op.page}`);
          break;
        }
        default:
          recordSkip(`SKIPPED ${op.op}: unknown op`);
      }
    } catch (e) {
      recordSkip(
        `SKIPPED ${op.op}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    if (applied.length === appliedBefore && skipped.length === skippedBefore) {
      recordSkip(`SKIPPED ${op.op}: did not apply`);
    }
  }

  for (const op of deleteOps) {
    const appliedBefore = applied.length;
    const skippedBefore = skipped.length;
    const sorted = [...new Set(op.pages)].sort((a, b) => b - a);
    let removed = 0;
    for (const p of sorted) {
      const idx = pageIndex(p, doc.getPageCount());
      if (idx == null) {
        warnings.push(`delete_pages: invalid page ${p}`);
        continue;
      }
      doc.removePage(idx);
      removed++;
    }
    if (removed) {
      applied.push(`delete_pages ${op.pages.join(",")}`);
    } else {
      recordSkip("SKIPPED delete_pages: no pages changed");
    }
    if (applied.length === appliedBefore && skipped.length === skippedBefore) {
      recordSkip("SKIPPED delete_pages: did not apply");
    }
  }

  // Once per apply: disclose cover-and-redraw semantics (not content-stream delete)
  if (
    applied.some((a) => a.startsWith("replace_line") || a.startsWith("replace_text")) &&
    !warnings.some((w) => w.includes("extractable"))
  ) {
    warnings.push(
      "Note: replace_line/replace_text paint a white cover + new glyphs; original text may still be extractable (search, copy, pdftotext, screen readers). Not forensic redaction. Prefer careful review for legal/financial PDFs.",
    );
  }

  const bytes = await doc.save();

  // Harvest every dropped/no-op, including validateOperations lowercase "skipped"
  for (const w of warnings) {
    if (typeof w === "string" && /skipped/i.test(w) && !skipped.includes(w)) {
      skipped.push(w);
    }
  }

  if (requireApplied != null && applied.length < requireApplied) {
    const err = new Error(
      `requireApplied=${requireApplied} but only ${applied.length} applied. skipped=${skipped.length}`,
    );
    err.patchpdf = { applied, warnings, skipped };
    throw err;
  }
  if (failOnSkip && skipped.length) {
    const err = new Error(
      `failOnSkip: ${skipped.length} op(s) skipped. First: ${skipped[0]}`,
    );
    err.patchpdf = { applied, warnings, skipped };
    throw err;
  }

  return { bytes, applied, warnings, skipped };
}

/* ─── Agent / programmatic API (not used by the human demo UI) ─── */

/**
 * Stable line map for agents: id + page + text + box + font size.
 * Prefer this over re-extracting ad hoc every time.
 *
 * @param {Uint8Array} pdfBytes
 * @param {{ maxStr?: number }} [options]
 * @returns {Promise<object>}
 */
export async function buildPatchmap(pdfBytes, options = {}) {
  const maxStr = options.maxStr != null ? Number(options.maxStr) : 500;
  const snap = await extractSnapshot(pdfBytes);
  const lines = (snap.textItems || []).map((t) => ({
    id: t.id,
    page: t.page,
    str: String(t.str || "").slice(0, maxStr),
    x: round4(t.x),
    y: round4(t.y),
    width: round4(t.width),
    height: round4(t.height ?? t.fontSize),
    fontSize: round4(t.fontSize),
  }));
  return {
    version: 1,
    kind: "patchpdf.patchmap",
    generatedAt: new Date().toISOString(),
    pageCount: snap.pageCount,
    pageSizes: snap.pageSizes,
    nLines: lines.length,
    lines,
    note:
      "Agent API: use line id + find for replace_line. Human UI does not load this file.",
  };
}

function round4(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return n;
  return Math.round(x * 10000) / 10000;
}

/**
 * Machine verification after patch (visible *and* extractable text caveats apply).
 * For cover-paint edits, old substrings may still appear in extract — use
 * `contains` for new text; treat `notContains` as soft unless strictExtract.
 *
 * @param {Uint8Array} pdfBytes
 * @param {object} spec
 * @param {string[]} [spec.contains] Must appear in extracted fullText
 * @param {string[]} [spec.notContains] Should not appear (warn or fail)
 * @param {boolean} [spec.strictExtract=false] Fail notContains even though cover-paint leaves old glyphs
 * @returns {Promise<{ ok: boolean, fullText: string, missing: string[], stillPresent: string[], warnings: string[] }>}
 */
export async function verifyPdfText(pdfBytes, spec = {}) {
  const snap = await extractSnapshot(pdfBytes);
  const fullText = snap.fullText || "";
  const contains = Array.isArray(spec.contains) ? spec.contains : [];
  const notContains = Array.isArray(spec.notContains) ? spec.notContains : [];
  const strictExtract = spec.strictExtract === true;
  const missing = [];
  const stillPresent = [];
  const warnings = [];

  for (const s of contains) {
    if (!s) continue;
    if (!fullText.includes(s)) missing.push(s);
  }
  for (const s of notContains) {
    if (!s) continue;
    if (fullText.includes(s)) stillPresent.push(s);
  }

  if (stillPresent.length && !strictExtract) {
    warnings.push(
      "notContains still found in extract — expected for visual cover-paint (old glyphs remain). Use strictExtract:true only if you need extract purity, or regen for forensic text.",
    );
  }

  const ok =
    missing.length === 0 &&
    (strictExtract ? stillPresent.length === 0 : true);

  return { ok, fullText, missing, stillPresent, warnings, pageCount: snap.pageCount };
}

/**
 * One-shot agent entry: apply ops with fail-closed defaults, optional verify.
 * Prefer over full regen for fact/label fixes (layout fidelity). Not always
 * faster in wall-clock than a minimal pdf-lib/HTML redraw — see AGENT_API.md.
 *
 * Human UI never calls this — browser demo keeps using applyOperations(bytes, ops).
 *
 * @param {Uint8Array} pdfBytes
 * @param {object} request
 * @param {object[]} request.operations
 * @param {boolean} [request.failOnSkip=true]
 * @param {number} [request.maxOps=32]
 * @param {number} [request.requireApplied]
 * @param {{ contains?: string[], notContains?: string[], strictExtract?: boolean }} [request.verify]
 * @returns {Promise<object>}
 */
export async function patchPdfAgent(pdfBytes, request = {}) {
  const operations = request.operations;
  if (!Array.isArray(operations) || !operations.length) {
    throw new Error("patchPdfAgent: operations[] required");
  }
  const failOnSkip = request.failOnSkip !== false; // default true for agents
  const maxOps = request.maxOps != null ? Number(request.maxOps) : 32;

  const result = await applyOperations(pdfBytes, operations, {
    failOnSkip,
    maxOps,
    requireApplied: request.requireApplied,
  });

  let verify = null;
  if (request.verify && typeof request.verify === "object") {
    verify = await verifyPdfText(result.bytes, request.verify);
    if (!verify.ok) {
      const err = new Error(
        `patchPdfAgent verify failed: missing=${JSON.stringify(verify.missing)} stillPresent=${JSON.stringify(verify.stillPresent)}`,
      );
      err.patchpdf = { ...result, verify };
      throw err;
    }
  }

  return {
    bytes: result.bytes,
    applied: result.applied,
    warnings: result.warnings,
    skipped: result.skipped,
    verify,
    mode: "agent",
  };
}


export function parseLocalOps(instruction) {
  const ops = [];
  const lower = instruction.toLowerCase();

  const rep =
    instruction.match(/replace\s+["'](.+?)["']\s+with\s+["'](.+?)["']/i) ||
    instruction.match(/change\s+["'](.+?)["']\s+to\s+["'](.+?)["']/i) ||
    instruction.match(/find\s+["'](.+?)["']\s+replace(?:\s+with)?\s+["'](.+?)["']/i);
  if (rep) {
    ops.push({
      op: "replace_text",
      find: rep[1],
      replace: rep[2],
      all: true,
      fit: true,
    });
  }

  const wm = instruction.match(/watermark\s+["'](.+?)["']/i);
  if (wm) ops.push({ op: "watermark", text: wm[1] });

  const title = instruction.match(/title\s+["'](.+?)["']/i);
  if (title) ops.push({ op: "set_metadata", title: title[1] });

  const del = instruction.match(/delete\s+pages?\s+([\d,\s-]+)/i);
  if (del) {
    const pages = parsePageList(del[1]);
    if (pages.length) ops.push({ op: "delete_pages", pages });
  }

  if (lower.includes("confidential") && lower.includes("watermark") && !wm) {
    ops.push({ op: "watermark", text: "CONFIDENTIAL" });
  }

  return ops;
}

export async function applyLocalInstruction(pdfBytes, instruction) {
  const ops = parseLocalOps(instruction);
  if (!ops.length) return null;
  const result = await applyOperations(pdfBytes, ops);
  return { ...result, operations: ops };
}

/* ─── AI plan (browser → provider; optional same-origin proxy for CORS) ─── */

const SYSTEM = `You are a PDF surgical editor for the patchpdf tool.
Given a PDF content snapshot and a user instruction, output ONLY a JSON object (no markdown fences) with this shape:
{
  "summary": "one-line description of the edit",
  "operations": [ ... ]
}

Available operations (use only these):
1. replace_line — PREFERRED for single fields/cells.
   { "op":"replace_line", "page":1, "find":"exact snippet from snapshot", "replace":"new snippet", "fit":true, "id": <number from #id>, "itemIndex"?: number, "force"?: false }
   force:true allows font crush below 8pt; otherwise too-long cell text is SKIPPED.
2. replace_text — { "op":"replace_text", "find":"snippet", "replace":"new", "page"?:1, "all"?:true, "fit"?:true, "force"?:false }
   Multiple matches require all:true or the op is SKIPPED. Prefer replace_line + id for one cell.
3. cover — visual whiteout only (NOT forensic redaction). { "op":"cover", "find":"text", "page"?:number, "all"?:true, "id"?:number, "itemIndex"?:number }
   Multiple matches require all:true or id/itemIndex or the op is SKIPPED.
4. add_text — { "op":"add_text", "page":1, "x":number, "y":number, "text":"...", "size"?:12, "color"?:"#111111" }
5. watermark — { "op":"watermark", "text":"CONFIDENTIAL", "opacity"?:0.15, "angle"?:-35, "size"?:48 }
6. set_metadata — { "op":"set_metadata", "title"?:string, "author"?:string, "subject"?:string, "keywords"?:string[] }
7. fill_form — { "op":"fill_form", "fields": { "FieldName": "value" } }
8. delete_pages — { "op":"delete_pages", "pages":[2,3] }
9. rotate_pages — { "op":"rotate_pages", "pages":[1], "degrees":90 }
10. draw_rect — { "op":"draw_rect", "page":1, "x":0, "y":0, "width":100, "height":20, "color"?:"#ffffff", "fill"?:true }

DISAMBIGUATION (critical — engine fail-closed):
- Snapshot lines are listed as "#id [pN size=S] \\"text\\"" in reading order: top-to-bottom, then left-to-right on the same page.
- If the same find string appears more than once on the page (tables: repeated "$500.00", "1", etc.), you MUST include "id" from that #id line for the intended cell. Without id (or itemIndex), the apply step SKIPS the op — it will not guess.
- itemIndex is the 0-based index among matches that share the same find on that page, counting in the same reading order (top-to-bottom, left-to-right). Prefer id over itemIndex when both are available.
- To change EVERY occurrence of a string, use replace_text with "all": true (not one vague replace_line).
- To change several specific cells, emit one replace_line per cell, each with its own id.

Rules:
- Copy "find" exactly from the snapshot text (substring ok if unique in that run, e.g. "Acme Corp" inside "Bill To: Acme Corp").
- Prefer short replacements that fit the original box; do not set force unless the user accepts tiny type.
- Soft edit only: visual cover over old glyphs, not content-stream delete.
- Only change what the user asked. Leave everything else untouched.
- Always set "fit": true for text replacements.
- Never invent pages or invent id numbers not present in the snapshot.
- Output JSON only.`;

async function sameOriginLlmProxyExists(signal) {
  try {
    const probe = await fetch("/api/llm-proxy", {
      method: "HEAD",
      signal,
    });
    return probe.status !== 404;
  } catch {
    return false;
  }
}

async function chatCompletions({
  baseUrl,
  apiKey,
  model,
  headers = {},
  messages,
  timeoutMs = 90_000,
}) {
  const body = JSON.stringify({
    model,
    temperature: 0.1,
    messages,
  });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const directUrl = `${String(baseUrl).replace(/\/$/, "")}/chat/completions`;

  async function post(url, extra = {}) {
    return fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        ...headers,
        ...extra,
      },
      body,
      signal: controller.signal,
    });
  }

  try {
    let res;
    const proxyHeaders = {
      "X-Patchpdf-Base-Url": String(baseUrl).replace(/\/$/, ""),
    };
    // This repo does not ship /api/llm-proxy. Use it only when the host exists.
    const useProxy = await sameOriginLlmProxyExists(controller.signal);
    if (useProxy) {
      res = await post("/api/llm-proxy", proxyHeaders);
      if (res.status === 404) {
        res = await post(directUrl);
      }
    } else {
      try {
        res = await post(directUrl);
      } catch (directErr) {
        throw new Error(
          `Could not reach ${baseUrl}. Enable CORS on the provider, or host ` +
            `/api/llm-proxy on this origin. ` +
            `(${directErr instanceof Error ? directErr.message : directErr})`,
        );
      }
    }

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new Error(
        `LLM API ${res.status}: ${errText.slice(0, 400) || res.statusText}`,
      );
    }

    const data = await res.json();
    return data.choices?.[0]?.message?.content ?? "";
  } finally {
    clearTimeout(timer);
  }
}

export async function planEdits({
  apiKey,
  model,
  baseUrl,
  headers = {},
  instruction,
  snapshot,
  maxChars = 400_000,
}) {
  if (!apiKey) {
    throw new Error("API key required for AI planning (or use Local patterns / line editor).");
  }
  if (!baseUrl) {
    throw new Error("baseUrl required for AI planning.");
  }

  const content = await chatCompletions({
    baseUrl,
    apiKey,
    model: model || "gpt-4.1-mini",
    headers,
    messages: [
      { role: "system", content: SYSTEM },
      {
        role: "user",
        content:
          `PDF SNAPSHOT:\n${snapshotForPrompt(snapshot, maxChars)}\n\n` +
          `USER INSTRUCTION:\n${instruction}\n\n` +
          `Return the JSON edit plan only.\n` +
          `Use replace_line with fit:true. Copy find from the snapshot.\n` +
          `If any find string is not unique on that page (common in tables), you MUST set id from the #id list ` +
          `(or itemIndex among matches, top-to-bottom then left-to-right). Missing disambiguation → op skipped.\n` +
          `For every occurrence of a value, use replace_text with all:true instead of one ambiguous replace_line.`,
      },
    ],
  });

  return parsePlan(content);
}

export async function editPdf({
  pdfBytes,
  instruction,
  apiKey,
  model,
  baseUrl,
  headers,
  profile = "local",
  localOnly = false,
  plan,
  maxChars = 400_000,
  dryRun = false,
}) {
  const snapshot = await extractSnapshot(pdfBytes);
  const prof = BUILTIN_PROFILES[profile] || BUILTIN_PROFILES.local;

  if (plan) {
    const { operations } = validateOperations(plan.operations || []);
    if (dryRun) {
      return {
        bytes: pdfBytes,
        applied: [],
        warnings: [],
        plan: { summary: plan.summary || "Dry run", operations },
        snapshot,
        mode: "plan",
        profileId: profile,
      };
    }
    const result = await applyOperations(pdfBytes, operations);
    return {
      ...result,
      plan: { summary: plan.summary || "Applied plan", operations },
      snapshot,
      mode: "plan",
      profileId: profile,
    };
  }

  const hasKey = Boolean(apiKey || prof.defaultApiKey);
  if (!localOnly && prof.kind === "openai-compatible" && !hasKey) {
    throw new Error(
      "API key required for this OpenAI-compatible profile. Refusing local-pattern fallback.",
    );
  }

  const useAi =
    !localOnly &&
    prof.kind !== "local" &&
    hasKey &&
    Boolean(baseUrl || prof.baseUrl);

  if (useAi) {
    const planned = await planEdits({
      apiKey: apiKey || prof.defaultApiKey || "",
      model: model || prof.model,
      baseUrl: baseUrl || prof.baseUrl,
      headers: { ...(prof.headers || {}), ...(headers || {}) },
      instruction,
      snapshot,
      maxChars,
    });
    if (dryRun) {
      return {
        bytes: pdfBytes,
        applied: [],
        warnings: planned.parseWarnings || [],
        plan: planned,
        snapshot,
        mode: "ai",
        profileId: prof.id,
      };
    }
    const result = await applyOperations(pdfBytes, planned.operations);
    return {
      ...result,
      warnings: [...(planned.parseWarnings || []), ...result.warnings],
      plan: planned,
      snapshot,
      mode: "ai",
      profileId: prof.id,
    };
  }

  const localOps = parseLocalOps(instruction);
  if (dryRun) {
    if (!localOps.length) {
      throw new Error(
        "No AI credentials and instruction did not match local patterns.\n" +
          'Try: replace "old" with "new" | watermark "DRAFT" | delete pages 2 | Or pick a provider + API key.',
      );
    }
    return {
      bytes: pdfBytes,
      applied: [],
      skipped: [],
      warnings: [],
      plan: {
        summary: "Dry run (local patterns; not applied)",
        operations: localOps,
      },
      snapshot,
      mode: "local",
      profileId: profile,
    };
  }

  const local = await applyLocalInstruction(pdfBytes, instruction);
  if (local) {
    return {
      bytes: local.bytes,
      applied: local.applied,
      skipped: local.skipped || [],
      warnings: local.warnings,
      plan: {
        summary: local.applied.join("; ") || "Local pattern edit",
        operations: local.operations,
      },
      snapshot,
      mode: "local",
      profileId: "local",
    };
  }

  throw new Error(
    "No AI credentials and instruction did not match local patterns.\n" +
      'Try: replace "old" with "new" | watermark "DRAFT" | delete pages 2 | Or pick a provider + API key.',
  );
}

/* ─── DOCX export (geometry → Word; never invents content) ───
 *
 * Only text that exists in the PDF is emitted. Layout is inferred from
 * measured positions: page size, margins, vertical gaps, horizontal gaps
 * (2-column tables when a baseline has a wide split), font-size hierarchy
 * relative to the page median, and label/value bolding from original strings.
 *
 * Does NOT regenerate prose. Does NOT call an LLM.
 */

const PT_TO_TWIP = 20;
const NO_BORDER = {
  top: { style: BorderStyle.NONE, size: 0, color: "FFFFFF" },
  bottom: { style: BorderStyle.NONE, size: 0, color: "FFFFFF" },
  left: { style: BorderStyle.NONE, size: 0, color: "FFFFFF" },
  right: { style: BorderStyle.NONE, size: 0, color: "FFFFFF" },
};

function groupIntoLines(items, page) {
  const pageItems = items
    .filter((t) => t.page === page && t.str.trim())
    .slice()
    .sort((a, b) => {
      if (Math.abs(a.y - b.y) > 1.5) return b.y - a.y;
      return a.x - b.x;
    });

  const lines = [];
  for (const it of pageItems) {
    const threshold = Math.max(3, (it.fontSize || 12) * 0.45);
    const last = lines[lines.length - 1];
    if (last && Math.abs(last.y - it.y) <= threshold) {
      last.runs.push({
        str: it.str,
        x: it.x,
        width: it.width || 0,
        fontSize: it.fontSize || 12,
      });
      last.minX = Math.min(last.minX, it.x);
      last.maxX = Math.max(last.maxX, it.x + (it.width || 0));
      last.fontSize = Math.max(last.fontSize, it.fontSize || 12);
      last.y = (last.y + it.y) / 2;
    } else {
      lines.push({
        page,
        y: it.y,
        fontSize: it.fontSize || 12,
        minX: it.x,
        maxX: it.x + (it.width || 0),
        runs: [
          {
            str: it.str,
            x: it.x,
            width: it.width || 0,
            fontSize: it.fontSize || 12,
          },
        ],
      });
    }
  }
  for (const line of lines) line.runs.sort((a, b) => a.x - b.x);
  return lines;
}

function estimateWidth(str, fontSize) {
  return str.length * fontSize * 0.5;
}

function median(nums) {
  if (!nums.length) return 11;
  const s = [...nums].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Split a baseline into left/right columns when a large X gap exists. */
function splitLineColumns(line) {
  const runs = line.runs;
  if (runs.length < 2) return null;
  let bestI = -1;
  let bestGap = 0;
  for (let i = 0; i < runs.length - 1; i++) {
    const left = runs[i];
    const right = runs[i + 1];
    const leftEnd =
      left.x + (left.width > 1 ? left.width : estimateWidth(left.str, left.fontSize));
    const gap = right.x - leftEnd;
    if (gap > bestGap) {
      bestGap = gap;
      bestI = i;
    }
  }
  // Wide enough gap = two visual columns on the same baseline
  if (bestI < 0 || bestGap < Math.max(28, line.fontSize * 2.2)) return null;
  const leftRuns = runs.slice(0, bestI + 1);
  const rightRuns = runs.slice(bestI + 1);
  return { leftRuns, rightRuns, gap: bestGap };
}

function joinRunsText(runs) {
  if (!runs.length) return { text: "", fontSize: 11 };
  let text = runs[0].str;
  let fontSize = runs[0].fontSize || 12;
  let xEnd =
    runs[0].x +
    (runs[0].width > 1
      ? runs[0].width
      : estimateWidth(runs[0].str, runs[0].fontSize));
  for (let i = 1; i < runs.length; i++) {
    const r = runs[i];
    const gap = r.x - xEnd;
    const needSpace =
      gap > (r.fontSize || 12) * 0.15 &&
      !text.endsWith(" ") &&
      !r.str.startsWith(" ");
    text += (needSpace ? " " : "") + r.str;
    fontSize = Math.max(fontSize, r.fontSize || 12);
    xEnd =
      r.x + (r.width > 1 ? r.width : estimateWidth(r.str, r.fontSize || 12));
  }
  return { text, fontSize };
}

/** Label/value heuristics from the *original* string only. */
function styleFromText(text, fontSize, bodyMedian) {
  const t = text.trim();
  const ratio = fontSize / (bodyMedian || 11);
  const isTitle =
    ratio >= 1.45 && t.length > 0 && t.length < 48 && !/[.!?]$/.test(t);
  const isSub =
    !isTitle && ratio >= 1.15 && t.length > 0 && t.length < 72;
  const labelMatch = t.match(
    /^((?:Bill\s*To|Ship\s*To|Invoice\s*#?|Date|Amount|Total|Subtotal|Description|From|To|Attn|Account|PO|Order)[:\s#-]*)(.*)$/i,
  );
  const money = /^\$?[\d,]+\.\d{2}$/.test(t) || /^Amount:/i.test(t);
  const allCaps =
    t.length >= 3 &&
    t.length <= 40 &&
    t === t.toUpperCase() &&
    /[A-Z]/.test(t) &&
    !/\d{4}/.test(t);

  let bold = isTitle || isSub || allCaps || money;
  let sizeHalfPts = Math.max(16, Math.round(fontSize * 2));
  if (isTitle) sizeHalfPts = Math.max(sizeHalfPts, Math.round(bodyMedian * 2 * 1.65));
  if (labelMatch && labelMatch[1] && labelMatch[2] !== undefined) {
    return {
      parts: [
        {
          text: labelMatch[1],
          bold: true,
          size: sizeHalfPts,
          font: "Helvetica",
        },
        {
          text: labelMatch[2],
          bold: money,
          size: sizeHalfPts,
          font: money ? "Courier New" : "Helvetica",
        },
      ],
    };
  }
  return {
    parts: [
      {
        text: t,
        bold,
        size: sizeHalfPts,
        font: money ? "Courier New" : "Helvetica",
      },
    ],
  };
}

function runsToParagraphChildren(text, fontSize, bodyMedian) {
  const styled = styleFromText(text, fontSize, bodyMedian);
  return styled.parts
    .filter((p) => p.text != null && p.text !== "")
    .map(
      (p) =>
        new TextRun({
          text: p.text,
          bold: p.bold,
          size: p.size,
          font: p.font,
        }),
    );
}

function spacingBeforeFromGap(prevY, line) {
  if (prevY == null) return 0;
  const gap = prevY - line.y - line.fontSize;
  if (gap <= 2) return 0;
  // Map PDF gap → Word twips; clamp so invoices don't explode
  return Math.round(Math.min(56, Math.max(0, gap * 0.95)) * PT_TO_TWIP);
}

function lineToBlock(line, prevY, pageWidth, leftMarginPt, contentWidthTwips, bodyMedian) {
  const indentPt = Math.max(0, line.minX - leftMarginPt);
  const indentTwips = Math.round(Math.min(indentPt, pageWidth * 0.5) * PT_TO_TWIP);
  const before = spacingBeforeFromGap(prevY, line);
  const cols = splitLineColumns(line);

  if (cols) {
    const left = joinRunsText(cols.leftRuns);
    const right = joinRunsText(cols.rightRuns);
    const leftW = Math.max(
      1200,
      Math.round((contentWidthTwips || 9000) * 0.48),
    );
    const rightW = Math.max(1200, (contentWidthTwips || 9000) - leftW);
    const cellPara = (side, align) =>
      new Paragraph({
        children: runsToParagraphChildren(side.text, side.fontSize, bodyMedian),
        alignment: align,
        spacing: {
          before: 0,
          after: Math.round(line.fontSize * 0.2 * PT_TO_TWIP),
          line: Math.round(Math.max(line.fontSize * 1.25, 12) * PT_TO_TWIP),
          lineRule: "auto",
        },
      });
    return new Table({
      width: { size: contentWidthTwips || leftW + rightW, type: WidthType.DXA },
      columnWidths: [leftW, rightW],
      rows: [
        new TableRow({
          children: [
            new TableCell({
              borders: NO_BORDER,
              width: { size: leftW, type: WidthType.DXA },
              verticalAlign: VerticalAlign.CENTER,
              children: [cellPara(left, AlignmentType.LEFT)],
            }),
            new TableCell({
              borders: NO_BORDER,
              width: { size: rightW, type: WidthType.DXA },
              verticalAlign: VerticalAlign.CENTER,
              children: [cellPara(right, AlignmentType.RIGHT)],
            }),
          ],
        }),
      ],
    });
  }

  const joined = joinRunsText(line.runs);
  const contentMid = (line.minX + line.maxX) / 2;
  let alignment = AlignmentType.LEFT;
  if (line.minX > pageWidth * 0.48 && line.maxX > pageWidth * 0.72) {
    alignment = AlignmentType.RIGHT;
  } else if (
    Math.abs(contentMid - pageWidth / 2) < pageWidth * 0.1 &&
    line.minX > leftMarginPt + 36 &&
    joined.text.length < 48
  ) {
    alignment = AlignmentType.CENTER;
  }

  const ratio = joined.fontSize / (bodyMedian || 11);
  const isTitle = ratio >= 1.45 && joined.text.length < 48;

  return new Paragraph({
    children: runsToParagraphChildren(
      joined.text,
      joined.fontSize,
      bodyMedian,
    ),
    spacing: {
      before: isTitle ? before || Math.round(6 * PT_TO_TWIP) : before,
      after: Math.round((isTitle ? 8 : line.fontSize * 0.22) * PT_TO_TWIP),
      line: Math.round(
        Math.max(line.fontSize * (isTitle ? 1.3 : 1.22), 12) * PT_TO_TWIP,
      ),
      lineRule: "auto",
    },
    indent:
      alignment === AlignmentType.LEFT && indentTwips > 36
        ? { left: indentTwips }
        : undefined,
    alignment,
  });
}

/**
 * @param {Uint8Array} pdfBytes
 * @param {{ title?: string, author?: string, subject?: string, mode?: "layout" }} [options]
 */
export async function exportPdfToDocx(pdfBytes, options = {}) {
  const warnings = [];
  const mode = options.mode || "layout";
  const snapshot = await extractSnapshot(pdfBytes);
  if (options.fromEditedBytes === true) {
    warnings.push(
      "Export extracted from edited PDF bytes. Cover-and-redraw leaves original glyphs in the content stream, so this DOCX may include both original and replacement text. Prefer the in-memory line table when you need only the visible replacement.",
    );
  }

  if (!snapshot.textItems.length && snapshot.fullText) {
    warnings.push(
      "No positioned runs — fell back to plain page text (still original wording).",
    );
  }
  if (!snapshot.textItems.length && !(snapshot.fullText || "").trim()) {
    warnings.push(
      "Little or no extractable text (scan?). Word export needs real text runs.",
    );
  }

  const sections = [];
  let totalLines = 0;

  for (let p = 1; p <= snapshot.pageCount; p++) {
    const size = snapshot.pageSizes[p - 1] || { width: 612, height: 792 };
    const pageWidth = size.width;
    const pageHeight = size.height;

    const pageItems = snapshot.textItems.filter((t) => t.page === p);
    let leftMargin = 54;
    let rightMargin = 54;
    let topMargin = 54;
    let bottomMargin = 54;

    if (pageItems.length) {
      const minX = Math.min(...pageItems.map((t) => t.x));
      const maxX = Math.max(...pageItems.map((t) => t.x + (t.width || 0)));
      const maxY = Math.max(
        ...pageItems.map((t) => t.y + (t.fontSize || 12)),
      );
      const minY = Math.min(...pageItems.map((t) => t.y));
      leftMargin = Math.max(36, Math.min(120, minX));
      rightMargin = Math.max(36, Math.min(120, pageWidth - maxX));
      topMargin = Math.max(36, Math.min(120, pageHeight - maxY));
      bottomMargin = Math.max(36, Math.min(120, minY));
    }

    const contentWidthTwips = Math.round(
      Math.max(200, pageWidth - leftMargin - rightMargin) * PT_TO_TWIP,
    );
    const bodyMedian = median(
      pageItems.map((t) => t.fontSize || 11).filter((n) => n >= 7 && n <= 18),
    );

    let children = [];
    const lines = groupIntoLines(snapshot.textItems, p);

    if (lines.length) {
      let prevY = null;
      for (const line of lines) {
        // Invisible border-width table needs a wrapping paragraph spacing —
        // insert a thin spacer paragraph when vertical gap is large and next is a table
        const block = lineToBlock(
          line,
          prevY,
          pageWidth,
          leftMargin,
          contentWidthTwips,
          bodyMedian,
        );
        const isTable =
          block &&
          (block instanceof Table ||
            block.constructor?.name === "Table" ||
            typeof block.rootKey === "string");
        if (isTable && prevY != null) {
          const gapTwips = spacingBeforeFromGap(prevY, line);
          if (gapTwips > 40) {
            children.push(
              new Paragraph({
                children: [new TextRun({ text: "" })],
                spacing: { before: 0, after: gapTwips },
              }),
            );
          }
        }
        children.push(block);
        prevY = line.y;
        totalLines++;
      }
    } else {
      const text =
        snapshot.textByPage[p - 1] ||
        (p === 1 ? snapshot.fullText : "") ||
        "";
      const plainLines = text.split(/\r?\n/);
      if (!plainLines.length || (plainLines.length === 1 && !plainLines[0])) {
        children.push(
          new Paragraph({ children: [new TextRun({ text: "" })] }),
        );
      } else {
        for (const pl of plainLines) {
          children.push(
            new Paragraph({
              children: runsToParagraphChildren(pl, 11, 11),
              spacing: { after: 80, line: 276, lineRule: "auto" },
            }),
          );
          totalLines++;
        }
      }
      if (!text.trim()) {
        warnings.push(`Page ${p}: empty or image-only.`);
      }
    }

    if (!children.length) {
      children = [new Paragraph({ children: [new TextRun({ text: "" })] })];
    }

    sections.push({
      properties: {
        page: {
          size: {
            width: Math.round(pageWidth * PT_TO_TWIP),
            height: Math.round(pageHeight * PT_TO_TWIP),
          },
          margin: {
            top: Math.round(topMargin * PT_TO_TWIP),
            bottom: Math.round(bottomMargin * PT_TO_TWIP),
            left: Math.round(leftMargin * PT_TO_TWIP),
            right: Math.round(rightMargin * PT_TO_TWIP),
          },
        },
      },
      children,
    });
  }

  const doc = new Document({
    creator: options.author || snapshot.metadata.author || "patchpdf",
    title: options.title || snapshot.metadata.title || "Exported from PDF",
    description:
      options.subject ||
      snapshot.metadata.subject ||
      "Geometry-mapped export from patchpdf (original wording only)",
    sections: sections.length
      ? sections
      : [
          {
            children: [
              new Paragraph({
                children: [
                  new TextRun({ text: "(empty document)", italics: true }),
                ],
              }),
            ],
          },
        ],
  });

  const blob = await Packer.toBlob(doc);
  const ab = await blob.arrayBuffer();
  return {
    bytes: new Uint8Array(ab),
    pages: snapshot.pageCount,
    lines: totalLines,
    mode,
    warnings,
  };
}
