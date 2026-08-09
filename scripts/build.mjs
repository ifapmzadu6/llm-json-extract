import { rm } from "node:fs/promises";
import { build } from "esbuild";

await rm(new URL("../dist", import.meta.url), { recursive: true, force: true });

const sharedOptions = {
  bundle: true,
  platform: "node",
  target: "node18",
  sourcemap: true,
  minify: false,
  treeShaking: true,
};

await Promise.all([
  build({
    ...sharedOptions,
    entryPoints: ["src/index.ts", "src/cli.ts"],
    format: "esm",
    outdir: "dist",
  }),
  build({
    ...sharedOptions,
    entryPoints: ["src/index.ts"],
    format: "cjs",
    outExtension: { ".js": ".cjs" },
    outdir: "dist",
  }),
]);
