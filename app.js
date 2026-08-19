/**
 * patchpdf playground: fully client-side
 * Copyright (c) 2026 Martial Systems LLC.
 */

import {
  listProfiles,
  extractSnapshot,
  applyOperations,
  opsFromHumanEdits,
  editPdf,
  exportPdfToDocx,
  BUILTIN_PROFILES,
} from "./engine.js";

const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];

const state = {
  tab: "safe",
  fileName: null,
  pdfBytes: null,
  snapshot: null,
  lines: [],
  meta: { title: "", author: "", subject: "" },
  origMeta: { title: "", author: "", subject: "" },
  sourceUrl: null,
  outUrl: null,
  editedBytes: null,
  preview: "original",
  busy: false,
  lastPlan: null,
  profile: "local",
  apiKey: "",
  customBase: "",
  customModel: "",
};

const els = {
  tabSafe: $("#tab-safe"),
  tabAi: $("#tab-ai"),
  panelSafe: $("#panel-safe"),
  panelAi: $("#panel-ai"),
  fileInput: $("#file-input"),
  fileLabel: $("#file-label"),
  btnSample: $("#btn-sample"),
  lineList: $("#line-list"),
  pageFilter: $("#page-filter"),
  lineQuery: $("#line-query"),
  dirtyOnly: $("#dirty-only"),
  dirtyBadge: $("#dirty-badge"),
  metaTitle: $("#meta-title"),
  metaAuthor: $("#meta-author"),
  metaSubject: $("#meta-subject"),
  btnApplyLines: $("#btn-apply-lines"),
  btnResetLines: $("#btn-reset-lines"),
  instruction: $("#instruction"),
  profile: $("#profile"),
  apiKey: $("#api-key"),
  showKey: $("#show-key"),
  customFields: $("#custom-fields"),
  customBase: $("#custom-base"),
  customModel: $("#custom-model"),
  btnPlan: $("#btn-plan"),
  btnApplyPlan: $("#btn-apply-plan"),
  btnRunAi: $("#btn-run-ai"),
  planBox: $("#plan-box"),
  presets: $("#presets"),
  msg: $("#msg"),
  resultBox: $("#result-box"),
  previewFrame: $("#preview-frame"),
  btnOrig: $("#btn-preview-orig"),
  btnEdited: $("#btn-preview-edited"),
  btnDownload: $("#btn-download"),
  btnDocx: $("#btn-docx"),
  statusLines: $("#status-lines"),
};

function setMsg(text, kind = "info") {
  if (!text) {
    els.msg.hidden = true;
    els.msg.textContent = "";
    els.msg.className = "msg";
    return;
  }
  els.msg.hidden = false;
  els.msg.textContent = text;
  els.msg.className = `msg msg-${kind}`;
}

function setBusy(busy) {
  state.busy = busy;
  $$("button, input, select, textarea").forEach((el) => {
    if (el.dataset.keepEnabled) return;
    if (el.id === "show-key") return;
    if (busy && (el.tagName === "BUTTON" || el.type === "file")) {
      el.disabled = true;
    } else if (!busy && (el.tagName === "BUTTON" || el.type === "file")) {
      el.disabled = false;
    }
  });
  // re-apply preview button state
  els.btnEdited.disabled = !state.outUrl;
  els.btnDownload.disabled = !state.editedBytes;
  els.btnApplyPlan.disabled = !state.lastPlan?.operations?.length;
}

function revoke(url) {
  if (url) URL.revokeObjectURL(url);
}

function bytesToUrl(bytes, mime = "application/pdf") {
  return URL.createObjectURL(new Blob([bytes], { type: mime }));
}

