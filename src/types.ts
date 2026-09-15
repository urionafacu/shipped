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
 * answer, but not the one someone reading `✓` would assume.
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

/** A verdict plus everything needed to explain how it was reached. */
export interface Comparison {
  source: BranchRef;
  target: BranchRef;
  strategy: Strategy;
  own: CommitRef[];
  /** The ref the source branch's own commits were measured against. */
  baseRef: string;
  verdict: Verdict;
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
  /** Every branch of this repository, local and remote alike. Both pickers read this. */
  branches: BranchRef[];
  freshness: Freshness;
  /** Anything worth saying in the header without failing the session. */
  warnings: string[];
}
