// Measures what an agent would actually receive if raw SessionEntry were exposed,
// and how long a full open() takes on the largest file.
// Run: node scratch/raw-exposure-measure.mjs
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { statSync } from "node:fs";

const all = await SessionManager.listAll();
const biggest = all.map((s) => ({ ...s, bytes: statSync(s.path).size })).sort((a, b) => b.bytes - a.bytes)[0];

// Timing: full open() parse cost, by file size.
const t0 = performance.now();
const bm = SessionManager.open(biggest.path);
const openMs = Math.round(performance.now() - t0);
const biggestEntries = bm.getEntries().length;

let rawBytes = 0;
let visibleBytes = 0;
let thinkingBytes = 0;
let signatureBytes = 0;
let imageCount = 0;
let imageBytes = 0;
let detailsBytes = 0;
let nestedBytes = 0;
let diagnostics = 0;
let toolCalls = 0;

const TEXTY = (c) => (typeof c === "string" ? c : (c ?? []).filter((b) => b.type === "text").map((b) => b.text).join(""));

for (const s of all) {
  const m = SessionManager.open(s.path);
  for (const e of m.getEntries()) {
    const json = JSON.stringify(e);
    rawBytes += json.length;
    if (e.type !== "message") continue;
    const msg = e.message;
    visibleBytes += TEXTY(msg.content).length;
    if (Array.isArray(msg.content)) {
      for (const b of msg.content) {
        if (b.type === "thinking") thinkingBytes += (b.thinking?.length ?? 0) + (b.thinkingSignature?.length ?? 0);
        if (b.type === "text") signatureBytes += b.textSignature?.length ?? 0;
        if (b.type === "image") { imageCount++; imageBytes += (b.data?.length ?? 0) + b.mimeType.length; }
        if (b.type === "toolCall") { toolCalls++; signatureBytes += b.thoughtSignature?.length ?? 0; }
      }
    }
    if (msg.role === "toolResult") {
      detailsBytes += msg.details ? JSON.stringify(msg.details).length : 0;
      nestedBytes += msg.nestedCalls ? JSON.stringify(msg.nestedCalls).length : 0;
    }
    if (msg.role === "assistant") {
      diagnostics += msg.diagnostics ? JSON.stringify(msg.diagnostics).length : 0;
      signatureBytes += 0;
    }
  }
}

const mb = (n) => +(n / 1048576).toFixed(2);
console.log(JSON.stringify({
  store: mb(all.reduce((n, s) => n + statSync(s.path).size, 0)),
  rawSerializedMB: mb(rawBytes),
  openCostMs_biggestFile: openMs,
  biggestFileMB: mb(biggest.bytes),
  biggestFileEntries: biggestEntries,
  humanVisibleTextMB: mb(visibleBytes),
  neverUsefulToAgent: {
    thinkingMB: mb(thinkingBytes),
    opaqueSignaturesMB: mb(signatureBytes),
    toolResultDetailsMB: mb(detailsBytes),
    nestedCallsMB: mb(nestedBytes),
    diagnosticsMB: mb(diagnostics),
    imageBlocks: imageCount,
    imageBase64MB: mb(imageBytes),
  },
  toolCallBlocks: toolCalls,
}, null, 2));
