/**
 * Tests for version.ts — all exported pure functions.
 *
 * Uses inline jsr: imports (no deno.json additions) and BDD style.
 */

import { describe, it } from "jsr:@std/testing@1/bdd";
import { assertEquals } from "jsr:@std/assert@1";
import {
  analyzeCommits,
  applyBump,
  calculateVersion,
  findReleaseAs,
  hasBreakingChangeBody,
  hasNonTestChanges,
  parseChangedFiles,
  parseSemver,
  run,
} from "./version.ts";

const makeCliDeps = (options: {
  env?: Record<string, string | undefined>;
  files?: Record<string, string>;
  commands?: Record<string, string | Error>;
  now?: Date;
}) => {
  const outputs: string[] = [];
  const logs: string[] = [];
  const calls: string[] = [];

  return {
    deps: {
      cmd: (...command: string[]) => {
        const key = command.join(" ");
        calls.push(key);
        const result = options.commands?.[key];
        if (result instanceof Error) return Promise.reject(result);
        return Promise.resolve(result ?? "");
      },
      readTextFile: (filePath: string) => {
        const result = options.files?.[filePath];
        if (result === undefined) {
          return Promise.reject(new Error(`ENOENT: ${filePath}`));
        }
        return Promise.resolve(result);
      },
      envGet: (name: string) => options.env?.[name],
      appendFile: (_filePath: string, text: string) => {
        outputs.push(text);
      },
      log: (message: string) => {
        logs.push(message);
      },
      now: () => options.now ?? new Date("2026-02-12T09:14:29Z"),
    },
    outputs,
    logs,
    calls,
  };
};

describe("analyzeCommits", () => {
  it("returns 'none' for empty array", () => {
    assertEquals(analyzeCommits([]), "none");
  });

  it("returns 'none' for only non-triggering commits", () => {
    const subjects = [
      "chore: update deps",
      "docs: fix typo",
      "refactor: cleanup",
      "style: format code",
      "test: add test",
    ];
    assertEquals(analyzeCommits(subjects), "none");
  });

  it("returns 'patch' for a single fix commit", () => {
    assertEquals(analyzeCommits(["fix: resolve bug"]), "patch");
  });

  it("returns 'patch' for a single perf commit", () => {
    assertEquals(analyzeCommits(["perf: optimize loop"]), "patch");
  });

  it("returns 'minor' for a single feat commit", () => {
    assertEquals(analyzeCommits(["feat: add feature"]), "minor");
  });

  it("returns 'major' for breaking change with ! suffix", () => {
    assertEquals(analyzeCommits(["feat!: breaking change"]), "major");
    assertEquals(analyzeCommits(["fix!: breaking fix"]), "major");
  });

  it("returns 'major' for breaking change with BREAKING CHANGE in subject", () => {
    assertEquals(
      analyzeCommits(["feat: something BREAKING CHANGE: details"]),
      "major",
    );
  });

  it("returns 'major' for breaking change case insensitive", () => {
    assertEquals(
      analyzeCommits(["feat: something breaking change: details"]),
      "major",
    );
  });

  it("returns 'major' when a commit body contains BREAKING CHANGE", () => {
    assertEquals(
      analyzeCommits(["feat: keep subject normal"], [
        "BREAKING CHANGE: api changed",
      ]),
      "major",
    );
  });

  it("returns highest bump when mixed commits (feat + fix → minor)", () => {
    const subjects = [
      "fix: bug fix",
      "feat: new feature",
      "docs: update readme",
    ];
    assertEquals(analyzeCommits(subjects), "minor");
  });

  it("returns highest bump when mixed commits (breaking + feat → major)", () => {
    const subjects = [
      "feat: new feature",
      "fix: bug fix",
      "feat!: breaking change",
    ];
    assertEquals(analyzeCommits(subjects), "major");
  });

  it("handles scoped feat commit", () => {
    assertEquals(analyzeCommits(["feat(api): add endpoint"]), "minor");
  });

  it("handles scoped fix commit", () => {
    assertEquals(analyzeCommits(["fix(core): resolve issue"]), "patch");
  });

  it("handles scoped breaking change", () => {
    assertEquals(analyzeCommits(["feat(api)!: breaking"]), "major");
  });

  it("is case insensitive for commit types", () => {
    assertEquals(analyzeCommits(["FEAT: uppercase"]), "minor");
    assertEquals(analyzeCommits(["FIX: uppercase"]), "patch");
    assertEquals(analyzeCommits(["Feat: mixed case"]), "minor");
  });

  it("ignores empty strings in array", () => {
    assertEquals(analyzeCommits(["", "feat: feature", ""]), "minor");
  });

  it("returns 'none' when fix comes after minor has been set", () => {
    // This verifies the logic: fix only bumps to patch if bump === "none"
    const subjects = ["feat: feature", "fix: bug"];
    assertEquals(analyzeCommits(subjects), "minor");
  });

  it("handles multiple breaking changes (first wins, returns immediately)", () => {
    const subjects = [
      "feat!: first breaking",
      "feat!: second breaking",
    ];
    assertEquals(analyzeCommits(subjects), "major");
  });
});

