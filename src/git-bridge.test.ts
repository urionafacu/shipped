import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import {
  ancestorNames,
  branchName,
  byRecency,
  cherry,
  findRepoRoot,
  GitError,
  headBranch,
  isAncestor,
  listLocalBranches,
  listRemoteBranches,
  loadWorkspace,
  mainWorkTree,
  mergeBranches,
  ownCommits,
  parseCherry,
  parseCommitLog,
  parseRefEntries,
  parseRefList,
  prepareSource,
  probeTarget,
  refExists,
  resolveBaseRef,
  resolveTarget,
  scanTargets,
  type RefEntry,
} from "./git-bridge";
import {
  buildSyntheticRepo,
  gitAvailable,
  SYNTHETIC,
  SYNTHETIC_SYNC,
  type SyntheticRepo,
} from "./synthetic-repo";
import type { BranchRef } from "./types";

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

  test("strips the local refs/heads prefix", () => {
    expect(branchName("refs/heads/feature/PROJ-517/sync")).toBe("feature/PROJ-517/sync");
  });

  test("leaves a name that carries no prefix alone", () => {
    expect(branchName("develop")).toBe("develop");
  });
});

describe("parseRefEntries", () => {
  const sha = (char: string) => char.repeat(40);

  test("splits each line into ref, commit and date", () => {
    const out = `develop ${sha("a")} 100\norigin/qa ${sha("b")} 200\n`;
    expect(parseRefEntries(out)).toEqual([
      { ref: "develop", sha: sha("a"), committedAt: 100 },
      { ref: "origin/qa", sha: sha("b"), committedAt: 200 },
    ]);
  });

  test("keeps a branch name that contains spaces out of the trailing fields", () => {
    // git allows almost anything but a space in a ref, yet the two fields have
    // to peel off the right regardless: neither a SHA nor a timestamp has one.
    expect(parseRefEntries(`feature/a b ${sha("c")} 300\n`)).toEqual([
      { ref: "feature/a b", sha: sha("c"), committedAt: 300 },
    ]);
  });

  test("drops the origin HEAD pointer however it is spelled", () => {
    const out = `origin ${sha("a")} 1\norigin/HEAD ${sha("a")} 1\norigin/develop ${sha("b")} 2\n`;
    expect(parseRefEntries(out)).toEqual([
      { ref: "origin/develop", sha: sha("b"), committedAt: 2 },
    ]);
  });

  test("skips a line whose SHA field is not a SHA", () => {
    expect(parseRefEntries(`warning: something git said\ndevelop ${sha("a")} 7\n`)).toEqual([
      { ref: "develop", sha: sha("a"), committedAt: 7 },
    ]);
  });

  test("keeps a ref whose date git could not render, rather than losing it", () => {
    // A branch with no usable date still belongs in the list; it simply sorts
    // last, which is better than vanishing from the answer.
    expect(parseRefEntries(`develop ${sha("a")} \n`)[0]).toMatchObject({ ref: "develop" });
  });

  test("survives empty output", () => {
    expect(parseRefEntries("")).toEqual([]);
    expect(parseRefEntries("\n\n")).toEqual([]);
  });
});

