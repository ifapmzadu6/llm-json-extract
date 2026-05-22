import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const sample = '<result>{"items":["apple","banana"],"count":2}</result>';
const expected = { items: ["apple", "banana"], count: 2 };

const isWindows = process.platform === "win32";
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const tempDir = mkdtempSync(join(tmpdir(), "llm-json-extract-smoke-"));

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    stdio: "inherit",
    ...options,
  });

  if (result.status !== 0) {
    if (result.error !== undefined) throw result.error;
    throw new Error(`${command} ${args.join(" ")} failed with status ${result.status}`);
  }
}

try {
  const npmOptions = { shell: isWindows };

  run(npm, ["pack", "--silent", "--pack-destination", tempDir], npmOptions);

  const { name, version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url)));
  const tarball = join(tempDir, `${name}-${version}.tgz`);
  const consumerDir = join(tempDir, "consumer");

  run(npm, ["init", "--yes"], { cwd: tempDir, ...npmOptions });
  run(npm, ["install", "--ignore-scripts", "--omit=dev", tarball], {
    cwd: tempDir,
    ...npmOptions,
  });

  const esmTest = `
    import assert from "node:assert/strict";
    import { extractJson, extractJsonString } from "${name}";
    const sample = ${JSON.stringify(sample)};
    const expected = ${JSON.stringify(expected)};
    assert.deepEqual(extractJson(sample), expected);
    assert.equal(extractJsonString(sample), ${JSON.stringify('{"items":["apple","banana"],"count":2}')});
  `;

  const cjsTest = `
    const assert = require("node:assert/strict");
    const { extractJson, extractJsonString } = require("${name}");
    const sample = ${JSON.stringify(sample)};
    const expected = ${JSON.stringify(expected)};
    assert.deepEqual(extractJson(sample), expected);
    assert.equal(extractJsonString(sample), ${JSON.stringify('{"items":["apple","banana"],"count":2}')});
  `;

  run(process.execPath, ["-e", "require('node:fs').mkdirSync(process.argv[1])", consumerDir]);
  writeFileSync(join(consumerDir, "esm.mjs"), esmTest);
  writeFileSync(join(consumerDir, "cjs.cjs"), cjsTest);

  run(process.execPath, [join(consumerDir, "esm.mjs")], { cwd: tempDir });
  run(process.execPath, [join(consumerDir, "cjs.cjs")], { cwd: tempDir });
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}
