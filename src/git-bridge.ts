/**
 * Bridge to git. The only module that knows git exists: everything else works
 * on the parsed shapes in types.ts.
 *
 * Every call is a one-shot `git -C <repo> …`. Nothing is cached beyond what the
 * caller holds, so a refetch is simply a matter of asking again.
 */

import { basename, dirname, isAbsolute, resolve } from "node:path";

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
const LOCAL_PREFIX = "refs/heads/";

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

/** One ref and the commit it points at, from `%(refname:short) %(objectname)`. */
export interface RefEntry {
  /** As git printed it: "develop" for a local ref, "origin/develop" for a remote one. */
  ref: string;
  sha: string;
}

/**
 * A branch name can contain almost anything but a space, and a SHA never does,
 * so splitting on the last space is the one split that cannot be fooled.
 */
export function parseRefEntries(stdout: string): RefEntry[] {
  const entries: RefEntry[] = [];
  for (const raw of stdout.split("\n")) {
    const line = raw.trim();
    if (line.length === 0) continue;
    const split = line.lastIndexOf(" ");
    if (split === -1) continue;
    const ref = line.slice(0, split).trim();
    const sha = line.slice(split + 1).trim();
    // origin/HEAD is a pointer at another branch, not a branch of its own.
    if (!SHA.test(sha) || ref.length === 0 || ref === REMOTE || ref === `${REMOTE}/HEAD`) continue;
    entries.push({ ref, sha });
  }
  return entries;
}

export function branchName(ref: string): string {
  if (ref.startsWith(LOCAL_PREFIX)) return ref.slice(LOCAL_PREFIX.length);
  return ref.startsWith(`${REMOTE}/`) ? ref.slice(REMOTE.length + 1) : ref;
}

/**
 * Merges the local and remote-tracking refs into the one list both pickers read.
 *
 * Deduplicated by branch name, because `develop` and `origin/develop` are one
 * branch to the person asking. When a local ref disagrees with origin's, the
 * local one wins: it is the work in hand, and whatever it carries beyond origin
 * is precisely what would show up as missing from the target.
 */
export function mergeBranches(local: RefEntry[], remote: RefEntry[]): BranchRef[] {
  const remoteByName = new Map(remote.map((entry) => [branchName(entry.ref), entry]));
  const localByName = new Map(local.map((entry) => [branchName(entry.ref), entry]));

  const branches: BranchRef[] = [];
  for (const name of new Set([...remoteByName.keys(), ...localByName.keys()])) {
    const here = localByName.get(name);
    const there = remoteByName.get(name);
    const remoteRef = there ? `${REMOTE}/${name}` : null;

    if (!here) {
      branches.push({ name, ref: `${REMOTE}/${name}`, remoteRef, sync: "in-sync" });
    } else if (!there) {
      branches.push({ name, ref: `${LOCAL_PREFIX}${name}`, remoteRef, sync: "local-only" });
    } else if (here.sha === there.sha) {
      branches.push({ name, ref: `${REMOTE}/${name}`, remoteRef, sync: "in-sync" });
    } else {
      branches.push({ name, ref: `${LOCAL_PREFIX}${name}`, remoteRef, sync: "diverged" });
    }
  }
  return branches.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Which ref actually answers for a target, and what is honest to say about it.
 *
 * Origin's ref wins whenever there is one. A target is the question "has this
 * arrived where the team will see it", and the team sees origin — a local copy
 * of a long-lived branch is routinely far behind and would report work as
 * missing that arrived weeks ago. With origin's ref in hand there is also
 * nothing left to warn about, so the mark goes quiet; a target origin has never
 * heard of keeps its `local-only` mark, because that one still changes how the
 * answer should be read.
 */
export function resolveTarget(target: BranchRef): BranchRef {
  if (target.remoteRef === null) return target;
  return { ...target, ref: target.remoteRef, sync: "in-sync" };
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

  const common = await git(cwd, ["rev-parse", "--git-common-dir"]);
  const mainRoot = common.ok ? mainWorkTree(root, common.stdout.trim()) : root;
  return { root, name: basename(mainRoot), worktree: mainRoot !== root };
}

/**
 * Where the repository's main work tree lives, from `--git-common-dir`.
 *
 * In a normal checkout that is the relative ".git" and the answer is the root we
 * already have. In a linked worktree it is an absolute path to the main
 * checkout's ".git", whose parent is the repository everyone would name — the
 * worktree's own directory is usually named after a branch.
 */
export function mainWorkTree(root: string, commonDir: string): string {
  if (commonDir.length === 0) return root;
  const absolute = resolve(isAbsolute(commonDir) ? commonDir : `${root}/${commonDir}`);
  // A bare repository has no ".git" to strip and is its own name.
  return basename(absolute) === ".git" ? dirname(absolute) : absolute;
}

async function listRefs(repoPath: string, namespace: string): Promise<RefEntry[]> {
  const stdout = await gitOrThrow(repoPath, [
    "for-each-ref",
    "--format=%(refname:short) %(objectname)",
    namespace,
  ]);
  return parseRefEntries(stdout);
}

export function listRemoteBranches(repoPath: string): Promise<RefEntry[]> {
  return listRefs(repoPath, `refs/remotes/${REMOTE}`);
}

/**
 * Local branches matter because a branch checked out in a worktree and never
 * pushed is invisible under refs/remotes — and a fragment naming it would
 * otherwise match some unrelated branch that happens to share its digits.
 */
export function listLocalBranches(repoPath: string): Promise<RefEntry[]> {
  return listRefs(repoPath, LOCAL_PREFIX);
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

  const [remote, local] = await Promise.all([
    listRemoteBranches(repo.root),
    listLocalBranches(repo.root),
  ]);

  // The base ref stays a remote-tracking one on purpose: it is the shared point
  // of reference the whole team forks from, not whatever this machine has.
  const baseRef = await resolveBaseRef(repo.root, new Set(remote.map((entry) => entry.ref)));
  if (baseRef === null) throw new GitError(NO_BASE_HINT);

  return {
    repo,
    baseRef,
    branches: mergeBranches(local, remote),
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
  requested: BranchRef,
  workspace: Workspace,
): Promise<Comparison> {
  const { root } = workspace.repo;
  const { baseRef } = workspace;
  // The two sides resolve differently on purpose: see resolveTarget.
  const target = resolveTarget(requested);

  const own = await ownCommits(root, source.ref, baseRef);
  const strategy = chooseStrategy(own, false);

  const probe: Probe =
    strategy === "cherry"
      ? { cherry: await cherry(root, target.ref, source.ref, baseRef) }
      : { containsBranch: await isAncestor(root, source.ref, target.ref) };

  return { source, target, strategy, own, baseRef, verdict: detect({ strategy, own, probe }) };
}