describe("hasBreakingChangeBody", () => {
  it("returns true for semantic-release style breaking change bodies", () => {
    assertEquals(
      hasBreakingChangeBody([
        "Some text\n\nBREAKING CHANGE: changed output format",
      ]),
      true,
    );
  });

  it("returns false when commit bodies do not include the breaking footer", () => {
    assertEquals(
      hasBreakingChangeBody(["Regular body", "Another body"]),
      false,
    );
  });
});

describe("findReleaseAs", () => {
  it("returns undefined for empty array", () => {
    assertEquals(findReleaseAs([]), undefined);
  });

  it("returns undefined for array of empty strings", () => {
    assertEquals(findReleaseAs(["", "", ""]), undefined);
  });

  it("finds Release-As with exact case", () => {
    assertEquals(
      findReleaseAs(["Release-As: 1.0.0"]),
      "1.0.0",
    );
  });

  it("finds release-as case insensitive", () => {
    assertEquals(
      findReleaseAs(["release-as: 2.3.4"]),
      "2.3.4",
    );
  });

  it("finds RELEASE-AS uppercase", () => {
    assertEquals(
      findReleaseAs(["RELEASE-AS: 3.4.5"]),
      "3.4.5",
    );
  });

  it("returns last match when multiple bodies contain Release-As", () => {
    const bodies = [
      "Release-As: 1.0.0",
      "Some other text",
      "Release-As: 2.0.0",
    ];
    assertEquals(findReleaseAs(bodies), "2.0.0");
  });

  it("finds Release-As mixed with other text", () => {
    const body = `This is a commit body.

Release-As: 4.5.6

Some more text here.`;
    assertEquals(findReleaseAs([body]), "4.5.6");
  });

  it("returns undefined when no match", () => {
    const bodies = [
      "This is just text",
      "No version here",
      "Release: 1.0.0", // Wrong format
    ];
    assertEquals(findReleaseAs(bodies), undefined);
  });

  it("handles whitespace variations", () => {
    assertEquals(findReleaseAs(["Release-As:1.0.0"]), "1.0.0");
    assertEquals(findReleaseAs(["Release-As:  2.3.4"]), "2.3.4");
  });

  it("must match at line start (multiline flag)", () => {
    const body = "Some text Release-As: 1.0.0"; // Not at start
    assertEquals(findReleaseAs([body]), undefined);
  });

  it("matches at line start in multiline body", () => {
    const body = "First line\nRelease-As: 5.6.7\nLast line";
    assertEquals(findReleaseAs([body]), "5.6.7");
  });
});

