import { assertEquals } from "jsr:@std/assert@^1.0.0";
import { describe, it } from "jsr:@std/testing@^1.0.0/bdd";
import type { Part } from "@opencode-ai/sdk";
import { extractTextFromParts, isTextPart } from "./utils.ts";

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
      const parts = [{ type: "text", text: "hello" }] as unknown as Part[];
      assertEquals(extractTextFromParts(parts), "hello");
    });

    it("joins multiple text parts", () => {
      const parts = [
        { type: "text", text: "hello" },
        { type: "text", text: "world" },
      ] as unknown as Part[];
      assertEquals(extractTextFromParts(parts), "hello world");
    });

    it("ignores non-text parts", () => {
      const parts = [
        { type: "text", text: "hello" },
        { type: "image", text: "ignored" },
      ] as unknown as Part[];
      assertEquals(extractTextFromParts(parts), "hello");
    });

    it("ignores synthetic text parts", () => {
      const parts = [
        { type: "text", text: "keep" },
        { type: "text", text: "skip", synthetic: true },
      ] as unknown as Part[];
      assertEquals(extractTextFromParts(parts), "keep");
    });

    it("trims whitespace when all parts are empty", () => {
      const parts = [
        { type: "text", text: "" },
        { type: "text", text: "" },
      ] as unknown as Part[];
      assertEquals(extractTextFromParts(parts), "");
    });
  });
});
