#!/usr/bin/env node
import { main } from "./cli-core.js";

// `llm-json-extract big.txt | head` closes stdout early. That is the reader's
// choice, not a failure, so stop quietly instead of printing an EPIPE trace.
process.stdout.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EPIPE") process.exit(process.exitCode ?? 0);
  throw err;
});

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
