const console = globalThis.console as {
  log: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  debug: (...args: unknown[]) => void;
};

const PREFIX = "[graphiti]";
let debugOverride: boolean | undefined;
let silentOverride = false;

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
