import { build } from "jsr:@deno/dnt@^0.42.3";
import manifest from "./deno.json" with { type: "json" };

const version = Deno.env.get("VERSION") || manifest.version;
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
    version,
    description: manifest.description,
    license: manifest.license,
    author: "Vicary A. <vicary.archangel@member.mensa.org>",
    repository: {
      type: "git",
      url: "https://github.com/vicary/opencode-graphiti.git",
    },
    bugs: {
      url: "https://github.com/vicary/opencode-graphiti/issues",
    },
    homepage: "https://github.com/vicary/opencode-graphiti#readme",
    keywords: [
      "opencode",
      "graphiti",
      "knowledge-graph",
      "persistent-memory",
      "plugin",
      "mcp",
      "ai",
      "context",
    ],
    engines: {
      node: ">=22",
    },
    main: "./esm/mod.js",
    types: "./esm/mod.d.ts",
    opencode: {
      type: "plugin",
      hooks: ["chat.message", "event", "experimental.session.compacting"],
    },
  },
});

await Deno.copyFile("README.md", `${outDir}README.md`);
await Deno.copyFile("LICENSE", `${outDir}LICENSE`);
