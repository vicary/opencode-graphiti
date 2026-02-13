import { assertEquals } from "jsr:@std/assert@^1.0.0";
import { describe, it } from "jsr:@std/testing@^1.0.0/bdd";
import type { Part, TextPart } from "@opencode-ai/sdk";
import { extractTextFromParts, isTextPart } from "./utils.ts";

const makeTextPart = (
  text: string,
  overrides: Partial<TextPart> = {},
): TextPart => ({
  id: "part-1",
  sessionID: "session-1",
  messageID: "message-1",
  type: "text",
  text,
  ...overrides,
});

describe("utils", () => {
  describe("isTextPart", () => {
    it("returns true for valid text parts", () => {
      const part = { type: "text", text: "hello" };
      assertEquals(isTextPart(part), true);
    });

    it("returns false for non-text parts", () => {
      const part = { type: "image", text: "ignored" };
      assertEquals(isTextPart(part), false);
    });

    it("returns false for synthetic text parts", () => {
      const part = { type: "text", text: "hidden", synthetic: true };
      assertEquals(isTextPart(part), false);
    });

    it("returns false for null and undefined", () => {
      assertEquals(isTextPart(null), false);
      assertEquals(isTextPart(undefined), false);
    });

    it("returns false for non-object values", () => {
      assertEquals(isTextPart("text"), false);
      assertEquals(isTextPart(42), false);
      assertEquals(isTextPart(true), false);
    });

    it("returns false for objects without type", () => {
      const part = { text: "missing type" };
      assertEquals(isTextPart(part), false);
    });

    it("returns false for objects with non-string text", () => {
      const part = { type: "text", text: 123 };
      assertEquals(isTextPart(part), false);
    });
  });

  describe("extractTextFromParts", () => {
    it("returns empty string for empty array", () => {
      assertEquals(extractTextFromParts([]), "");
    });

    it("returns single text part", () => {
      const parts = [makeTextPart("hello")];
      assertEquals(extractTextFromParts(parts), "hello");
    });

    it("joins multiple text parts", () => {
      const parts = [makeTextPart("hello"), makeTextPart("world")];
      assertEquals(extractTextFromParts(parts), "hello world");
    });

    it("ignores non-text parts", () => {
      const parts: Part[] = [
        makeTextPart("hello"),
        {
          id: "part-2",
          sessionID: "session-1",
          messageID: "message-1",
          type: "file",
          mime: "image/png",
          url: "https://example.com/image.png",
        },
      ];
      assertEquals(extractTextFromParts(parts), "hello");
    });

    it("ignores synthetic text parts", () => {
      const parts = [
        makeTextPart("keep"),
        makeTextPart("skip", { synthetic: true }),
      ];
      assertEquals(extractTextFromParts(parts), "keep");
    });

    it("trims whitespace when all parts are empty", () => {
      const parts = [makeTextPart(""), makeTextPart("")];
      assertEquals(extractTextFromParts(parts), "");
    });
  });
});
