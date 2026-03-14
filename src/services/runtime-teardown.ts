import { logger } from "./logger.ts";

export type RuntimeTeardownTask = {
  name: string;
  run: () => void | Promise<void>;
};

export interface RuntimeTeardownRegistration {
  run(): Promise<void>;
}

type ShutdownRegistrationAdapter = {
  addEventListener?: (
    type: string,
    listener: (event?: Event) => void,
    options?: boolean | { once?: boolean; capture?: boolean },
  ) => void;
  Deno?: {
    addSignalListener?: (
      signal: "SIGINT" | "SIGTERM",
      handler: () => void,
    ) => void;
  };
};

const SHUTDOWN_EVENTS = ["unload", "beforeunload"] as const;
const SHUTDOWN_SIGNALS = ["SIGINT", "SIGTERM"] as const;

export function registerRuntimeTeardown(
  tasks: RuntimeTeardownTask[],
  runtime: ShutdownRegistrationAdapter = globalThis,
): RuntimeTeardownRegistration {
  let teardownPromise: Promise<void> | null = null;

  const run = (): Promise<void> => {
    if (teardownPromise) return teardownPromise;

    teardownPromise = (async () => {
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
    })();

    return teardownPromise;
  };

  for (const eventType of SHUTDOWN_EVENTS) {
    runtime.addEventListener?.(eventType, () => {
      void run();
    }, { once: true });
  }

  for (const signal of SHUTDOWN_SIGNALS) {
    runtime.Deno?.addSignalListener?.(signal, () => {
      void run();
    });
  }

  return { run };
}