describe("mergeBranches", () => {
  const sha = (char: string) => char.repeat(40);
  const entry = (ref: string, at: string, committedAt = 0): RefEntry => ({
    ref,
    sha: sha(at),
    committedAt,
  });

  test("keeps a branch that exists only on origin", () => {
    expect(mergeBranches([], [entry("origin/qa", "a", 5)])).toEqual([
      { name: "qa", ref: "origin/qa", remoteRef: "origin/qa", sync: "in-sync", committedAt: 5 },
    ]);
  });

  test("keeps a branch that exists only locally, and says so", () => {
    expect(mergeBranches([entry("feature/x", "a", 5)], [])).toEqual([
      {
        name: "feature/x",
        ref: "refs/heads/feature/x",
        remoteRef: null,
        sync: "local-only",
        committedAt: 5,
      },
    ]);
  });

  test("collapses the two refs of one branch into a single entry", () => {
    expect(mergeBranches([entry("qa", "a", 5)], [entry("origin/qa", "a", 5)])).toEqual([
      { name: "qa", ref: "origin/qa", remoteRef: "origin/qa", sync: "in-sync", committedAt: 5 },
    ]);
  });

  test("prefers the local ref as a source when the tips disagree", () => {
    // The local ref carries work origin does not have, and that work is exactly
    // what would come back as missing from a target.
    expect(mergeBranches([entry("qa", "a", 9)], [entry("origin/qa", "b", 4)])).toEqual([
      {
        name: "qa",
        ref: "refs/heads/qa",
        remoteRef: "origin/qa",
        sync: "diverged",
        committedAt: 9,
      },
    ]);
  });

  test("dates a branch by the newer of its two refs", () => {
    // Whichever ref answers, the branch is as recent as the most recent thing
    // anyone put on it — and that date is the whole ordering of the answer.
    const merged = mergeBranches([entry("qa", "a", 3)], [entry("origin/qa", "b", 80)]);
    expect(merged[0]!.committedAt).toBe(80);
  });

  test("does not confuse two branches whose names share a fragment", () => {
    // The bug: searching "1351" used to find only the unrelated remote branch,
    // because the branch actually being looked for had never been pushed.
    const merged = mergeBranches(
      [entry("feature/LOCAL-1351/mine", "a")],
      [entry("origin/bugfix/DECOY-11351/theirs", "b")],
    );

    expect(merged.map((b) => b.name)).toEqual([
      "bugfix/DECOY-11351/theirs",
      "feature/LOCAL-1351/mine",
    ]);
  });

  test("sorts by name so the picker order does not depend on git's", () => {
    const merged = mergeBranches([entry("zulu", "a")], [entry("origin/alpha", "b")]);
    expect(merged.map((b) => b.name)).toEqual(["alpha", "zulu"]);
  });

  test("survives a repository with no branches at all", () => {
    expect(mergeBranches([], [])).toEqual([]);
  });
});

describe("resolveTarget", () => {
  const local = (name: string, sync: "diverged" | "local-only"): BranchRef => ({
    name,
    ref: `refs/heads/${name}`,
    remoteRef: sync === "diverged" ? `origin/${name}` : null,
    sync,
    committedAt: 10,
  });

  test("reads a target from origin even when a local ref exists", () => {
    // Measured on a real checkout: a worktree's local `testing` sat 361 commits
    // behind origin's, and against it 8 of 14 recent branches read as ABSENT
    // when their work had in fact been there for weeks. A target answers "has
    // this arrived where the team looks", and the team looks at origin.
    expect(resolveTarget(local("testing", "diverged"))).toEqual({
      name: "testing",
      ref: "origin/testing",
      remoteRef: "origin/testing",
      sync: "in-sync",
      committedAt: 10,
    });
  });

  test("leaves a target origin has never heard of on its local ref", () => {
    const only = local("feature/x", "local-only");
    expect(resolveTarget(only)).toEqual(only);
  });

  test("keeps the local-only mark, which still changes how to read the answer", () => {
    expect(resolveTarget(local("feature/x", "local-only")).sync).toBe("local-only");
  });

  test("leaves an already-remote target untouched", () => {
    const remote: BranchRef = {
      name: "qa",
      ref: "origin/qa",
      remoteRef: "origin/qa",
      sync: "in-sync",
      committedAt: 10,
    };
    expect(resolveTarget(remote)).toEqual(remote);
  });
});

