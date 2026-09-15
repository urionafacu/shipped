import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import {
  branchName,
  cherry,
  compare,
  findRepoRoot,
  GitError,
  isAncestor,
  listRemoteBranches,
  loadWorkspace,
  ownCommits,
  parseCherry,
  parseCommitLog,
  parseRefList,
  refExists,
  resolveBaseRef,
} from "./git-bridge";
import { buildSyntheticRepo, gitAvailable, SYNTHETIC, type SyntheticRepo } from "./synthetic-repo";

describe("parseRefList", () => {
  test("returns the remote refs as git printed them", () => {
    const out = "origin/develop\norigin/qa\norigin/feature/PROJ-517/search-filter-sync\n";
    expect(parseRefList(out)).toEqual([
      "origin/develop",
      "origin/qa",
      "origin/feature/PROJ-517/search-filter-sync",
    ]);
  });

  test("drops the bare origin entry", () => {
    // refs/remotes/origin/HEAD renders as a bare "origin" under refname:short.
    // It is a symbolic pointer, not a branch anyone can compare against.
    expect(parseRefList("origin\norigin/develop\n")).toEqual(["origin/develop"]);
  });

  test("drops origin/HEAD however it is spelled", () => {
    expect(parseRefList("origin/HEAD\norigin/develop\n")).toEqual(["origin/develop"]);
  });

  test("survives empty output", () => {
    expect(parseRefList("")).toEqual([]);
    expect(parseRefList("\n\n")).toEqual([]);
  });
});

describe("branchName", () => {
  test("strips the remote prefix", () => {
    expect(branchName("origin/feature/PROJ-517/search-filter-sync")).toBe(
      "feature/PROJ-517/search-filter-sync",
    );
  });

  test("leaves a name that carries no prefix alone", () => {
    expect(branchName("develop")).toBe("develop");
  });
});

describe("parseCommitLog", () => {
  test("splits each line into SHA and subject", () => {
    const out =
      "a3f1c07b9e4d2865fa10cb374e29d8506b1fa4c2 docs(web): note the US cases\n" +
      "c81b640e2af59d3706ec148bb5390a27fd6e0b19 test(web): named fixture\n";

    expect(parseCommitLog(out)).toEqual([
      { sha: "a3f1c07b9e4d2865fa10cb374e29d8506b1fa4c2", subject: "docs(web): note the US cases" },
      { sha: "c81b640e2af59d3706ec148bb5390a27fd6e0b19", subject: "test(web): named fixture" },
    ]);
  });

  test("keeps subjects that contain spaces intact", () => {
    const out = `${"a".repeat(40)} fix: a subject with  several   spaces\n`;
    expect(parseCommitLog(out)[0]!.subject).toBe("fix: a subject with  several   spaces");
  });

  test("tolerates a commit with an empty subject", () => {
    expect(parseCommitLog(`${"a".repeat(40)}\n`)).toEqual([{ sha: "a".repeat(40), subject: "" }]);
  });

  test("survives empty output", () => {
    expect(parseCommitLog("")).toEqual([]);
    expect(parseCommitLog("\n")).toEqual([]);
  });

  test("skips a line that does not start with a SHA", () => {
    const out = `warning: something git said\n${"a".repeat(40)} fix: real commit\n`;
    expect(parseCommitLog(out)).toEqual([{ sha: "a".repeat(40), subject: "fix: real commit" }]);
  });
});

describe("parseCherry", () => {
  test("reads the present and missing marks", () => {
    const out =
      "- d362fd8026ffd7a51ddc7d65b5165c0cff99f516 fix: only hide send actions\n" +
      "+ a3f1c07b9e4d2865fa10cb374e29d8506b1fa4c2 docs: note the US cases\n";

    expect(parseCherry(out)).toEqual([
      {
        mark: "-",
        sha: "d362fd8026ffd7a51ddc7d65b5165c0cff99f516",
        subject: "fix: only hide send actions",
      },
      {
        mark: "+",
        sha: "a3f1c07b9e4d2865fa10cb374e29d8506b1fa4c2",
        subject: "docs: note the US cases",
      },
    ]);
  });

  test("reads output produced without -v", () => {
    expect(parseCherry(`+ ${"a".repeat(40)}\n`)).toEqual([
      { mark: "+", sha: "a".repeat(40), subject: "" },
    ]);
  });

  test("survives empty output", () => {
    expect(parseCherry("")).toEqual([]);
    expect(parseCherry("\n\n")).toEqual([]);
  });

  test("skips lines that carry no cherry mark", () => {
    const out = `warning: refname is ambiguous\n- ${"a".repeat(40)} fix: real commit\n`;
    expect(parseCherry(out)).toEqual([
      { mark: "-", sha: "a".repeat(40), subject: "fix: real commit" },
    ]);
  });

  test("does not mistake a subject starting with a dash for a mark", () => {
    const out = `- ${"a".repeat(40)} -- revert the thing\n`;
    expect(parseCherry(out)).toEqual([
      { mark: "-", sha: "a".repeat(40), subject: "-- revert the thing" },
    ]);
  });
});

