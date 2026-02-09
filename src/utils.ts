import type { Part } from "@opencode-ai/sdk";
import os from "node:os";

/**
 * Build a sanitized Graphiti group ID from a prefix and project directory.
 */
export const makeGroupId = (prefix: string, directory?: string): string => {
  const parts = directory?.split("/").filter(Boolean) ?? [];
  const projectName = parts[parts.length - 1] || "default";
  const rawGroupId = `${prefix}_${projectName}`;
  return rawGroupId.replace(/[^A-Za-z0-9_-]/g, "_");
};

/**
 * Build a sanitized Graphiti group ID from a prefix and user home directory.
 */
export const makeUserGroupId = (prefix: string): string => {
  const homeDir = os.homedir() || "user";
  const parts = homeDir.split("/").filter(Boolean);
  const userName = parts[parts.length - 1] || "user";
  const rawGroupId = `${prefix}_user_${userName}`;
  return rawGroupId.replace(/[^A-Za-z0-9_-]/g, "_");
};

/**
 * Narrow an OpenCode Part to a non-synthetic text part.
 */
export const isTextPart = (value: unknown): value is Part & {
  type: "text";
  text: string;
} => {
  if (!value || typeof value !== "object") return false;
  const part = value as Part & { text?: unknown; synthetic?: boolean };
  return part.type === "text" && typeof part.text === "string" &&
    !part.synthetic;
};

/**
 * Extract and join text from OpenCode message parts.
 */
export const extractTextFromParts = (parts: Part[]): string =>
  parts.filter(isTextPart).map((part) => part.text).join(" ").trim();
