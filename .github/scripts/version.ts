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

/**
 * Analyze conventional commit subjects and return the highest bump type.
 *
 * Rules:
 * - `BREAKING CHANGE` in body or `type!:` → major
 * - `feat:` → minor
 * - `fix:` / `perf:` → patch
 * - Anything else → none
 */
export function analyzeCommits(subjects: string[]): Bump {
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
  /** Commit bodies (for Release-As detection). */
  bodies: string[];
  /** Whether this is a "push" (release) or "pull_request" (canary). */
  eventName: "push" | "pull_request";
  /** Commit SHA for canary suffix. */
  commitSha: string;
  /** Timestamp string for canary suffix (e.g. "20260212091429"). */
  timestamp: string;
  /** Whether we fell back to npm (no git tags). */
  noGitTags: boolean;
}): VersionResult {
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

  // Analyze commits
  let bump = analyzeCommits(opts.subjects);

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

async function run(args: string[]): Promise<void> {
  const cmd = async (...command: string[]): Promise<string> => {
    const proc = new Deno.Command(command[0], {
      args: command.slice(1),
      stdout: "piped",
      stderr: "piped",
    });
    const { stdout } = await proc.output();
    return new TextDecoder().decode(stdout).trim();
  };

  const output = (key: string, value: string): void => {
    const ghOutput = Deno.env.get("GITHUB_OUTPUT");
    if (ghOutput) {
      Deno.writeTextFileSync(ghOutput, `${key}=${value}\n`, { append: true });
    }
    console.log(`${key}=${value}`);
  };

  // Read package name from deno.json or package.json
  let packageName = "unknown";
  for (const file of ["deno.json", "deno.jsonc", "package.json"]) {
    try {
      const text = await Deno.readTextFile(file);
      const json = JSON.parse(text);
      if (json.name) {
        packageName = json.name;
        break;
      }
    } catch {
      continue;
    }
  }

  const eventName = (Deno.env.get("GITHUB_EVENT_NAME") ?? args[0] ?? "push") as
    | "push"
    | "pull_request";
  const commitSha = Deno.env.get("COMMIT_SHA") ??
    Deno.env.get("GITHUB_SHA") ??
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
  let noGitTags: boolean;

  if (!latestTag) {
    // Fall back to npm
    const npmVersion = await cmd("npm", "view", packageName, "version")
      .catch(() => "0.0.0");
    currentVersion = npmVersion || "0.0.0";
    subjects = (await cmd("git", "log", "--format=%s")).split("\n");
    bodies = (await cmd("git", "log", "--format=%b")).split("\n");
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
    noGitTags = false;
  }

  const timestamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);

  const result = calculateVersion({
    currentVersion,
    subjects,
    bodies,
    eventName,
    commitSha,
    timestamp,
    noGitTags,
  });

  if (result.skip) {
    output("skip", "true");
    console.log(
      `No release-triggering commits since ${latestTag || "initial"}, skipping`,
    );
  } else {
    output("version", result.version);
    output("tag", result.tag);
    console.log(
      `${
        result.tag === "canary" ? "Canary" : "Release"
      } version: ${result.version}`,
    );
  }
}

if (import.meta.main) {
  await run(Deno.args);
}
