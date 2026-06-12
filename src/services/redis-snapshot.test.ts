import { assertEquals } from "jsr:@std/assert@^1.0.0";

import { createSnapshotSummaryResult } from "./redis-snapshot.ts";

Deno.test("createSnapshotSummaryResult keeps session scope separate from temporal granularity", () => {
  const result = createSnapshotSummaryResult({
    rootSessionId: "root-1",
    created_at: "2026-06-05T00:00:00.000Z",
    snippet: "snapshot summary",
  });

  assertEquals(result.scope, "session");
  assertEquals(result.granularity, undefined);
});
