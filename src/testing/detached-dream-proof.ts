import type { Hooks, Plugin, PluginInput } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  notifyPluginWarning,
  setOpenCodeClient,
  showWarningToast,
} from "../services/opencode-warning.ts";
import type { RuntimeTeardownRegistration } from "../services/runtime-teardown.ts";
import { registerRuntimeTeardown } from "../services/runtime-teardown.ts";

export const PROOF_WAIT_MS = 10_000;

export type DetachedDreamProofHost = "tui" | "server";

type DetachedDreamProofDependencies = {
  registerRuntimeTeardown?: (
    tasks: Array<{
      name: string;
      run: () => void | Promise<void>;
    }>,
  ) => RuntimeTeardownRegistration;
  waitMs?: number;
};

const hostLabel = (host: DetachedDreamProofHost): string =>
  host === "tui" ? "TUI" : "server/web/serve";

const toolIdForHost = (host: DetachedDreamProofHost): string =>
  `detached_dream_proof_${host}`;

const proofFileNameForHost = (host: DetachedDreamProofHost): string =>
  `.opencode-detached-dream-proof-${host}.json`;

const proofToastForHost = (host: DetachedDreamProofHost): string =>
  `Detached dream proof for ${host} armed. Gracefully exit the ${
    hostLabel(host)
  } host after this session to test foreground waiting.`;

const proofWaitToastForHost = (
  host: DetachedDreamProofHost,
  waitMs: number,
): string =>
  `Detached dream proof for ${host} waiting about ${
    Math.floor(waitMs / 1000)
  } seconds before writing its verification artifact. Keep OpenCode open.`;

const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export const createDetachedDreamProofPlugin = (
  options: {
    host: DetachedDreamProofHost;
  } & DetachedDreamProofDependencies,
): Plugin => {
  const proofHost = options.host;
  const proofToolId = toolIdForHost(proofHost);
  const proofWaitMs = options.waitMs ?? PROOF_WAIT_MS;
  const registerTeardown = options.registerRuntimeTeardown ??
    registerRuntimeTeardown;

  return (input: PluginInput) => {
    setOpenCodeClient(input.client);

    const proofFile = join(input.directory, proofFileNameForHost(proofHost));
    let teardownRegistration: RuntimeTeardownRegistration | null = null;

    const hooks: Hooks = {
      tool: {
        [proofToolId]: tool({
          description:
            `Proof-only helper that verifies graceful-shutdown waiting behavior for the ${
              hostLabel(proofHost)
            } host lifecycle.`,
          args: {},
          execute: () => {
            const newlyArmed = !teardownRegistration;
            if (!teardownRegistration) {
              teardownRegistration = registerTeardown([
                {
                  name: proofToolId,
                  run: async () => {
                    notifyPluginWarning(
                      proofWaitToastForHost(proofHost, proofWaitMs),
                      {
                        proof_only: true,
                        host: proofHost,
                        tool: proofToolId,
                        wait_ms: proofWaitMs,
                      },
                    );
                    await wait(proofWaitMs);
                    await writeFile(
                      proofFile,
                      JSON.stringify(
                        {
                          proof: proofToolId,
                          host: proofHost,
                          mode: "runtime_teardown_wait",
                          proof_only: true,
                          wait_ms: proofWaitMs,
                          finished_at: new Date().toISOString(),
                        },
                        null,
                        2,
                      ) + "\n",
                      "utf8",
                    );
                  },
                },
              ]);
            }

            showWarningToast(proofToastForHost(proofHost), {
              proof_only: true,
              temporary: true,
              host: proofHost,
              tool: proofToolId,
            });
            return Promise.resolve(
              newlyArmed
                ? `Detached dream proof for ${proofHost} armed. Gracefully exit and keep OpenCode open until the proof completes.`
                : `Detached dream proof for ${proofHost} already armed.`,
            );
          },
        }),
      },
    };

    return Promise.resolve(hooks);
  };
};

export const detachedDreamProofTui = createDetachedDreamProofPlugin({
  host: "tui",
});

export const detachedDreamProofServer = createDetachedDreamProofPlugin({
  host: "server",
});

export const detachedDreamProof = detachedDreamProofTui;
