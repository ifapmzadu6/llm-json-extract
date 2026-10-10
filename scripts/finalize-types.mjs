import { copyFile, readdir, readFile, rm } from "node:fs/promises";

// tsc emits a declaration per source file, but the public entry point is
// self-contained. Ship only it, plus a .d.cts copy so CommonJS consumers on
// node16/nodenext resolution get CommonJS-flavored types instead of ESM ones.
const dist = new URL("../dist/", import.meta.url);
const entry = new URL("index.d.ts", dist);

if (/^\s*(?:import|export)\b[^;]*\bfrom\s/m.test(await readFile(entry, "utf8"))) {
  throw new Error("dist/index.d.ts imports other declarations; ship them as well");
}

for (const file of await readdir(dist)) {
  if (file.endsWith(".d.ts") && file !== "index.d.ts") await rm(new URL(file, dist));
}
await copyFile(entry, new URL("index.d.cts", dist));