describe("applyBump", () => {
  describe("0.x semver (pre-1.0)", () => {
    it("major bump increases minor (0.1.4 → 0.2.0)", () => {
      assertEquals(applyBump(0, 1, 4, "major"), "0.2.0");
    });

    it("minor bump increases patch (0.1.4 → 0.1.5)", () => {
      assertEquals(applyBump(0, 1, 4, "minor"), "0.1.5");
    });

    it("patch bump increases patch (0.1.4 → 0.1.5)", () => {
      assertEquals(applyBump(0, 1, 4, "patch"), "0.1.5");
    });

    it("none bump increases patch (0.1.4 → 0.1.5)", () => {
      assertEquals(applyBump(0, 1, 4, "none"), "0.1.5");
    });

    it("major bump from 0.0.0 → 0.1.0", () => {
      assertEquals(applyBump(0, 0, 0, "major"), "0.1.0");
    });

    it("patch bump from 0.0.0 → 0.0.1", () => {
      assertEquals(applyBump(0, 0, 0, "patch"), "0.0.1");
    });

    it("minor bump from 0.0.1 → 0.0.2", () => {
      assertEquals(applyBump(0, 0, 1, "minor"), "0.0.2");
    });
  });

  describe("1.x+ semver", () => {
    it("major bump increases major (1.2.3 → 2.0.0)", () => {
      assertEquals(applyBump(1, 2, 3, "major"), "2.0.0");
    });

    it("minor bump increases minor (1.2.3 → 1.3.0)", () => {
      assertEquals(applyBump(1, 2, 3, "minor"), "1.3.0");
    });

    it("patch bump increases patch (1.2.3 → 1.2.4)", () => {
      assertEquals(applyBump(1, 2, 3, "patch"), "1.2.4");
    });

    it("none bump increases patch (1.2.3 → 1.2.4)", () => {
      assertEquals(applyBump(1, 2, 3, "none"), "1.2.4");
    });

    it("handles large version numbers (10.20.30)", () => {
      assertEquals(applyBump(10, 20, 30, "major"), "11.0.0");
      assertEquals(applyBump(10, 20, 30, "minor"), "10.21.0");
      assertEquals(applyBump(10, 20, 30, "patch"), "10.20.31");
    });

    it("major bump from 1.0.0 → 2.0.0", () => {
      assertEquals(applyBump(1, 0, 0, "major"), "2.0.0");
    });

    it("minor bump from 2.0.0 → 2.1.0", () => {
      assertEquals(applyBump(2, 0, 0, "minor"), "2.1.0");
    });
  });
});

describe("parseSemver", () => {
  it("parses standard semver 1.2.3", () => {
    assertEquals(parseSemver("1.2.3"), [1, 2, 3]);
  });

  it("parses semver with v prefix v1.2.3", () => {
    assertEquals(parseSemver("v1.2.3"), [1, 2, 3]);
  });

  it("parses zero version 0.0.0", () => {
    assertEquals(parseSemver("0.0.0"), [0, 0, 0]);
  });

  it("parses version with v prefix v0.0.0", () => {
    assertEquals(parseSemver("v0.0.0"), [0, 0, 0]);
  });

  it("parses large version numbers", () => {
    assertEquals(parseSemver("10.20.30"), [10, 20, 30]);
  });

  it("parses version with v prefix and large numbers", () => {
    assertEquals(parseSemver("v99.88.77"), [99, 88, 77]);
  });

  it("handles missing parts as 0", () => {
    assertEquals(parseSemver("1"), [1, 0, 0]);
    assertEquals(parseSemver("1.2"), [1, 2, 0]);
  });
});

describe("hasNonTestChanges", () => {
  it("returns false for only test files", () => {
    assertEquals(
      hasNonTestChanges([
        ".github/scripts/version.test.ts",
        "src/foo.test.ts",
      ]),
      false,
    );
  });

  it("returns true when at least one non-test file is present", () => {
    assertEquals(
      hasNonTestChanges([
        ".github/scripts/version.test.ts",
        ".github/scripts/version.ts",
      ]),
      true,
    );
  });

  it("returns false for an empty file list", () => {
    assertEquals(hasNonTestChanges([]), false);
  });
});

describe("parseChangedFiles", () => {
  it("returns unique trimmed changed paths", () => {
    assertEquals(
      parseChangedFiles("src/mod.ts\n\nsrc/mod.ts\n src/util.ts \n"),
      ["src/mod.ts", "src/util.ts"],
    );
  });
});

