import { assertEquals, assertStringIncludes } from "jsr:@std/assert@^1.0.0";
import { describe, it } from "jsr:@std/testing@^1.0.0/bdd";
import { createCompactingHandler } from "./compacting.ts";

describe("compacting handler", () => {
  it("injects locally prepared session_memory without Graphiti reads", async () => {
    const handler = createCompactingHandler({
      sessionManager: {
        getState() {
          return { isMain: true, hotTierReady: true };
        },
        prepareInjection() {
          return {
            envelope:
              '<session_memory version="1"><session_snapshot><snapshot /></session_snapshot></session_memory>',
            factUuids: [],
            nodeRefs: [],
          };
        },
      } as never,
    });

    const output = { context: ["existing"] };
    await handler({ sessionID: "session-1" }, output as never);

    assertEquals(output.context.length, 2);
    assertStringIncludes(output.context[1], "<session_memory");
  });
});
