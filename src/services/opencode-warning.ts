const console = globalThis.console as {
  warn: (...args: unknown[]) => void;
};

type OpenCodeLogLevel = "debug" | "info" | "warn" | "error";
type OpenCodeToastVariant = "info" | "success" | "warning" | "error";

type OpenCodeClientLike = {
  app?: {
    log: (input: {
      body: {
        service: string;
        level: OpenCodeLogLevel;
        message: string;
        extra?: Record<string, unknown>;
      };
    }) => Promise<unknown> | unknown;
  };
  tui?: {
    showToast: (input: {
      body: {
        message: string;
        variant: OpenCodeToastVariant;
      };
    }) => Promise<unknown> | unknown;
  };
};

const PREFIX = "[graphiti]";

let openCodeClient: unknown;
let scheduleTask: (callback: () => void) => void = (callback) => {
  setTimeout(callback, 0);
};
let suppressConsoleWarningsDuringTestsOverride: boolean | undefined;

export const shouldSuppressConsoleWarningsDuringTests = (): boolean => {
  if (suppressConsoleWarningsDuringTestsOverride !== undefined) {
    return suppressConsoleWarningsDuringTestsOverride;
  }
  const stack = new Error().stack;
  return typeof stack === "string" && stack.includes("ext:cli/40_test.js");
};

const warnToConsole = (
  message: string,
  extra?: unknown,
  error?: unknown,
): void => {
  if (shouldSuppressConsoleWarningsDuringTests()) return;
  if (extra === undefined) {
    if (error === undefined) {
      console.warn(PREFIX, message);
      return;
    }
    console.warn(PREFIX, message, error);
    return;
  }

  if (error === undefined) {
    console.warn(PREFIX, message, extra);
    return;
  }
  console.warn(PREFIX, message, extra, error);
};

const asRecord = (value: unknown): Record<string, unknown> => {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return { data: value };
};

const getClient = (): OpenCodeClientLike | undefined => {
  return openCodeClient as OpenCodeClientLike | undefined;
};

const runSafely = (
  task: () => Promise<unknown> | unknown,
  onError?: (err: unknown) => void,
): boolean => {
  try {
    scheduleTask(() => {
      try {
        void Promise.resolve(task()).catch((err) => onError?.(err));
      } catch (err) {
        onError?.(err);
      }
    });
    return true;
  } catch {
    return false;
  }
};

const scheduleStructuredWarning = (
  message: string,
  extra?: unknown,
): boolean => {
  const client = getClient();
  if (!client?.app?.log) return false;

  return runSafely(
    () =>
      client.app!.log({
        body: {
          service: "graphiti",
          level: "warn",
          message,
          ...(extra === undefined ? {} : { extra: asRecord(extra) }),
        },
      }),
    (error) => warnToConsole(message, extra, error),
  );
};

const scheduleWarningToast = (
  message: string,
  extra?: unknown,
): boolean => {
  const client = getClient();
  if (!client?.tui?.showToast) return false;

  return runSafely(
    () =>
      client.tui!.showToast({
        body: {
          message,
          variant: "warning",
        },
      }),
    (error) => warnToConsole(message, extra, error),
  );
};

export const setOpenCodeClient = (
  client: unknown,
): void => {
  openCodeClient = client;
};

export const setWarningTaskScheduler = (
  scheduler: ((callback: () => void) => void) | undefined,
): void => {
  scheduleTask = scheduler ?? ((callback) => {
    setTimeout(callback, 0);
  });
};

export const setSuppressConsoleWarningsDuringTestsOverride = (
  value: boolean | undefined,
): void => {
  suppressConsoleWarningsDuringTestsOverride = value;
};

export const logStructuredWarning = (
  message: string,
  extra?: unknown,
): boolean => {
  return scheduleStructuredWarning(message, extra);
};

export const showWarningToast = (message: string, extra?: unknown): boolean => {
  return scheduleWarningToast(message, extra);
};

export const notifyGraphitiAvailabilityIssue = (
  message: string,
  extra?: unknown,
): void => {
  const logged = scheduleStructuredWarning(message, extra);
  const toasted = scheduleWarningToast(message, extra);
  if (!logged && !toasted) {
    warnToConsole(message, extra);
  }
};