function downloadBytes(bytes, name, mime) {
  const url = bytesToUrl(bytes, mime);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function dirtyCount() {
  let n = state.lines.filter((l) => l.edited !== l.original).length;
  if (state.meta.title !== state.origMeta.title) n++;
  if (state.meta.author !== state.origMeta.author) n++;
  if (state.meta.subject !== state.origMeta.subject) n++;
  return n;
}

function updateDirtyBadge() {
  const n = dirtyCount();
  if (n) {
    els.dirtyBadge.hidden = false;
    els.dirtyBadge.textContent = `${n} changed`;
  } else {
    els.dirtyBadge.hidden = true;
  }
}

function setTab(tab) {
  state.tab = tab;
  els.tabSafe.setAttribute("aria-selected", tab === "safe" ? "true" : "false");
  els.tabAi.setAttribute("aria-selected", tab === "ai" ? "true" : "false");
  els.panelSafe.hidden = tab !== "safe";
  els.panelAi.hidden = tab !== "ai";
}

function setPreview(which) {
  state.preview = which;
  els.btnOrig.setAttribute("aria-pressed", which === "original" ? "true" : "false");
  els.btnEdited.setAttribute("aria-pressed", which === "edited" ? "true" : "false");
  const url =
    which === "edited" && state.outUrl ? state.outUrl : state.sourceUrl;
  if (url) {
    els.previewFrame.src = url;
    els.previewFrame.hidden = false;
  }
}

function storeEdited(bytes) {
  state.editedBytes = bytes;
  revoke(state.outUrl);
  state.outUrl = bytesToUrl(bytes);
  els.btnEdited.disabled = false;
  els.btnDownload.disabled = false;
  setPreview("edited");
}

async function loadPdf(bytes, name) {
  state.fileName = name;
  state.pdfBytes = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  state.editedBytes = null;
  state.lastPlan = null;
  els.planBox.textContent = "";
  els.btnApplyPlan.disabled = true;
  revoke(state.outUrl);
  state.outUrl = null;
  revoke(state.sourceUrl);
  state.sourceUrl = bytesToUrl(state.pdfBytes);
  els.fileLabel.textContent = name;

  const snap = await extractSnapshot(state.pdfBytes);
  state.snapshot = snap;
  state.lines = (snap.textItems || []).map((t) => ({
    id: t.id,
    page: t.page,
    original: t.str,
    edited: t.str,
    fontSize: t.fontSize,
  }));
  state.meta = {
    title: snap.metadata.title || "",
    author: snap.metadata.author || "",
    subject: snap.metadata.subject || "",
  };
  state.origMeta = { ...state.meta };
  els.metaTitle.value = state.meta.title;
  els.metaAuthor.value = state.meta.author;
  els.metaSubject.value = state.meta.subject;

  // page filter options
  const pages = [...new Set(state.lines.map((l) => l.page))].sort((a, b) => a - b);
  els.pageFilter.innerHTML =
    `<option value="all">All pages</option>` +
    pages.map((p) => `<option value="${p}">Page ${p}</option>`).join("");

  renderLines();
  setPreview("original");
  els.statusLines.textContent = `${snap.pageCount} page(s) · ${state.lines.length} runs · local extract complete`;
  setMsg(null);
  els.resultBox.textContent = "";
}

function renderLines() {
  const q = els.lineQuery.value.trim().toLowerCase();
  const page = els.pageFilter.value;
  const dirtyOnly = els.dirtyOnly.checked;

  const visible = state.lines.filter((l) => {
    if (dirtyOnly && l.edited === l.original) return false;
    if (page !== "all" && String(l.page) !== page) return false;
    if (!q) return true;
    return (
      l.original.toLowerCase().includes(q) ||
      l.edited.toLowerCase().includes(q) ||
      String(l.id) === q
    );
  });

  els.lineList.innerHTML = "";
  const frag = document.createDocumentFragment();
  for (const l of visible) {
    const row = document.createElement("div");
    row.className = "line-row" + (l.edited !== l.original ? " dirty" : "");
    row.innerHTML = `
      <span class="line-id">#${l.id}</span>
      <span class="line-page">p${l.page}</span>
      <input type="text" data-id="${l.id}" value="" spellcheck="false" />
    `;
    const input = row.querySelector("input");
    input.value = l.edited;
    input.addEventListener("input", () => {
      const target = state.lines.find((x) => x.id === l.id);
      if (target) {
        target.edited = input.value;
        row.classList.toggle("dirty", target.edited !== target.original);
        updateDirtyBadge();
      }
    });
    frag.appendChild(row);
  }
  if (!visible.length) {
    const empty = document.createElement("p");
    empty.className = "hint";
    empty.textContent = state.lines.length
      ? "No lines match this filter."
      : "Load a PDF to list editable text runs.";
    frag.appendChild(empty);
  }
  els.lineList.appendChild(frag);
  updateDirtyBadge();
}

function showResult(result) {
  const parts = [];
  if (result.mode) parts.push(`mode: ${result.mode}`);
  if (result.profileId) parts.push(`profile: ${result.profileId}`);
  if (result.plan?.summary) parts.push(result.plan.summary);
  if (result.applied?.length) parts.push("applied: " + result.applied.join("; "));
  if (result.skipped?.length) parts.push("skipped: " + result.skipped.join("; "));
  if (result.warnings?.length) parts.push("warnings: " + result.warnings.join("; "));
  els.resultBox.textContent = parts.join("\n");
  if (result.plan) {
    state.lastPlan = result.plan;
    els.planBox.textContent = JSON.stringify(result.plan, null, 2);
    els.btnApplyPlan.disabled = !result.plan.operations?.length;
  }
}

function appliedNothing(result) {
  return (result.skipped?.length || 0) > 0 && !(result.applied?.length);
}

async function applyHuman() {
  if (!state.pdfBytes) {
    setMsg("Load a PDF first", "error");
    return;
  }
  if (dirtyCount() === 0) {
    setMsg("Change at least one line or metadata field", "error");
    return;
  }
  setBusy(true);
  setMsg("Applying line edits in your browser…", "info");
  try {
    const { operations, changed } = opsFromHumanEdits({
      items: state.lines.map((l) => ({
        id: l.id,
        page: l.page,
        original: l.original,
        edited: l.edited,
      })),
      metadata: state.meta,
      originalMetadata: state.origMeta,
    });
    const result = await applyOperations(state.pdfBytes, operations);
    showResult({
      mode: "human",
      plan: { summary: `Updated ${changed} field(s)`, operations },
      applied: result.applied,
      skipped: result.skipped,
      warnings: result.warnings,
    });
    if (appliedNothing(result)) {
      setMsg(result.skipped[0] || "Nothing applied", "error");
    } else {
      storeEdited(result.bytes);
      setMsg(
        `Applied ${result.applied?.length || changed} change(s). Layout preserved where possible.`,
        "ok",
      );
    }
  } catch (e) {
    setMsg(e instanceof Error ? e.message : String(e), "error");
  } finally {
    setBusy(false);
  }
}

function profileOpts() {
  const id = state.profile;
  const prof = BUILTIN_PROFILES[id] || BUILTIN_PROFILES.local;
  const baseUrl =
    id === "custom"
      ? state.customBase || prof.baseUrl
      : els.customBase?.value && id === "custom"
        ? els.customBase.value
        : prof.baseUrl;
  const model =
    id === "custom"
      ? state.customModel || prof.model
      : prof.model;
  return {
    profile: id,
    apiKey: state.apiKey || prof.defaultApiKey || "",
    baseUrl,
    model,
    localOnly: id === "local",
    headers: prof.headers || {},
  };
}

async function runAi({ dryRun }) {
  if (!state.pdfBytes) {
    setMsg("Load a PDF first", "error");
    return;
  }
  const instruction = els.instruction.value.trim();
  if (!instruction) {
    setMsg("Enter an instruction", "error");
    return;
  }
  setBusy(true);
  setMsg(
    dryRun
      ? "Planning with your provider (PDF never leaves the browser)…"
      : "Planning + applying…",
    "info",
  );
  try {
    const opts = profileOpts();
    const result = await editPdf({
      pdfBytes: state.pdfBytes,
      instruction,
      ...opts,
      dryRun,
      maxChars: 400_000,
    });
    showResult(result);
    if (dryRun) {
      setMsg(
        `Plan ready (${result.plan?.operations?.length || 0} ops). Review, then Apply plan.`,
        "ok",
      );
    } else if (appliedNothing(result)) {
      setMsg(result.skipped[0] || "Nothing applied", "error");
    } else {
      if (result.bytes) storeEdited(result.bytes);
      setMsg(result.plan?.summary || "Done", "ok");
    }
  } catch (e) {
    setMsg(e instanceof Error ? e.message : String(e), "error");
  } finally {
    setBusy(false);
  }
}

async function applyStoredPlan() {
  if (!state.pdfBytes || !state.lastPlan?.operations?.length) {
    setMsg("No plan to apply", "error");
    return;
  }
  setBusy(true);
  try {
    const result = await applyOperations(state.pdfBytes, state.lastPlan.operations);
    showResult({
      mode: "plan",
      plan: state.lastPlan,
      applied: result.applied,
      skipped: result.skipped,
      warnings: result.warnings,
    });
    if (appliedNothing(result)) {
      setMsg(result.skipped[0] || "Nothing applied", "error");
    } else {
      storeEdited(result.bytes);
      setMsg("Plan applied.", "ok");
    }
  } catch (e) {
    setMsg(e instanceof Error ? e.message : String(e), "error");
  } finally {
    setBusy(false);
  }
}

async function exportDocx() {
  const bytes =
    state.preview === "edited" && state.editedBytes
      ? state.editedBytes
      : state.pdfBytes;
  if (!bytes) {
    setMsg("Load a PDF first", "error");
    return;
  }
  setBusy(true);
  setMsg("Exporting DOCX in your browser…", "info");
  try {
    const fromEdited = state.preview === "edited" && !!state.editedBytes;
    const result = await exportPdfToDocx(bytes, {
      title: state.meta.title || undefined,
      author: state.meta.author || undefined,
      fromEditedBytes: fromEdited,
    });
    const base = (state.fileName || "document").replace(/\.pdf$/i, "");
    downloadBytes(
      result.bytes,
      `${base}.docx`,
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
    setMsg(
      `DOCX: ${result.pages} page(s), ${result.lines} line(s) from the PDF’s own text geometry. ` +
        `No rewrite: download the PDF when layout has to stay exact.` +
        (result.warnings.length
          ? " " + result.warnings.join(" ")
          : ""),
      "ok",
    );
  } catch (e) {
    setMsg(e instanceof Error ? e.message : String(e), "error");
  } finally {
    setBusy(false);
  }
}

function persistKey() {
  try {
    if (state.apiKey) sessionStorage.setItem("patchpdf-key", state.apiKey);
    else sessionStorage.removeItem("patchpdf-key");
    sessionStorage.setItem("patchpdf-profile", state.profile);
  } catch {
    /* ignore */
  }
}

function initProfiles() {
  const profiles = listProfiles();
  els.profile.innerHTML = profiles
    .map((p) => `<option value="${p.id}">${p.label}</option>`)
    .join("");
  try {
    const savedP = sessionStorage.getItem("patchpdf-profile");
    const savedK = sessionStorage.getItem("patchpdf-key");
    if (savedP) state.profile = savedP;
    if (savedK) state.apiKey = savedK;
  } catch {
    /* ignore */
  }
  els.profile.value = state.profile;
  els.apiKey.value = state.apiKey;
  toggleCustom();
}

function toggleCustom() {
  const show = state.profile === "custom";
  els.customFields.hidden = !show;
  const needsKey = state.profile !== "local" && state.profile !== "ollama";
  els.apiKey.closest("label").style.opacity = state.profile === "local" ? "0.5" : "1";
  void needsKey;
}

function wire() {
  els.tabSafe.addEventListener("click", () => setTab("safe"));
  els.tabAi.addEventListener("click", () => setTab("ai"));

  els.fileInput.addEventListener("change", async () => {
    const f = els.fileInput.files?.[0];
    if (!f) return;
    setBusy(true);
    try {
      await loadPdf(new Uint8Array(await f.arrayBuffer()), f.name);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e), "error");
    } finally {
      setBusy(false);
    }
  });

  els.btnSample.addEventListener("click", async () => {
    setBusy(true);
    try {
      const res = await fetch("./sample-invoice.pdf");
      if (!res.ok) throw new Error("Sample PDF missing");
      await loadPdf(new Uint8Array(await res.arrayBuffer()), "sample-invoice.pdf");
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e), "error");
    } finally {
      setBusy(false);
    }
  });

  els.pageFilter.addEventListener("change", renderLines);
  els.lineQuery.addEventListener("input", renderLines);
  els.dirtyOnly.addEventListener("change", renderLines);

  for (const [el, key] of [
    [els.metaTitle, "title"],
    [els.metaAuthor, "author"],
    [els.metaSubject, "subject"],
  ]) {
    el.addEventListener("input", () => {
      state.meta[key] = el.value;
      updateDirtyBadge();
    });
  }

  els.btnApplyLines.addEventListener("click", () => void applyHuman());
  els.btnResetLines.addEventListener("click", () => {
    state.lines = state.lines.map((l) => ({ ...l, edited: l.original }));
    state.meta = { ...state.origMeta };
    els.metaTitle.value = state.meta.title;
    els.metaAuthor.value = state.meta.author;
    els.metaSubject.value = state.meta.subject;
    renderLines();
    setMsg("Line edits reset", "info");
  });

  els.profile.addEventListener("change", () => {
    state.profile = els.profile.value;
    toggleCustom();
    persistKey();
  });
  els.apiKey.addEventListener("input", () => {
    state.apiKey = els.apiKey.value.trim();
    persistKey();
  });
  els.showKey.addEventListener("change", () => {
    els.apiKey.type = els.showKey.checked ? "text" : "password";
  });
  els.customBase.addEventListener("input", () => {
    state.customBase = els.customBase.value.trim();
  });
  els.customModel.addEventListener("input", () => {
    state.customModel = els.customModel.value.trim();
  });

  els.btnPlan.addEventListener("click", () => void runAi({ dryRun: true }));
  els.btnRunAi.addEventListener("click", () => void runAi({ dryRun: false }));
  els.btnApplyPlan.addEventListener("click", () => void applyStoredPlan());

  els.presets.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-preset]");
    if (!btn) return;
    els.instruction.value = btn.getAttribute("data-preset") || "";
  });

  els.btnOrig.addEventListener("click", () => setPreview("original"));
  els.btnEdited.addEventListener("click", () => {
    if (state.outUrl) setPreview("edited");
  });
  els.btnDownload.addEventListener("click", () => {
    if (!state.editedBytes) return;
    const base = (state.fileName || "document").replace(/\.pdf$/i, "");
    downloadBytes(state.editedBytes, `${base}.edited.pdf`, "application/pdf");
  });
  els.btnDocx.addEventListener("click", () => void exportDocx());
}

initProfiles();
wire();
setTab("safe");
// Auto-load sample for first paint
els.btnSample.click();
