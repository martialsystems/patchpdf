import assert from "node:assert/strict";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { loadEngine } from "./load-engine.mjs";

const engine = await loadEngine();
const {
  applyOperations,
  extractSnapshot,
  sortReadingOrder,
  coverRect,
  lineReplaceText,
  planActivityMessage,
} = engine;

function assertEqual(actual, expected, label) {
  assert.equal(actual, expected, label);
}

async function pdfWithLines(lines) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([612, 792]);
  for (const line of lines) {
    page.drawText(line.text, {
      x: line.x ?? 72,
      y: line.y ?? 700,
      size: line.size ?? 12,
      font,
    });
  }
  return doc.save();
}

async function stampedPdf() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const created = new Date(Date.UTC(2020, 0, 2, 3, 4, 5));
  doc.setTitle("Keep me");
  doc.setAuthor("Ada");
  doc.setProducer("Acme Press");
  doc.setCreator("Acme");
  doc.setCreationDate(created);
  doc.setModificationDate(created);
  const page = doc.addPage();
  page.drawText("Hello", { x: 72, y: 700, size: 12, font });
  return { bytes: await doc.save(), created };
}

const failures = [];
async function check(name, fn) {
  try {
    await fn();
    console.log(`ok ${name}`);
  } catch (err) {
    failures.push(name);
    console.error(`FAIL ${name}`);
    console.error(err);
  }
}

await check("reading order does not chain 2pt gaps", async () => {
  const items = [
    { n: "Bill", y: 100, x: 10 },
    { n: "Invoice", y: 100, x: 10 },
    { n: "BRIDGE", y: 101.6, x: 10 },
    { n: "To", y: 101.6, x: 10 },
    { n: "Date", y: 103.2, x: 10 },
  ];
  const names = sortReadingOrder(items).map((item) => item.n);
  assert.deepEqual(names, ["Date", "BRIDGE", "To", "Bill", "Invoice"]);
});

await check("cover box includes Helvetica descent", async () => {
  const rect = coverRect(
    { x: 10, y: 100, width: 40, height: 12, fontSize: 12 },
    12,
    { fit: true, textWidth: 40 },
  );
  const descent = 12 * 0.207;
  assert.ok(rect.y <= 100 - descent, `bottom ${rect.y} should cover descent`);
  assert.ok(rect.y + rect.height >= 100 + 12, "top should clear the em square");
});

await check("replacement dollars stay literal", async () => {
  assertEqual(lineReplaceText("Total price", "price", "$$500"), "Total $$500");
  assertEqual(lineReplaceText("Acme", "Acme", "$$500"), "$$500");
  assertEqual(lineReplaceText("hello world", "hello", "$'"), "$' world");
  assertEqual(lineReplaceText("Pay $100 now", "100", "$$"), "Pay $$$ now");
});

await check("plan copy names the text snapshot when a provider is used", async () => {
  const cloud = planActivityMessage({
    dryRun: true,
    localOnly: false,
    kind: "openai-compatible",
    apiKey: "sk-test",
    baseUrl: "https://example.test/v1",
  });
  assert.match(cloud, /extracted text snapshot is sent/);
  assert.doesNotMatch(cloud, /never leaves/i);
  const apply = planActivityMessage({
    dryRun: false,
    localOnly: false,
    kind: "openai-compatible",
    apiKey: "sk-test",
    baseUrl: "https://example.test/v1",
  });
  assert.match(apply, /extracted text snapshot is sent/);
  const local = planActivityMessage({
    dryRun: true,
    localOnly: true,
    kind: "local",
    apiKey: "",
    baseUrl: "",
  });
  assert.match(local, /local patterns/);
  assert.doesNotMatch(local, /sent to the provider/);
});

await check("apply does not rewrite producer or creation date", async () => {
  const { bytes, created } = await stampedPdf();
  const result = await applyOperations(bytes, []);
  const again = await PDFDocument.load(result.bytes, { updateMetadata: false });
  assertEqual(again.getProducer(), "Acme Press");
  assertEqual(again.getCreator(), "Acme");
  assertEqual(again.getTitle(), "Keep me");
  assertEqual(again.getCreationDate().getTime(), created.getTime());
  assertEqual(again.getModificationDate().getTime(), created.getTime());
});

await check("bad keywords skip the whole metadata op", async () => {
  const { bytes } = await stampedPdf();
  const result = await applyOperations(bytes, [
    { op: "set_metadata", title: "New title", keywords: "nope" },
  ]);
  assert.ok(result.skipped.some((line) => /keywords/.test(line)));
  const again = await PDFDocument.load(result.bytes, { updateMetadata: false });
  assertEqual(again.getTitle(), "Keep me");
  assertEqual(again.getAuthor(), "Ada");
});

await check("valid metadata still writes and keeps the producer", async () => {
  const { bytes, created } = await stampedPdf();
  const result = await applyOperations(bytes, [
    { op: "set_metadata", title: "New title", keywords: ["invoice", "2020"] },
  ]);
  assert.ok(result.applied.includes("set_metadata"));
  const again = await PDFDocument.load(result.bytes, { updateMetadata: false });
  assertEqual(again.getTitle(), "New title");
  assertEqual(again.getKeywords(), "invoice 2020");
  assertEqual(again.getProducer(), "Acme Press");
  assertEqual(again.getAuthor(), "Ada");
  assertEqual(again.getCreationDate().getTime(), created.getTime());
  assert.ok(again.getModificationDate().getTime() !== created.getTime());
});

