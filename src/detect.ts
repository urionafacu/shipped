/**
 * The detection algorithm. Pure: it takes what git already said and decides
 * what that means, so every branch of the decision is testable from fixtures
 * without a repository on disk.
 *
 * Comparison is by patch-id rather than SHA. A rebase or a cherry-pick rewrites
 * SHAs, so `git branch --contains` would report a false absence for any branch
 * that reached a target through one.
 */

import type { CommitRef, DetectInput, Probe, Strategy, Verdict } from "./types";

/**
 * `git cherry` needs a limit that says which commits belong to the branch, and
 * the base ref is the only honest one — but it collapses to nothing once the
 * base has absorbed the branch. Ancestry is the fallback for that case, and for
 * a repository with no base ref to measure against.
 */
export function chooseStrategy(own: readonly CommitRef[], baseMissing: boolean): Strategy {
  if (baseMissing || own.length === 0) return "ancestry";
  return "cherry";
}

export function detect(input: DetectInput): Verdict {
  return input.strategy === "cherry"
    ? fromCherry(input.probe, input.own)
    : fromAncestry(input.probe);
}

/**
 * Only the `+` lines carry information about what is missing.
 *
 * `git cherry` ranges over limit..head *minus whatever upstream already
 * reaches*, so a commit that is already in the target leaves the output in one
 * of two ways: merged directly, and it is dropped from the range entirely;
 * rebased or cherry-picked, and it is listed with `-` as patch-equivalent. Both
 * mean present, which is why the denominator is the branch's own commits rather
 * than the number of lines git happened to print — counting lines reports a
 * fully merged branch as "0/0 commits".
 */
function fromCherry(probe: Probe, own: readonly CommitRef[]): Verdict {
  const lines = probe.cherry ?? [];
  const subjects = new Map(own.map((commit) => [commit.sha, commit.subject]));

  // Without -v git prints SHAs only, so backfill the subject from the branch's
  // own commits. An unknown SHA is kept with an empty subject rather than
  // dropped: losing it would quietly shrink the count.
  const missing: CommitRef[] = lines
    .filter((line) => line.mark === "+")
    .map((line) => ({ sha: line.sha, subject: line.subject || subjects.get(line.sha) || "" }));

  const total = own.length;
  const present = Math.max(total - missing.length, 0);

  return {
    state: missing.length === 0 ? "full" : present === 0 ? "absent" : "partial",
    present,
    total,
    missing,
    approximate: false,
  };
}

/**
 * The base ref already absorbed the branch, so git can no longer tell which
 * commits were originally its own. Only "all of it" or "none of it" is knowable
 * here — partial is not representable, and the counts stay at zero rather than
 * being invented.
 */
function fromAncestry(probe: Probe): Verdict {
  return {
    state: probe.containsBranch ? "full" : "absent",
    present: 0,
    total: 0,
    missing: [],
    approximate: true,
  };
}
