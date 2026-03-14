import { assertEquals } from "jsr:@std/assert@^1.0.0";
import * as pluginModule from "./mod.ts";

Deno.test("root plugin module exports only the plugin entrypoint", () => {
  assertEquals(Object.keys(pluginModule).sort(), ["graphiti"]);
});
