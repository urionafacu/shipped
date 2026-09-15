# shipped — design

**Date:** 2026-09-14
**Status:** implemented
**Revised:** 2026-09-15 — the default target list was removed; both sides of the
comparison are now chosen by the user. See *Why the approach changed*.

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

So the target is now picked the same way the source is: out of the branches the
repository reports. Nothing is proposed, remembered, ranked or configured. The
tool compares two branches and says whether one's work is in the other; which
two is the user's business.

The detection algorithm below is unchanged by either revision. It never depended
on which repository it was reading, or on what anything was named.

## Problem

Before asking QA to test a feature, the author has to remember whether that
feature's commits were already merged into the testing environments. Today the
only way to check is to open each environment and look, or to run a series of
`git` commands by hand. The answer is needed several times a week and the manual
check is slow enough that it gets skipped.

The question is narrow and concrete: *standing in a repository, given a source
branch and a target branch, are the source's commits present in the target?*
When the answer is no, the author merges the branch into that target and pushes.

In practice the same source gets asked about against several targets in sequence
— the environment QA reads first, then the integration branch, then trunk — which
is a property of the user's workflow, not of the tool, and is served by making
the second question cheap to re-ask rather than by guessing the answers.

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

There are none, in the sense of a list this tool holds. The target is a branch
the user picks from the same list the source is picked from — every branch the
repository has, local and remote alike.

This is the second revision's whole content, and it is worth being explicit
about why the alternatives were rejected:

- **A default list** (what the previous version shipped) encodes one team's
  branch names. It shows empty rows to everyone else, and it is a value
  judgement the tool has no standing to make.
- **A config file** (`.shipped.json`, also shipped previously) is configuration
  the user explicitly did not want, and it has to be committed to repositories
  that may not be theirs.
- **Heuristic discovery** was tried and measured: "remote branches with no slash
  in the name" returned 35 entries on a real repository, including six
  `snyk-fix-*`, `gh-pages` and a `revert-*-staging`. Useless.
- **Remembering the last choice** was considered and rejected as state the tool
  would have to own, invalidate and explain. Seeding both picks from the command
  line gets the same keystroke savings with nothing persisted.

The cost is one extra choice per run. It is paid back by the CLI form — naming
both fragments answers the question in a single command — and by the answer
screen returning to the target picker rather than to the start, since the same
source is usually asked about against several targets in a row.

The base branch is not special here either. It is one of the branches in the
list, so "is this in develop yet?" is asked exactly the way every other question
is.

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

Three steps, and the first two are the same widget: a fuzzy filter over the
branches of the current repository, where substrings of the ticket or of the
description both match.

The match list draws from a fixed pool of row renderables rather than rebuilding
them per keystroke, which over a few thousand branches is the difference between
a filter that feels instant and one that does not. The pool is sized from a
constant, so it must be clipped: `overflow: "hidden"` on the box, and a row count
taken from the laid-out box rather than from the constant. Without both, a pool
taller than its box laid the surplus rows out past the bottom border and over the
footer, and the help text came out with branch names woven through it.

```
 web-client · 412 branches · base origin/develop · fetched 2m ago

 ┌─ source branch ──────────────┐        ┌─ target branch ──────────────┐
 │ 517                          │  →     │ prep                         │
 └──────────────────────────────┘        └──────────────────────────────┘

 source  feature/PROJ-517/search-filter-sync
 target  origin/preprod
 11 commit(s) of its own vs origin/develop

   ~  8/11 commits · 3 missing

   missing from origin/preprod:
   2fd26e28e  fix(web): …

 [esc] another target   [b] another source   [r] refetch   [q] quit
```

The missing commits are listed on the answer screen rather than behind a
keypress: there is one verdict now, so there is nothing to select between and
nothing to expand.

A fragment that matches exactly one branch skips its picker — the ticket already
said which branch, so a confirming keypress adds nothing. Seeding both from the
command line therefore answers the question with no interaction at all, which is
the form the tool is meant to be used in day to day.

`esc` pops one step rather than returning to the start, because the same source
is usually asked about against several targets in a row. The source picker has
nowhere back to, so `esc` clears its filter instead.

The source branch is excluded from the target list. Comparing a branch against
itself is always trivially full and is never the question.

## Structure

The layout mirrors dicomancer: a thin entry point, the TUI, an I/O bridge to the
external tool, and a shared contract.

```
src/index.ts            entry point, argv parsing, --help
src/app.ts              the TUI (@opentui/core)
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

## Error handling

| Condition | Behavior |
|---|---|
| cwd is not inside a git repository | Error naming the directory, plus usage; exit 1 |
| No base ref can be determined | Error naming `git remote set-head origin -a`; exit 1 |
| `git fetch` fails | Results still computed from local refs, flagged `STALE` |
| Branch name matches nothing | Empty filter result, no error |
| Repository has one branch and no other to compare against | Empty target list; nothing to pick, no error |
| `git` fails while comparing | Message in the status bar, session stays usable |

A target that "does not exist" is no longer a case: both branches are picked from
the repository's own ref list, so neither can be absent by the time it is used.
The `unavailable` state was removed from the model rather than left unreachable.

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
- No test reads a checkout it did not create, and none touches the network.

## Open questions deferred

- Whether the tool should offer to perform the merge and push.
- Whether asking one source against several targets at once is worth a screen of
  its own, or whether re-asking from the answer screen is already cheap enough.
