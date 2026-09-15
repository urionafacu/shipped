import { afterEach, describe, expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import type { CliRenderer } from "@opentui/core";

import {
  ShippedApp,
  describeVerdict,
  formatAge,
  freshnessLabel,
  fuzzyMatch,
  noMissingReason,
  rankBranches,
  shortSha,
  stateGlyph,
  summarize,
  type AppDeps,
  type Seeds,
} from "./app";
import { GitError } from "./git-bridge";
import type { BranchRef, Comparison, Verdict, Workspace } from "./types";

const mounted: { renderer: CliRenderer; app: ShippedApp }[] = [];

afterEach(() => {
  // Each mount attaches listeners to shared terminal singletons; without this
  // the suite drowns in EventTarget max-listener warnings. dispose() first so an
  // in-flight refetch cannot come back and touch a destroyed renderable.
  for (const { renderer, app } of mounted.splice(0)) {
    app.dispose();
    renderer.destroy();
  }
});

function branch(name: string): BranchRef {
  return { name, ref: `origin/${name}` };
}

function verdict(overrides: Partial<Verdict> = {}): Verdict {
  return { state: "absent", present: 0, total: 5, missing: [], approximate: false, ...overrides };
}

function workspace(overrides: Partial<Workspace> = {}): Workspace {
  return {
    repo: { root: "/work/web-client", name: "web-client" },
    baseRef: "origin/develop",
    branches: [
      branch("feature/PROJ-517/search-filter-sync"),
      branch("bugfix/PROJ-482-disable-export-actions"),
      branch("feature/PROJ-533/inline-preview-flag"),
      branch("develop"),
      branch("preprod"),
      branch("qa"),
      branch("release"),
    ],
    freshness: { fetchedAt: Date.now(), stale: false },
    warnings: [],
    ...overrides,
  };
}

const SOURCE = branch("bugfix/PROJ-482-disable-export-actions");
const TARGET = branch("preprod");

const OWN = [
  { sha: "1b9e42a7c05f38d6ea71b0c94d2f8563ae017b4d", subject: "fix(web): only hide export actions" },
  { sha: "7c40de915b62a8f30d5c19e7b84a2610fd3b7982", subject: "fix(web): close the empty filter menu" },
  { sha: "5e83b1fa7d094c26b8e5310af7629d04c1b8e735", subject: "test(web): drop any from the mocks" },
  { sha: "9a27ec5b03df14876b2e0a9c5d3481fe6027ab30", subject: "test(web): named fixture" },
  { sha: "f04c9b28e17a5d306cb98241e7f350ad6b2c9e81", subject: "docs(web): note which PROJ-482 cases" },
];

function comparison(overrides: Partial<Comparison> = {}): Comparison {
  return {
    source: SOURCE,
    target: TARGET,
    strategy: "cherry",
    baseRef: "origin/develop",
    own: OWN,
    verdict: verdict(),
    ...overrides,
  };
}

/** The branch shape the design was validated against: four of five arrived. */
function validatedPartial(): Comparison {
  return comparison({
    verdict: verdict({ state: "partial", present: 4, total: 5, missing: [OWN[4]!] }),
  });
}

/** The other validated shape: the base absorbed it, so only all-or-nothing is knowable. */
function validatedAbsorbed(): Comparison {
  return comparison({
    strategy: "ancestry",
    own: [],
    verdict: verdict({ state: "full", present: 0, total: 0, approximate: true }),
  });
}

/**
 * kittyKeyboard makes a bare Escape arrive as an unambiguous "escape" key. With
 * the legacy encoding a lone \x1b is held back by the parser waiting to see if
 * it starts a CSI sequence, so the key never reaches the handler in tests.
 */
async function mount(ws: Workspace = workspace(), seeds: Seeds = {}, deps: AppDeps = {}) {
  const setup = await createTestRenderer({ width: 110, height: 30, kittyKeyboard: true });
  const app = new ShippedApp(setup.renderer, ws, seeds, deps);
  mounted.push({ renderer: setup.renderer, app });
  await setup.renderOnce();
  return { ...setup, app };
}

/**
 * Key handlers that reach git are async, and the renderer does not await them.
 * Let the microtask queue drain before reading the frame, or the assertion
 * races the "… checking" placeholder.
 */
function settle(): Promise<void> {
  return Bun.sleep(0);
}

/**
 * Walks the whole flow the way a user does: type, enter, type, enter.
 *
 * Typed rather than seeded on purpose. A seed that matches exactly one branch
 * skips its picker, which is a different path with its own test — seeding here
 * would stop exercising the keyboard at all.
 */
async function openResult(deps: AppDeps, ws: Workspace = workspace()) {
  const setup = await mount(ws, {}, deps);
  await setup.mockInput.pressKeys([..."482"]);
  await setup.mockInput.pressKey("RETURN");
  await settle();
  await setup.mockInput.pressKeys([..."preprod"]);
  await setup.mockInput.pressKey("RETURN");
  await settle();
  await setup.renderOnce();
  return setup;
}

describe("fuzzyMatch", () => {
  test("an empty query matches everything", () => {
    expect(fuzzyMatch("", "anything")).toBe(true);
  });

  test("matches a plain substring", () => {
    expect(fuzzyMatch("filter", "feature/PROJ-517/search-filter-sync")).toBe(true);
  });

  test("matches a scattered subsequence", () => {
    expect(fuzzyMatch("517filter", "feature/PROJ-517/search-filter-sync")).toBe(true);
  });

  test("ignores case", () => {
    expect(fuzzyMatch("PROJ", "feature/proj-517/search-filter-sync")).toBe(true);
  });

  test("rejects characters that are not there", () => {
    expect(fuzzyMatch("zzz", "feature/PROJ-517/search-filter-sync")).toBe(false);
  });

  test("respects order", () => {
    expect(fuzzyMatch("syncfilter", "feature/PROJ-517/search-filter-sync")).toBe(false);
  });
});

describe("rankBranches", () => {
  const all = [
    branch("feature/PROJ-517/search-filter-sync"),
    branch("bugfix/PROJ-482-disable-export-actions"),
    branch("feature/PROJ-533/inline-preview-flag"),
  ];

  test("an empty query keeps everything, sorted by name", () => {
    expect(rankBranches("", all).map((b) => b.name)).toEqual([
      "bugfix/PROJ-482-disable-export-actions",
      "feature/PROJ-517/search-filter-sync",
      "feature/PROJ-533/inline-preview-flag",
    ]);
  });

  test("filters by ticket", () => {
    expect(rankBranches("482", all).map((b) => b.name)).toEqual([
      "bugfix/PROJ-482-disable-export-actions",
    ]);
  });

  test("ranks a contiguous hit above a scattered one", () => {
    const ranked = rankBranches("filter", all);
    expect(ranked[0]!.name).toBe("feature/PROJ-517/search-filter-sync");
  });

  test("a query matching nothing yields an empty list rather than an error", () => {
    expect(rankBranches("zzz", all)).toEqual([]);
  });
});

describe("describeVerdict", () => {
  test("prints the ratio when the commits are countable", () => {
    expect(
      describeVerdict(
        verdict({ state: "partial", present: 4, total: 5, missing: [OWN[4]!] }),
      ),
    ).toBe("4/5 commits · 1 missing");
  });

  test("prints a full ratio", () => {
    expect(describeVerdict(verdict({ state: "full", present: 11, total: 11 }))).toBe("11/11 commits");
  });

  test("prints a zero ratio when absent", () => {
    expect(describeVerdict(verdict({ state: "absent", total: 11 }))).toBe("0/11 commits");
  });

  test("invents no ratio on the ancestry path", () => {
    // present/total are 0 there; printing "0/0 commits" would be a lie.
    expect(
      describeVerdict(verdict({ state: "full", approximate: true, present: 0, total: 0 })),
    ).toBe("the whole branch is here");
    expect(
      describeVerdict(verdict({ state: "absent", approximate: true, present: 0, total: 0 })),
    ).toBe("the branch has not arrived");
  });
});

describe("stateGlyph", () => {
  test("gives each state its own mark", () => {
    const glyphs = (["full", "partial", "absent"] as const).map(stateGlyph);
    expect(glyphs).toEqual(["✓", "◐", "✗"]);
    expect(new Set(glyphs).size).toBe(3);
  });
});

describe("noMissingReason", () => {
  test("explains an empty list on the ancestry path", () => {
    expect(noMissingReason(verdict({ approximate: true }), "origin/develop")).toContain(
      "origin/develop absorbed",
    );
  });

  test("says nothing is missing otherwise", () => {
    expect(noMissingReason(verdict({ state: "full" }))).toBe("nothing missing");
  });
});

describe("formatAge", () => {
  test("counts in the largest unit that still reads naturally", () => {
    expect(formatAge(5_000)).toBe("5s");
    expect(formatAge(120_000)).toBe("2m");
    expect(formatAge(7_200_000)).toBe("2h");
    expect(formatAge(172_800_000)).toBe("2d");
  });

  test("never reports a negative age from a clock skew", () => {
    expect(formatAge(-1000)).toBe("0s");
  });
});

describe("freshnessLabel", () => {
  const now = 1_000_000;

  test("reports how long ago the fetch succeeded", () => {
    expect(freshnessLabel({ fetchedAt: now - 120_000, stale: false }, now)).toBe("fetched 2m ago");
  });

  test("a failed fetch is called stale rather than dated", () => {
    // A checkmark computed from refs that may be behind is worse than no answer.
    expect(freshnessLabel({ fetchedAt: null, stale: true, error: "no network" }, now)).toContain(
      "STALE",
    );
  });

  test("a skipped fetch is stale too", () => {
    expect(freshnessLabel({ fetchedAt: null, stale: true }, now)).toContain("STALE");
  });
});

describe("shortSha", () => {
  test("keeps enough to paste into a git command", () => {
    expect(shortSha("f04c9b28e17a5d306cb98241e7f350ad6b2c9e81")).toBe("f04c9b28e");
  });
});

describe("summarize", () => {
  test("everything present reads as a success, and names the target", () => {
    const [kind, line] = summarize(
      comparison({ verdict: verdict({ state: "full", present: 5, total: 5 }) }),
    );
    expect(kind).toBe("ok");
    expect(line).toBe("preprod ✓ 5/5 commits");
  });

  test("a partial warns", () => {
    expect(summarize(validatedPartial())[0]).toBe("warn");
  });

  test("plainly absent is information, not a warning", () => {
    expect(summarize(comparison())[0]).toBe("info");
  });
});

describe("ShippedApp — picking the source", () => {
  test("lists the branches of the repository it was invoked in", async () => {
    const frame = (await mount()).captureCharFrame();

    expect(frame).toContain("search-filter-sync");
    expect(frame).toContain("inline-preview-flag");
  });

  test("names the repository and the base it measures against", async () => {
    const frame = (await mount()).captureCharFrame();

    expect(frame).toContain("web-client");
    expect(frame).toContain("base origin/develop");
  });

  test("asks for the source branch first", async () => {
    expect((await mount()).captureCharFrame()).toContain("source branch");
  });

  test("shows how fresh the refs are", async () => {
    expect((await mount()).captureCharFrame()).toContain("fetched");
  });

  test("flags stale refs instead of presenting them as authoritative", async () => {
    const { captureCharFrame } = await mount(
      workspace({
        freshness: { fetchedAt: null, stale: true, error: "no network" },
        warnings: ["fetch failed — no network"],
      }),
    );

    expect(captureCharFrame()).toContain("STALE");
  });

  test("surfaces a warning in the header", async () => {
    const { captureCharFrame } = await mount(
      workspace({ warnings: ["fetch failed — no network"] }),
    );
    expect(captureCharFrame()).toContain("fetch failed");
  });

  test("typing filters the list", async () => {
    const { mockInput, renderOnce, captureCharFrame } = await mount();

    await mockInput.pressKeys(["4", "8", "2"]);
    await renderOnce();
    const frame = captureCharFrame();

    expect(frame).toContain("PROJ-482");
    expect(frame).not.toContain("inline-preview-flag");
  });

  test("a seed filters before the first paint", async () => {
    // "feature" on purpose: a seed matching exactly one branch skips this
    // picker entirely, which is a different path with its own test.
    const { captureCharFrame } = await mount(workspace(), { source: "feature" });
    const frame = captureCharFrame();

    expect(frame).toContain("source branch");
    expect(frame).toContain("inline-preview-flag");
    expect(frame).toContain("search-filter-sync");
    expect(frame).not.toContain("preprod");
  });

  test("a seed matching exactly one branch skips straight to the target picker", async () => {
    const { captureCharFrame } = await mount(workspace(), { source: "preview" });
    await settle();

    expect(captureCharFrame()).toContain("target branch");
  });

  test("a query matching nothing says so instead of erroring", async () => {
    const { mockInput, renderOnce, captureCharFrame } = await mount();

    await mockInput.pressKeys(["z", "z", "z"]);
    await renderOnce();

    expect(captureCharFrame()).toContain("no branch matches");
  });

  test("arrow keys move the selection instead of typing into the filter", async () => {
    const { mockInput, renderOnce, captureCharFrame } = await mount();

    await mockInput.pressKey("ARROW_DOWN");
    await renderOnce();
    const frame = captureCharFrame();

    // The cursor moved to the second row and nothing was typed, so the full
    // list is still on screen and the filter is still empty.
    expect(frame).toContain("search-filter-sync");
    expect(frame).toContain("inline-preview-flag");
    expect(frame).not.toContain("no branch matches");
  });

  test("the selection marker follows the arrow keys", async () => {
    const { mockInput, renderOnce, captureCharFrame } = await mount();

    // Sorted by name, so the bugfix branch is first and develop is second.
    expect(captureCharFrame()).toContain("› bugfix/PROJ-482");

    await mockInput.pressKey("ARROW_DOWN");
    await renderOnce();
    expect(captureCharFrame()).toContain("› develop");

    await mockInput.pressKey("ARROW_UP");
    await renderOnce();
    expect(captureCharFrame()).toContain("› bugfix/PROJ-482");
  });

  test("the cursor stops at the ends of the list", async () => {
    const { mockInput, renderOnce, captureCharFrame } = await mount();

    await mockInput.pressKeys(["ARROW_UP", "ARROW_UP"]);
    await renderOnce();
    expect(captureCharFrame()).toContain("› bugfix/PROJ-482");

    await mockInput.pressKeys(Array(12).fill("ARROW_DOWN"));
    await renderOnce();
    expect(captureCharFrame()).toContain("› release");
  });

  test("esc clears the filter rather than quitting", async () => {
    const { mockInput, renderOnce, captureCharFrame } = await mount();

    await mockInput.pressKeys(["4", "8", "2"]);
    await renderOnce();
    expect(captureCharFrame()).not.toContain("inline-preview-flag");

    await mockInput.pressKey("ESCAPE");
    await renderOnce();
    expect(captureCharFrame()).toContain("inline-preview-flag");
  });

  test("r types into the filter instead of refetching", async () => {
    // The search field is focused, so a bare `r` has to reach it as text.
    const { mockInput, renderOnce, captureCharFrame } = await mount();

    await mockInput.pressKey("r");
    await renderOnce();

    expect(captureCharFrame()).not.toContain("fetching");
  });
});

describe("ShippedApp — picking the target", () => {
  async function pickSource(deps: AppDeps = {}) {
    const setup = await mount(workspace(), {}, deps);
    await setup.mockInput.pressKeys([..."482"]);
    await setup.mockInput.pressKey("RETURN");
    await settle();
    await setup.renderOnce();
    return setup;
  }

  test("picking a source asks which branch to check it against", async () => {
    expect((await pickSource()).captureCharFrame()).toContain("target branch");
  });

  test("the target list is the repository's own branches, chosen by nobody", async () => {
    // Nothing is preselected or ranked ahead: these are simply the branches the
    // repository has.
    const frame = (await pickSource()).captureCharFrame();

    expect(frame).toContain("qa");
    expect(frame).toContain("preprod");
    expect(frame).toContain("release");
    expect(frame).toContain("develop");
  });

  test("the source is not offered as its own target", async () => {
    // Comparing a branch against itself is always trivially full, so it is never
    // the question. The status line still names it; the list must not.
    expect((await pickSource()).captureCharFrame()).not.toContain("› bugfix/PROJ-482");
  });

  test("esc goes back to the source picker rather than clearing", async () => {
    const { mockInput, renderOnce, captureCharFrame } = await pickSource();

    await mockInput.pressKey("ESCAPE");
    await renderOnce();
    const frame = captureCharFrame();

    expect(frame).toContain("source branch");
    expect(frame).toContain("› bugfix/PROJ-482");
  });

  test("naming both branches answers the question with no keystrokes", async () => {
    // The whole point of the CLI form: `shipped PROJ-482 preprod`.
    const { captureCharFrame } = await mount(
      workspace(),
      { source: "482", target: "preprod" },
      { compare: async () => validatedPartial() },
    );

    await settle();
    await settle();
    const frame = captureCharFrame();

    expect(frame).toContain("4/5 commits · 1 missing");
  });

  test("a target seed matching several branches still asks which one", async () => {
    const { captureCharFrame } = await mount(
      workspace(),
      { source: "482", target: "e" },
      { compare: async () => validatedPartial() },
    );

    await settle();
    await settle();
    const frame = captureCharFrame();

    expect(frame).toContain("target branch");
    expect(frame).not.toContain("4/5 commits");
  });
});

describe("ShippedApp — the answer", () => {
  test("names both branches and the verdict", async () => {
    const frame = (await openResult({ compare: async () => validatedPartial() })).captureCharFrame();

    expect(frame).toContain("bugfix/PROJ-482-disable-export-actions");
    expect(frame).toContain("origin/preprod");
    expect(frame).toContain("◐  4/5 commits · 1 missing");
  });

  test("the status line answers the question without leaving the keyboard", async () => {
    const frame = (await openResult({ compare: async () => validatedPartial() })).captureCharFrame();

    expect(frame).toContain("preprod ◐ 4/5 commits · 1 missing");
  });

  test("lists the commits that did not make it", async () => {
    const frame = (await openResult({ compare: async () => validatedPartial() })).captureCharFrame();

    expect(frame).toContain("missing from origin/preprod");
    expect(frame).toContain("docs(web): note which PROJ-482");
    expect(frame).toContain("f04c9b28e");
  });

  test("says nothing is missing when everything arrived", async () => {
    const full = comparison({ verdict: verdict({ state: "full", present: 5, total: 5 }) });
    const frame = (await openResult({ compare: async () => full })).captureCharFrame();

    expect(frame).toContain("✓  5/5 commits");
    expect(frame).toContain("nothing missing");
  });

  test("an absorbed branch says so and prints no invented ratio", async () => {
    const frame = (await openResult({ compare: async () => validatedAbsorbed() })).captureCharFrame();

    expect(frame).toContain("already absorbed this branch");
    expect(frame).toContain("✓  the whole branch is here");
    expect(frame).not.toContain("0/0 commits");
  });

  test("explains why an absorbed branch has no commit list", async () => {
    const frame = (await openResult({ compare: async () => validatedAbsorbed() })).captureCharFrame();

    expect(frame).toContain("absorbed the branch");
  });

  test("esc asks about another target without re-picking the source", async () => {
    // The same branch usually gets asked about against several targets in a row.
    const { mockInput, renderOnce, captureCharFrame } = await openResult({
      compare: async () => validatedPartial(),
    });
    expect(captureCharFrame()).toContain("4/5 commits");

    await mockInput.pressKey("ESCAPE");
    await renderOnce();
    const frame = captureCharFrame();

    expect(frame).toContain("target branch");
    expect(frame).not.toContain("4/5 commits");
  });

  test("b goes all the way back to the source picker", async () => {
    const { mockInput, renderOnce, captureCharFrame } = await openResult({
      compare: async () => validatedPartial(),
    });

    await mockInput.pressKey("b");
    await renderOnce();
    const frame = captureCharFrame();

    expect(frame).toContain("source branch");
    expect(frame).toContain("› bugfix/PROJ-482");
  });

  test("r refetches and recomputes the answer", async () => {
    let calls = 0;
    const { mockInput, renderOnce, captureCharFrame } = await openResult({
      compare: async () =>
        calls++ === 0
          ? validatedPartial()
          : comparison({ verdict: verdict({ state: "full", present: 5, total: 5 }) }),
      reload: async () => workspace(),
    });
    expect(captureCharFrame()).toContain("4/5 commits");

    await mockInput.pressKey("r");
    await settle();
    await renderOnce();
    expect(captureCharFrame()).toContain("5/5 commits");
  });

  test("a git failure lands in the status bar instead of killing the session", async () => {
    const { captureCharFrame } = await openResult({
      compare: async () => {
        throw new GitError("bad object origin/nope");
      },
    });
    const frame = captureCharFrame();

    expect(frame).toContain("bad object origin/nope");
    // Still on the target picker, still usable.
    expect(frame).toContain("target branch");
  });

  test("dispose stops the app from repainting", async () => {
    // Guards the real failure mode: an async refetch resolving after teardown
    // and writing into a destroyed TextBuffer.
    const { mockInput, renderOnce, captureCharFrame, app } = await mount();

    await mockInput.pressKeys(["4", "8", "2"]);
    await renderOnce();
    expect(captureCharFrame()).not.toContain("inline-preview-flag");

    app.dispose();
    await mockInput.pressKey("ESCAPE"); // would clear the filter
    await renderOnce();
    expect(captureCharFrame()).not.toContain("inline-preview-flag");
  });
});
