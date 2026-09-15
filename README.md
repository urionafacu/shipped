# shipped

TUI that answers one question: **is this branch's work already in that branch?**

Run it inside any git repository. Pick the branch you worked on, pick the branch
you want to check it against, read the answer — instead of opening the
environment and looking for yourself.

```
┌─ answer ─────────────────────────────────────────────────────────────┐
│ source  bugfix/PROJ-482-disable-export-actions                       │
│ target  origin/preprod                                               │
│ 5 commit(s) of its own vs origin/develop                             │
│                                                                      │
│   ◐  4/5 commits · 1 missing                                         │
│                                                                      │
│   missing from origin/preprod:                                       │
│   f04c9b28e  docs(web): note which PROJ-482 cases the US env …       │
└──────────────────────────────────────────────────────────────────────┘
```

When the answer is "no", go merge it yourself — shipped reports, it never writes.

## It knows nothing about your branches

There is no list of environment names in this tool, and nothing to configure.
Both sides of the comparison are branches you pick out of the ones the repository
actually has, so `qa`, `preprod`, `release/2024` and `testing-dx` all work the
same way, because none of them are special.

The only thing shipped works out on its own is the **base branch**, and it asks
the repository rather than guessing. See below.

## Local branches, and worktrees

The list covers local branches as well as the ones on `origin`, because a branch
checked out in a worktree and never pushed is exactly the work most likely to be
asked about. Before that it was invisible: a fragment naming it would match some
unrelated branch that happened to share its digits, and answer about that one
instead.

Branches that need saying something about are marked:

| | meaning |
|---|---|
| *(nothing)* | `origin` has it, and any local ref agrees |
| `· local only` | never pushed — `origin` has no branch by this name |
| `· local ≠ origin` | a local ref exists and its tip disagrees with `origin`'s |

The two sides then resolve differently, on purpose:

- A **source** prefers the local ref. It is the work in hand, and whatever it
  carries beyond `origin` is precisely what should show up as missing.
- A **target** prefers `origin`. A target answers *has this arrived where the
  team will see it*, and the team sees `origin`. A local copy of a long-lived
  branch runs behind — measured against one on a real checkout, work that had
  been in `testing` for weeks read as missing.

A target `origin` has never heard of keeps its `local only` mark, because that
still changes how to read the answer.

Standing inside a worktree works, and the header names the repository rather than
the worktree's directory, which is usually named after a branch.

## Why three states and not a checkmark

`preprod` above holds four of the branch's five commits. A binary present/absent
report would have shown that as **present** and hidden a real gap. That is the
whole reason this tool exists, so the third state is not a nicety:

| | meaning |
|---|---|
| `✓` | every commit of the branch reached the target |
| `◐` | some did — the missing ones are listed underneath |
| `✗` | none did |

## How it decides

Comparison is by **patch-id** (`git cherry`), not by commit SHA. A rebase or a
cherry-pick rewrites SHAs, so `git branch --contains` reports a false absence for
any branch that reached a target through one.

```
own = git log --no-merges <base>..<source>

own is not empty            →  git cherry <target> <source> <base>
  the branch is still its own thing, so compare its commits one by one

own is empty                →  git merge-base --is-ancestor <source> <target>
  the base already absorbed it; git can no longer tell which commits were
  originally the branch's, so only all-or-nothing is knowable
```

The second path reports `✓` or `✗` and **no ratio**. Printing `0/0 commits` there
would be inventing a number, so it says what it knows in words instead.

### The counting subtlety

`git cherry` ranges over `limit..head` *minus whatever upstream already reaches*.
So a commit that is already in the target leaves the output two different ways:

- **merged directly** — reachable from the target, dropped from the range
  entirely (a cleanly merged branch produces **no output at all**)
- **rebased or cherry-picked** — not reachable, but listed with `-` as
  patch-equivalent

Both mean present. That is why the denominator is the branch's own commits and
not the number of lines git printed — counting lines reports a fully merged
branch as `0/0 commits`, which reads like nothing was checked.

## The base branch

`<base>` above is what the source branch's own commits get measured against. It
is discovered, not configured: shipped reads `origin/HEAD`, which is what
`git clone` records and `git remote set-head` maintains. A repository that lives
on `develop` and one that lives on `main` both work without being told which.

When the remote has no HEAD pointer — a `--single-branch` clone, or one where
`git remote set-head` has never run — it falls back to the first of
`origin/develop`, `origin/main`, `origin/master` that exists. If none do, it says
so and points at `git remote set-head origin -a` rather than guessing.

That fallback is the one place branch names appear in the source, and they are
git's own defaults for a repository's trunk, not a guess at how you name things.

## Freshness

Stale local refs produce wrong answers, and a wrong answer here is worse than no
answer — it sends someone to QA with a branch that never left their machine.

On startup shipped runs `git fetch --prune origin` on the current repository and
shows how long ago that succeeded. A failed or skipped fetch marks the answer
`STALE` rather than presenting it as authoritative.

## Install