await check("later delete_pages keeps original page numbers", async () => {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const label of ["P1", "P2", "P3", "P4"]) {
    const page = doc.addPage();
    page.drawText(label, { x: 72, y: 720, size: 24, font });
  }
  const result = await applyOperations(await doc.save(), [
    { op: "delete_pages", pages: [1] },
    { op: "delete_pages", pages: [2] },
  ]);
  const snap = await extractSnapshot(result.bytes);
  assertEqual(snap.error, null);
  assertEqual(snap.pageCount, 2);
  const text = snap.textItems.map((item) => item.str).join(" ");
  assert.match(text, /P3/);
  assert.match(text, /P4/);
  assert.doesNotMatch(text, /P1/);
  assert.doesNotMatch(text, /P2/);
});

await check("one delete_pages op still removes that original page", async () => {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const label of ["P1", "P2", "P3"]) {
    const page = doc.addPage();
    page.drawText(label, { x: 72, y: 720, size: 24, font });
  }
  const result = await applyOperations(await doc.save(), [
    { op: "delete_pages", pages: [1] },
  ]);
  const snap = await extractSnapshot(result.bytes);
  assertEqual(snap.pageCount, 2);
  const text = snap.textItems.map((item) => item.str).join(" ");
  assert.match(text, /P2/);
  assert.match(text, /P3/);
  assert.doesNotMatch(text, /P1/);
});

await check("out of range itemIndex does not edit the only match", async () => {
  const bytes = await pdfWithLines([{ text: "Only", x: 72, y: 700, size: 18 }]);
  const result = await applyOperations(bytes, [
    { op: "replace_line", find: "Only", replace: "Gone", itemIndex: 5, fit: true },
  ]);
  assert.ok(result.skipped.some((line) => /itemIndex 5/.test(line)), result.skipped.join("\n"));
  const snap = await extractSnapshot(result.bytes);
  const texts = snap.textItems.map((item) => item.str);
  assert.ok(texts.includes("Only"), texts.join("|"));
  assert.ok(!texts.some((text) => text.includes("Gone")), texts.join("|"));
  const nan = await applyOperations(bytes, [
    { op: "replace_line", find: "Only", replace: "Gone", itemIndex: Number.NaN, fit: true },
  ]);
  assert.ok(nan.skipped.some((line) => /itemIndex/.test(line)), nan.skipped.join("\n"));
  const afterNan = await extractSnapshot(nan.bytes);
  assert.ok(afterNan.textItems.some((item) => item.str.includes("Only")));
  assert.ok(!afterNan.textItems.some((item) => item.str.includes("Gone")));
});

await check("substring replacement keeps dollar patterns in the PDF", async () => {
  const bytes = await pdfWithLines([{ text: "Total price", x: 72, y: 700, size: 18 }]);
  const result = await applyOperations(bytes, [
    { op: "replace_text", find: "price", replace: "$$500", all: true, fit: true },
  ]);
  assert.ok(result.applied.some((line) => line.startsWith("replace_text")));
  const snap = await extractSnapshot(result.bytes);
  const texts = snap.textItems.map((item) => item.str);
  assert.ok(
    texts.some((text) => text.includes("$$500")),
    `drawn text missing $$500: ${texts.join("|")}`,
  );
  assert.ok(!texts.some((text) => text === "Total $500"), texts.join("|"));
});

await check("itemIndex 0 still edits the first match", async () => {
  const bytes = await pdfWithLines([{ text: "Only", x: 72, y: 700, size: 18 }]);
  const result = await applyOperations(bytes, [
    { op: "replace_line", find: "Only", replace: "Gone", itemIndex: 0, fit: true },
  ]);
  assert.ok(result.applied.some((line) => line.startsWith("replace_line")));
  const snap = await extractSnapshot(result.bytes);
  const texts = snap.textItems.map((item) => item.str);
  assert.ok(texts.some((text) => text.includes("Gone")), texts.join("|"));
});

await check("text extract failure is an error, not an empty success", async () => {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage();
  page.drawText("Hello", { x: 72, y: 700, size: 12, font });
  // pdf-lib loads this with ignoreEncryption. pdf.js rejects the algorithm.
  doc.context.trailerInfo.Encrypt = doc.context.obj({
    Filter: "Standard",
    V: 99,
    R: 2,
    P: -4,
    Length: 40,
    O: "0123456789abcdef0123456789abcdef",
    U: "0123456789abcdef0123456789abcdef",
  });
  const broken = await doc.save();
  const healthy = await pdfWithLines([{ text: "Hello", x: 72, y: 700, size: 12 }]);
  const okSnap = await extractSnapshot(healthy);
  assert.equal(okSnap.error, null);
  assert.ok(okSnap.textItems.some((item) => item.str.includes("Hello")));
  const snap = await extractSnapshot(broken);
  assert.match(snap.error, /text extraction failed/);
  assert.deepEqual(snap.textItems, []);
  assert.equal(snap.fullText, "");
  await assert.rejects(() => applyOperations(broken, []));
});

if (failures.length) {
  console.error(`${failures.length} failed`);
  process.exit(1);
}
console.log("all checks passed");