describe("byRecency", () => {
  const at = (name: string, committedAt: number): BranchRef => ({
    name,
    ref: `origin/${name}`,
    remoteRef: `origin/${name}`,
    sync: "in-sync",
    committedAt,
  });

  test("puts the newest tip first", () => {
    // The whole ordering of the answer. A branch the team keeps integrating into
    // has a tip from today; a branch someone finished and left behind froze the
    // day its author stopped. Ranking by how much of the work arrived instead
    // was measured on a real repository and buried the integration branch at
    // position 11 of 14.
    const sorted = byRecency([at("old", 100), at("new", 900), at("mid", 500)]);
    expect(sorted.map((b) => b.name)).toEqual(["new", "mid", "old"]);
  });

  test("breaks a tie by name, so the order never depends on git's", () => {
    const sorted = byRecency([at("zulu", 100), at("alpha", 100)]);
    expect(sorted.map((b) => b.name)).toEqual(["alpha", "zulu"]);
  });

  test("leaves the input alone", () => {
    const input = [at("old", 1), at("new", 2)];
    byRecency(input);
    expect(input.map((b) => b.name)).toEqual(["old", "new"]);
  });
});

describe("mainWorkTree", () => {
  test("stays put in an ordinary checkout, where the common dir is relative", () => {
    expect(mainWorkTree("/work/web-client", ".git")).toBe("/work/web-client");
  });

  test("climbs to the repository a linked worktree belongs to", () => {
    // The worktree's own directory is usually named after its branch, which
    // reads as the wrong repository in the header.
    expect(mainWorkTree("/work/web-client/.trees/feature-x", "/work/web-client/.git")).toBe(
      "/work/web-client",
    );
  });

  test("names a bare repository after itself", () => {
    expect(mainWorkTree("/work/web-client", "/srv/web-client.git")).toBe("/srv/web-client.git");
  });

  test("falls back to the root when git said nothing", () => {
    expect(mainWorkTree("/work/web-client", "")).toBe("/work/web-client");
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

  const pick = (name: string): BranchRef => {
    const found = workspace.branches.find((b) => b.name === branchName(name));
    if (!found) throw new Error(`fixture has no branch ${name}`);
    return found;
  };

  /** One source against one target, the way the scan asks about each branch. */
  const ask = async (source: string, target: string) => {
    const context = await prepareSource(pick(source), workspace);
    const hit = await probeTarget(context, pick(target), path);
    return { context, ...hit };
  };

  /** The whole answer for one source: every branch that carries any of its work. */
  const whereIs = async (source: string) => {
    const hits: Awaited<ReturnType<typeof probeTarget>>[] = [];
    const summary = await scanTargets(
      pick(source),
      workspace,
      { onHit: (hit) => hits.push(hit), onProgress: () => {} },
      4,
    );
    return { summary, hits: hits.sort((a, b) => b.target.committedAt - a.target.committedAt) };
  };

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

    test("does not call an ordinary checkout a worktree", async () => {
      expect((await findRepoRoot(path)).worktree).toBe(false);
    });

    test("names the repository, not the worktree, from inside a linked worktree", async () => {
      // A worktree directory is usually named after its branch, so its basename
      // reads as a repository nobody has.
      const tree = `${path}/../wt-preprod`;
      await Bun.$`git -C ${path} worktree add -q --detach ${tree}`.quiet();
      try {
        const context = await findRepoRoot(tree);

        expect(context.name).toBe("repo");
        expect(context.worktree).toBe(true);
        expect(context.root).not.toBe(path);
      } finally {
        await Bun.$`git -C ${path} worktree remove --force ${tree}`.quiet().nothrow();
      }
    });

    test("refuses a directory that is not inside a repository", async () => {
      expect(findRepoRoot("/")).rejects.toThrow(GitError);
    });
  });

  describe("resolveBaseRef", () => {
    test("reads origin/HEAD when the clone recorded one", async () => {
      const refs = new Set((await listRemoteBranches(path)).map((e) => e.ref));
      expect(await resolveBaseRef(path, refs)).toBe(SYNTHETIC.develop);
    });

    test("falls back when the clone never recorded origin/HEAD", async () => {
      // What a --single-branch clone looks like, and any clone where
      // `git remote set-head` has never run.
      const bare = await buildSyntheticRepo({ symbolicHead: false });
      try {
        const refs = new Set((await listRemoteBranches(bare.path)).map((e) => e.ref));
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
        const refs = new Set((await listRemoteBranches(stale.path)).map((e) => e.ref));
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

    test("offers every branch, local and remote alike, choosing none of them", () => {
      // Both pickers read this list. Anything that pre-selected a branch here
      // would be the default list coming back in another shape.
      const names = workspace.branches.map((b) => b.name).sort();
      expect(names).toEqual(
        [
          "bugfix/ABSORBED-1/already-in-develop",
          SYNTHETIC_SYNC.decoy,
          "develop",
          "feature/ACTIVE-1/partially-shipped",
          branchName(SYNTHETIC.stacked),
          branchName(SYNTHETIC.mirror),
          "feature/CLEAN-1/merged-straight-in",
          SYNTHETIC_SYNC.unpushed,
          "main",
          "preprod",
          "qa",
          "release",
        ].sort(),
      );
    });

    test("lists a branch once, however many refs carry its name", () => {
      // "qa" and "origin/qa" are one branch to the person asking.
      const names = workspace.branches.map((b) => b.name);
      expect(new Set(names).size).toBe(names.length);
    });

    test("finds a branch that only ever existed locally", () => {
      // The bug this fixes: a branch checked out in a worktree and never pushed
      // is invisible under refs/remotes, so it could not be asked about at all.
      const found = workspace.branches.find((b) => b.name === SYNTHETIC_SYNC.unpushed);

      expect(found?.sync).toBe("local-only");
      expect(found?.ref).toBe(`refs/heads/${SYNTHETIC_SYNC.unpushed}`);
    });

    test("flags a branch whose local ref has outrun origin", () => {
      const found = workspace.branches.find((b) => b.name === SYNTHETIC_SYNC.diverged);

      // The local ref wins: its extra commits are exactly what would be missing
      // from a target, which is the answer worth having.
      expect(found?.sync).toBe("diverged");
      expect(found?.ref).toBe(`refs/heads/${SYNTHETIC_SYNC.diverged}`);
    });

    test("says nothing about a branch whose local ref agrees with origin", () => {
      const found = workspace.branches.find((b) => b.name === SYNTHETIC_SYNC.synced);

      expect(found?.sync).toBe("in-sync");
      expect(found?.ref).toBe(`origin/${SYNTHETIC_SYNC.synced}`);
    });

    test("prefers origin for a branch that exists nowhere locally", () => {
      const found = workspace.branches.find((b) => b.name === SYNTHETIC_SYNC.decoy);

      expect(found?.sync).toBe("in-sync");
      expect(found?.ref).toBe(`origin/${SYNTHETIC_SYNC.decoy}`);
    });

    test("measures against origin's base ref, not a local one", () => {
      // A local base would answer for whatever this machine last pulled.
      expect(workspace.baseRef.startsWith("origin/")).toBe(true);
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
      const refs = (await listRemoteBranches(path)).map((entry) => entry.ref);

      expect(refs).toContain(SYNTHETIC.develop);
      expect(refs).toContain(SYNTHETIC.qa);
      expect(refs).not.toContain("origin");
      expect(refs.every((r) => r.startsWith("origin/"))).toBe(true);
    });

    test("lists local branches, which refs/remotes cannot see", async () => {
      const refs = (await listLocalBranches(path)).map((entry) => entry.ref);

      expect(refs).toContain(SYNTHETIC_SYNC.unpushed);
      expect(refs).toContain(SYNTHETIC_SYNC.synced);
      expect(refs.every((r) => !r.startsWith("origin/"))).toBe(true);
    });

    test("reports the commit each ref points at", async () => {
      const local = await listLocalBranches(path);
      const entry = local.find((e) => e.ref === SYNTHETIC_SYNC.unpushed);
      const sha = (await Bun.$`git -C ${path} rev-parse ${SYNTHETIC_SYNC.unpushed}`.text()).trim();

      // The SHA is what separates a synced branch from a diverged one, so it has
      // to come back with the ref rather than cost a call per branch.
      expect(entry?.sha).toBe(sha);
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

  describe("headBranch", () => {
    test("names the checked-out branch, so an argument-free run has an answer", async () => {
      expect(await headBranch(path)).toBe("main");
    });

    test("says nothing on a detached HEAD rather than guessing", async () => {
      const tree = `${path}/../wt-detached`;
      await Bun.$`git -C ${path} worktree add -q --detach ${tree}`.quiet();
      try {
        expect(await headBranch(tree)).toBeNull();
      } finally {
        await Bun.$`git -C ${path} worktree remove --force ${tree}`.quiet().nothrow();
      }
    });
  });

  describe("ancestorNames", () => {
    test("names the branches the source already contains", async () => {
      // One call for the whole repository, which is what makes it affordable to
      // ask at all.
      const names = await ancestorNames(path, SYNTHETIC.active);

      expect(names.has(branchName(SYNTHETIC.stacked))).toBe(true);
      expect(names.has(branchName(SYNTHETIC.mirror))).toBe(true);
      expect(names.has("develop")).toBe(true);
    });

    test("leaves out a branch the source does not contain", async () => {
      const names = await ancestorNames(path, SYNTHETIC.active);
      expect(names.has("preprod")).toBe(false);
    });
  });

  describe("probeTarget", () => {
    test("an active branch is partial where some of its commits arrived", async () => {
      const result = await ask(SYNTHETIC.active, SYNTHETIC.preprod);

      expect(result.context.strategy).toBe("cherry");
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

    test("answers for a source that exists only on this machine", async () => {
      // The whole point of listing local refs: before this, a branch living in
      // a worktree and never pushed could not be asked about at all.
      const result = await ask(SYNTHETIC_SYNC.unpushed, "qa");

      expect(pick(SYNTHETIC_SYNC.unpushed).sync).toBe("local-only");
      expect(result.context.own).toHaveLength(1);
      expect(result.verdict).toMatchObject({ state: "absent", present: 0, total: 1 });
    });

    test("reads a diverged target from origin, not from the local copy", async () => {
      // A local copy of a long-lived branch runs behind, and measured against
      // one, work that arrived weeks ago reads as missing.
      const result = await ask(SYNTHETIC_SYNC.unpushed, SYNTHETIC_SYNC.diverged);

      expect(pick(SYNTHETIC_SYNC.diverged).ref).toBe(`refs/heads/${SYNTHETIC_SYNC.diverged}`);
      expect(result.target.ref).toBe(`origin/${SYNTHETIC_SYNC.diverged}`);
    });

    test("the base branch is a target like any other", async () => {
      // Answers "is this in develop yet?" through the same path, because the
      // tool draws no line between a base branch and any other branch.
      const { verdict } = await ask(SYNTHETIC.active, SYNTHETIC.develop);

      expect(verdict).toMatchObject({ state: "absent", present: 0, total: 5 });
    });

    test("a branch merged straight in is full, counted against its own commits", async () => {
      const result = await ask(SYNTHETIC.clean, SYNTHETIC.qa);

      expect(result.context.strategy).toBe("cherry");
      expect(result.verdict).toMatchObject({ state: "full", present: 2, total: 2 });
    });

    test("a branch the base absorbed falls back to ancestry", async () => {
      const result = await ask(SYNTHETIC.absorbed, SYNTHETIC.qa);

      expect(result.context.strategy).toBe("ancestry");
      expect(result.verdict).toMatchObject({ state: "full", approximate: true });
    });

    test("the ancestry path invents no counts", async () => {
      const { verdict } = await ask(SYNTHETIC.absorbed, SYNTHETIC.preprod);

      expect(verdict).toMatchObject({ state: "absent", present: 0, total: 0, missing: [] });
    });

    test("reports the base it measured against", async () => {
      expect((await ask(SYNTHETIC.active, SYNTHETIC.qa)).context.baseRef).toBe(SYNTHETIC.develop);
    });

    test("marks a target the source was built on", async () => {
      expect((await ask(SYNTHETIC.active, SYNTHETIC.stacked)).ancestor).toBe(true);
    });

    test("does not mark a target that merely shares commits", async () => {
      expect((await ask(SYNTHETIC.active, SYNTHETIC.preprod)).ancestor).toBe(false);
    });
  });

  describe("scanTargets", () => {
    test("finds every branch carrying the work without being told which to check", async () => {
      // The question the tool exists to answer, asked in one move. Nothing here
      // names a branch: the repository is asked what it has.
      const { hits } = await whereIs(SYNTHETIC.active);

      expect(hits.map((h) => h.target.name).sort()).toEqual(
        [
          branchName(SYNTHETIC.preprod),
          branchName(SYNTHETIC.stacked),
          branchName(SYNTHETIC.mirror),
        ].sort(),
      );
    });

    test("never lists a branch that has none of the work", async () => {
      const { hits, summary } = await whereIs(SYNTHETIC.active);

      expect(hits.every((h) => h.verdict.state !== "absent")).toBe(true);
      expect(summary.absent).toBeGreaterThan(0);
    });

    test("counts the branches it left out, so the list never reads as truncated", async () => {
      const { hits, summary } = await whereIs(SYNTHETIC.active);

      // Everything but the source itself was compared, and every comparison
      // either became a hit or was counted as absent.
      expect(summary.scanned).toBe(workspace.branches.length - 1);
      expect(summary.absent + hits.length).toBe(summary.scanned);
    });

    test("never compares the source against itself", async () => {
      const { hits } = await whereIs(SYNTHETIC.active);
      expect(hits.some((h) => h.target.name === branchName(SYNTHETIC.active))).toBe(false);
    });

    test("carries the source's own commits so the screen can count them", async () => {
      const { summary } = await whereIs(SYNTHETIC.active);

      expect(summary.context.own).toHaveLength(5);
      expect(summary.context.strategy).toBe("cherry");
    });

    test("orders newest tip first", async () => {
      const { hits } = await whereIs(SYNTHETIC.active);
      const dates = hits.map((h) => h.target.committedAt);

      expect([...dates].sort((a, b) => b - a)).toEqual(dates);
    });

    test("marks the branches the source was built on, and only those", async () => {
      const { hits } = await whereIs(SYNTHETIC.active);
      const ancestors = hits.filter((h) => h.ancestor).map((h) => h.target.name);

      expect(ancestors.sort()).toEqual(
        [branchName(SYNTHETIC.stacked), branchName(SYNTHETIC.mirror)].sort(),
      );
    });

    test("a stacked earlier slice is an ancestor and only partial — the noise to fold", async () => {
      const { hits } = await whereIs(SYNTHETIC.active);
      const stacked = hits.find((h) => h.target.name === branchName(SYNTHETIC.stacked));

      expect(stacked).toMatchObject({ ancestor: true });
      expect(stacked!.verdict).toMatchObject({ state: "partial", present: 3, total: 5 });
    });

    test("a branch at the same commit is an ancestor but full — never foldable", async () => {
      // Merging into a branch and then rebasing onto it leaves that branch an
      // ancestor too. Folding by ancestry alone would hide the answer.
      const { hits } = await whereIs(SYNTHETIC.active);
      const mirror = hits.find((h) => h.target.name === branchName(SYNTHETIC.mirror));

      expect(mirror).toMatchObject({ ancestor: true });
      expect(mirror!.verdict).toMatchObject({ state: "full", present: 5, total: 5 });
    });

    test("answers for a branch the base already absorbed", async () => {
      const { hits, summary } = await whereIs(SYNTHETIC.absorbed);

      expect(summary.context.strategy).toBe("ancestry");
      expect(hits.every((h) => h.verdict.approximate)).toBe(true);
      expect(hits.map((h) => h.target.name)).toContain("qa");
    });

    test("answers for a branch that never left this machine", async () => {
      const { summary } = await whereIs(SYNTHETIC_SYNC.unpushed);
      expect(summary.context.own).toHaveLength(1);
    });
  });
});
