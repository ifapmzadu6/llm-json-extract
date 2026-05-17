// Stress-test: prompt the model in a way more likely to produce
// extra prose, code fences, or example echoes around the answer.

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { extractJson, extractJsonString } from "../dist/index.js";

const PROMPT = `Compare these two fictional video games.

Game A: "Skybound Anglers" - fishing game in the clouds
Game B: "Coral Symphony" - rhythm game underwater

For each, give: title, genre, score (0-100), one_strength, one_weakness.

You may freely explain your reasoning first. After your explanation, output
the FINAL answer as JSON wrapped in <result>...</result>.
Example format (do not copy the values):

<result>
{
  "games": [
    {"title": "Example", "genre": "...", "score": 0, "one_strength": "...", "one_weakness": "..."}
  ]
}
</result>`;

const dir = mkdtempSync(join(tmpdir(), "llmjsonextract-e2e2-"));
const outFile = join(dir, "last.txt");

console.log("→ codex exec (messy prompt) ...");
execFileSync("codex", ["exec", "--skip-git-repo-check", "-o", outFile, PROMPT], {
  stdio: ["ignore", "inherit", "inherit"],
});
const text = readFileSync(outFile, "utf8");

console.log("\n=== raw (last 800 chars) ===");
console.log(text.slice(-800));
console.log("============================\n");

const str = extractJsonString(text);
console.log("extractJsonString length:", str?.length);

const data = extractJson(text);
console.log("extractJson →", JSON.stringify(data, null, 2));

if (!data || typeof data !== "object") throw new Error("expected object");
if (!Array.isArray(data.games) || data.games.length !== 2) {
  throw new Error(`expected 2 games, got ${JSON.stringify(data.games)}`);
}
for (const g of data.games) {
  if (typeof g.title !== "string") throw new Error("title not string");
  if (typeof g.score !== "number") throw new Error("score not number");
}

console.log("\n✅ messy E2E OK — picked the real answer past the example.");

rmSync(dir, { recursive: true, force: true });
