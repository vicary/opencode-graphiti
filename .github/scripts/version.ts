/**
 * Calculate the next version based on conventional commits and semver.
 *
 * Exported functions are pure and testable. The CLI entry point at the bottom
 * shells out to git/npm and writes to $GITHUB_OUTPUT.
 *
 * Environment variables (CLI only):
 *   GITHUB_EVENT_NAME  - "push" or "pull_request" (set by GitHub Actions)
 *   GITHUB_SHA         - commit SHA (set by GitHub Actions)
 *   COMMIT_SHA         - override for GITHUB_SHA (e.g. PR head SHA)
 */

/** Semantic version bump type. */
export type Bump = "major" | "minor" | "patch" | "none";

/** Result of version calculation. */
export type VersionResult =
  | { skip: true }
  | { skip: false; version: string; tag: "latest" | "canary" };

export interface VersionCliDeps {
  cmd: (...command: string[]) => Promise<string>;
  readTextFile: (filePath: string) => Promise<string>;
  envGet: (name: string) => string | undefined;
  appendFile: (filePath: string, text: string) => void;
  log: (message: string) => void;
  now: () => Date;
}

export interface CommandOutputResult {
  stdout: Uint8Array;
  stderr: Uint8Array;
  success: boolean;
  code: number;
}

export function parseCommandOutput(
  command: string[],
  result: CommandOutputResult,
): string {
  const stdoutText = new TextDecoder().decode(result.stdout).trim();
  const stderrText = new TextDecoder().decode(result.stderr).trim();

  if (!result.success) {
    const stderrSuffix = stderrText ? `: ${stderrText}` : "";
    throw new Error(
      `Command failed with exit code ${result.code} (${
        command.join(" ")
      })${stderrSuffix}`,
    );
  }

  return stdoutText;
}

export async function runCommand(...command: string[]): Promise<string> {
  const proc = new Deno.Command(command[0], {
    args: command.slice(1),
    stdout: "piped",
    stderr: "piped",
  });
  return parseCommandOutput(command, await proc.output());
}

function stripJsonComments(text: string): string {
  let result = "";
  let inString = false;
  let escaped = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const nextChar = text[index + 1];

    if (inString) {
      result += char;
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      result += char;
      continue;
    }

    if (char === "/" && nextChar === "/") {
      index += 2;
      while (index < text.length && text[index] !== "\n") {
        index += 1;
      }
      if (index < text.length) {
        result += text[index];
      }
      continue;
    }

    if (char === "/" && nextChar === "*") {
      index += 2;
      while (
        index < text.length - 1 &&
        !(text[index] === "*" && text[index + 1] === "/")
      ) {
        if (text[index] === "\n") {
          result += "\n";
        }
        index += 1;
      }
      index += 1;
      continue;
    }

    result += char;
  }

  return result;
}

function parsePackageManifest(text: string, filePath: string): unknown {
  if (filePath.endsWith(".jsonc")) {
    return JSON.parse(stripJsonComments(text));
  }

  return JSON.parse(text);
}

function getPackageNameFromManifest(manifest: unknown): string | undefined {
  if (
    manifest &&
    typeof manifest === "object" &&
    "name" in manifest &&
    typeof manifest.name === "string"
  ) {
    return manifest.name;
  }

  return undefined;
}

const defaultVersionCliDeps: VersionCliDeps = {
  cmd: (...command: string[]) => runCommand(...command),
  readTextFile: (filePath) => Deno.readTextFile(filePath),
  envGet: (name) => Deno.env.get(name),
  appendFile: (filePath, text) => {
    Deno.writeTextFileSync(filePath, text, { append: true });
  },
  log: (message) => console.log(message),
  now: () => new Date(),
};

/**
 * Returns true when any commit body contains a semantic-release style breaking
 * change footer/header such as `BREAKING CHANGE: details`.
 */
export function hasBreakingChangeBody(bodies: string[]): boolean {
  return bodies.some((body) => /^BREAKING CHANGE:/im.test(body));
}

