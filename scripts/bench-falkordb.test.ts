import { assertEquals } from "jsr:@std/assert@^1.0.0";
import { describe, it } from "jsr:@std/testing@^1.0.0/bdd";

import { formatEndpointForDisplay } from "./bench-falkordb-format.ts";

describe("bench-falkordb", () => {
  it("redacts Redis endpoint credentials before display", () => {
    assertEquals(
      formatEndpointForDisplay("redis://user:secret@redis.test:6379"),
      "redis://redis.test:6379",
    );
  });

  it("leaves credential-free endpoints unchanged", () => {
    assertEquals(
      formatEndpointForDisplay("redis://redis.test:6379"),
      "redis://redis.test:6379",
    );
  });
});
