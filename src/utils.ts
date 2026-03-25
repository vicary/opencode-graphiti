import type { Part } from "@opencode-ai/sdk";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const getPathBasename = (value: string): string => {
  const trimmed = value.trim();
  if (!trimmed) return "";
  const normalized = trimmed.replaceAll("\\", "/");
  return path.posix.basename(normalized);
};

const getProjectName = (directory: string) =>
  getPathBasename(directory) || "default";

const toPascalCaseSegment = (value: string): string => {
  const words = value.match(/[\p{L}\p{N}]+/gu) ?? [];
  const pascal = words.map((word) => {
    if (!word) return "";
    const [first = "", ...rest] = Array.from(word);
    return first.toLocaleUpperCase() + rest.join("").toLocaleLowerCase();
  }).join("");
  return pascal || "Default";
};

const sanitizeGroupSegment = (value: string): string =>
  value.replace(/[^A-Za-z0-9_]/g, "_");

const sanitizeProjectSegment = (value: string): string =>
  value.replace(/[^\p{L}\p{N}_]/gu, "_");

const getHomeDirectory = (): string | undefined => {
  try {
    return os.homedir();
  } catch {
    return undefined;
  }
};

const getUserName = () =>
  getPathBasename(getHomeDirectory() ?? "") || undefined;

/**
 * Build a sanitized Graphiti group ID from a prefix and project directory.
 */
export const makeGroupId = (
  prefix?: string,
  directory: string = process.cwd(),
): string => {
  const projectName = sanitizeProjectSegment(
    toPascalCaseSegment(getProjectName(directory)),
  );
  const prefixPart = prefix ? `${sanitizeGroupSegment(prefix)}_` : "";
  return `${prefixPart}${projectName}__main`;
};

/**
 * Build a sanitized Graphiti group ID from a prefix and user home directory.
 */
export const makeUserGroupId = (
  prefix?: string,
  directory: string = process.cwd(),
): string => {
  const projectName = sanitizeProjectSegment(
    toPascalCaseSegment(getProjectName(directory)),
  );
  const userName = getUserName() ?? "unknown";
  const prefixPart = prefix ? `${sanitizeGroupSegment(prefix)}_` : "";
  const userSegment = sanitizeGroupSegment(userName);
  return `${prefixPart}${projectName}__user_${userSegment}`;
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
 * Construct a canonical abort-shaped error for use as an abort reason or test double.
 */
export const createAbortError = (message = "Aborted"): Error => {
  if (typeof DOMException !== "undefined") {
    return new DOMException(message, "AbortError");
  }

  const error = new Error(message);
  error.name = "AbortError";
  return error;
};

/**
 * Narrow unknown values to abort-shaped errors across runtimes.
 */
export const isAbortError = (error: unknown): boolean => {
  if (!error || typeof error !== "object") return false;
  return (error instanceof DOMException && error.name === "AbortError") ||
    (error instanceof Error && error.name === "AbortError");
};

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
