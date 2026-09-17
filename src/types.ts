/** Contract shared between the git bridge, the detection algorithm and the TUI. */

/** The repository the tool was invoked inside. */
export interface RepoContext {
  /** Absolute path to the work tree root — a linked worktree's own root, when in one. */
  root: string;
  /**
   * Name of the repository itself, not of the directory the user stands in. In a
   * linked worktree those differ, and the worktree's directory name is usually
   * the branch, which reads as the wrong repository in the header.
   */
  name: string;
  /** True in a linked worktree, where `root` is not the repository's main work tree. */
  worktree: boolean;
}

export interface CommitRef {
  /** Full SHA. The UI shortens it; comparisons need the whole thing. */
  sha: string;
  subject: string;
}

/**
 * How a branch's local ref stands against origin's. Worth saying out loud: an
 * answer computed from a branch that never left the machine is still a true
 * answer, but not the one someone reading a full ratio would assume.
 *
 * - `in-sync`     nothing to flag — origin has it, and any local ref agrees
 * - `local-only`  never pushed: origin has no branch by this name
 * - `diverged`    a local ref exists and its tip disagrees with origin's
 */
export type SyncState = "in-sync" | "local-only" | "diverged";

/**
 * A branch of the current repository. Both sides of a comparison are one of
 * these: the tool holds no opinion about which branches are worth asking about,
 * so a target is simply another branch the repository has.
 *
 * Local and remote-tracking refs are merged by branch name, because a branch
 * living in a worktree and never pushed is exactly the work someone is most
 * likely to be asking about.
 */
export interface BranchRef {
  /** Bare branch name, e.g. "feature/PROJ-517/search-filter-sync". */
  name: string;
  /**
   * The ref to read this branch as a *source*: `refs/heads/…` when a local ref
   * exists and carries work origin does not have, `origin/…` otherwise. The
   * work in hand is what someone asking about their own branch means.
   */
  ref: string;
  /**
   * The ref to read this branch as a *target*, when origin has one at all.
   *
   * A target answers "has my work arrived where the team will see it", and the
   * team sees origin. A local copy of a long-lived branch is routinely months
   * behind, and measured against one it reports work as missing that has been
   * there all along — the exact mistake this tool exists to prevent.
   */
  remoteRef: string | null;
  sync: SyncState;
  /**
   * Epoch seconds of the tip commit, which is the whole ordering of the answer.
   *
   * A branch the team keeps integrating into has a tip from today, because
   * everyone's merges land on it; a branch someone finished and left behind
   * freezes the day its author stopped. So the branches worth seeing first sort
   * themselves to the top without the tool knowing a single branch name.
   */
  committedAt: number;
}

/**
 * - `full`     every commit reached the target
 * - `partial`  some did, some did not
 * - `absent`   none did
 */
export type MatchState = "full" | "partial" | "absent";

/** One line of `git cherry` output. `+` is missing upstream, `-` is present. */
export interface CherryLine {
  mark: "+" | "-";
  sha: string;
  /** Empty when `git cherry` ran without -v. */
  subject: string;
}

/**
 * Which comparison a branch's shape calls for.
 *
 * `cherry` compares patch-ids over the branch's own commits. `ancestry` is the
 * fallback for a branch the base already absorbed, where git can no longer tell
 * which commits were originally the branch's.
 */
export type Strategy = "cherry" | "ancestry";

/** What asking git about one target came back with. */
export interface Probe {
  /** Populated on the `cherry` strategy. */
  cherry?: CherryLine[];
  /** Populated on the `ancestry` strategy. */
  containsBranch?: boolean;
}

export interface DetectInput {
  strategy: Strategy;
  /** Commits unique to the source branch against the base ref. Empty on `ancestry`. */
  own: CommitRef[];
  probe: Probe;
}

/** The answer: did this source branch's work reach this target branch? */
export interface Verdict {
  state: MatchState;
  present: number;
  total: number;
  missing: CommitRef[];
  /**
   * True on the `ancestry` path, where only "all" or "none" is knowable. The UI
   * must not print a ratio when this is set — the numbers would be invented.
   */
  approximate: boolean;
}

/** One branch that carries some of the source's work, and how much of it. */
export interface Hit {
  /** The target, already resolved to the ref that answers for it. */
  target: BranchRef;
  verdict: Verdict;
  /**
   * True when this branch's tip is reachable from the source.
   *
   * Then it is not somewhere the work arrived — it is where the work came from.
   * Stacked branches shared a history with the source before it was finished,
   * so they report a partial hit forever and crowd out the answer.
   */
  ancestor: boolean;
}

/** Everything about a source branch that every target comparison reuses. */
export interface SourceContext {
  source: BranchRef;
  /** The ref the source's own commits were measured against. */
  baseRef: string;
  own: CommitRef[];
  strategy: Strategy;
  /** Branch names reachable from the source tip: the source's own past. */
  ancestors: ReadonlySet<string>;
}

/** What a completed scan says about the branches that had none of the work. */
export interface ScanSummary {
  context: SourceContext;
  /** How many branches were compared. */
  scanned: number;
  /** How many of those carried none of the work, and so were never listed. */
  absent: number;
}

/** So the UI can flag an answer computed from refs that may be behind. */
export interface Freshness {
  /** Epoch millis of the last successful fetch, or null when never observed. */
  fetchedAt: number | null;
  /** True when the fetch was skipped or failed and the refs may be behind. */
  stale: boolean;
  /** Why the fetch failed, for the status line. */
  error?: string;
}

/** Everything the TUI needs to answer questions, rebuilt on every refetch. */
export interface Workspace {
  repo: RepoContext;
  /** The branch the tool measures a source branch's own commits against. */
  baseRef: string;
  /** Every branch of this repository, local and remote alike. */
  branches: BranchRef[];
  /** The branch checked out here, so an argument-free run has something to answer for. */
  head: string | null;
  freshness: Freshness;
  /** Anything worth saying in the header without failing the session. */
  warnings: string[];
}
