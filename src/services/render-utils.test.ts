import { assertEquals } from "jsr:@std/assert@^1.0.0";

import {
  isHighValueMemoryText,
  renderXmlListSection,
  sanitizeMemoryInput,
  sanitizeMemoryInputPreservingMemoryBlocks,
} from "./render-utils.ts";

Deno.test("isHighValueMemoryText keeps concise architectural memories that mention transcript terms", () => {
  const memory =
    "Architecture decision: prefer session memory summaries over transcript bodies when updating src/session.ts.";

  assertEquals(isHighValueMemoryText(memory), true);
});

Deno.test("isHighValueMemoryText still rejects transcript-heavy tool-like content", () => {
  const memory = [
    "tool output:",
    "1: Architecture decision: prefer session memory summaries over transcript bodies",
    "2: Update src/session.ts to keep Graphiti off the hot path",
    "3: stdout captured from transcript review",
  ].join("\n");

  assertEquals(isHighValueMemoryText(memory), false);
});

Deno.test("sanitizeMemoryInputPreservingMemoryBlocks keeps literal memory XML while shared sanitize strips injected blocks", () => {
  const input =
    'Example\n\n<session_memory version="1"><last_request>sample</last_request></session_memory>';

  assertEquals(
    sanitizeMemoryInputPreservingMemoryBlocks(input),
    input,
  );
  assertEquals(sanitizeMemoryInput(input), "Example");
});

Deno.test("renderXmlListSection omits empty sections automatically", () => {
  assertEquals(renderXmlListSection("active_tasks", "task", []), "");
});
