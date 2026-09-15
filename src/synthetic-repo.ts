/**
 * Builds a throwaway git repository whose history reproduces the three shapes
 * the detection algorithm has to tell apart.
 *
 * Test support, not shipped behavior. It exists because the integration tests
 * used to assert against live branches in a real checkout: the remote moved, a
 * branch was deleted, and five tests failed without anything in this project
 * having changed. A test that depends on someone else's branch is an alarm, not
 * a test.
 *
 * Synthesizing the history rather than recording git's output is the point. The
 * case that matters most — a cleanly merged branch, where `git cherry` prints
 * *nothing* — is a claim about how git behaves. Recording a fixture would only
 * encode the assumption; building the history proves it against the git that is
 * actually installed.
 *
 * The three shapes:
 *
 *   active    5 own commits, 4 of them cherry-picked into preprod
 *             -> qa ABSENT 0/5 · preprod PARTIAL 4/5 · release ABSENT 0/5
 *   absorbed  merged into develop, so it has no own commits left to compare
 *             -> qa FULL · preprod ABSENT · release FULL   (ancestry)
 *   clean     2 own commits, merged into qa with a real merge commit, so
 *             `git cherry` emits empty output
 *             -> qa FULL 2/2 · preprod ABSENT 0/2 · release ABSENT 0/2
 *
 * It also carries the three ways a local ref can stand against origin's — see
 * SYNTHETIC_SYNC — because a branch that only ever existed locally is invisible
 * under refs/remotes, and that is the common shape in a worktree.
 */

import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REMOTE = "origin";

export interface SyntheticRepo {
  path: string;
  cleanup(): Promise<void>;
}

export interface SyntheticOptions {
  /**
   * Whether to record refs/remotes/origin/HEAD. Off reproduces a --single-branch
   * clone, or any clone where `git remote set-head` has never run — the case the
   * base-ref fallback exists for.
   */
  symbolicHead?: boolean;
}

/**
 * The branches that exercise how a local ref stands against origin's.
 *
 * `unpushed` exists only under refs/heads, which is what a branch checked out in
 * a worktree and never pushed looks like. Its name carries digits that also
 * appear inside `decoy`, reproducing the false match that motivated listing
 * local refs at all: searching those digits used to return the unrelated remote
 * branch and never the branch actually being looked for.
 */
export const SYNTHETIC_SYNC = {
  /** Local and remote agree — nothing for the UI to flag. */
  synced: "qa",
  /** Never pushed: refs/heads only. */
  unpushed: "feature/LOCAL-1351/only-on-this-machine",
  /** Pushed, then committed on top without pushing again. */
  diverged: "release",
  /** Remote-only, and its name contains 1351 — the collision, made real. */
  decoy: "bugfix/DECOY-11351/unrelated-but-similar",
} as const;

/** Branch names the built repository exposes under refs/remotes/origin. */
export const SYNTHETIC = {
  main: "origin/main",
  develop: "origin/develop",
  active: "origin/feature/ACTIVE-1/partially-shipped",
  absorbed: "origin/bugfix/ABSORBED-1/already-in-develop",
  clean: "origin/feature/CLEAN-1/merged-straight-in",
  qa: "origin/qa",
  preprod: "origin/preprod",
  release: "origin/release",
} as const;

