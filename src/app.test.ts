import { afterEach, describe, expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import type { CliRenderer } from "@opentui/core";

import {
  ShippedApp,
  builtOn,
  chooseRow,
  describeRatio,
  expansionLines,
  formatAge,
  freshnessLabel,
  fuzzyMatch,
  hitRow,
  originLabel,
  rankBranches,
  relativeDay,
  resolveSource,
  shortSha,
  syncTag,
  truncate,
  type AppDeps,
  type Seeds,
} from "./app";
import { GitError, type ScanHandlers } from "./git-bridge";
import type {
  BranchRef,
  CommitRef,
  Hit,
  ScanSummary,
  SourceContext,
  SyncState,
  Verdict,
  Workspace,
} from "./types";

const mounted: { renderer: CliRenderer; app: ShippedApp }[] = [];

afterEach(() => {
  // Each mount attaches listeners to shared terminal singletons; without this
  // the suite drowns in EventTarget max-listener warnings. dispose() first so an
  // in-flight scan cannot come back and touch a destroyed renderable.
  for (const { renderer, app } of mounted.splice(0)) {
    app.dispose();
    renderer.destroy();
  }
});

const DAY = 86_400;
const NOW = 1_780_000_000_000;

function branch(name: string, sync: SyncState = "in-sync", daysOld = 1): BranchRef {
  return {
    name,
    ref: sync === "in-sync" ? `origin/${name}` : `refs/heads/${name}`,
    remoteRef: sync === "local-only" ? null : `origin/${name}`,
    sync,
    committedAt: Math.floor(NOW / 1000) - daysOld * DAY,
  };
}

function verdict(overrides: Partial<Verdict> = {}): Verdict {
  return { state: "absent", present: 0, total: 5, missing: [], approximate: false, ...overrides };
}

const OWN: CommitRef[] = [
  { sha: "1b9e42a7c05f38d6ea71b0c94d2f8563ae017b4d", subject: "fix(web): only hide export actions" },
  { sha: "7c40de915b62a8f30d5c19e7b84a2610fd3b7982", subject: "fix(web): close the empty filter menu" },
  { sha: "5e83b1fa7d094c26b8e5310af7629d04c1b8e735", subject: "test(web): drop any from the mocks" },
  { sha: "9a27ec5b03df14876b2e0a9c5d3481fe6027ab30", subject: "test(web): named fixture" },
  { sha: "f04c9b28e17a5d306cb98241e7f350ad6b2c9e81", subject: "docs(web): note which PROJ-482 cases" },
];

const SOURCE = branch("bugfix/PROJ-482-disable-export-actions", "in-sync", 0);

function workspace(overrides: Partial<Workspace> = {}): Workspace {
  return {
    repo: { root: "/work/web-client", name: "web-client", worktree: false },
    baseRef: "origin/develop",
    branches: [
      SOURCE,
      branch("feature/PROJ-517/search-filter-sync", "in-sync", 30),
      branch("feature/PROJ-533/inline-preview-flag", "in-sync", 12),
      branch("develop", "in-sync", 2),
      branch("preprod", "in-sync", 7),
      branch("qa", "in-sync", 0),
      branch("release", "in-sync", 40),
    ],
    head: "bugfix/PROJ-482-disable-export-actions",
    freshness: { fetchedAt: Date.now(), stale: false },
    warnings: [],
    ...overrides,
  };
}

function context(overrides: Partial<SourceContext> = {}): SourceContext {
  return {
    source: SOURCE,
    baseRef: "origin/develop",
    own: OWN,
    strategy: "cherry",
    ancestors: new Set<string>(),
    ...overrides,
  };
}

function hit(name: string, v: Partial<Verdict>, opts: { days?: number; ancestor?: boolean } = {}): Hit {
  return {
    target: branch(name, "in-sync", opts.days ?? 1),
    verdict: verdict(v),
    ancestor: opts.ancestor ?? false,
  };
}

/** The shape the design was validated against: four of five arrived. */
const PARTIAL = hit("qa", { state: "partial", present: 4, total: 5, missing: [OWN[4]!] }, { days: 0 });

/**
 * A scan driven from fixtures: it reports the hits it was handed and then the
 * summary, the same way the real one streams.
 */
function scanOf(hits: Hit[], summary: Partial<ScanSummary> = {}): NonNullable<AppDeps["scan"]> {
  return async (_source, _ws, handlers: ScanHandlers) => {
    for (const [i, h] of hits.entries()) {
      handlers.onHit(h);
      handlers.onProgress(i + 1, 6);
    }
    return { context: context(), scanned: 6, absent: 6 - hits.length, ...summary };
  };
}

async function mount(ws: Workspace = workspace(), seeds: Seeds = {}, deps: AppDeps = {}) {
  const setup = await createTestRenderer({ width: 110, height: 30, kittyKeyboard: true });
  const app = new ShippedApp(setup.renderer, ws, seeds, deps);
  mounted.push({ renderer: setup.renderer, app });
  await setup.renderOnce();
  return { ...setup, app };
}

/**
 * The scan is async and the renderer does not await it. Let the microtask queue
 * drain before reading the frame, or the assertion races the "scanning" state.
 */
function settle(): Promise<void> {
  return Bun.sleep(0);
}

/** Mounts, lets the scan finish, and returns the settled frame. */
async function answer(hits: Hit[], ws: Workspace = workspace(), summary: Partial<ScanSummary> = {}) {
  const setup = await mount(ws, {}, { scan: scanOf(hits, summary) });
  await settle();
  await setup.renderOnce();
  return setup;
}

const lineWith = (frame: string, needle: string) =>
  frame.split("\n").find((line) => line.includes(needle)) ?? "";

describe("fuzzyMatch", () => {
  test("matches a contiguous fragment", () => {
    expect(fuzzyMatch("517", "feature/PROJ-517/search-filter-sync")).toBe(true);
  });

  test("matches characters spread across the name", () => {
    expect(fuzzyMatch("517filter", "feature/PROJ-517/search-filter-sync")).toBe(true);
  });

  test("rejects a fragment whose characters are out of order", () => {
    expect(fuzzyMatch("syncfilter", "feature/PROJ-517/search-filter-sync")).toBe(false);
  });

  test("ignores case", () => {
    expect(fuzzyMatch("SEARCH", "feature/PROJ-517/search-filter-sync")).toBe(true);
  });

  test("an empty query matches everything", () => {
    expect(fuzzyMatch("", "anything")).toBe(true);
  });
});

describe("rankBranches", () => {
  const all = workspace().branches;

  test("keeps only the branches that match", () => {
    expect(rankBranches("517", all).map((b) => b.name)).toEqual([
      "feature/PROJ-517/search-filter-sync",
    ]);
  });

  test("puts a name that starts with the fragment first", () => {
    const ranked = rankBranches("qa", [branch("feature/qa-helpers"), branch("qa")]);
    expect(ranked[0]!.name).toBe("qa");
  });

  test("returns everything for an empty query", () => {
    expect(rankBranches("", all)).toHaveLength(all.length);
  });
});

describe("resolveSource", () => {
  test("an exact name wins outright", () => {
    // Otherwise `shipped develop` would open a picker just because some feature
    // branch also contains those letters.
    const ws = workspace({ branches: [branch("develop"), branch("feature/develop-helpers")] });
    expect(resolveSource("develop", ws).map((b) => b.name)).toEqual(["develop"]);
  });

  test("a fragment that names one branch resolves to it", () => {
    expect(resolveSource("517", workspace()).map((b) => b.name)).toEqual([
      "feature/PROJ-517/search-filter-sync",
    ]);
  });

  test("an ambiguous fragment returns every candidate", () => {
    expect(resolveSource("PROJ", workspace()).length).toBeGreaterThan(1);
  });

  test("no fragment means the branch you are standing on", () => {
    expect(resolveSource("", workspace()).map((b) => b.name)).toEqual([SOURCE.name]);
  });

  test("a detached HEAD resolves to nothing rather than guessing", () => {
    expect(resolveSource("", workspace({ head: null }))).toEqual([]);
  });

  test("a fragment that names nothing resolves to nothing", () => {
    expect(resolveSource("no-such-branch", workspace())).toEqual([]);
  });
});

describe("builtOn", () => {
  test("folds a partial hit the source already contains", () => {
    // A stacked branch forked off an earlier point of the same work reports a
    // partial hit forever. It is where the work came from, not where it went.
    expect(builtOn(hit("earlier", { state: "partial", present: 3 }, { ancestor: true }))).toBe(true);
  });

  test("never folds a full hit, even one the source contains", () => {
    // Merging into a branch and then rebasing onto it leaves it an ancestor
    // too. Folding by ancestry alone would hide the answer.
    expect(builtOn(hit("qa", { state: "full", present: 5 }, { ancestor: true }))).toBe(false);
  });

  test("never folds a branch the source was not built on", () => {
    expect(builtOn(hit("preprod", { state: "partial", present: 4 }))).toBe(false);
  });
});

describe("describeRatio", () => {
  test("counts what arrived against what there was", () => {
    expect(describeRatio(verdict({ present: 4, total: 5 }))).toBe("4/5");
  });

  test("says it in words when there is no honest count", () => {
    // On the ancestry path git cannot tell which commits were the branch's, so
    // a ratio would be invented.
    expect(describeRatio(verdict({ state: "full", approximate: true }))).toBe("all of it");
    expect(describeRatio(verdict({ state: "absent", approximate: true }))).toBe("none");
  });
});

describe("relativeDay", () => {
  test("calls anything from the last day today", () => {
    expect(relativeDay(Math.floor(NOW / 1000) - 3600, NOW)).toBe("today");
  });

  test("counts whole days after that", () => {
    expect(relativeDay(Math.floor(NOW / 1000) - 7 * DAY, NOW)).toBe("7d");
  });
});

describe("truncate", () => {
  test("leaves a name that fits alone", () => {
    expect(truncate("qa", 10)).toBe("qa");
  });

  test("marks a name it had to cut", () => {
    expect(truncate("feature/PROJ-517/search-filter-sync", 10)).toBe("feature/P…");
  });
});

describe("originLabel", () => {
  test("counts the commits the ratios are measured against", () => {
    expect(originLabel(context(), "origin/develop")).toBe("5 commits vs origin/develop");
  });

  test("says so when the base already absorbed the branch", () => {
    expect(originLabel(context({ strategy: "ancestry", own: [] }), "origin/develop")).toBe(
      "absorbed by origin/develop",
    );
  });

  test("names the base before any scan has run", () => {
    expect(originLabel(null, "origin/main")).toBe("vs origin/main");
  });
});

describe("hitRow", () => {
  test("carries the branch, the ratio and the age", () => {
    const row = hitRow(PARTIAL, false, 60, NOW);

    expect(row).toContain("qa");
    expect(row).toContain("4/5");
    expect(row).toContain("today");
  });

  test("marks the selected row", () => {
    expect(hitRow(PARTIAL, true, 60, NOW).startsWith(" › ")).toBe(true);
  });

  test("keeps a long name from pushing the ratio off the edge", () => {
    const long = hit("feature/PROJ-517/a-branch-name-that-will-not-fit-in-the-column", {
      state: "full",
      present: 5,
    });
    expect(hitRow(long, false, 40, NOW).length).toBeLessThanOrEqual(40);
  });

  test("says when the branch never left this machine", () => {
    const local: Hit = { ...PARTIAL, target: branch("qa", "local-only") };
    expect(hitRow(local, false, 70, NOW)).toContain("local only");
  });
});

describe("chooseRow", () => {
  test("shows no ratio, because nothing has been compared yet", () => {
    const row = chooseRow(branch("feature/PROJ-517/search-filter-sync", "in-sync", 30), false, 70, NOW);

    expect(row).toContain("feature/PROJ-517/search-filter-sync");
    expect(row).toContain("30d");
    expect(row).not.toContain("/5");
  });
});

describe("expansionLines", () => {
  test("names the commits that did not arrive", () => {
    const lines = expansionLines(PARTIAL);

    expect(lines[0]).toContain("1 missing from origin/qa");
    expect(lines[1]).toContain("f04c9b28e");
    expect(lines[1]).toContain("docs(web): note which PROJ-482 cases");
  });

  test("says so when nothing is missing", () => {
    expect(expansionLines(hit("qa", { state: "full", present: 5 }))[0]).toContain("nothing missing");
  });

  test("explains itself when there is nothing to list", () => {
    const absorbed = hit("qa", { state: "full", approximate: true, total: 0 });
    expect(expansionLines(absorbed)[0]).toContain("cannot list its commits");
  });
});

describe("syncTag", () => {
  test("says nothing for the ordinary case", () => {
    expect(syncTag("in-sync")).toBe("");
  });

  test("flags a branch origin has never seen", () => {
    expect(syncTag("local-only")).toContain("local only");
  });

  test("flags a local ref that disagrees with origin", () => {
    expect(syncTag("diverged")).toContain("local ≠ origin");
  });
});

describe("shortSha", () => {
  test("shortens to something a person can read back", () => {
    expect(shortSha("f04c9b28e17a5d306cb98241e7f350ad6b2c9e81")).toBe("f04c9b28e");
  });
});

describe("formatAge", () => {
  test("counts seconds, then minutes, then hours, then days", () => {
    expect(formatAge(5_000)).toBe("5s");
    expect(formatAge(90_000)).toBe("1m");
    expect(formatAge(3_600_000 * 2)).toBe("2h");
    expect(formatAge(86_400_000 * 3)).toBe("3d");
  });
});

describe("freshnessLabel", () => {
  test("shouts when the refs were never refreshed", () => {
    expect(freshnessLabel({ fetchedAt: null, stale: true }, NOW)).toBe("refs may be STALE");
  });

  test("otherwise says how old the answer is", () => {
    expect(freshnessLabel({ fetchedAt: NOW - 5_000, stale: false }, NOW)).toBe("fetched 5s ago");
  });
});

describe("ShippedApp — the answer arrives without being asked for", () => {
  test("names the branch it is answering for", async () => {
    // The question "did it find my branch?" is answered by the largest element
    // on the screen. It used to live in a dim footer line under a list of every
    // branch in the repository, and readers concluded the search had failed.
    const frame = (await answer([PARTIAL])).captureCharFrame();

    expect(frame).toContain("shipped  bugfix/PROJ-482-disable-export-actions");
  });

  test("lists every branch carrying the work, without a target being picked", async () => {
    const frame = (
      await answer([PARTIAL, hit("preprod", { state: "full", present: 5 }, { days: 7 })])
    ).captureCharFrame();

    expect(lineWith(frame, " qa ")).toContain("4/5");
    expect(lineWith(frame, "preprod")).toContain("5/5");
  });

  test("orders the newest tip first", async () => {
    // Measured on a real repository: ranking by how much of the work arrived
    // buried the integration branch at position 11 of 14, while ranking by date
    // put it first.
    const frame = (
      await answer([
        hit("old-feature", { state: "full", present: 5 }, { days: 30 }),
        hit("qa", { state: "partial", present: 4 }, { days: 0 }),
      ])
    ).captureCharFrame();
    const lines = frame.split("\n");

    expect(lines.findIndex((l) => l.includes("qa"))).toBeLessThan(
      lines.findIndex((l) => l.includes("old-feature")),
    );
  });

  test("counts the branches that do not have it, so the list is not read as truncated", async () => {
    const frame = (await answer([PARTIAL])).captureCharFrame();

    expect(frame).toContain("5 branches do not have it");
  });

  test("says how many hits there are next to how many branches were checked", async () => {
    const frame = (await answer([PARTIAL])).captureCharFrame();

    expect(frame).toContain("where this work is");
    expect(lineWith(frame, "where this work is")).toContain("1 hit");
  });

  test("counts the commits every ratio is measured against", async () => {
    const frame = (await answer([PARTIAL])).captureCharFrame();

    expect(frame).toContain("5 commits vs origin/develop");
  });

  test("says plainly when the work is nowhere yet", async () => {
    const frame = (await answer([])).captureCharFrame();

    expect(frame).toContain("nowhere yet");
  });

  test("never asks which branch to compare against", async () => {
    const frame = (await answer([PARTIAL])).captureCharFrame();

    expect(frame).not.toContain("target");
    expect(frame).not.toContain("step 2");
    expect(frame).not.toContain("pick one");
  });

  test("surfaces a scan that failed instead of dying quietly", async () => {
    const setup = await mount(
      workspace(),
      {},
      {
        scan: () => Promise.reject(new GitError("origin/develop is gone")),
      },
    );
    await settle();
    await setup.renderOnce();

    expect(setup.captureCharFrame()).toContain("origin/develop is gone");
  });
});

describe("ShippedApp — what is missing", () => {
  test("lists the missing commits under the row, without leaving the screen", async () => {
    const setup = await answer([PARTIAL]);
    await setup.mockInput.pressKey("RETURN");
    await setup.renderOnce();
    const frame = setup.captureCharFrame();

    expect(frame).toContain("1 missing from origin/qa");
    expect(frame).toContain("docs(web): note which PROJ-482");
    // The row it belongs to is still on screen: nothing navigated anywhere.
    expect(frame).toContain("shipped  bugfix/PROJ-482-disable-export-actions");
  });

  test("closes again on a second press", async () => {
    const setup = await answer([PARTIAL]);
    await setup.mockInput.pressKey("RETURN");
    await setup.renderOnce();
    await setup.mockInput.pressKey("RETURN");
    await setup.renderOnce();

    expect(setup.captureCharFrame()).not.toContain("1 missing from");
  });
});

describe("ShippedApp — branches the source was built on", () => {
  const stacked = hit("feature/PROJ-482-earlier-slice", { state: "partial", present: 2 }, {
    days: 20,
    ancestor: true,
  });

  test("keeps them out of the answer", async () => {
    const frame = (await answer([PARTIAL, stacked])).captureCharFrame();

    expect(frame).not.toContain("earlier-slice");
  });

  test("says how many were folded, rather than hiding them silently", async () => {
    const frame = (await answer([PARTIAL, stacked])).captureCharFrame();

    expect(frame).toContain("1 more your branch was built on");
    expect(frame).toContain("h to show");
  });

  test("shows them on demand", async () => {
    const setup = await answer([PARTIAL, stacked]);
    await setup.mockInput.pressKey("h");
    await setup.renderOnce();

    expect(setup.captureCharFrame()).toContain("earlier-slice");
  });

  test("a full hit is never folded, even when the source contains it", async () => {
    const mirror = hit("same-tip", { state: "full", present: 5 }, { days: 20, ancestor: true });
    const frame = (await answer([PARTIAL, mirror])).captureCharFrame();

    expect(frame).toContain("same-tip");
    expect(frame).not.toContain("your branch was built on");
  });

  test("does not offer the key when nothing was folded", async () => {
    const frame = (await answer([PARTIAL])).captureCharFrame();

    expect(frame).not.toContain("built on");
  });
});

describe("ShippedApp — choosing between branches", () => {
  test("an unambiguous fragment goes straight to the answer", async () => {
    const setup = await mount(workspace(), { source: "517" }, { scan: scanOf([PARTIAL]) });
    await settle();
    await setup.renderOnce();

    expect(setup.captureCharFrame()).toContain("where this work is");
  });

  test("an ambiguous one asks, over the branches it could mean and no others", async () => {
    const setup = await mount(workspace(), { source: "PROJ" }, { scan: scanOf([PARTIAL]) });
    await settle();
    await setup.renderOnce();
    const frame = setup.captureCharFrame();

    expect(frame).toContain("branches match");
    expect(frame).toContain("pick the one you mean");
    // The branches that cannot be meant are not on screen.
    expect(frame).not.toContain("release");
  });

  test("picking one answers for it", async () => {
    const setup = await mount(workspace(), { source: "PROJ" }, { scan: scanOf([PARTIAL]) });
    await settle();
    await setup.mockInput.pressKey("RETURN");
    await settle();
    await setup.renderOnce();

    expect(setup.captureCharFrame()).toContain("where this work is");
  });

  test("says so when the fragment names nothing", async () => {
    const setup = await mount(workspace(), { source: "no-such-branch" }, { scan: scanOf([]) });
    await settle();
    await setup.renderOnce();

    expect(setup.captureCharFrame()).toContain('no branch matches "no-such-branch"');
  });

  test("with no fragment it answers for the branch you are standing on", async () => {
    const frame = (await answer([PARTIAL])).captureCharFrame();

    expect(frame).toContain(`shipped  ${SOURCE.name}`);
  });

  test("asks which branch when HEAD is detached", async () => {
    const setup = await mount(workspace({ head: null }), {}, { scan: scanOf([]) });
    await settle();
    await setup.renderOnce();

    expect(setup.captureCharFrame()).toContain("detached HEAD");
  });
});

describe("ShippedApp — the list stays inside its box", () => {
  /**
   * More hits than the row pool can hold. This is the condition the overflow bug
   * needed: with a handful of rows the surplus ones are empty and paint nothing,
   * so every other test passed while a real repository rendered branch names
   * straight over the footer.
   */
  function crowded() {
    return Array.from({ length: 61 }, (_, i) =>
      hit(`feature/PROJ-${100 + i}/some-reasonably-long-branch-name`, {
        state: "partial",
        present: 3,
      }, { days: i }),
    );
  }

  const footerOf = (frame: string) => lineWith(frame, "q quit");

  test("the footer survives a list longer than the screen", async () => {
    const frame = (await answer(crowded())).captureCharFrame();

    expect(footerOf(frame)).toContain("enter what is missing");
  });

  test("no branch name bleeds into the footer", async () => {
    expect(footerOf((await answer(crowded())).captureCharFrame())).not.toContain("PROJ-");
  });

  test("the counted line is not overwritten either", async () => {
    const frame = (await answer(crowded())).captureCharFrame();

    expect(lineWith(frame, "do not have it")).not.toContain("PROJ-");
  });

  test("the box keeps its bottom border", async () => {
    const frame = (await answer(crowded())).captureCharFrame();
    const closing = frame.split("\n").filter((line) => line.includes("└"));

    expect(closing.every((line) => !line.includes("PROJ-"))).toBe(true);
  });

  test("the header survives a crowded list", async () => {
    // It sits above the box that grows, so an unclipped list would reach it
    // before it reached the footer.
    const frame = (await answer(crowded())).captureCharFrame();

    expect(lineWith(frame, "shipped  ")).toContain(SOURCE.name);
  });

  test("scrolls to keep the cursor visible", async () => {
    const setup = await answer(crowded());
    for (let i = 0; i < 40; i++) await setup.mockInput.pressKey("DOWN");
    await setup.renderOnce();
    const frame = setup.captureCharFrame();

    expect(frame).toContain("›");
    expect(footerOf(frame)).not.toContain("PROJ-");
  });
});
