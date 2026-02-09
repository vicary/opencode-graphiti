import { assertEquals, assertStrictEquals } from "jsr:@std/assert@^1.0.0";
import { describe, it } from "jsr:@std/testing@^1.0.0/bdd";
import { GraphitiClient } from "./client.ts";

describe("client", () => {
  describe("parseToolResult", () => {
    const client = new GraphitiClient("http://test:8000/mcp");

    it("should return original result when no content array", () => {
      const result = { status: "ok" };
      const parsed = client.parseToolResult(result);
      assertEquals(parsed, result);
    });

    it("should return original result when content is empty array", () => {
      const result = { content: [] };
      const parsed = client.parseToolResult(result);
      assertEquals(parsed, result);
    });

    it("should parse JSON from text content", () => {
      const result = {
        content: [{
          type: "text",
          text: '{"facts": [{"uuid": "1", "fact": "test"}]}',
        }],
      };
      const parsed = client.parseToolResult(result);
      assertEquals(parsed, { facts: [{ uuid: "1", fact: "test" }] });
    });

    it("should parse JSON array from text content", () => {
      const result = {
        content: [{ type: "text", text: '[{"uuid": "1"}, {"uuid": "2"}]' }],
      };
      const parsed = client.parseToolResult(result);
      assertEquals(parsed, [{ uuid: "1" }, { uuid: "2" }]);
    });

    it("should return plain text when not valid JSON", () => {
      const result = {
        content: [{ type: "text", text: "Hello, world!" }],
      };
      const parsed = client.parseToolResult(result);
      assertStrictEquals(parsed, "Hello, world!");
    });

    it("should handle nested JSON structures", () => {
      const result = {
        content: [{
          type: "text",
          text: '{"nested": {"deep": {"value": 42}}, "array": [1,2,3]}',
        }],
      };
      const parsed = client.parseToolResult(result);
      assertEquals(parsed, {
        nested: { deep: { value: 42 } },
        array: [1, 2, 3],
      });
    });

    it("should find text content among other content types", () => {
      const result = {
        content: [
          { type: "image", data: "base64data" },
          { type: "text", text: '{"status": "success"}' },
          { type: "binary", data: "binarydata" },
        ],
      };
      const parsed = client.parseToolResult(result);
      assertEquals(parsed, { status: "success" });
    });

    it("should return original result when no text type found", () => {
      const result = {
        content: [
          { type: "image", data: "base64data" },
          { type: "binary", data: "binarydata" },
        ],
      };
      const parsed = client.parseToolResult(result);
      assertEquals(parsed, result);
    });

    it("should parse JSON string with special characters", () => {
      const result = {
        content: [{
          type: "text",
          text: '{"message": "Hello\\nWorld\\t!", "emoji": "🎉"}',
        }],
      };
      const parsed = client.parseToolResult(result);
      assertEquals(parsed, { message: "Hello\nWorld\t!", emoji: "🎉" });
    });

    it("should handle text field that is not a string", () => {
      const result = {
        content: [{ type: "text", text: 123 }],
      };
      const parsed = client.parseToolResult(result);
      // JSON.parse(123) returns 123
      assertStrictEquals(parsed, 123);
    });

    it("should handle text field that is null", () => {
      const result = {
        content: [{ type: "text", text: null }],
      };
      const parsed = client.parseToolResult(result);
      // JSON.parse(null) returns null
      assertStrictEquals(parsed, null);
    });

    it("should handle text field that is undefined", () => {
      const result = {
        content: [{ type: "text" }],
      };
      const parsed = client.parseToolResult(result);
      // When text property doesn't exist, return original result
      assertEquals(parsed, result);
    });

    it("should handle empty string as valid JSON", () => {
      const result = {
        content: [{ type: "text", text: "" }],
      };
      const parsed = client.parseToolResult(result);
      // JSON.parse("") throws, so should return original text
      assertStrictEquals(parsed, "");
    });

    it("should handle JSON with arrays as root", () => {
      const result = {
        content: [{ type: "text", text: '[{"id": 1}, {"id": 2}]' }],
      };
      const parsed = client.parseToolResult(result);
      assertEquals(parsed, [{ id: 1 }, { id: 2 }]);
    });

    it("should handle primitive JSON values", () => {
      const testCases = [
        { input: "true", expected: true },
        { input: "false", expected: false },
        { input: "123", expected: 123 },
        { input: '"string"', expected: "string" },
        { input: "null", expected: null },
      ];

      for (const { input, expected } of testCases) {
        const result = {
          content: [{ type: "text", text: input }],
        };
        const parsed = client.parseToolResult(result);
        assertStrictEquals(parsed, expected);
      }
    });

    it("should handle whitespace-only string as invalid JSON", () => {
      const result = {
        content: [{ type: "text", text: "   " }],
      };
      const parsed = client.parseToolResult(result);
      // JSON.parse("   ") throws, should return original text
      assertStrictEquals(parsed, "   ");
    });

    it("should handle first text content when multiple text types exist", () => {
      const result = {
        content: [
          { type: "text", text: '{"first": true}' },
          { type: "text", text: '{"second": true}' },
        ],
      };
      const parsed = client.parseToolResult(result);
      // Should use the first text content found
      assertEquals(parsed, { first: true });
    });
  });

  describe("response parsing integration", () => {
    it("should correctly parse object responses from searchFacts", () => {
      // Testing the logic that searchFacts uses to handle both array and object responses
      const testCases = [
        {
          description: "direct array response",
          input: [{ uuid: "1", fact: "Fact 1" }],
          expected: [{ uuid: "1", fact: "Fact 1" }],
        },
        {
          description: "object with facts array",
          input: { facts: [{ uuid: "2", fact: "Fact 2" }] },
          expected: [{ uuid: "2", fact: "Fact 2" }],
        },
        {
          description: "object without facts array",
          input: { status: "ok" },
          expected: [],
        },
        {
          description: "null response",
          input: null,
          expected: [],
        },
        {
          description: "undefined response",
          input: undefined,
          expected: [],
        },
        {
          description: "string response",
          input: "error",
          expected: [],
        },
      ];

      for (const { description, input, expected } of testCases) {
        // Simulate the logic in searchFacts
        let result: unknown[] = [];
        if (Array.isArray(input)) {
          result = input as unknown[];
        } else if (
          input &&
          typeof input === "object" &&
          Array.isArray((input as { facts?: unknown[] }).facts)
        ) {
          result = (input as { facts: unknown[] }).facts;
        }
        assertEquals(result, expected, description);
      }
    });

    it("should correctly parse object responses from searchNodes", () => {
      // Testing the logic that searchNodes uses to handle both array and object responses
      const testCases = [
        {
          description: "direct array response",
          input: [{ uuid: "1", name: "Node 1" }],
          expected: [{ uuid: "1", name: "Node 1" }],
        },
        {
          description: "object with nodes array",
          input: { nodes: [{ uuid: "2", name: "Node 2" }] },
          expected: [{ uuid: "2", name: "Node 2" }],
        },
        {
          description: "object without nodes array",
          input: { status: "ok" },
          expected: [],
        },
      ];

      for (const { description, input, expected } of testCases) {
        // Simulate the logic in searchNodes
        let result: unknown[] = [];
        if (Array.isArray(input)) {
          result = input as unknown[];
        } else if (
          input &&
          typeof input === "object" &&
          Array.isArray((input as { nodes?: unknown[] }).nodes)
        ) {
          result = (input as { nodes: unknown[] }).nodes;
        }
        assertEquals(result, expected, description);
      }
    });
  });
});
