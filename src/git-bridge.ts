/**
 * Bridge to git. The only module that knows git exists: everything else works
 * on the parsed shapes in types.ts.
 *
 * Every call is a one-shot `git -C <repo> …`. Nothing is cached beyond what the
 * caller holds, so a refetch is simply a matter of asking again.
 */

import { basename } from "node:path";

import { baseRefFromSymbolic, NO_BASE_HINT, pickBaseFallback } from "./base-ref";
import { chooseStrategy, detect } from "./detect";
import type {
  BranchRef,
  CherryLine,
  CommitRef,
  Comparison,
  Freshness,
  Probe,
  RepoContext,
  Workspace,
} from "./types";

const REMOTE = "origin";

export class GitError extends Error {}

interface Ran {
  ok: boolean;
  stdout: string;
  stderr: string;
}

async function git(repoPath: string, args: string[]): Promise<Ran> {
  const result = await Bun.$`git -C ${repoPath} ${args}`.quiet().nothrow();
  return {
    ok: result.exitCode === 0,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString().trim(),
  };
}

/** For calls whose failure means the answer would be wrong rather than simply "no". */
async function gitOrThrow(repoPath: string, args: string[]): Promise<string> {
  const result = await git(repoPath, args);
  if (!result.ok) {
    throw new GitError(result.stderr || `git ${args.join(" ")} failed in ${repoPath}`);
  }
  return result.stdout;
}

// --- parsing ---------------------------------------------------------------

const SHA = /^[0-9a-f]{40}$/;

/**
 * `%(refname:short)` renders refs/remotes/origin/HEAD as a bare "origin", which
 * is a symbolic pointer rather than a branch anyone can compare against.
 */
export function parseRefList(stdout: string): string[] {
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && line !== REMOTE && line !== `${REMOTE}/HEAD`);
}

export function branchName(ref: string): string {
  return ref.startsWith(`${REMOTE}/`) ? ref.slice(REMOTE.length + 1) : ref;
}

/** Reads `git log --format=%H %s`: SHA, a space, then the rest of the line. */
export function parseCommitLog(stdout: string): CommitRef[] {
  const commits: CommitRef[] = [];
  for (const line of stdout.split("\n")) {
    const space = line.indexOf(" ");
    const sha = space === -1 ? line.trim() : line.slice(0, space);
    if (!SHA.test(sha)) continue;
    commits.push({ sha, subject: space === -1 ? "" : line.slice(space + 1) });
  }
  return commits;
}

/** Reads `git cherry -v`: a `+`/`-` mark, the SHA, then the subject. */
export function parseCherry(stdout: string): CherryLine[] {
  const lines: CherryLine[] = [];
  for (const line of stdout.split("\n")) {
    const mark = line[0];
    if ((mark !== "+" && mark !== "-") || line[1] !== " ") continue;
    const rest = line.slice(2);
    const space = rest.indexOf(" ");
    const sha = space === -1 ? rest.trim() : rest.slice(0, space);
    if (!SHA.test(sha)) continue;
    lines.push({ mark, sha, subject: space === -1 ? "" : rest.slice(space + 1) });
  }
  return lines;
}

// --- queries ---------------------------------------------------------------

/** Fails fast with an actionable message instead of a spawn ENOENT mid-session. */
export async function assertToolchain(): Promise<void> {
  const version = await Bun.$`git --version`.quiet().nothrow();
  if (version.exitCode !== 0) {
    throw new GitError("git not found on PATH");
  }
}

/**
 * The work tree root for wherever the user happens to be standing, which is
 * usually a subdirectory rather than the root itself.
 */
export async function findRepoRoot(cwd: string): Promise<RepoContext> {
  const result = await git(cwd, ["rev-parse", "--show-toplevel"]);
  if (!result.ok) {
    throw new GitError(`${cwd} is not inside a git repository`);
  }
  const root = result.stdout.trim();
  if (root.length === 0) {
    throw new GitError(`${cwd} is not inside a git repository`);
  }
  return { root, name: basename(root) };
}

export async function listRemoteBranches(repoPath: string): Promise<string[]> {
  const stdout = await gitOrThrow(repoPath, [
    "for-each-ref",
    "--format=%(refname:short)",
    `refs/remotes/${REMOTE}`,
  ]);
  return parseRefList(stdout);
}

