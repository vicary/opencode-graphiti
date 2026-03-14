import {
  logStructuredWarning,
  shouldSuppressConsoleWarningsDuringTests,
} from "./opencode-warning.ts";

const console = globalThis.console as {
  log: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  debug: (...args: unknown[]) => void;
};

const PREFIX = "[graphiti]";
let debugOverride: boolean | undefined;
let silentOverride = false;

const serializeLogArg = (value: unknown): unknown => {
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack,
    };
  }
  return value;
};

const stringifyLogArg = (value: unknown): string => {
  if (typeof value === "string") return value;
  if (value instanceof Error) return value.message;
  if (
    typeof value === "number" || typeof value === "boolean" ||
    typeof value === "bigint"
  ) {
    return String(value);
  }
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};

const toWarningPayload = (
  args: unknown[],
): { message: string; extra?: unknown } => {
  if (args.length === 0) return { message: "Graphiti warning" };
  const [first, ...rest] = args;
  if (typeof first === "string") {
    return rest.length === 0
      ? { message: first }
      : { message: first, extra: { data: rest.map(serializeLogArg) } };
  }
  return {
    message: stringifyLogArg(first),
    ...(rest.length === 0 ? {} : {
      extra: {
        data: [serializeLogArg(first), ...rest.map(serializeLogArg)],
      },
    }),
  };
};

const isDebugEnabled = (): boolean => {
  if (debugOverride !== undefined) return debugOverride;
  try {
    return !!Deno.env.get("GRAPHITI_DEBUG");
  } catch {
    return false;
  }
};

export const setLoggerDebugOverride = (value: boolean | undefined): void => {
  debugOverride = value;
};

export const setLoggerSilentOverride = (value: boolean): void => {
  silentOverride = value;
};

export const logger = {
  info: (...args: unknown[]) => {
    if (silentOverride) return;
    if (isDebugEnabled()) console.log(PREFIX, ...args);
  },
  warn: (...args: unknown[]) => {
    if (silentOverride) return;
    const payload = toWarningPayload(args);
    try {
      if (logStructuredWarning(payload.message, payload.extra)) return;
    } catch {
      // Fall back to console below when structured warning scheduling fails.
    }
    if (shouldSuppressConsoleWarningsDuringTests()) return;
    console.warn(PREFIX, ...args);
  },
  error: (...args: unknown[]) => {
    if (silentOverride) return;
    console.error(PREFIX, ...args);
  },
  debug: (...args: unknown[]) => {
    if (silentOverride) return;
    if (isDebugEnabled()) console.debug(PREFIX, ...args);
  },
};
