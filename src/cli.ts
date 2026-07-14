#!/usr/bin/env node
import { main } from "./cli-core.js";

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