async function run(cwd: string, args: string[]): Promise<string> {
  const result = await Bun.$`git -C ${cwd} ${args}`.quiet().nothrow();
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString().trim()}`);
  }
  return result.stdout.toString();
}

async function commit(cwd: string, file: string, body: string, subject: string): Promise<void> {
  await Bun.write(join(cwd, file), `${body}\n`);
  await run(cwd, ["add", "-A"]);
  await run(cwd, ["commit", "-q", "-m", subject]);
}

/** Is git usable at all? Callers skip rather than fail when it is not. */
export async function gitAvailable(): Promise<boolean> {
  return (await Bun.$`git --version`.quiet().nothrow()).exitCode === 0;
}

export async function buildSyntheticRepo(
  options: SyntheticOptions = {},
): Promise<SyntheticRepo> {
  const { symbolicHead = true } = options;
  // realpath because macOS hands out /var/... from mkdtemp while git reports the
  // resolved /private/var/..., and the two have to compare equal.
  const base = await realpath(await mkdtemp(join(tmpdir(), "shipped-synthetic-")));
  const path = join(base, "repo");
  await Bun.$`mkdir -p ${path}`.quiet();

  await run(path, ["init", "-q", "-b", "main"]);
  // Identity and signing are per-repo so the suite never depends on, or touches,
  // whatever the developer has configured globally.
  await run(path, ["config", "user.email", "synthetic@shipped.test"]);
  await run(path, ["config", "user.name", "shipped synthetic"]);
  await run(path, ["config", "commit.gpgsign", "false"]);

  await commit(path, "base.txt", "v0", "chore: root");
  await run(path, ["branch", "develop"]);
  await run(path, ["checkout", "-q", "develop"]);
  await commit(path, "d1.txt", "v1", "chore: develop moves on");

  // Kept so preprod can fork from before the absorbed merge and therefore
  // genuinely not contain it.
  await run(path, ["branch", "pre-absorb"]);

  await run(path, ["checkout", "-q", "-b", "absorbed"]);
  await commit(path, "absorbed.txt", "v1", "fix: the change develop swallowed");
  await run(path, ["checkout", "-q", "develop"]);
  await run(path, ["merge", "-q", "--no-ff", "absorbed", "-m", "Merge absorbed into develop"]);

  await run(path, ["checkout", "-q", "-b", "active", "develop"]);
  for (const n of [1, 2, 3, 4, 5]) {
    await commit(path, `active-${n}.txt`, `v${n}`, `fix: active commit ${n}`);
  }

  await run(path, ["checkout", "-q", "-b", "clean", "develop"]);
  await commit(path, "clean-1.txt", "v1", "feat: clean one");
  await commit(path, "clean-2.txt", "v2", "feat: clean two");

  // qa takes `clean` through a real merge commit, which is how most
  // environment branches are actually built — the commits keep their SHAs.
  await run(path, ["checkout", "-q", "-b", "qa", "develop"]);
  await run(path, ["merge", "-q", "--no-ff", "clean", "-m", "Merge clean into qa"]);

  await run(path, ["checkout", "-q", "-b", "release", "develop"]);

  // preprod takes four of the five active commits by cherry-pick: new SHAs,
  // identical patch-ids, which is exactly what the partial case has to survive.
  await run(path, ["checkout", "-q", "-b", "preprod", "pre-absorb"]);
  for (const back of [4, 3, 2, 1]) {
    const sha = (await run(path, ["rev-parse", `active~${back}`])).trim();
    await run(path, ["cherry-pick", "--no-edit", sha]);
  }

  // The fixture has no remote, so "pushing" is writing the ref under
  // refs/remotes/origin by hand. Nothing here touches the network.
  const published: Array<[string, string]> = [
    ["main", SYNTHETIC.main],
    ["develop", SYNTHETIC.develop],
    ["active", SYNTHETIC.active],
    ["absorbed", SYNTHETIC.absorbed],
    ["clean", SYNTHETIC.clean],
    ["qa", SYNTHETIC.qa],
    ["preprod", SYNTHETIC.preprod],
    ["release", SYNTHETIC.release],
  ];
  for (const [local, remote] of published) {
    const sha = (await run(path, ["rev-parse", local])).trim();
    await run(path, ["update-ref", `refs/remotes/${remote}`, sha]);
  }

  // A branch that exists on origin and nowhere locally — the ordinary case, and
  // the one whose name collides with the never-pushed branch below.
  await run(path, [
    "update-ref",
    `refs/remotes/${REMOTE}/${SYNTHETIC_SYNC.decoy}`,
    (await run(path, ["rev-parse", "develop"])).trim(),
  ]);

  // Committing on release after it was published leaves the local ref ahead of
  // origin's: the "diverged" shape.
  await run(path, ["checkout", "-q", "release"]);
  await commit(path, "release-note.txt", "v1", "chore: not pushed yet");

  // Never published at all: the "local only" shape, and what a worktree branch
  // looks like before its first push.
  await run(path, ["checkout", "-q", "-b", SYNTHETIC_SYNC.unpushed, "develop"]);
  await commit(path, "local-only.txt", "v1", "feat: work that never left this machine");

  // What `git clone` records and `git remote set-head` maintains. The tool reads
  // it to learn which branch this repository forks from.
  if (symbolicHead) {
    await run(path, ["symbolic-ref", `refs/remotes/${REMOTE}/HEAD`, `refs/remotes/${SYNTHETIC.develop}`]);
  }

  await run(path, ["checkout", "-q", "main"]);

  // The scaffolding branches are local names that were published under different
  // ones, so leaving them behind would invent local-only entries the fixture
  // never meant to describe. A real clone does not carry a local branch for
  // every remote one either.
  for (const scratch of ["pre-absorb", "absorbed", "active", "clean", "preprod"]) {
    await run(path, ["branch", "-q", "-D", scratch]);
  }

  return { path, cleanup: () => rm(base, { recursive: true, force: true }) };
}
