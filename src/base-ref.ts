/**
 * How the base ref is chosen. Pure: everything here takes the refs a repository
 * already reported.
 *
 * This is discovery, not configuration. The base ref is what the branch's own
 * commits get measured against, and the repository already records it — nobody
 * has to declare it, and the tool never has to guess a branch naming scheme.
 */

const REMOTE = "origin";

/**
 * Tried in order when the remote has no HEAD pointer, which happens on clones
 * made with --single-branch and on any clone where `git remote set-head` has
 * never run.
 */
export const BASE_FALLBACKS: readonly string[] = [
  `${REMOTE}/develop`,
  `${REMOTE}/main`,
  `${REMOTE}/master`,
];

/**
 * `git symbolic-ref refs/remotes/origin/HEAD` prints a full ref path; the rest
 * of the tool speaks in `origin/<branch>`.
 */
export function baseRefFromSymbolic(stdout: string): string | null {
  const line = stdout.trim();
  const prefix = "refs/remotes/";
  if (!line.startsWith(prefix)) return null;
  const short = line.slice(prefix.length);
  return short.length > 0 ? short : null;
}

/**
 * The first fallback the repository actually has. Returns null when none do,
 * which the caller turns into an actionable error rather than a wrong answer.
 */
export function pickBaseFallback(existingRefs: ReadonlySet<string>): string | null {
  return BASE_FALLBACKS.find((ref) => existingRefs.has(ref)) ?? null;
}

/** Shown when no base ref can be determined at all. */
export const NO_BASE_HINT =
  "could not tell which branch this repository forks from — " +
  "run `git remote set-head origin -a`, or make sure origin/develop, origin/main " +
  "or origin/master exists locally";
