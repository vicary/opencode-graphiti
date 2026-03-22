import { assertEquals, assertStrictEquals } from "jsr:@std/assert@^1.0.0";
import { afterEach, describe, it } from "jsr:@std/testing@^1.0.0/bdd";

import {
  type ToolRoutingOutcome,
  ToolRoutingOutcomeCache,
} from "./tool-routing-outcome-cache.ts";

describe("tool routing outcome cache", () => {
  const cache = new ToolRoutingOutcomeCache();

  afterEach(() => {
    cache.clearAll();
  });

  it("set(callId, outcome) stores a compact routing outcome", () => {
    const outcome: ToolRoutingOutcome = {
      source: "tool-routing",
      action: "modify",
      reason: "bash-network-rewrite",
    };

    cache.set("call-1", outcome);

    assertStrictEquals(cache.take("call-1"), outcome);
  });

  it("take(callId) returns and clears the stored outcome", () => {
    const outcome: ToolRoutingOutcome = {
      source: "tool-routing",
      action: "context",
      guidanceType: "read",
      reason: "read-guidance",
    };

    cache.set("call-1", outcome);

    assertStrictEquals(cache.take("call-1"), outcome);
    assertEquals(cache.take("call-1"), undefined);
  });

  it("take(callId) is safe to call repeatedly after the entry is cleared", () => {
    const outcome: ToolRoutingOutcome = {
      source: "tool-routing",
      action: "deny",
      reason: "webfetch-denied",
    };

    cache.set("call-1", outcome);

    assertStrictEquals(cache.take("call-1"), outcome);
    assertEquals(cache.take("call-1"), undefined);
    assertEquals(cache.take("call-1"), undefined);
  });
});
