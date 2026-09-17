# shipped

TUI that answers one question: **where did this branch's work end up?**

Run it inside any git repository, name a branch or none at all, and it compares
that branch against every other branch the repository has — then lists the ones
carrying its commits, newest first. Nothing to pick, nothing to configure.

```
 shipped  feature/PROJ-517/search-filter-sync
 8 commits vs origin/develop · web-client · fetched 3s ago

  where this work is                             411 branches · 7 hits

 ┌──────────────────────────────────────────────────────────────────┐
 │  › qa                                            6/8    today    │
 │    feature/PROJ-533/inline-preview-flag          6/8    7d       │
 │    preprod                                       8/8    24d      │
 │    feature/PROJ-482-disable-export-actions       3/8    51d      │
 │    4 more your branch was built on                   h to show   │
 └──────────────────────────────────────────────────────────────────┘

  404 branches do not have it
  ↑/↓ move · enter what is missing · h built on · r refetch · q quit
```

`Enter` opens the commits that did not make it, under the row:

```
 │  › qa                                            6/8    today    │
 │      2 missing from origin/qa                                    │
 │      a1b2c3d4e  fix(web): guard the empty filter list            │
 │      f5e6d7c8b  refactor(web): extract the filter mapper         │
```

When the answer is "not there yet", go merge it yourself — shipped reports, it
never writes.

## It asks nothing and knows nothing about your branches

There is no list of environment names in this tool, nothing to configure, and no
second branch to choose. `qa`, `preprod`, `release/2024` and `testing-dx` are all
ordinary branches to it, because none of them are special.

Two things it works out on its own, both by asking the repository rather than
guessing: the **base branch** (see below), and the **order** — newest tip first.

That order is the one piece of judgement in the screen, and it is a fact about
how branches are used rather than about their names. A branch the team keeps
integrating into carries everyone's merges, so its tip is from today; a branch
someone finished and walked away from froze the day they stopped. Sorting by how
much of the work arrived was tried instead and measured on a real repository: it
put the integration branch at position **11 of 14**, below three feature branches
nobody was asking about. By date it came first.

## Local branches, and worktrees

The scan covers local branches as well as the ones on `origin`, because a branch
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

The two sides of a comparison then resolve differently, on purpose:

- The **branch you asked about** prefers the local ref. It is the work in hand,
  and whatever it carries beyond `origin` is precisely what should show up as
  missing elsewhere.
- Every **branch it is compared against** prefers `origin`, because the question
  is *has this arrived where the team will see it*, and the team sees `origin`.
  A local copy of a long-lived branch runs behind — measured on a real checkout,
  a local `testing` sat 361 commits behind origin's, and against it 8 of 14
  recent branches read as absent when their work had been there for weeks.

A branch `origin` has never heard of keeps its `local only` mark, because that
still changes how to read the answer.

Standing inside a worktree works, and the header names the repository rather than
the worktree's directory, which is usually named after a branch.

## Why a ratio and not a checkmark

`qa` above holds six of the branch's eight commits. A binary present/absent
report would have shown that as **present** and hidden a real gap. That is the
whole reason this tool exists, so the ratio is not decoration — it is the state:

| | meaning |
|---|---|
| `8/8` | every commit of the branch reached that branch |
| `6/8` | some did — `Enter` lists the ones that did not |
| *(absent)* | none did, and the branch is never listed at all |

Branches with none of the work are counted at the foot of the screen rather than
listed, so a short list is never mistaken for a truncated one.

### Branches your branch was built on

A branch forked from an earlier point of the same work always holds some of it,
and will report a partial hit forever. Those are folded away behind `h`, and the
count says how many.

The test is a fact about the graph, not a guess about names: the branch's tip is
reachable from your source, so your branch already contains everything it has —
it is where the work came from, not where it went.

Only **partial** hits fold. Merging into a branch and then rebasing onto it
leaves that branch an ancestor too, but the hit is then full, and hiding a full
hit would hide the answer.

## How it decides

Comparison is by **patch-id** (`git cherry`), not by commit SHA. A rebase or a
cherry-pick rewrites SHAs, so `git branch --contains` reports a false absence for
any branch that got the work through one. This is the whole reason the tool is
worth running: on a real repository a branch read `9/9` by patch-id while
`--contains` said it had not arrived at all.

Every branch in the repository goes through this, one at a time:

```
own = git log --no-merges <base>..<source>

own is not empty            →  git cherry <target> <source> <base>
  the branch is still its own thing, so compare its commits one by one

own is empty                →  git merge-base --is-ancestor <source> <target>
  the base already absorbed it; git can no longer tell which commits were
  originally the branch's, so only all-or-nothing is knowable
```

The second path reports *all of it* or *none*, and **no ratio**. Printing
`0/0 commits` there would be inventing a number, so it says what it knows in
words instead.

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

shipped                # the branch you are standing on
shipped PROJ-517       # name one by a fragment of it
shipped --no-fetch     # skip the startup fetch, answer from local refs
```

The fragment is fuzzy: `517filter` finds `feature/PROJ-517/search-filter-sync`.
An exact branch name always wins outright, so `shipped develop` never opens a
picker just because some feature branch also contains those letters.

A fragment that names more than one branch is the only time shipped asks
anything, and it asks over the branches it could have meant — not over the whole
repository:

```
 shipped  7 branches match
  pick the one you mean

 ┌──────────────────────────────────────────────────────┐
 │  › feature/PROJ-517/cleanup                   30d    │
 │    feature/PROJ-517/domain                    30d    │
 │    feature/PROJ-517/search-filter-sync         3d    │
 └──────────────────────────────────────────────────────┘
```

### Keys

| Key | Action |
|---|---|
| `↑` / `↓` | move the selection |
| `Enter` | open or close the commits that are missing |
| `h` | show the branches your branch was built on |
| `r` | refetch and scan again |
| `q` / `Ctrl+C` | quit |

### How long it takes

The scan compares the branch against every other branch, one `git` process each,
so it is not instant: **6s over 653 branches** on a real repository. It scans in
the same order it lists, so the branch most likely to be the answer resolves
first — the first row lands in about **0.2s** and the rest fill in underneath.

Two things were tried to make it faster and both were measured and rejected:

- **A `git for-each-ref --contains` fast path** (0.05s for the whole repository)
  answers the SHA-merged case only. On a real branch it returned five rows and
  left out `testing`, which the patch-id scan finds holding 6 of 8 commits. A
  70ms screen that looks complete and omits the branch you came for is worse
  than waiting.
- **Pruning branches whose tip predates the oldest commit** looked sound and is
  not: it dropped a real hit, because a branch you cherry-picked *from* holds
  patch-equivalent commits while its tip stays older than yours.

Raising the number of parallel `git` processes does not help either — past a
handful they only contend, and the branches scanned first are the ones made to
wait. Measured over 653 branches: 8 at a time took 6.0s with the first row at
0.22s; 24 at a time took 7.7s with the first row at 1.08s.

## Architecture

```
install.sh              links the entry point onto PATH
src/index.ts            entry point, argv, --help
src/app.ts              the one screen (@opentui/core)
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

It carries both shapes of a branch the source was built on, too: one forked from
an earlier point of the same work, which folds, and one sitting on the very same
commit, which must not. Every commit is dated an hour apart in creation order, so
a fixture where everything shared one timestamp cannot pass off a stable order as
a correct one.

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
character frame. The scan is injected, so the answer screen is driven from
fixtures — including its streaming, since the fake scan reports hits the same way
the real one does.

### A detail if you write more tests

Tests run with `kittyKeyboard: true`. Under the legacy encoding a lone `Esc`
(`\x1b`) is held by the parser waiting to see whether it starts a CSI sequence,
so the key never reaches the handler. Special keys are named by OpenTUI's
`KeyCodes`: `RETURN`, `ESCAPE`, `ARROW_DOWN` — not `ENTER` or `DOWN`, which get
typed as literal text.

Give the app **more hits than fit on screen** whenever a test touches layout. The
list draws from a fixed pool of row renderables, and a pool taller than its box
used to lay the surplus rows out past the bottom border, over the status line and
the footer — branch names bleeding through the help text. With a handful of rows
the surplus ones are empty and paint nothing, so the whole suite passed while
every real repository rendered the bug. The box now sets `overflow: "hidden"` and
`drawList` asks the laid-out box how many rows it can actually show.

Row *text*, on the other hand, is sized from the terminal and not from the box.
The first draw happens in the constructor before any layout pass, when every
renderable still measures zero, and a row built against a width of zero renders
as `where this work isscanning 0/653` on a real terminal.

One more thing, learned the hard way: **the test renderer cannot stand in for a
terminal when checking layout.** Piping the real binary's stdout to a file does
not work either — it flushes one frame and the rest of the session never lands.
Capturing through a real pty (`pty.fork`) is what finally showed the screen as a
person sees it.
