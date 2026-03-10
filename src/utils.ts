import type { Part } from "@opencode-ai/sdk";
import os from "node:os";
import process from "node:process";

const getProjectName = (directory: string) =>
  directory.split("/").filter(Boolean).at(-1)?.trim() || "default";

const getUserName = (
  home = os.homedir().split("/").filter(Boolean).at(-1),
) => home?.trim() || undefined;

/**
 * Build a sanitized Graphiti group ID from a prefix and project directory.
 */
export const makeGroupId = (
  prefix?: string,
  directory = process.cwd(),
): string => {
  const projectName = getProjectName(directory);
  const rawGroupId = `${prefix?.concat("-")}${projectName}__main`;
  return rawGroupId.replace(/[^A-Za-z0-9_-]/g, "_");
};

/**
 * Build a sanitized Graphiti group ID from a prefix and user home directory.
 */
export const makeUserGroupId = (
  prefix?: string,
  directory = process.cwd(),
): string => {
  const projectName = getProjectName(directory);
  const userName = getUserName();
  const rawGroupId = `${prefix?.concat("-")}${projectName}__user-${userName}`;
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

/**
 * Truncate `text` to at most `budget` characters without cutting mid-line.
 * Prefers to break at the last newline within the budget window; falls back
 * to a raw slice only when the candidate contains no newline.
 */
export const truncateAtLineBoundary = (
  text: string,
  budget: number,
): string => {
  if (text.length <= budget) return text;
  const candidate = text.slice(0, budget);
  const lastNl = candidate.lastIndexOf("\n");
  return lastNl > 0 ? candidate.slice(0, lastNl) : candidate;
};
