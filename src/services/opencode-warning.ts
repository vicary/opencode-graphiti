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
): void => {
  scheduleTask(() => {
    try {
      void Promise.resolve(task()).catch((err) => onError?.(err));
    } catch (err) {
      onError?.(err);
    }
  });
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

export const logStructuredWarning = (
  message: string,
  extra?: unknown,
): boolean => {
  const client = getClient();
  if (!client?.app?.log) return false;

  runSafely(() =>
    client.app!.log({
      body: {
        service: "graphiti",
        level: "warn",
        message,
        ...(extra === undefined ? {} : { extra: asRecord(extra) }),
      },
    })
  );
  return true;
};

export const showWarningToast = (message: string): boolean => {
  const client = getClient();
  if (!client?.tui?.showToast) return false;

  runSafely(() =>
    client.tui!.showToast({
      body: {
        message,
        variant: "warning",
      },
    })
  );
  return true;
};

export const notifyGraphitiAvailabilityIssue = (
  message: string,
  extra?: unknown,
): void => {
  const logged = logStructuredWarning(message, extra);
  const toasted = showWarningToast(message);
  if (!logged && !toasted) {
    if (extra === undefined) {
      console.warn(PREFIX, message);
      return;
    }
    console.warn(PREFIX, message, extra);
  }
};
