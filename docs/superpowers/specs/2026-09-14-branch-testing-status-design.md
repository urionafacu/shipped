# shipped — design

**Date:** 2026-09-14
**Status:** implemented
**Revised:** 2026-09-15 — the default target list was removed; both sides of the
comparison were chosen by the user.
**Revised:** 2026-09-17 — the target stopped being a question at all. The tool
scans every branch and reports where the work is. See *Why the approach changed*.

## Why the approach changed

The first version hardcoded four repositories under one root directory, with an
environment variable to move that root. Two problems surfaced as soon as it was
installed somewhere else:

- It tied the tool to one machine's directory layout. A fresh install answered
  "no repositories found" until the root was pointed at the right place, and the
  root is not something the user should have to think about at all.
- It tied the tool to one company. The repository names, and the branch names
  they use, were facts baked into the source.

Both disappear when the question is asked of the repository the user is already
standing in. `cd` has been the selector all along; the tool just was not using
it. The fixed table becomes a candidate list filtered by what the repository
actually has, and the base branch becomes something git already records rather
than something the tool assumes.

A second round removed the remaining assumption. The tool still shipped a
default list of target branches — `testing`, `testing-us`, `us-testing`,
`testing-dx`, `develop`, `main`, `master`, `staging` — filtered down to what the
repository had, with a `.shipped.json` to override it. That list was one team's
branch naming, and it was the same mistake one level down: a repository using
`qa` and `preprod` got a screen full of nothing, and the `.shipped.json` escape
hatch was configuration the tool should not have needed.

So the target was picked the same way the source was: out of the branches the
repository reports, with nothing proposed, remembered or configured.

A third round found that this had fixed the wrong half. Removing the default
list was right; turning the target into a **question put to the user** was not.
The screen that resulted asked "which branch should I compare against?" and
filled itself with every branch in the repository, while the user's actual
question was "where is my work?". Twice in a row that screen was read as *the
tool did not find my branch* — the branch it had found was named on one dim line
above a list of 576 it had not.

The third option was there all along and neither earlier round took it: do not
decide for the user, and do not ask the user — **find out**. The repository
already knows every branch the work could be in, and comparing against all of
them costs about six seconds. So `shipped PROJ-517` now answers, and the only
thing it ever asks is which branch a genuinely ambiguous fragment meant.

The detection algorithm below is unchanged by all three revisions. It never
depended on which repository it was reading, or on what anything was named.

## Problem

Before asking QA to test a feature, the author has to remember whether that
feature's commits were already merged into the testing environments. Today the
only way to check is to open each environment and look, or to run a series of
`git` commands by hand. The answer is needed several times a week and the manual
check is slow enough that it gets skipped.

The question is narrow and concrete: *standing in a repository, given one
branch, which other branches already carry its commits?* When the branch QA
reads is not among them, the author merges it there and pushes.

Asking it as two questions — a source and then a target — was tried and was
wrong. The same branch gets asked about against several branches in sequence
(the environment QA reads, then the integration branch, then trunk), and each
one cost a decision over a list of hundreds. All three answers fit on one screen
that needs no decision at all.

## Scope

In scope:

- Operate on the repository the tool was invoked in, found from the cwd.
- Discover the base branch the repository forks from, rather than assuming one.
- Let the user pick both the source and the target from the repository's own
  branches.
- Report whether the source's commits are fully, partially, or not present in
  the target.
- List the missing commits when the state is partial.
- Keep the remote refs fresh so the answer is trustworthy.

Out of scope for this version:

- Performing the merge or the push. The tool reports; the author acts.
- Any view spanning several repositories at once. One `cd`, one answer.
- Knowing anything about a particular company, machine or directory layout.
- Any notion of which branches are worth asking about: no default list, no
  configuration file, no memory of previous answers.

## The repository

Found from the cwd with `git rev-parse --show-toplevel`, so the tool works from
any subdirectory of a checkout. Outside a repository it says so and exits
non-zero rather than guessing.

