import process from "node:process";
import { registerRuntimeTeardown } from "./runtime-teardown.ts";

const keepAlive = setInterval(() => {}, 1_000);

registerRuntimeTeardown([
  {
    name: "flush",
    run: async () => {
      await new Promise((resolve) => setTimeout(resolve, 25));
      clearInterval(keepAlive);
      process.stdout.write("teardown-run\n");
    },
  },
], {
  process: {
    on: process.on.bind(process),
    off: process.off.bind(process),
    exit: process.exit.bind(process),
  },
});

process.stdout.write("ready\n");
