import { assertEquals } from "jsr:@std/assert@^1.0.0";
import { describe, it } from "jsr:@std/testing@^1.0.0/bdd";

import type { ToolGuidanceType } from "./tool-guidance.ts";
import { ToolGuidanceCache } from "./tool-guidance-cache.ts";

const READ_GUIDANCE_TYPE: ToolGuidanceType = "read";
const GREP_GUIDANCE_TYPE: ToolGuidanceType = "grep";
const BASH_GUIDANCE_TYPE: ToolGuidanceType = "bash";

describe("tool guidance cache", () => {
  it("only emits a guidance type once per canonical root session", () => {
    const cache = new ToolGuidanceCache();

    assertEquals(cache.shouldEmit("root-session", READ_GUIDANCE_TYPE), true);
    assertEquals(cache.shouldEmit("root-session", READ_GUIDANCE_TYPE), false);
  });

  it("allows different guidance types to emit independently for one canonical root session", () => {
    const cache = new ToolGuidanceCache();

    assertEquals(cache.shouldEmit("root-session", READ_GUIDANCE_TYPE), true);
    assertEquals(cache.shouldEmit("root-session", GREP_GUIDANCE_TYPE), true);
    assertEquals(cache.shouldEmit("root-session", BASH_GUIDANCE_TYPE), true);

    assertEquals(cache.shouldEmit("root-session", READ_GUIDANCE_TYPE), false);
    assertEquals(cache.shouldEmit("root-session", GREP_GUIDANCE_TYPE), false);
    assertEquals(cache.shouldEmit("root-session", BASH_GUIDANCE_TYPE), false);
  });

  it("does not share throttle state across canonical root sessions", () => {
    const cache = new ToolGuidanceCache();

    assertEquals(cache.shouldEmit("root-session-a", READ_GUIDANCE_TYPE), true);
    assertEquals(cache.shouldEmit("root-session-b", READ_GUIDANCE_TYPE), true);
    assertEquals(cache.shouldEmit("root-session-a", READ_GUIDANCE_TYPE), false);
    assertEquals(cache.shouldEmit("root-session-b", READ_GUIDANCE_TYPE), false);
  });

  it("allows a session guidance type to emit again after clearSession", () => {
    const cache = new ToolGuidanceCache();

    assertEquals(cache.shouldEmit("root-session", READ_GUIDANCE_TYPE), true);
    assertEquals(cache.shouldEmit("root-session", READ_GUIDANCE_TYPE), false);

    cache.clearSession("root-session");

    assertEquals(cache.shouldEmit("root-session", READ_GUIDANCE_TYPE), true);
  });

  it("allows all session guidance types to emit again after clearAll", () => {
    const cache = new ToolGuidanceCache();

    assertEquals(cache.shouldEmit("root-session-a", READ_GUIDANCE_TYPE), true);
    assertEquals(cache.shouldEmit("root-session-b", GREP_GUIDANCE_TYPE), true);
    assertEquals(cache.shouldEmit("root-session-a", READ_GUIDANCE_TYPE), false);
    assertEquals(cache.shouldEmit("root-session-b", GREP_GUIDANCE_TYPE), false);

    cache.clearAll();

    assertEquals(cache.shouldEmit("root-session-a", READ_GUIDANCE_TYPE), true);
    assertEquals(cache.shouldEmit("root-session-b", GREP_GUIDANCE_TYPE), true);
  });
});