Inside a linked worktree that toplevel is the worktree's own root, whose
directory is usually named after the branch it holds — as a repository name it
reads as one nobody has. The name therefore comes from `git rev-parse
--git-common-dir`: relative (`.git`) in an ordinary checkout, and an absolute
path to the main checkout's `.git` in a worktree, whose parent is the repository
everyone would recognise.

## Branches

The branch list is the union of `refs/heads` and `refs/remotes/origin`,
deduplicated by name — `develop` and `origin/develop` are one branch to the
person asking. Both pickers read it.

Local refs are in the list because a branch checked out in a worktree and never
pushed is exactly the work most likely to be asked about, and under
remote-tracking refs alone it is invisible. Worse than invisible: on a real
checkout, searching a fragment of such a branch returned an unrelated remote
branch that shared its digits, so the tool answered confidently about the wrong
branch rather than admitting it could not find the right one.

Each entry carries how its refs stand against each other — `in-sync`,
`local-only`, or `diverged` — and the UI marks the last two, because an answer
computed from a branch that never left the machine is still true but not the
fact a bare `✓` suggests.

### Which ref each side reads

The two sides resolve differently, and the asymmetry is deliberate:

| side | ref | why |
|---|---|---|
| source | local when one exists | the work in hand; anything it carries beyond `origin` is exactly what should read as missing |
| target | `origin` when one exists | the question is whether the work reached where the team looks, and the team looks at `origin` |

The target rule was measured rather than assumed. On a real checkout a
worktree's local `testing` sat **361 commits behind** `origin/testing`; of 14
recent branches, **8** reported differently against the two, always in the
dangerous direction — work already in `testing` reported as absent, which is the
exact mistake this tool exists to prevent.

A target `origin` has never heard of stays on its local ref and keeps its
`local-only` mark; there is nothing else to read it from, and the mark says so.

## The base branch

The branch a feature forks from is read from `origin/HEAD`, which `git clone`
records and `git remote set-head` maintains. A repository on `develop` and one on
`main` both work without being told which — verified against a set of real
repositories, all of which had `origin/HEAD -> origin/develop` already recorded.

When the remote has no HEAD pointer — a `--single-branch` clone, or one where
`git remote set-head` never ran — it falls back to the first of `origin/develop`,
`origin/main`, `origin/master` that exists. A pointer aimed at a branch that has
since been deleted is treated as no pointer, because every range against it would
fail. If nothing resolves, the tool says so and names `git remote set-head origin
-a` rather than answering wrongly.

## Targets

There are none, in the sense of a list this tool holds — and none, in the sense
of something the user names either. Every branch the repository has is compared,
local and remote alike, and the ones carrying any of the work are the answer.

Every alternative was tried and measured, so it is worth being explicit:

- **A default list** (what the first version shipped) encodes one team's branch
  names. It shows empty rows to everyone else, and it is a value judgement the
  tool has no standing to make.
- **A config file** (`.shipped.json`, also shipped once) is configuration the
  user explicitly did not want, and it has to be committed to repositories that
  may not be theirs.
- **Heuristic discovery** was measured: "remote branches with no slash in the
  name" returned 35 entries on a real repository, including six `snyk-fix-*`,
  `gh-pages` and a `revert-*-staging`. Useless.
- **Remembering the last choice** was rejected as state the tool would have to
  own, invalidate and explain.
- **Asking the user each time** shipped, and was the mistake this revision
  undoes. It is not neutral just because it holds no opinion: it moves the work
  onto the person, over a list of several hundred, every single run.

Scanning everything costs about six seconds over 653 branches and returns a
short answer — 14 hits, the rest never shown. That is affordable, so nobody has
to be asked.

### Ordering

The one judgement the screen makes, and it is read off the graph rather than off
the names: **newest tip first**.

A branch the team integrates into receives everyone's merges, so its tip is
always recent. A branch someone finished and left behind freezes the day its
author stopped. Since the question is about work pushed days ago, any
integration branch holding it will be more recent than the finished feature
branches that also hold it.

Ranking by how much of the work arrived was the obvious alternative and is
wrong. Measured on a real repository, for a source with 8 own commits:

