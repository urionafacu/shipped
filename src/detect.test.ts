import { describe, expect, test } from "bun:test";

import { chooseStrategy, detect } from "./detect";
import type { CherryLine, CommitRef, Probe } from "./types";

function commits(...subjects: string[]): CommitRef[] {
  return subjects.map((subject, i) => ({ sha: `${i}`.repeat(40), subject }));
}

/** "----+" reads as: four commits already upstream, the fifth still missing. */
function cherry(marks: string, own: CommitRef[]): CherryLine[] {
  return [...marks].map((mark, i) => ({
    mark: mark as "+" | "-",
    sha: own[i]!.sha,
    subject: own[i]!.subject,
  }));
}

describe("chooseStrategy", () => {
  test("an active feature branch is compared by patch-id", () => {
    expect(chooseStrategy(commits("a", "b"), false)).toBe("cherry");
  });

  test("a branch the base already absorbed falls back to ancestry", () => {
    // Without its own commits there is nothing for `git cherry` to compare.
    expect(chooseStrategy([], false)).toBe("ancestry");
  });

  test("a repository with no base ref falls back to ancestry", () => {
    // The cherry path needs a base ref as its limit; ancestry does not.
    expect(chooseStrategy(commits("a", "b"), true)).toBe("ancestry");
  });
});

describe("detect — cherry strategy", () => {
  const own = commits("one", "two", "three");

  function run(probe: Probe) {
    return detect({ strategy: "cherry", own, probe });
  }

  test("every commit present reads as full", () => {
    const verdict = run({ cherry: cherry("---", own) });

    expect(verdict).toMatchObject({ state: "full", present: 3, total: 3, approximate: false });
    expect(verdict.missing).toEqual([]);
  });

  test("some commits present reads as partial and names what is missing", () => {
    const verdict = run({ cherry: cherry("--+", own) });

    expect(verdict).toMatchObject({ state: "partial", present: 2, total: 3 });
    expect(verdict.missing).toEqual([own[2]!]);
  });

  test("no commit present reads as absent and lists them all", () => {
    const verdict = run({ cherry: cherry("+++", own) });

    expect(verdict).toMatchObject({ state: "absent", present: 0, total: 3 });
    expect(verdict.missing).toEqual(own);
  });

  test("a branch merged straight in reads as full against its own commits", () => {
    // `git cherry` drops commits the target already reaches, so a cleanly
    // merged branch produces no output at all. Counting the printed lines would
    // report "0/0 commits"; the branch's own commits are the honest denominator.
    const verdict = run({ cherry: [] });

    expect(verdict).toMatchObject({ state: "full", present: 3, total: 3 });
    expect(verdict.missing).toEqual([]);
  });

  test("counts a rebased commit as present even though git still lists it", () => {
    // A `-` line means patch-equivalent: the commit arrived under another SHA.
    expect(run({ cherry: cherry("--+", own) })).toMatchObject({ present: 2, total: 3 });
  });

  test("never reports more present than the branch has", () => {
    const stray: CherryLine[] = own
      .concat(commits("stray-a", "stray-b"))
      .map((c) => ({ mark: "+" as const, sha: c.sha, subject: c.subject }));

    expect(run({ cherry: stray }).present).toBe(0);
  });

  test("fills missing subjects from the branch's own commits", () => {
    // `git cherry` without -v prints SHAs only; the UI still needs subjects.
    const bare: CherryLine[] = [{ mark: "+", sha: own[1]!.sha, subject: "" }];

    expect(run({ cherry: bare }).missing).toEqual([own[1]!]);
  });

  test("keeps an unknown SHA rather than dropping it from the count", () => {
    const stray: CherryLine[] = [{ mark: "+", sha: "f".repeat(40), subject: "" }];

    expect(run({ cherry: stray }).missing).toEqual([{ sha: "f".repeat(40), subject: "" }]);
  });

  test("treats absent cherry output as an empty comparison rather than throwing", () => {
    expect(run({}).state).toBe("full");
  });
});

describe("detect — ancestry strategy", () => {
  function run(probe: Probe) {
    return detect({ strategy: "ancestry", own: [], probe });
  }

  test("a branch reachable from the target is full", () => {
    expect(run({ containsBranch: true })).toMatchObject({ state: "full", approximate: true });
  });

  test("a branch not reachable from the target is absent", () => {
    expect(run({ containsBranch: false })).toMatchObject({ state: "absent", approximate: true });
  });

  test("never reports partial — git cannot isolate the branch's commits here", () => {
    for (const containsBranch of [true, false]) {
      expect(run({ containsBranch }).state).not.toBe("partial");
    }
  });

  test("invents no counts and no commit list", () => {
    const verdict = run({ containsBranch: false });

    expect(verdict).toMatchObject({ present: 0, total: 0 });
    expect(verdict.missing).toEqual([]);
  });
});

/**
 * The two branch shapes the design was validated against on a real repository,
 * reproduced here with example names. These are the regression guard for the
 * whole algorithm.
 */
describe("detect — the validated branch shapes", () => {
  const own = commits(
    "fix(web): only hide export actions under DISABLE_EXPORT",
    "fix(web): close the empty filter menu and the preview leak",
    "test(web): drop any from the store passthrough mocks",
    "test(web): build the footer record from a named fixture",
    "docs(web): note which PROJ-482 cases the US environment cannot exercise",
  );

  test("bugfix/PROJ-482 against testing: none of it arrived", () => {
    expect(chooseStrategy(own, false)).toBe("cherry");

    expect(detect({ strategy: "cherry", own, probe: { cherry: cherry("+++++", own) } })).toMatchObject(
      { state: "absent", present: 0, total: 5 },
    );
  });

  test("bugfix/PROJ-482 against testing-us: four of five, and it names the fifth", () => {
    const verdict = detect({ strategy: "cherry", own, probe: { cherry: cherry("----+", own) } });

    expect(verdict).toMatchObject({ state: "partial", present: 4, total: 5 });
    // The one commit QA would never have been told about under a binary report.
    expect(verdict.missing).toEqual([own[4]!]);
  });

  test("bugfix/PROJ-461: absorbed by the base, so only all-or-nothing is knowable", () => {
    expect(chooseStrategy([], false)).toBe("ancestry");

    expect(detect({ strategy: "ancestry", own: [], probe: { containsBranch: true } })).toMatchObject({
      state: "full",
      approximate: true,
    });
    expect(detect({ strategy: "ancestry", own: [], probe: { containsBranch: false } })).toMatchObject(
      { state: "absent", approximate: true },
    );
  });
});
