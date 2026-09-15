/** Contract shared between the git bridge, the detection algorithm and the TUI. */

/** The repository the tool was invoked inside. */
export interface RepoContext {
  /** Absolute path to the work tree root. */
  root: string;
  /** Basename of the root, for the header. */
  name: string;
}

export interface CommitRef {
  /** Full SHA. The UI shortens it; comparisons need the whole thing. */
  sha: string;
  subject: string;
}

/**
 * A remote branch of the current repository. Both sides of a comparison are one
 * of these: the tool holds no opinion about which branches are worth asking
 * about, so a target is simply another branch the repository has.
 */
export interface BranchRef {
  /** Ref name without the remote prefix, e.g. "feature/PROJ-517/search-filter-sync". */
  name: string;
  /** Fully qualified, e.g. "origin/feature/PROJ-517/search-filter-sync". */
  ref: string;
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
  /** Every remote branch of this repository. Both pickers read from this. */
  branches: BranchRef[];
  freshness: Freshness;
  /** Anything worth saying in the header without failing the session. */
  warnings: string[];
}