/**
 * Analyze conventional commits and return the highest bump type.
 *
 * Supported formats:
 * - `feat: add feature` -> minor
 * - `fix: resolve bug` / `perf: speed up path` -> patch
 * - `feat!: breaking api change` / `fix!: breaking bugfix` -> major
 * - `BREAKING CHANGE: explanation` in a commit body -> major
 * - `Release-As: x.y.z` is handled separately as an exact override
 *
 * In `0.x`, a major bump resolves to the next minor version.
 */
export function analyzeCommits(
  subjects: string[],
  bodies: string[] = [],
): Bump {
  if (hasBreakingChangeBody(bodies)) return "major";

  let bump: Bump = "none";

  for (const msg of subjects) {
    if (!msg) continue;

    if (/^[a-z]+(\(.+\))?!:/i.test(msg) || /BREAKING CHANGE/i.test(msg)) {
      return "major";
    }

    if (/^feat(\(.+\))?:/i.test(msg)) {
      bump = "minor";
    } else if (/^(fix|perf)(\(.+\))?:/i.test(msg) && bump === "none") {
      bump = "patch";
    }
  }

  return bump;
}

/**
 * Find a `Release-As: x.y.z` override in commit bodies.
 * Returns the last match, or undefined if none found.
 */
export function findReleaseAs(bodies: string[]): string | undefined {
  const pattern = /^Release-As:\s*(\d+\.\d+\.\d+)/im;
  let found: string | undefined;

  for (const body of bodies) {
    const match = pattern.exec(body);
    if (match) found = match[1];
  }

  return found;
}

/**
 * Apply a bump to a semver version.
 *
 * In 0.x: breaking → minor, feat → patch, fix → patch
 * In 1.x+: breaking → major, feat → minor, fix → patch
 */
export function applyBump(
  major: number,
  minor: number,
  patch: number,
  bump: Bump,
): string {
  if (major === 0) {
    switch (bump) {
      case "major":
        return `0.${minor + 1}.0`;
      default:
        return `0.${minor}.${patch + 1}`;
    }
  }

  switch (bump) {
    case "major":
      return `${major + 1}.0.0`;
    case "minor":
      return `${major}.${minor + 1}.0`;
    default:
      return `${major}.${minor}.${patch + 1}`;
  }
}

/** Parse a semver string into [major, minor, patch]. */
export function parseSemver(
  version: string,
): [number, number, number] {
  const parts = version.replace(/^v/, "").split(".");
  return [
    parseInt(parts[0] ?? "0", 10),
    parseInt(parts[1] ?? "0", 10),
    parseInt(parts[2] ?? "0", 10),
  ];
}

/** Whether the changed paths include at least one non-test file. */
export function hasNonTestChanges(changedFiles: string[]): boolean {
  return changedFiles.some((file) => file && !file.endsWith(".test.ts"));
}

/** Parse newline-separated changed-file output into a stable unique list. */
export function parseChangedFiles(output: string): string[] {
  return [
    ...new Set(
      output.split("\n").map((line) => line.trim()).filter(
        Boolean,
      ),
    ),
  ];
}

/**
 * Calculate the next version given all inputs.
 *
 * This is the pure core — no I/O, fully testable.
 */
