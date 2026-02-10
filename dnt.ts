import { build } from "jsr:@deno/dnt@^0.42.3";
import manifest from "./deno.json" with { type: "json" };

const outDir = "dist/";

await Deno.remove(outDir, { recursive: true }).catch(() => undefined);

await build({
  entryPoints: ["./mod.ts"],
  outDir,
  shims: {
    deno: true,
  },
  typeCheck: "single",
  test: false,
  package: {
    name: manifest.name,
    version: manifest.version,
    description: manifest.description,
    license: manifest.license,
    main: "./esm/mod.js",
    opencode: {
      type: "plugin",
      hooks: ["chat.message", "event", "experimental.session.compacting"],
    },
  },
});

await Deno.copyFile("README.md", `${outDir}README.md`);
await Deno.copyFile("LICENSE", `${outDir}LICENSE`);