On a machine that has [bun](https://bun.sh/docs/installation) and git:

```bash
curl -fsSL https://raw.githubusercontent.com/urionafacu/shipped/main/install.sh | bash
```

That clones the repository into `~/.local/share/shipped`, installs its
dependencies, and links `shipped` into `~/.local/bin`.

**Running the same line again updates the install** — it fast-forwards the clone
rather than cloning a second time. There is no separate upgrade command.

If you would rather read the script before running it — which is the reasonable
instinct for anything piped into a shell — clone first and run it from there:

```bash
git clone https://github.com/urionafacu/shipped.git
cd shipped
./install.sh
```

The installer notices it is already inside a checkout and installs that one
instead of cloning another.

Both paths take the same two environment variables:

```bash
PREFIX=/usr/local/bin       # where the `shipped` link goes    (default ~/.local/bin)
SHIPPED_HOME=~/src/shipped  # where the clone is kept          (default ~/.local/share/shipped)
```

The installer never touches a file it did not create. If something already sits
at either destination — a binary of your own named `shipped`, or an unrelated
repository where the clone would go — it stops and says so instead of
overwriting it. Running it twice is fine.

To uninstall, delete the link and the clone:

```bash
rm ~/.local/bin/shipped
rm -rf ~/.local/share/shipped
```

## Usage

```bash
cd path/to/your/repo

shipped                   # pick both branches
shipped PROJ-517          # seed the source picker with a ticket
shipped PROJ-517 testing  # name both: the answer, in one command
shipped --no-fetch        # skip the startup fetch, answer from local refs
```

A fragment that matches exactly one branch skips its picker, which is why naming
both answers the question without a single keystroke.

Both fragments are fuzzy: `517filter` finds `feature/PROJ-517/search-filter-sync`.

### Keys

| Screen | Key | Action |
|---|---|---|
| picker | *any text* | filter |
| picker | `↑` / `↓` | move the selection |
| picker | `Enter` | pick |
| picker | `Ctrl+R` | refetch |
| source | `Esc` | clear the filter |
| target | `Esc` | back to the source picker |
| answer | `Esc` | ask about another target, keeping the same source |
| answer | `b` | back to the source picker |
| answer | `r` | refetch and recompute |
| answer | `q` | quit |
| any | `Ctrl+C` | quit |

`Esc` pops one step. On the source picker there is nowhere back to, so it clears
the filter instead.

`Ctrl+R` rather than `r` on the pickers: the filter field is focused there, so a
bare `r` has to reach it as text.

## Architecture

```
install.sh              links the entry point onto PATH
src/index.ts            entry point, argv, --help
src/app.ts              the TUI (@opentui/core)
src/base-ref.ts         how the base branch is discovered — pure
src/git-bridge.ts       runs git through Bun.$, parses its output
src/detect.ts           the own/cherry/ancestry algorithm — pure, no I/O
src/types.ts            shared contract
src/synthetic-repo.ts   builds the throwaway repo the tests run against
```

The boundary that matters is `detect.ts` against `git-bridge.ts`. The algorithm
takes commit lists and `git cherry` output as plain data, so every branch of the
decision — full, partial, absent, absorbed-by-base — is testable from fixtures
without a repository on disk. `git-bridge.ts` owns every process call and every
parse, and is the only module that knows git exists.

## Tests

```bash
bun test
bun run typecheck
```

Nothing in the suite touches a real checkout or the network, so it passes on a
machine that has never cloned anything.

`detect.test.ts` carries the weight: full, partial, absent, absorbed-by-base, and
the two branch shapes the design was validated against on a real repository, all
from fixtures.

The synthetic repository also carries the three ways a local ref can stand
against `origin`'s — never pushed, ahead of it, identical to it — plus a
remote-only branch whose name shares a fragment with the never-pushed one, so the
false match that motivated listing local refs stays covered.

`git-bridge.test.ts` covers the parsers, then runs real git against a repository
the suite builds in a temp directory — five commits partly cherry-picked into one
branch, a branch the base absorbed, and a branch merged in cleanly. Its branches
are named `qa` / `preprod` / `release` on purpose: nothing in the tool knows any
branch name, and a fixture named after someone's own environments would hide a
regression that reintroduced one.

That repository used to be a live clone on the author's machine, until a
`fetch --prune` deleted one of the branches it asserted on and five tests failed
without anything here having changed. A test that depends on someone else's
branch is an alarm, not a test.

It is built rather than recorded because the case that matters most is a claim
about git itself: for a cleanly merged branch, `git cherry` prints **nothing**.
A recorded fixture would only encode that assumption. Building the history proves
it against the git that is actually installed.

The TUI tests use OpenTUI's test renderer (`@opentui/core/testing`): they mount
the app with a synthetic workspace, press keys, and assert on the captured
character frame. The git calls are injected, so the answer screen is driven from
fixtures rather than needing a clone.

### A detail if you write more tests

Tests run with `kittyKeyboard: true`. Under the legacy encoding a lone `Esc`
(`\x1b`) is held by the parser waiting to see whether it starts a CSI sequence,
so the key never reaches the handler. Special keys are named by OpenTUI's
`KeyCodes`: `RETURN`, `ESCAPE`, `ARROW_DOWN` — not `ENTER` or `DOWN`, which get
typed as literal text.

Give the workspace **more branches than fit on screen** whenever a test touches
layout. The match list draws from a fixed pool of row renderables, and a pool
taller than its box used to lay the surplus rows out past the bottom border,
over the status line and the footer — branch names bleeding through the help
text. With a handful of branches the surplus rows are empty and paint nothing,
so the whole suite passed while every real repository rendered the bug. The box
now sets `overflow: "hidden"` and `drawList` asks the laid-out box how many rows
it can actually show.