export function calculateVersion(opts: {
  /** Current base version (from git tag or npm). */
  currentVersion: string;
  /** Conventional commit subjects since last release. */
  subjects: string[];
  /** Commit bodies (for Release-As and BREAKING CHANGE detection). */
  bodies: string[];
  /** Whether this is a "push" (release) or "pull_request" (canary). */
  eventName: "push" | "pull_request";
  /** Commit SHA for canary suffix. */
  commitSha: string;
  /** Timestamp string for canary suffix (e.g. "20260212091429"). */
  timestamp: string;
  /** Files changed since the last release baseline. */
  changedFiles: string[];
  /** Whether we fell back to npm (no git tags). */
  noGitTags: boolean;
}): VersionResult {
  if (!hasNonTestChanges(opts.changedFiles)) {
    return { skip: true };
  }

  const [major, minor, patch] = parseSemver(opts.currentVersion);

  // Check for Release-As override first
  const releaseAs = findReleaseAs(opts.bodies);

  if (releaseAs) {
    const version = opts.eventName === "pull_request"
      ? `${releaseAs}-canary.${opts.commitSha.slice(0, 7)}.${opts.timestamp}`
      : releaseAs;
    const tag = opts.eventName === "pull_request" ? "canary" : "latest";
    return { skip: false, version, tag } as const;
  }

  // Analyze commits using subjects plus semantic-release style body footers.
  let bump = analyzeCommits(opts.subjects, opts.bodies);

  // When no git tags, default to patch bump from npm baseline
  if (opts.noGitTags && bump === "none") {
    bump = "patch";
  }

  if (bump === "none") {
    if (opts.eventName === "push") {
      return { skip: true };
    }
    // For PRs, still publish a canary with a patch bump
    bump = "patch";
  }

  const nextVersion = applyBump(major, minor, patch, bump);

  if (opts.eventName === "pull_request") {
    const shortSha = opts.commitSha.slice(0, 7);
    return {
      skip: false,
      version: `${nextVersion}-canary.${shortSha}.${opts.timestamp}`,
      tag: "canary",
    } as const;
  }

  return { skip: false, version: nextVersion, tag: "latest" } as const;
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

export async function run(
  args: string[],
  deps: VersionCliDeps = defaultVersionCliDeps,
): Promise<void> {
  const { cmd, readTextFile, envGet, appendFile, log, now } = deps;
  const output = (key: string, value: string): void => {
    const ghOutput = envGet("GITHUB_OUTPUT");
    if (ghOutput) {
      appendFile(ghOutput, `${key}=${value}\n`);
    }
    log(`${key}=${value}`);
  };

  // Read package name from deno.json or package.json
  let packageName = "unknown";
  for (const file of ["deno.json", "deno.jsonc", "package.json"]) {
    try {
      const text = await readTextFile(file);
      const manifest = parsePackageManifest(text, file);
      const manifestPackageName = getPackageNameFromManifest(manifest);
      if (manifestPackageName) {
        packageName = manifestPackageName;
        break;
      }
    } catch {
      continue;
    }
  }

  const eventName = (envGet("GITHUB_EVENT_NAME") ?? args[0] ?? "push") as
    | "push"
    | "pull_request";
  const commitSha = envGet("COMMIT_SHA") ??
    envGet("GITHUB_SHA") ??
    args[1] ??
    await cmd("git", "rev-parse", "HEAD");

  // Find latest git tag
  const latestTag = await cmd(
    "git",
    "describe",
    "--tags",
    "--abbrev=0",
    "--match",
    "v*",
  ).catch(() => "");

  let currentVersion: string;
  let subjects: string[];
  let bodies: string[];
  let changedFiles: string[];
  let noGitTags: boolean;

  if (!latestTag) {
    // Fall back to npm
    const npmVersion = await cmd("npm", "view", packageName, "version")
      .catch(() => "0.0.0");
    currentVersion = npmVersion || "0.0.0";
    subjects = (await cmd("git", "log", "--format=%s")).split("\n");
    bodies = (await cmd("git", "log", "--format=%b")).split("\n");
    changedFiles = parseChangedFiles(
      await cmd("git", "show", "--format=", "--name-only", "HEAD"),
    );
    noGitTags = true;
  } else {
    currentVersion = latestTag.replace(/^v/, "");
    subjects = (await cmd(
      "git",
      "log",
      `${latestTag}..HEAD`,
      "--format=%s",
    )).split("\n");
    bodies = (await cmd(
      "git",
      "log",
      `${latestTag}..HEAD`,
      "--format=%b",
    )).split("\n");
    changedFiles = parseChangedFiles(
      await cmd(
        "git",
        "diff",
        "--name-only",
        `${latestTag}..HEAD`,
      ),
    );
    noGitTags = false;
  }

  const timestamp = now().toISOString().replace(/[-:T]/g, "").slice(0, 14);

  const result = calculateVersion({
    currentVersion,
    subjects,
    bodies,
    eventName,
    commitSha,
    timestamp,
    changedFiles,
    noGitTags,
  });

  if (result.skip) {
    output("skip", "true");
    log(
      `No release-triggering commits since ${latestTag || "initial"}, skipping`,
    );
  } else {
    output("version", result.version);
    output("tag", result.tag);
    log(
      `${
        result.tag === "canary" ? "Canary" : "Release"
      } version: ${result.version}`,
    );
  }
}

if (import.meta.main) {
  await run(Deno.args);
}