| by commits present | by tip date |
|---|---|
| 1. feature/…/ecg 8/8 (30d) | 1. **testing** 6/8 (3d) |
| 2. fix/…-mouse-sync 8/8 (24d) | 2. feature/…/stale-drag 6/8 (3d) |
| 3. fix/…-tool-sync 8/8 (24d) | 3. feature/…-integration 6/8 (7d) |
| … | … |
| **7. testing 6/8 (3d)** | |

The branch the user came for sat at position 7 of 12 under the first ordering,
below three feature branches nobody asked about, and first under the second.

Ordering rather than classifying is deliberate. No cheap, robust, name-free
classifier for "integration branch" exists — fan-in of reachable tips (109 vs
106 for a feature branch), fan-in excluding the base (4 vs 5) and merge density
(a feature branch showed 49 merges per 100 commits against `testing`'s 20) were
each measured and each failed. An order that is wrong still leaves the row on
screen two places lower; a classifier that is wrong hides it.

### Branches the source was built on

A branch forked from an earlier point of the same work holds part of it forever
and crowds the answer. Those are folded behind a key, with a count, when **both**
hold:

1. the hit is `partial`, and
2. the branch's tip is reachable from the source (`git for-each-ref --merged`,
   one call for the whole repository, 0.03s).

The second condition is a fact about the graph, not a guess: if the source
contains that branch's tip, the source already has everything it has — it is
where the work came from, not where it went.

The first condition is what makes it safe. Merging into a branch and then
rebasing onto it leaves that branch an ancestor of the source too, but then the
hit is `full`, and hiding a `full` hit would hide the answer.

### What was rejected for speed

- **A `git for-each-ref --contains` fast path**, 0.05s for the whole repository,
  answering the SHA-merged case while the patch-id scan continues. Measured on a
  real branch it returned five rows and omitted `testing`, which the full scan
  finds holding 6 of 8 commits. A fast screen that looks complete and lacks the
  branch the user came for is worse than a slow one — it is a confident false
  negative. Rejected.
- **Pruning branches whose tip predates the source's oldest own commit.** Sound
  in theory, false in practice: it dropped a real hit, because a branch the
  source cherry-picked *from* holds patch-equivalent commits while its own tip
  stays older. Rejected.
- **More parallelism.** Measured over 653 branches, 8 concurrent `git` processes
  took 6.0s with the first row at 0.22s; 24 took 7.7s with the first row at
  1.08s. Past a handful they only contend, and the branches scanned first —
  which are the likeliest answers — are the ones made to wait.

What does work is scanning in the order the screen lists: the likeliest answer
resolves first, rows append rather than reshuffle, and there is no second,
provisional state to explain.

The base branch is not special here either. It is one of the branches scanned,
so "is this in develop yet?" is answered in the same pass as everything else.

## Detection algorithm

The environment branches this was measured against are built with real merge
commits, not squashes. Commits therefore keep their identity when they reach a
target, and content-based comparison is exact rather than heuristic. Where that
does not hold, patch-id comparison still covers rebases and cherry-picks.

Comparison is by **patch-id** (`git cherry`), not by commit SHA. A patch-id
hashes the diff, so a commit still matches after a rebase or a cherry-pick, both
of which rewrite SHAs. Using `git branch --contains` would report false absences
for any branch that reached an environment through a rebase.

### The baseline problem

`git cherry <upstream> <head> <limit>` needs a limit that defines which commits
belong to the branch. Two candidates were tested against real branches and
neither works alone:

- **The base branch as the limit** is precise for an active feature branch, but
  collapses to zero commits once the base has absorbed it, which would render a
  meaningless checkmark.
- **`git cherry`'s default merge-base** never collapses, but includes commits the
  branch absorbed *from* the base. Measured on the absorbed branch below: 43
  reported missing commits, of which only one belonged to the branch.

### Resolution

```
own = git rev-list --no-merges <base>..<source>

if own is not empty:
    # active feature branch
    result  = git cherry <target> <source> <base>
    missing = lines starting with "+"
    present = len(own) - len(missing)     # NOT the count of "-" lines
    state   = no missing -> FULL | present > 0 -> PARTIAL | else ABSENT

if own is empty:
    # the base already absorbed the branch; git can no longer isolate which
    # commits were originally its own
    state = git merge-base --is-ancestor <source> <target>
              ? FULL : ABSENT
```