export async function refExists(repoPath: string, ref: string): Promise<boolean> {
  const result = await git(repoPath, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
  return result.ok;
}

/**
 * Which branch this repository forks from, asked of the repository rather than
 * assumed. `origin/HEAD` is what `git clone` records and what `git remote
 * set-head` maintains, so it is right for a repository on `main` and for one on
 * `develop` without either being special-cased here.
 */
export async function resolveBaseRef(
  repoPath: string,
  existingRefs: ReadonlySet<string>,
): Promise<string | null> {
  const symbolic = await git(repoPath, ["symbolic-ref", "-q", `refs/remotes/${REMOTE}/HEAD`]);
  if (symbolic.ok) {
    const ref = baseRefFromSymbolic(symbolic.stdout);
    // A stale HEAD can point at a branch that has since been deleted, in which
    // case it is worse than no answer: every range against it would fail.
    if (ref !== null && existingRefs.has(ref)) return ref;
  }
  return pickBaseFallback(existingRefs);
}

/**
 * Newest first, merges excluded — the same set `git cherry` will compare, so the
 * two sides agree on what "the branch's own commits" means.
 */
export async function ownCommits(
  repoPath: string,
  branchRef: string,
  baseRef: string,
): Promise<CommitRef[]> {
  const stdout = await gitOrThrow(repoPath, [
    "log",
    "--no-merges",
    "--format=%H %s",
    `${baseRef}..${branchRef}`,
  ]);
  return parseCommitLog(stdout);
}

/** Oldest first, which is the order git cherry prints and the order to read them in. */
export async function cherry(
  repoPath: string,
  upstreamRef: string,
  branchRef: string,
  limitRef: string,
): Promise<CherryLine[]> {
  const stdout = await gitOrThrow(repoPath, ["cherry", "-v", upstreamRef, branchRef, limitRef]);
  return parseCherry(stdout);
}

export async function isAncestor(
  repoPath: string,
  branchRef: string,
  targetRef: string,
): Promise<boolean> {
  const result = await git(repoPath, ["merge-base", "--is-ancestor", branchRef, targetRef]);
  return result.ok;
}

// --- orchestration ---------------------------------------------------------

/**
 * A failed fetch is not fatal: the local refs still answer the question, just
 * possibly with stale data. The caller decides how loudly to say so.
 */
export async function fetchRepo(repoPath: string): Promise<Freshness> {
  const result = await git(repoPath, ["fetch", "--prune", REMOTE]);
  if (!result.ok) {
    return { fetchedAt: null, stale: true, error: result.stderr || "fetch failed" };
  }
  return { fetchedAt: Date.now(), stale: false };
}

/**
 * Builds everything the TUI needs for the repository the user is standing in.
 *
 * Fetching before the first paint is the point: a stale answer here sends
 * someone to QA with a branch that never left their machine.
 */
export async function loadWorkspace(cwd: string, fetch = true): Promise<Workspace> {
  const repo = await findRepoRoot(cwd);
  const warnings: string[] = [];

  const freshness: Freshness = fetch
    ? await fetchRepo(repo.root)
    : { fetchedAt: null, stale: true };
  if (freshness.error) warnings.push(`fetch failed — ${freshness.error}`);

  const refs = await listRemoteBranches(repo.root);
  const refSet = new Set(refs);

  const baseRef = await resolveBaseRef(repo.root, refSet);
  if (baseRef === null) throw new GitError(NO_BASE_HINT);

  return {
    repo,
    baseRef,
    branches: refs.map((ref) => ({ name: branchName(ref), ref })),
    freshness,
    warnings,
  };
}

/**
 * Answers one question: did the source branch's work reach the target branch?
 *
 * Both branches come from the repository's own ref list, so neither side is
 * assumed to exist or assumed to be named anything in particular.
 */
export async function compare(
  source: BranchRef,
  target: BranchRef,
  workspace: Workspace,
): Promise<Comparison> {
  const { root } = workspace.repo;
  const { baseRef } = workspace;

  const own = await ownCommits(root, source.ref, baseRef);
  const strategy = chooseStrategy(own, false);

  const probe: Probe =
    strategy === "cherry"
      ? { cherry: await cherry(root, target.ref, source.ref, baseRef) }
      : { containsBranch: await isAncestor(root, source.ref, target.ref) };

  return { source, target, strategy, own, baseRef, verdict: detect({ strategy, own, probe }) };
}
