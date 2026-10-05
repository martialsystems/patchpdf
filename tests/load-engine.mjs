/**
 * Load ../engine.js under Node by rewriting CDN ESM imports to npm packages.
 */
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENGINE_SRC = path.resolve(__dirname, "../engine.js");
const CACHE_DIR = path.join(__dirname, ".cache");
const CACHE_FILE = path.join(CACHE_DIR, "engine.generated.mjs");
const require = createRequire(import.meta.url);

function workerSrcLiteral() {
  const candidates = [
    "pdfjs-dist/legacy/build/pdf.worker.mjs",
    "pdfjs-dist/build/pdf.worker.mjs",
  ];
  for (const spec of candidates) {
    try {
      const resolved = require.resolve(spec);
      return JSON.stringify(pathToFileURL(resolved).href);
    } catch {
      /* try next */
    }
  }
  return '""';
}

function rewrite(source) {
  let s = source;
  s = s.replace(
    /from\s+["']https:\/\/cdn\.jsdelivr\.net\/npm\/pdf-lib@[^"']+["']/g,
    'from "pdf-lib"',
  );
  s = s.replace(
    /from\s+["']https:\/\/cdn\.jsdelivr\.net\/npm\/pdfjs-dist@[^"']+\/build\/pdf\.min\.mjs["']/g,
    'from "pdfjs-dist/legacy/build/pdf.mjs"',
  );
  s = s.replace(
    /from\s+["']https:\/\/cdn\.jsdelivr\.net\/npm\/docx@[^"']+["']/g,
    'from "docx"',
  );
  const worker = workerSrcLiteral();
  s = s.replace(
    /pdfjs\.GlobalWorkerOptions\.workerSrc\s*=\s*[^;]+;/g,
    `pdfjs.GlobalWorkerOptions.workerSrc = ${worker};`,
  );
  return s;
}

export async function loadEngine() {
  const raw = fs.readFileSync(ENGINE_SRC, "utf8");
  const hash = createHash("sha256").update(raw).digest("hex").slice(0, 16);
  const stamped = `/* generated from engine.js sha256=${hash} */\n${rewrite(raw)}\n`;
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  let needWrite = true;
  if (fs.existsSync(CACHE_FILE)) {
    const prev = fs.readFileSync(CACHE_FILE, "utf8");
    if (prev === stamped) needWrite = false;
  }
  if (needWrite) fs.writeFileSync(CACHE_FILE, stamped, "utf8");
  return import(pathToFileURL(CACHE_FILE).href);
}