The empty-`own` case reports only FULL or ABSENT. PARTIAL is not representable
there, and the UI states the reason rather than implying a precise count.

### Validation

Both paths were verified against a real repository. Branch names here are
examples; the counts and verdicts are the measured ones:

| Branch | own | testing | testing-us | testing-dx |
|---|---|---|---|---|
| `bugfix/PROJ-482-disable-export-actions` | 5 | ABSENT 0/5 | PARTIAL 4/5 | ABSENT 0/5 |
| `bugfix/PROJ-461/persist-draft-state` | 0 | FULL | ABSENT | FULL |

The PROJ-482 partial is genuine: a documentation commit reached the branch after
the environment merge. A binary present/absent report would have shown this as
present and hidden a real gap.

A third shape, found later, is the regression guard for the counting subtlety: a
branch with 2 own commits, merged cleanly into `testing`, for which `git cherry`
prints nothing at all. Counting printed lines reports that as `0/0`; counting
against `own` reports the correct `FULL 2/2`.

## Freshness

Stale local refs produce wrong answers, and a wrong answer here is worse than no
answer: it leads the author to skip a merge that was never done, or to redo one
that was.

On startup the tool runs `git fetch --prune origin` on the current repository and
displays how long ago that succeeded. The `r` key refetches on demand. A failed
or skipped fetch marks the answer `STALE` rather than presenting it as
authoritative. One repository rather than four means one round-trip, so the wait
before the first paint is short enough to keep.

## Interface

One screen. The branch being asked about is the title; underneath it, the
branches carrying its commits, newest first.

```
 shipped  feature/PROJ-517/search-filter-sync
 8 commits vs origin/develop · web-client · fetched 3s ago

  where this work is                             411 branches · 7 hits

 ┌──────────────────────────────────────────────────────────────────┐
 │  › qa                                            6/8    today    │
 │    feature/PROJ-533/inline-preview-flag          6/8    7d       │
 │    preprod                                       8/8    24d      │
 │    4 more your branch was built on                   h to show   │
 └──────────────────────────────────────────────────────────────────┘

  404 branches do not have it
  ↑/↓ move · enter what is missing · h built on · r refetch · q quit
```

Points that are decisions rather than taste:

- **The title is the branch.** "Did it find my branch?" has to be answered by the
  largest thing on the screen. The previous version answered it on one dim line
  above a list of 576 branches the user had not asked for, and two readers in a
  row concluded it had found nothing. Size and position beat a checkmark.
- **The ratio is the state.** `8/8` in green, `6/8` in amber. A separate glyph
  column would repeat what the numbers already say.
- **Absent branches are counted, never listed.** Otherwise a 7-row answer among
  555 branches reads as a truncated list. The count at the foot closes that.
- **Missing commits expand in place.** With one verdict per row there is nothing
  to navigate to, and expanding rather than pushing a screen removes the whole
  navigation stack — and with it the three different meanings `esc` used to have.
- **Rows append while the scan runs.** Same layout, same order, a counter in the
  section line. No separate loading screen and no provisional state.

The list draws from a fixed pool of row renderables. The pool is sized from a
constant, so it must be clipped: `overflow: "hidden"` on the box, and a row count
taken from the laid-out box rather than from the constant. Without both, a pool
taller than its box laid the surplus rows out past the bottom border and over the
footer, and the help text came out with branch names woven through it.

Row *text* is sized from the terminal, not from the box. The first draw happens
in the constructor before any layout pass, when every renderable still measures
zero; a row built against a width of zero renders as
`where this work isscanning 0/653` on a real terminal.

### The one question it still asks

A fragment that names more than one branch is genuinely ambiguous, and only then
does a picker appear — over the branches it could have meant, not over the
repository:

```
 shipped  7 branches match
  pick the one you mean
```

An exact branch name wins outright, so `shipped develop` never opens a picker
just because some feature branch contains those letters. With no argument at all
the question is about the checked-out branch, which is why the tool is being run
from inside a repository in the first place. A detached HEAD is the one case with
no answer, and it says so.