// Everything below runs real git against a repository this suite builds itself.
// It needs no clone, no network and no checkout of anyone else's project: the
// history is synthesized to carry the three shapes the algorithm has to tell
// apart. See synthetic-repo.ts for why this is built rather than recorded.
//
// The fixture's branches are named qa / preprod / release on purpose. Nothing in
// the tool knows any branch name, and a fixture named after the author's own
// environments would hide a regression that reintroduced one.
const runnable = await gitAvailable();

describe.skipIf(!runnable)("against a synthetic repository", () => {
  let repo: SyntheticRepo;
  let path: string;
  let workspace: Awaited<ReturnType<typeof loadWorkspace>>;

  beforeAll(async () => {
    repo = await buildSyntheticRepo();
    path = repo.path;
    // No fetch: the repository has no remote, and the point is the local refs.
    workspace = await loadWorkspace(path, false);
  });

  afterAll(async () => {
    await repo?.cleanup();
  });

  const ref = (r: string) => ({ name: branchName(r), ref: r });
  const ask = (source: string, target: string) => compare(ref(source), ref(target), workspace);

  describe("findRepoRoot", () => {
    test("resolves the repository from its own root", async () => {
      expect((await findRepoRoot(path)).root).toBe(path);
    });

    test("resolves the repository from a subdirectory", async () => {
      // The usual case: nobody stands at the root of a checkout.
      await Bun.$`mkdir -p ${path}/deep/nested`.quiet();
      expect((await findRepoRoot(`${path}/deep/nested`)).root).toBe(path);
    });

    test("names the repository after its directory", async () => {
      expect((await findRepoRoot(path)).name).toBe("repo");
    });

    test("refuses a directory that is not inside a repository", async () => {
      expect(findRepoRoot("/")).rejects.toThrow(GitError);
    });
  });

  describe("resolveBaseRef", () => {
    test("reads origin/HEAD when the clone recorded one", async () => {
      const refs = new Set(await listRemoteBranches(path));
      expect(await resolveBaseRef(path, refs)).toBe(SYNTHETIC.develop);
    });

    test("falls back when the clone never recorded origin/HEAD", async () => {
      // What a --single-branch clone looks like, and any clone where
      // `git remote set-head` has never run.
      const bare = await buildSyntheticRepo({ symbolicHead: false });
      try {
        const refs = new Set(await listRemoteBranches(bare.path));
        expect(await resolveBaseRef(bare.path, refs)).toBe(SYNTHETIC.develop);
      } finally {
        await bare.cleanup();
      }
    });

    test("ignores an origin/HEAD pointing at a branch that is gone", async () => {
      // A stale pointer is worse than none: every range against it would fail.
      const stale = await buildSyntheticRepo();
      try {
        await Bun.$`git -C ${stale.path} symbolic-ref refs/remotes/origin/HEAD refs/remotes/origin/deleted`.quiet();
        const refs = new Set(await listRemoteBranches(stale.path));
        expect(await resolveBaseRef(stale.path, refs)).toBe(SYNTHETIC.develop);
      } finally {
        await stale.cleanup();
      }
    });
  });

  describe("loadWorkspace", () => {
    test("reports the repository it was invoked in", () => {
      expect(workspace.repo.root).toBe(path);
    });

    test("finds the base ref without being told", () => {
      expect(workspace.baseRef).toBe(SYNTHETIC.develop);
    });

    test("offers every remote branch, choosing none of them", () => {
      // Both pickers read this list. Anything that pre-selected a branch here
      // would be the default list coming back in another shape.
      const names = workspace.branches.map((b) => b.name).sort();
      expect(names).toEqual(
        [
          "bugfix/ABSORBED-1/already-in-develop",
          "develop",
          "feature/ACTIVE-1/partially-shipped",
          "feature/CLEAN-1/merged-straight-in",
          "preprod",
          "qa",
          "release",
        ].sort(),
      );
    });

    test("does not leak the local branches the fixture was built from", () => {
      // The tool compares remote-tracking refs only; a local branch of the same
      // name would answer for whatever is checked out rather than for origin.
      expect(workspace.branches.every((b) => b.ref.startsWith("origin/"))).toBe(true);
    });

    test("marks the refs stale when the fetch was skipped", () => {
      expect(workspace.freshness.stale).toBe(true);
    });

    test("refuses a directory that is not a repository", () => {
      expect(loadWorkspace("/", false)).rejects.toThrow(GitError);
    });
  });

  describe("queries", () => {
    test("lists remote branches without the HEAD pointer", async () => {
      const refs = await listRemoteBranches(path);

      expect(refs).toContain(SYNTHETIC.develop);
      expect(refs).toContain(SYNTHETIC.qa);
      expect(refs).not.toContain("origin");
      expect(refs.every((r) => r.startsWith("origin/"))).toBe(true);
    });

    test("refExists tells a real ref from one that merely looks plausible", async () => {
      expect(await refExists(path, SYNTHETIC.qa)).toBe(true);
      expect(await refExists(path, "origin/definitely-not-a-branch")).toBe(false);
    });

    test("ownCommits finds the commits a branch added on top of the base", async () => {
      const own = await ownCommits(path, SYNTHETIC.active, SYNTHETIC.develop);

      expect(own).toHaveLength(5);
      expect(own.every((c) => c.sha.length === 40)).toBe(true);
      expect(own.every((c) => c.subject.startsWith("fix: active commit"))).toBe(true);
    });

    test("ownCommits is empty once the base has absorbed the branch", async () => {
      expect(await ownCommits(path, SYNTHETIC.absorbed, SYNTHETIC.develop)).toEqual([]);
    });

    test("cherry marks cherry-picked commits present despite their new SHAs", async () => {
      const lines = await cherry(path, SYNTHETIC.preprod, SYNTHETIC.active, SYNTHETIC.develop);

      expect(lines).toHaveLength(5);
      expect(lines.filter((l) => l.mark === "-")).toHaveLength(4);
      expect(lines.filter((l) => l.mark === "+")).toHaveLength(1);
    });

    test("cherry marks everything missing when the target has none of it", async () => {
      const lines = await cherry(path, SYNTHETIC.qa, SYNTHETIC.active, SYNTHETIC.develop);

      expect(lines).toHaveLength(5);
      expect(lines.every((l) => l.mark === "+")).toBe(true);
    });

    test("cherry prints NOTHING for a branch merged straight in", async () => {
      // The reason the denominator cannot be the line count. A cleanly merged
      // branch leaves the range entirely, so git emits no lines at all — and a
      // fully shipped branch would otherwise read as "0/0 commits".
      expect(await cherry(path, SYNTHETIC.qa, SYNTHETIC.clean, SYNTHETIC.develop)).toEqual([]);
    });

    test("isAncestor separates the targets that carry the absorbed branch", async () => {
      expect(await isAncestor(path, SYNTHETIC.absorbed, SYNTHETIC.qa)).toBe(true);
      expect(await isAncestor(path, SYNTHETIC.absorbed, SYNTHETIC.release)).toBe(true);
      expect(await isAncestor(path, SYNTHETIC.absorbed, SYNTHETIC.preprod)).toBe(false);
    });
  });

  describe("compare", () => {
    test("an active branch is partial where some of its commits arrived", async () => {
      const result = await ask(SYNTHETIC.active, SYNTHETIC.preprod);

      expect(result.strategy).toBe("cherry");
      expect(result.verdict).toMatchObject({ state: "partial", present: 4, total: 5 });
    });

    test("it names the commit that did not make it", async () => {
      const { verdict } = await ask(SYNTHETIC.active, SYNTHETIC.preprod);

      expect(verdict.missing).toHaveLength(1);
      expect(verdict.missing[0]!.subject).toBe("fix: active commit 5");
    });

    test("an active branch is absent from a target that took none of it", async () => {
      const { verdict } = await ask(SYNTHETIC.active, SYNTHETIC.qa);

      expect(verdict).toMatchObject({ state: "absent", present: 0, total: 5 });
    });

    test("the base branch is a target like any other", async () => {
      // Answers "is this in develop yet?" through the same path, because the
      // tool draws no line between a base branch and any other branch.
      const { verdict } = await ask(SYNTHETIC.active, SYNTHETIC.develop);

      expect(verdict).toMatchObject({ state: "absent", present: 0, total: 5 });
    });

    test("a branch merged straight in is full, counted against its own commits", async () => {
      const result = await ask(SYNTHETIC.clean, SYNTHETIC.qa);

      expect(result.strategy).toBe("cherry");
      expect(result.verdict).toMatchObject({ state: "full", present: 2, total: 2 });
    });

    test("a branch the base absorbed falls back to ancestry", async () => {
      const result = await ask(SYNTHETIC.absorbed, SYNTHETIC.qa);

      expect(result.strategy).toBe("ancestry");
      expect(result.verdict).toMatchObject({ state: "full", approximate: true });
    });

    test("the ancestry path invents no counts", async () => {
      const { verdict } = await ask(SYNTHETIC.absorbed, SYNTHETIC.preprod);

      expect(verdict).toMatchObject({ state: "absent", present: 0, total: 0, missing: [] });
    });

    test("carries both branches through, so the UI can show what was compared", async () => {
      const result = await ask(SYNTHETIC.active, SYNTHETIC.preprod);

      expect(result.source.ref).toBe(SYNTHETIC.active);
      expect(result.target.ref).toBe(SYNTHETIC.preprod);
    });

    test("reports the base it measured against", async () => {
      expect((await ask(SYNTHETIC.active, SYNTHETIC.qa)).baseRef).toBe(SYNTHETIC.develop);
    });

    test("compares any two branches, with no notion of a special one", async () => {
      // Two feature branches: nothing here is an environment, and the tool does
      // not care.
      const result = await ask(SYNTHETIC.clean, SYNTHETIC.active);

      expect(result.verdict.state).toBe("absent");
      expect(result.verdict.total).toBe(2);
    });
  });
});
