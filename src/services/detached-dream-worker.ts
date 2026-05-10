import type { DreamJob } from "./dream-jobs.ts";

export type DetachedDreamSpawnInput = {
  directory: string;
  job: DreamJob;
};

export const spawnDetachedDreamWorker = (
  _input: DetachedDreamSpawnInput,
): Promise<boolean> => {
  return Promise.resolve(false);
};
