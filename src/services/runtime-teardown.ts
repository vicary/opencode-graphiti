import { logger } from "./logger.ts";

export type RuntimeTeardownTask = {
  name: string;
  run: () => void | Promise<void>;
};

export interface RuntimeTeardownRegistration {
  run(): Promise<void>;
  dispose(): void;
}

type ShutdownTrigger =
  | { kind: "event"; type: (typeof SHUTDOWN_EVENTS)[number] }
  | { kind: "signal"; signal: (typeof SHUTDOWN_SIGNALS)[number] };

type ShutdownRegistrationAdapter = {
  addEventListener?: (
    type: string,
    listener: (event?: Event) => void,
    options?: boolean | { once?: boolean; capture?: boolean },
  ) => void;
  removeEventListener?: (
    type: string,
    listener: (event?: Event) => void,
    options?: boolean | EventListenerOptions,
  ) => void;
  Deno?: {
    addSignalListener?: (
      signal: "SIGINT" | "SIGTERM",
      handler: () => void,
    ) => void;
    removeSignalListener?: (
      signal: "SIGINT" | "SIGTERM",
      handler: () => void,
    ) => void;
    exit?: (code?: number) => never;
  };
};

const SHUTDOWN_EVENTS = ["unload", "beforeunload"] as const;
const SHUTDOWN_SIGNALS = ["SIGINT", "SIGTERM"] as const;
const SHUTDOWN_EXIT_CODE: Record<(typeof SHUTDOWN_SIGNALS)[number], number> = {
  SIGINT: 130,
  SIGTERM: 143,
};
const activeRegistrations = new WeakMap<object, Set<() => void>>();

const getShutdownNotice = (
  signal: (typeof SHUTDOWN_SIGNALS)[number],
): string =>
  signal === "SIGINT"
    ? "Graceful shutdown in progress; waiting for pending memory flush. Press Ctrl+C again to exit immediately and drop pending memories."
    : "Graceful shutdown in progress; waiting for pending memory flush. Send the signal again to exit immediately and drop pending memories.";

const getForcedShutdownNotice = (
  signal: (typeof SHUTDOWN_SIGNALS)[number],
): string =>
  signal === "SIGINT"
    ? "Forced shutdown requested; exiting immediately and dropping pending memories."
    : "Forced shutdown requested; exiting immediately after repeated shutdown signal and dropping pending memories.";

export function registerRuntimeTeardown(
  tasks: RuntimeTeardownTask[],
  runtime: ShutdownRegistrationAdapter = globalThis,
): RuntimeTeardownRegistration {
  const runtimeKey = runtime as object;
  let teardownPromise: Promise<void> | null = null;
  let eventListenersDisposed = false;
  let signalListenersDisposed = false;
  let registrationReleased = false;
  let shutdownSignal: (typeof SHUTDOWN_SIGNALS)[number] | null = null;
  let exitRequested = false;
  let gracefulShutdownStarted = false;
  const eventListeners: Array<{
    type: (typeof SHUTDOWN_EVENTS)[number];
    listener: () => void;
  }> = [];
  const signalListeners: Array<{
    signal: (typeof SHUTDOWN_SIGNALS)[number];
    handler: () => void;
  }> = [];

  const disposeEventListeners = (): void => {
    if (eventListenersDisposed) return;
    eventListenersDisposed = true;
    for (const { type, listener } of eventListeners) {
      runtime.removeEventListener?.(type, listener, false);
    }
  };

  const disposeSignalListeners = (): void => {
    if (signalListenersDisposed) return;
    signalListenersDisposed = true;
    for (const { signal, handler } of signalListeners) {
      runtime.Deno?.removeSignalListener?.(signal, handler);
    }
  };

  const releaseRegistration = (): void => {
    if (registrationReleased) return;
    registrationReleased = true;
    const registrations = activeRegistrations.get(runtimeKey);
    if (!registrations) return;
    registrations.delete(dispose);
    if (registrations.size === 0) {
      activeRegistrations.delete(runtimeKey);
    }
  };

  const dispose = (): void => {
    disposeEventListeners();
    disposeSignalListeners();
    releaseRegistration();
  };

  const requestExit = (signal: (typeof SHUTDOWN_SIGNALS)[number]): void => {
    if (exitRequested) return;
    exitRequested = true;
    dispose();
    runtime.Deno?.exit?.(SHUTDOWN_EXIT_CODE[signal]);
  };

  const run = (): Promise<void> => {
    if (teardownPromise) return teardownPromise;

    teardownPromise = (async () => {
      disposeEventListeners();
      disposeSignalListeners();
      releaseRegistration();

      try {
        for (const task of tasks) {
          try {
            await task.run();
          } catch (err) {
            logger.warn("Runtime teardown failed", {
              resource: task.name,
              err,
            });
          }
        }
      } finally {
        disposeSignalListeners();
      }
    })();

    return teardownPromise;
  };

  const beginGracefulShutdown = (trigger: ShutdownTrigger): void => {
    if (gracefulShutdownStarted) return;
    gracefulShutdownStarted = true;
    disposeEventListeners();
    disposeSignalListeners();

    if (trigger.kind === "signal") {
      shutdownSignal = trigger.signal;
      logger.warn(getShutdownNotice(trigger.signal), {
        signal: trigger.signal,
      });
      void run().finally(() => {
        requestExit(trigger.signal);
      });
      return;
    }

    void run();
  };

  for (const eventType of SHUTDOWN_EVENTS) {
    const listener = () => {
      beginGracefulShutdown({ kind: "event", type: eventType });
    };

    runtime.addEventListener?.(eventType, listener, { once: true });
    eventListeners.push({ type: eventType, listener });
  }

  for (const signal of SHUTDOWN_SIGNALS) {
    const handler = () => {
      if (gracefulShutdownStarted) {
        logger.warn(getForcedShutdownNotice(signal), {
          signal,
          initialSignal: shutdownSignal ?? signal,
        });
        requestExit(signal);
        return;
      }

      beginGracefulShutdown({ kind: "signal", signal });
    };

    runtime.Deno?.addSignalListener?.(signal, handler);
    signalListeners.push({ signal, handler });
  }

  const registrations = activeRegistrations.get(runtimeKey) ?? new Set();
  registrations.add(dispose);
  activeRegistrations.set(runtimeKey, registrations);

  return { run, dispose };
}