describe("calculateVersion", () => {
  const baseOpts = {
    currentVersion: "1.0.0",
    subjects: [],
    bodies: [],
    commitSha: "abc123def456",
    timestamp: "20260212091429",
    changedFiles: ["src/mod.ts"],
    noGitTags: false,
  };

  describe("push events (releases)", () => {
    it("creates release version for feat commit", () => {
      const result = calculateVersion({
        ...baseOpts,
        subjects: ["feat: new feature"],
        eventName: "push",
      });
      assertEquals(result, { skip: false, version: "1.1.0", tag: "latest" });
    });

    it("creates release version for fix commit", () => {
      const result = calculateVersion({
        ...baseOpts,
        subjects: ["fix: bug fix"],
        eventName: "push",
      });
      assertEquals(result, { skip: false, version: "1.0.1", tag: "latest" });
    });

    it("creates release version for breaking change", () => {
      const result = calculateVersion({
        ...baseOpts,
        subjects: ["feat!: breaking"],
        eventName: "push",
      });
      assertEquals(result, { skip: false, version: "2.0.0", tag: "latest" });
    });

    it("creates release version for BREAKING CHANGE in commit body", () => {
      const result = calculateVersion({
        ...baseOpts,
        subjects: ["feat: keep subject stable"],
        bodies: ["BREAKING CHANGE: api changed"],
        eventName: "push",
      });
      assertEquals(result, { skip: false, version: "2.0.0", tag: "latest" });
    });

    it("skips when no triggering commits", () => {
      const result = calculateVersion({
        ...baseOpts,
        subjects: ["chore: cleanup", "docs: update"],
        eventName: "push",
      });
      assertEquals(result, { skip: true });
    });

    it("uses Release-As override exactly", () => {
      const result = calculateVersion({
        ...baseOpts,
        subjects: ["feat: feature"],
        bodies: ["Release-As: 3.0.0"],
        eventName: "push",
      });
      assertEquals(result, { skip: false, version: "3.0.0", tag: "latest" });
    });

    it("applies 0.x breaking change as minor bump", () => {
      const result = calculateVersion({
        ...baseOpts,
        currentVersion: "0.5.3",
        subjects: ["feat!: breaking"],
        eventName: "push",
      });
      assertEquals(result, { skip: false, version: "0.6.0", tag: "latest" });
    });

    it("skips when unreleased changes are only test files", () => {
      const result = calculateVersion({
        ...baseOpts,
        subjects: ["feat: new feature"],
        changedFiles: ["src/foo.test.ts", ".github/scripts/version.test.ts"],
        eventName: "push",
      });
      assertEquals(result, { skip: true });
    });

    it("still releases when test and non-test files both changed", () => {
      const result = calculateVersion({
        ...baseOpts,
        subjects: ["feat: new feature"],
        changedFiles: ["src/foo.test.ts", "src/foo.ts"],
        eventName: "push",
      });
      assertEquals(result, { skip: false, version: "1.1.0", tag: "latest" });
    });
  });

  describe("pull_request events (canaries)", () => {
    it("creates canary version for feat commit", () => {
      const result = calculateVersion({
        ...baseOpts,
        subjects: ["feat: new feature"],
        eventName: "pull_request",
      });
      assertEquals(result, {
        skip: false,
        version: "1.1.0-canary.abc123d.20260212091429",
        tag: "canary",
      });
    });

    it("creates canary with patch bump when no triggering commits", () => {
      const result = calculateVersion({
        ...baseOpts,
        subjects: ["chore: cleanup"],
        eventName: "pull_request",
      });
      assertEquals(result, {
        skip: false,
        version: "1.0.1-canary.abc123d.20260212091429",
        tag: "canary",
      });
    });

    it("creates canary with Release-As base version", () => {
      const result = calculateVersion({
        ...baseOpts,
        subjects: ["feat: feature"],
        bodies: ["Release-As: 5.0.0"],
        eventName: "pull_request",
      });
      assertEquals(result, {
        skip: false,
        version: "5.0.0-canary.abc123d.20260212091429",
        tag: "canary",
      });
    });

    it("creates a 0.x canary with an exact Release-As override", () => {
      const result = calculateVersion({
        ...baseOpts,
        currentVersion: "0.1.12",
        subjects: ["feat!: context overhaul"],
        bodies: ["Release-As: 0.2.0"],
        eventName: "pull_request",
      });
      assertEquals(result, {
        skip: false,
        version: "0.2.0-canary.abc123d.20260212091429",
        tag: "canary",
      });
    });

    it("creates canary for breaking change", () => {
      const result = calculateVersion({
        ...baseOpts,
        subjects: ["feat!: breaking"],
        eventName: "pull_request",
      });
      assertEquals(result, {
        skip: false,
        version: "2.0.0-canary.abc123d.20260212091429",
        tag: "canary",
      });
    });

    it("creates canary for BREAKING CHANGE in commit body", () => {
      const result = calculateVersion({
        ...baseOpts,
        subjects: ["fix: preserve subject format"],
        bodies: ["BREAKING CHANGE: cache schema changed"],
        eventName: "pull_request",
      });
      assertEquals(result, {
        skip: false,
        version: "2.0.0-canary.abc123d.20260212091429",
        tag: "canary",
      });
    });

    it("shortens commit SHA to 7 characters", () => {
      const result = calculateVersion({
        ...baseOpts,
        subjects: ["feat: feature"],
        commitSha: "1234567890abcdef",
        eventName: "pull_request",
      });
      assertEquals(result.skip, false);
      if (!result.skip) {
        assertEquals(result.version.includes("1234567."), true);
      }
    });

    it("skips canary publish when unreleased changes are only test files", () => {
      const result = calculateVersion({
        ...baseOpts,
        subjects: ["feat: feature"],
        changedFiles: ["src/foo.test.ts"],
        eventName: "pull_request",
      });
      assertEquals(result, { skip: true });
    });
  });

  describe("noGitTags fallback", () => {
    it("applies patch bump when no git tags and no triggering commits on push", () => {
      const result = calculateVersion({
        ...baseOpts,
        currentVersion: "0.0.0",
        subjects: ["chore: initial"],
        noGitTags: true,
        eventName: "push",
      });
      assertEquals(result, { skip: false, version: "0.0.1", tag: "latest" });
    });

    it("applies feat bump when no git tags on push", () => {
      const result = calculateVersion({
        ...baseOpts,
        currentVersion: "1.0.0",
        subjects: ["feat: feature"],
        noGitTags: true,
        eventName: "push",
      });
      assertEquals(result, { skip: false, version: "1.1.0", tag: "latest" });
    });

    it("applies patch bump when no git tags and no triggering commits on PR", () => {
      const result = calculateVersion({
        ...baseOpts,
        currentVersion: "0.0.0",
        subjects: ["docs: update"],
        noGitTags: true,
        eventName: "pull_request",
      });
      assertEquals(result, {
        skip: false,
        version: "0.0.1-canary.abc123d.20260212091429",
        tag: "canary",
      });
    });

    it("skips push release when no git tags and only test files changed", () => {
      const result = calculateVersion({
        ...baseOpts,
        currentVersion: "0.0.0",
        subjects: ["chore: initial"],
        changedFiles: ["src/foo.test.ts", ".github/scripts/version.test.ts"],
        noGitTags: true,
        eventName: "push",
      });
      assertEquals(result, { skip: true });
    });

    it("skips canary publish when no git tags and only test files changed", () => {
      const result = calculateVersion({
        ...baseOpts,
        currentVersion: "0.0.0",
        subjects: ["docs: update"],
        changedFiles: ["src/foo.test.ts"],
        noGitTags: true,
        eventName: "pull_request",
      });
      assertEquals(result, { skip: true });
    });
  });

  describe("edge cases", () => {
    it("handles empty subjects array on push", () => {
      const result = calculateVersion({
        ...baseOpts,
        subjects: [],
        eventName: "push",
      });
      assertEquals(result, { skip: true });
    });

    it("handles empty subjects array on PR", () => {
      const result = calculateVersion({
        ...baseOpts,
        subjects: [],
        eventName: "pull_request",
      });
      assertEquals(result, {
        skip: false,
        version: "1.0.1-canary.abc123d.20260212091429",
        tag: "canary",
      });
    });

    it("handles multiple feat commits", () => {
      const result = calculateVersion({
        ...baseOpts,
        subjects: ["feat: one", "feat: two", "feat: three"],
        eventName: "push",
      });
      assertEquals(result, { skip: false, version: "1.1.0", tag: "latest" });
    });

    it("prioritizes Release-As over commit analysis", () => {
      const result = calculateVersion({
        ...baseOpts,
        subjects: ["feat!: breaking change"],
        bodies: ["Release-As: 1.5.0"], // Lower than major bump would produce
        eventName: "push",
      });
      assertEquals(result, { skip: false, version: "1.5.0", tag: "latest" });
    });

    it("uses last Release-As when multiple present", () => {
      const result = calculateVersion({
        ...baseOpts,
        subjects: ["feat: feature"],
        bodies: ["Release-As: 2.0.0", "Release-As: 3.0.0"],
        eventName: "push",
      });
      assertEquals(result, { skip: false, version: "3.0.0", tag: "latest" });
    });
  });

  describe("0.x version special handling", () => {
    it("bumps minor for breaking change in 0.x on push", () => {
      const result = calculateVersion({
        ...baseOpts,
        currentVersion: "0.1.4",
        subjects: ["feat!: breaking"],
        eventName: "push",
      });
      assertEquals(result, { skip: false, version: "0.2.0", tag: "latest" });
    });

    it("bumps patch for feat in 0.x on push", () => {
      const result = calculateVersion({
        ...baseOpts,
        currentVersion: "0.1.4",
        subjects: ["feat: feature"],
        eventName: "push",
      });
      assertEquals(result, { skip: false, version: "0.1.5", tag: "latest" });
    });

    it("creates canary with minor bump for breaking in 0.x on PR", () => {
      const result = calculateVersion({
        ...baseOpts,
        currentVersion: "0.3.5",
        subjects: ["feat!: breaking"],
        eventName: "pull_request",
      });
      assertEquals(result, {
        skip: false,
        version: "0.4.0-canary.abc123d.20260212091429",
        tag: "canary",
      });
    });

    it("creates a 0.x canary minor bump from BREAKING CHANGE in body", () => {
      const result = calculateVersion({
        ...baseOpts,
        currentVersion: "0.1.12",
        subjects: ["feat: keep subject stable"],
        bodies: ["BREAKING CHANGE: overhaul session-memory semantics"],
        eventName: "pull_request",
      });
      assertEquals(result, {
        skip: false,
        version: "0.2.0-canary.abc123d.20260212091429",
        tag: "canary",
      });
    });
  });
});

