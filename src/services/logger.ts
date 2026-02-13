import process from "node:process";
const console = globalThis.console as {
  log: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  debug: (...args: unknown[]) => void;
};

const PREFIX = "[graphiti]";

export const logger = {
  info: (...args: unknown[]) => {
    if (process.env.GRAPHITI_DEBUG) console.log(PREFIX, ...args);
  },
  warn: (...args: unknown[]) => {
    if (process.env.GRAPHITI_DEBUG) console.warn(PREFIX, ...args);
  },
  error: (...args: unknown[]) => {
    if (process.env.GRAPHITI_DEBUG) console.error(PREFIX, ...args);
  },
  debug: (...args: unknown[]) => {
    if (process.env.GRAPHITI_DEBUG) console.debug(PREFIX, ...args);
  },
};
