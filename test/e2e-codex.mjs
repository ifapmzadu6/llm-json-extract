// Real-world E2E test against the Codex CLI on this machine.
// Not part of `npm test` — invoke manually with `node test/e2e-codex.mjs`.

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { extractJson, extractJsonString, LlmJsonExtractError } from "../dist/index.js";

const PROMPT = `Output a JSON object describing 3 fictional fruits.
You may think first inside <thinking>...</thinking> if helpful.
Reply with the FINAL answer wrapped in <result>...</result> tags. Schema:
{ "items": [ { "name": string, "color": string, "tasty": boolean } ] }
Reply with nothing after </result>.`;

const dir = mkdtempSync(join(tmpdir(), "llmjsonextract-e2e-"));
const outFile = join(dir, "last.txt");

function run(prompt) {
  console.log("→ codex exec ...");
  execFileSync("codex", ["exec", "--skip-git-repo-check", "-o", outFile, prompt], {
    stdio: ["ignore", "inherit", "inherit"],
  });
  return readFileSync(outFile, "utf8");
}

try {
  const text = run(PROMPT);
  console.log(`\n=== raw output ===\n${text}\n==================\n`);

  const extracted = extractJsonString(text);
  console.log("extractJsonString →", extracted);

  const parsed = extractJson(text);
  console.log("extractJson →", JSON.stringify(parsed, null, 2));

  if (!parsed || typeof parsed !== "object") {
    throw new Error("expected object");
  }
  if (!Array.isArray(parsed.items)) {
    throw new Error("expected items[]");
  }
  for (const item of parsed.items) {
    if (typeof item.name !== "string") throw new Error("item.name not string");
    if (typeof item.color !== "string") throw new Error("item.color not string");
    if (typeof item.tasty !== "boolean") throw new Error("item.tasty not boolean");
  }
  console.log("\n✅ E2E OK — codex output extracted & shape-checked.");
} catch (e) {
  console.error("\n❌ E2E FAILED");
  if (e instanceof LlmJsonExtractError) {
    console.error("  stage:", e.stage);
    console.error("  extracted:", e.extracted);
  }
  console.error(e);
  process.exitCode = 1;
} finally {
  rmSync(dir, { recursive: true, force: true });
}