describe("run", () => {
  it("writes release outputs for the git-tag CLI path used by GitHub Actions", async () => {
    const cli = makeCliDeps({
      env: {
        GITHUB_EVENT_NAME: "push",
        GITHUB_OUTPUT: "/tmp/github-output",
        COMMIT_SHA: "override-sha-1234567",
      },
      files: {
        "deno.json": JSON.stringify({ name: "opencode-graphiti" }),
      },
      commands: {
        "git describe --tags --abbrev=0 --match v*": "v1.2.3",
        "git log v1.2.3..HEAD --format=%s": "feat: ship cli coverage",
        "git log v1.2.3..HEAD --format=%b": "",
        "git diff --name-only v1.2.3..HEAD": ".github/scripts/version.ts\n",
      },
    });

    await run([], cli.deps);

    assertEquals(cli.outputs, ["version=1.3.0\n", "tag=latest\n"]);
    assertEquals(cli.logs, [
      "version=1.3.0",
      "tag=latest",
      "Release version: 1.3.0",
    ]);
    assertEquals(
      cli.calls.includes("git describe --tags --abbrev=0 --match v*"),
      true,
    );
  });

  it("covers the no-tag fallback path, package discovery, args fallback, and canary output", async () => {
    const cli = makeCliDeps({
      env: {
        GITHUB_OUTPUT: "/tmp/github-output",
      },
      files: {
        "package.json": JSON.stringify({ name: "fallback-package" }),
      },
      commands: {
        "git describe --tags --abbrev=0 --match v*": new Error("no tags"),
        "npm view fallback-package version": "0.1.0",
        "git log --format=%s": "docs: note fallback behavior",
        "git log --format=%b": "",
        "git show --format= --name-only HEAD": "src/mod.ts\n",
      },
      now: new Date("2026-02-12T09:14:29Z"),
    });

    await run(["pull_request", "abcdef1234567890"], cli.deps);

    assertEquals(cli.outputs, [
      "version=0.1.1-canary.abcdef1.20260212091429\n",
      "tag=canary\n",
    ]);
    assertEquals(
      cli.logs.at(-1),
      "Canary version: 0.1.1-canary.abcdef1.20260212091429",
    );
    assertEquals(cli.calls.includes("npm view fallback-package version"), true);
  });

  it("reads the package name from commented deno.jsonc content", async () => {
    const cli = makeCliDeps({
      env: {
        GITHUB_OUTPUT: "/tmp/github-output",
      },
      files: {
        "deno.jsonc": `{
  // Package metadata for release automation.
  "name": "commented-package",
  /* Keep the rest of the manifest commented-friendly. */
  "version": "0.0.0-development"
}`,
      },
      commands: {
        "git describe --tags --abbrev=0 --match v*": new Error("no tags"),
        "npm view commented-package version": "0.2.0",
        "git log --format=%s": "docs: note jsonc support",
        "git log --format=%b": "",
        "git show --format= --name-only HEAD": ".github/scripts/version.ts\n",
      },
      now: new Date("2026-02-12T09:14:29Z"),
    });

    await run(["pull_request", "abcdef1234567890"], cli.deps);

    assertEquals(cli.outputs, [
      "version=0.2.1-canary.abcdef1.20260212091429\n",
      "tag=canary\n",
    ]);
    assertEquals(
      cli.calls.includes("npm view commented-package version"),
      true,
    );
  });

  it("emits skip=true when only test files changed", async () => {
    const cli = makeCliDeps({
      env: {
        GITHUB_EVENT_NAME: "push",
        GITHUB_OUTPUT: "/tmp/github-output",
      },
      files: {
        "deno.json": JSON.stringify({ name: "opencode-graphiti" }),
      },
      commands: {
        "git rev-parse HEAD": "abc123def4567890",
        "git describe --tags --abbrev=0 --match v*": "v1.2.3",
        "git log v1.2.3..HEAD --format=%s": "test: add cli coverage",
        "git log v1.2.3..HEAD --format=%b": "",
        "git diff --name-only v1.2.3..HEAD":
          ".github/scripts/version.test.ts\n",
      },
    });

    await run([], cli.deps);

    assertEquals(cli.outputs, ["skip=true\n"]);
    assertEquals(cli.logs, [
      "skip=true",
      "No release-triggering commits since v1.2.3, skipping",
    ]);
  });

  it("emits skip=true in the no-tag fallback when only the current commit changes test files", async () => {
    const cli = makeCliDeps({
      env: {
        GITHUB_EVENT_NAME: "pull_request",
        GITHUB_OUTPUT: "/tmp/github-output",
      },
      files: {
        "package.json": JSON.stringify({ name: "fallback-package" }),
      },
      commands: {
        "git rev-parse HEAD": "abcdef1234567890",
        "git describe --tags --abbrev=0 --match v*": new Error("no tags"),
        "npm view fallback-package version": "0.1.0",
        "git log --format=%s": "docs: note fallback behavior",
        "git log --format=%b": "",
        "git show --format= --name-only HEAD":
          ".github/scripts/version.test.ts\n",
      },
      now: new Date("2026-02-12T09:14:29Z"),
    });

    await run([], cli.deps);

    assertEquals(cli.outputs, ["skip=true\n"]);
    assertEquals(cli.logs, [
      "skip=true",
      "No release-triggering commits since initial, skipping",
    ]);
  });
});
