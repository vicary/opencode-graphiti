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
  parseSemver,
} from "./version.ts";

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

describe("calculateVersion", () => {
  const baseOpts = {
    currentVersion: "1.0.0",
    subjects: [],
    bodies: [],
    commitSha: "abc123def456",
    timestamp: "20260212091429",
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
  });
});
