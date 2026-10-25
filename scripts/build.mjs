import { rm } from "node:fs/promises";
import * as esbuild from "esbuild";
import { createPluginBundlerPresets } from "@paperclipai/plugin-sdk/bundlers";

await rm("dist", { recursive: true, force: true });
const presets = createPluginBundlerPresets({
  workerEntry: "src/worker.ts",
  manifestEntry: "src/manifest.ts",
  uiEntry: "src/ui/index.tsx",
});
for (const [name, options] of Object.entries(presets.esbuild)) {
  if (!options) continue;
  await esbuild.build(options);
  console.log(`built ${name} -> ${options.outdir}`);
}