There is no text input anywhere. With a handful of rows there is nothing to
filter, and removing it removed the `r` / `ctrl+r` split that existed only
because a focused field was stealing the key.

The source branch is excluded from the scan. Comparing a branch against itself is
always trivially full and is never the question.

## Structure

The layout mirrors dicomancer: a thin entry point, the TUI, an I/O bridge to the
external tool, and a shared contract.

```
src/index.ts            entry point, argv parsing, --help
src/app.ts              the one screen (@opentui/core)
src/base-ref.ts         how the base branch is discovered — pure
src/git-bridge.ts       runs git through Bun.$, parses its output
src/detect.ts           the own/cherry/ancestry algorithm — pure, no I/O
src/types.ts            shared contract
src/synthetic-repo.ts   builds the throwaway repo the tests run against
```

The boundary that matters is `detect.ts` against `git-bridge.ts`. The algorithm
takes commit lists and `git cherry` output as plain data and returns the verdict,
so every branch of the decision — full, partial, absent, absorbed-by-base — is
testable from fixtures without a repository on disk. `git-bridge.ts` owns every
process call and every parse, and is the only module that knows git exists.

`base-ref.ts` is the other pure half, and it is small on purpose: the only thing
the tool works out on its own is where to measure from, decided entirely from
refs somebody else reported.

The scan lives in `git-bridge.ts` as `scanTargets`, which streams hits through
callbacks rather than returning a list. The screen therefore has no separate
loading state to model — it draws whatever it has whenever it is told, and the
last call happens to be the final one.

## Error handling

| Condition | Behavior |
|---|---|
| cwd is not inside a git repository | Error naming the directory, plus usage; exit 1 |
| No base ref can be determined | Error naming `git remote set-head origin -a`; exit 1 |
| `git fetch` fails | Results still computed from local refs, flagged `STALE` |
| Fragment matches nothing | Named in the status line, no branches listed |
| Repository has one branch and nothing to compare it against | "nowhere yet", no error |
| HEAD is detached and no fragment was given | Says so and asks for a branch |
| `git` fails mid-scan | Message in the status bar, session stays usable |
| The branch disappears between a refetch and the rescan | Named in the status bar rather than rescanned against nothing |

A target that "does not exist" is not a case: every branch compared comes from
the repository's own ref list, so none can be absent by the time it is used. The
`unavailable` state was removed from the model rather than left unreachable.

## Testing

`bun test`, colocated `*.test.ts`, following dicomancer.

- `detect.test.ts` carries the weight: fixtures for full, partial, absent and
  absorbed-by-base, asserted without touching disk.
- `base-ref.test.ts` covers reading `origin/HEAD` and the fallback order.
- `git-bridge.test.ts` covers parsing of `git cherry` and `git log` output, then
  runs real git against a repository the suite builds in a temp directory. That
  fixture's branches are named `qa` / `preprod` / `release`: nothing in the tool
  knows a branch name, and a fixture named after the author's own environments
  would hide a regression that reintroduced one.
- The same fixture carries both shapes of a branch the source was built on — one
  forked from an earlier point, which folds, and one on the very same commit,
  which must not — and dates every commit an hour apart, so a stable order
  cannot pass for a correct one.
- `app.test.ts` drives the screen with an injected scan that streams hits the way
  the real one does, and sizes its layout cases at 61 rows. Small fixtures hide
  layout bugs: the row pool overflowed over the footer for weeks while every test
  passed, because a handful of rows leaves the surplus ones empty.
- No test reads a checkout it did not create, and none touches the network.

One caveat learned while verifying this revision: **the test renderer cannot
stand in for a terminal.** Piping the real binary's stdout to a file does not
work either — one frame flushes and the rest of the session never lands, which
reads as a screen frozen on "scanning". Capturing through a real pty is what
showed the screen as a person sees it.

## Open questions deferred

- Whether the tool should offer to perform the merge and push.
- Whether the six-second scan is worth caching between runs, and what would
  invalidate the cache honestly.
- Whether the ordering should ever be switchable. It is one key away from being
  configurable, and configuration is what this design keeps removing, so the bar
  is a case where the date order is actually wrong rather than merely different.
