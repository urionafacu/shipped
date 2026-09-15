/**
 * shipped TUI.
 *
 * Three steps: pick the branch you worked on, pick the branch to check it
 * against, read the verdict. Both pickers are the same widget over the same
 * list — the tool has no opinion about which branches are worth asking about,
 * so a target is just another branch.
 *
 * The whole screen is a projection of the fields below: key handlers mutate
 * state and call refresh(), nothing draws on its own.
 */

import {
  BoxRenderable,
  InputRenderable,
  InputRenderableEvents,
  TextRenderable,
  type CliRenderer,
  type KeyEvent,
} from "@opentui/core";

import { compare, GitError, loadWorkspace } from "./git-bridge";
import type {
  BranchRef,
  Comparison,
  Freshness,
  SyncState,
  Verdict,
  Workspace,
} from "./types";

const theme = {
  bg: "#0b1220",
  panel: "#111a2e",
  border: "#1e293b",
  borderActive: "#22d3ee",
  fg: "#e2e8f0",
  dim: "#64748b",
  accent: "#22d3ee",
  ok: "#4ade80",
  warn: "#fbbf24",
  err: "#f87171",
} as const;

/** Pick a source, pick a target, read the answer. */
type Step = "source" | "target" | "result";

interface Status {
  kind: "info" | "ok" | "warn" | "err";
  message: string;
}

/**
 * The two ways this screen reaches git. Injectable so the result view can be
 * driven from fixtures instead of needing a real clone on the test machine.
 */
export interface AppDeps {
  compare?: (source: BranchRef, target: BranchRef, workspace: Workspace) => Promise<Comparison>;
  reload?: () => Promise<Workspace>;
}

/** Fragments that seed each picker, so naming both skips straight to the answer. */
export interface Seeds {
  source?: string;
  target?: string;
}

/**
 * Rows the chrome takes before any branch is listed: root padding, the header,
 * the search field, the footer, this box's own borders, and the gaps between
 * them. Deliberately generous — it only sizes the pool, and `drawList` asks the
 * laid-out box how many of those rows actually fit before writing to them.
 */
const CHROME_HEIGHT = 15;

/** Borders, top and bottom, inside the box's laid-out height. */
const LIST_BORDERS = 2;

export class ShippedApp {
  private step: Step = "source";
  private workspace: Workspace;

  private matches: BranchRef[] = [];
  private cursor = 0;
  /** Index of the first branch drawn, so the list scrolls without a ScrollBox. */
  private window = 0;

  private source: BranchRef | null = null;
  private comparison: Comparison | null = null;
  private targetSeed: string;

  private busy = false;
  private disposed = false;
  private status: Status = { kind: "info", message: "ready" };

  private readonly root: BoxRenderable;
  private readonly subtitleText: TextRenderable;
  private readonly searchBox: BoxRenderable;
  private readonly searchInput: InputRenderable;
  private readonly listBox: BoxRenderable;
  private readonly listRows: TextRenderable[] = [];
  private readonly resultBox: BoxRenderable;
  private readonly pairText: TextRenderable;
  private readonly verdictText: TextRenderable;
  private readonly missingText: TextRenderable;
  private readonly statusText: TextRenderable;
  private readonly helpText: TextRenderable;

  private readonly compare: NonNullable<AppDeps["compare"]>;
  private readonly reload: NonNullable<AppDeps["reload"]>;

  constructor(
    private readonly renderer: CliRenderer,
    workspace: Workspace,
    seeds: Seeds = {},
    deps: AppDeps = {},
  ) {
    this.workspace = workspace;
    this.targetSeed = seeds.target ?? "";
    this.compare = deps.compare ?? compare;
    this.reload = deps.reload ?? (() => loadWorkspace(workspace.repo.root, true));

    this.root = new BoxRenderable(renderer, {
      id: "root",
      flexDirection: "column",
      width: "100%",
      height: "100%",
      backgroundColor: theme.bg,
      padding: 1,
      gap: 1,
    });

    const header = new BoxRenderable(renderer, {
      id: "header",
      flexDirection: "column",
      flexShrink: 0,
      height: 2,
    });
    header.add(
      new TextRenderable(renderer, {
        id: "title",
        content: "shipped — did this branch's work get there?",
        fg: theme.accent,
        attributes: 1,
      }),
    );
    this.subtitleText = new TextRenderable(renderer, { id: "subtitle", fg: theme.dim });
    header.add(this.subtitleText);
    this.root.add(header);

    this.searchBox = new BoxRenderable(renderer, {
      id: "search",
      flexDirection: "row",
      // Without flexShrink: 0 the growing list starves the fixed panels and Yoga
      // collapses them onto a single overlapping row.
      flexShrink: 0,
      border: true,
      borderColor: theme.borderActive,
      backgroundColor: theme.panel,
      title: " source branch ",
      titleColor: theme.accent,
      paddingX: 1,
      height: 3,
    });
    this.searchInput = new InputRenderable(renderer, {
      id: "search-input",
      value: seeds.source ?? "",
      flexGrow: 1,
      placeholder: "type a branch name, a ticket, or any fragment",
      textColor: theme.fg,
      cursorColor: theme.accent,
      backgroundColor: theme.panel,
      focusedBackgroundColor: theme.border,
      maxLength: 200,
    });
    this.searchInput.on(InputRenderableEvents.INPUT, () => this.onQueryChanged());
    this.searchBox.add(this.searchInput);
    this.root.add(this.searchBox);

    this.listBox = new BoxRenderable(renderer, {
      id: "list",
      flexDirection: "column",
      flexGrow: 1,
      border: true,
      borderColor: theme.border,
      backgroundColor: theme.panel,
      title: " matches ",
      titleColor: theme.dim,
      paddingX: 1,
      // Without this, a pool taller than the box does not shrink: flex lays the
      // surplus rows out past the bottom border, straight over the status line
      // and the footer, and what the user reads is branch names bleeding
      // through the help text.
      overflow: "hidden",
    });
    // A fixed pool of rows windowed by hand: rebuilding renderables on every
    // keystroke over a few thousand branches is what makes a filter feel slow.
    const visibleRows = Math.max(renderer.height - CHROME_HEIGHT, 3);
    for (let i = 0; i < visibleRows; i++) {
      const row = new TextRenderable(renderer, { id: `row-${i}`, height: 1, fg: theme.fg });
      this.listRows.push(row);
      this.listBox.add(row);
    }
    this.root.add(this.listBox);

    this.resultBox = new BoxRenderable(renderer, {
      id: "result-panel",
      flexDirection: "column",
      flexGrow: 1,
      border: true,
      borderColor: theme.borderActive,
      backgroundColor: theme.panel,
      title: " answer ",
      titleColor: theme.accent,
      paddingX: 1,
      visible: false,
    });
    this.pairText = new TextRenderable(renderer, { id: "pair-text", height: 3, fg: theme.fg });
    this.verdictText = new TextRenderable(renderer, { id: "verdict-text", height: 2 });
    this.missingText = new TextRenderable(renderer, { id: "missing", fg: theme.dim, flexGrow: 1 });
    this.resultBox.add(this.pairText);
    this.resultBox.add(this.verdictText);
    this.resultBox.add(this.missingText);
    this.root.add(this.resultBox);

    const footer = new BoxRenderable(renderer, {
      id: "footer",
      flexDirection: "column",
      flexShrink: 0,
      height: 2,
    });
    this.statusText = new TextRenderable(renderer, { id: "status-text", height: 1, flexShrink: 0 });
    this.helpText = new TextRenderable(renderer, {
      id: "help-text",
      fg: theme.dim,
      height: 1,
      flexShrink: 0,
    });
    footer.add(this.statusText);
    footer.add(this.helpText);
    this.root.add(footer);

    renderer.root.add(this.root);
    renderer.keyInput.on("keypress", (key: KeyEvent) => {
      // An unexpected failure in a handler must land in the status bar, not
      // become an unhandled rejection that kills the session.
      void this.onKey(key).catch((error: unknown) => this.fail(error));
    });

    this.searchInput.focus();
    this.onQueryChanged();

    // A fragment that names exactly one branch has already answered "which
    // one?", so making the user press enter adds nothing. Chained, so naming
    // both branches answers the question without any keystroke at all.
    if ((seeds.source ?? "").length > 0 && this.matches.length === 1) {
      void this.pickSource(this.matches[0]!).catch((error: unknown) => this.fail(error));
    }
  }

  // --- state -> screen -------------------------------------------------------

  /** Every branch the active picker may offer. */
  private candidates(): BranchRef[] {
    // Comparing a branch against itself is always trivially "full", so it is
    // never the question being asked.
    return this.step === "target" && this.source !== null
      ? this.workspace.branches.filter((b) => b.ref !== this.source!.ref)
      : this.workspace.branches;
  }

  private onQueryChanged(): void {
    this.matches = rankBranches(this.searchInput.value, this.candidates());
    this.cursor = 0;
    this.window = 0;
    this.refresh();
  }

  private refresh(): void {
    // A refetch is async: it can resolve after the app was torn down, and
    // touching a destroyed renderable throws. Bail instead.
    if (this.disposed) return;

    this.subtitleText.content = this.subtitle();
    this.subtitleText.fg = this.workspace.warnings.length > 0 ? theme.warn : theme.dim;

    const picking = this.step !== "result";
    this.searchBox.visible = picking;
    this.listBox.visible = picking;
    this.resultBox.visible = !picking;

    if (picking) {
      this.searchBox.title = this.step === "source" ? " source branch " : " target branch ";
      this.drawList();
    } else {
      this.drawResult();
    }

    const prefix = this.busy ? "… " : "";
    this.statusText.content = `${prefix}${this.status.message}`;
    this.statusText.fg =
      this.status.kind === "err"
        ? theme.err
        : this.status.kind === "ok"
          ? theme.ok
          : this.status.kind === "warn"
            ? theme.warn
            : theme.fg;

    this.helpText.content = this.help();
    this.renderer.requestRender();
  }

  private help(): string {
    switch (this.step) {
      case "source":
        return "type to filter · ↑/↓ move · enter pick · ctrl+r refetch · esc clear · ctrl+c quit";
      case "target":
        return "type to filter · ↑/↓ move · enter check · ctrl+r refetch · esc back · ctrl+c quit";
      case "result":
        return "esc another target · b another source · r refetch · q quit";
    }
  }

  private subtitle(): string {
    const { repo, baseRef, branches, freshness, warnings } = this.workspace;
    const age = freshnessLabel(freshness, Date.now());
    const warn = warnings.length > 0 ? ` · ! ${warnings[0]}` : "";
    const where = repo.worktree ? `${repo.name} (worktree)` : repo.name;
    return `${where} · ${branches.length} branches · base ${baseRef} · ${age}${warn}`;
  }

  /**
   * How many pooled rows the box can actually show right now.
   *
   * Asked of the laid-out box rather than recomputed from the terminal size:
   * the pool is built once from a constant, and any drift between that constant
   * and the real layout used to be painted outside the box rather than dropped.
   */
  private listCapacity(): number {
    const inner = this.listBox.height - LIST_BORDERS;
    // The first draw happens in the constructor, before any layout pass, so the
    // box has no height yet. Fall back to the whole pool: `overflow: hidden`
    // keeps a too-tall pool clipped rather than painted over the footer, and the
    // next refresh measures for real.
    if (inner <= 0) return this.listRows.length;
    return Math.min(this.listRows.length, inner);
  }

  private drawList(): void {
    const height = this.listCapacity();
    // Keep the cursor inside the window without jumping it to the middle.
    if (this.cursor < this.window) this.window = this.cursor;
    else if (height > 0 && this.cursor >= this.window + height) {
      this.window = this.cursor - height + 1;
    }

    for (const [i, row] of this.listRows.entries()) {
      const branch = i < height ? this.matches[this.window + i] : undefined;
      if (!branch) {
        row.content = "";
        continue;
      }
      const selected = this.window + i === this.cursor;
      row.content = `${selected ? "› " : "  "}${branch.name}${syncTag(branch.sync)}`;
      row.fg = selected ? theme.accent : branch.sync === "in-sync" ? theme.fg : theme.warn;
    }

    if (this.matches.length === 0) {
      const first = this.listRows[0];
      // An empty result is not an error: the filter simply matched nothing.
      if (first) first.content = this.searchInput.value ? "  no branch matches" : "  no branches";
    }
  }

  private drawResult(): void {
    const comparison = this.comparison;
    if (!comparison) return;

    const { source, target, verdict, own, baseRef, strategy } = comparison;
    const note =
      strategy === "ancestry"
        ? `${baseRef} already absorbed this branch — only all-or-nothing is knowable`
        : `${own.length} commit(s) of its own vs ${baseRef}`;
    // Which ref each side resolved to, because a ✓ earned against a branch that
    // never left this machine is a different fact from one earned against origin.
    this.pairText.content =
      `source  ${source.name}${syncNote(source.sync)}\n` +
      `target  ${target.ref}${syncNote(target.sync)}\n` +
      note;
    this.pairText.fg = source.sync === "in-sync" && target.sync === "in-sync" ? theme.fg : theme.warn;

    this.verdictText.content = `\n  ${stateGlyph(verdict.state)}  ${describeVerdict(verdict)}`;
    this.verdictText.fg = stateColor(verdict.state);

    if (verdict.missing.length === 0) {
      this.missingText.content = `\n  ${noMissingReason(verdict, baseRef)}`;
      return;
    }
    const lines = verdict.missing.map((c) => `  ${shortSha(c.sha)}  ${c.subject}`);
    this.missingText.content = `\n  missing from ${target.ref}:\n${lines.join("\n")}`;
  }

  private setStatus(kind: Status["kind"], message: string): void {
    this.status = { kind, message };
    this.refresh();
  }

  private fail(error: unknown): void {
    this.busy = false;
    this.setStatus("err", error instanceof Error ? error.message : String(error));
  }

  // --- input -----------------------------------------------------------------

  private moveCursor(delta: number): void {
    if (this.matches.length === 0) return;
    this.cursor = clamp(this.cursor + delta, 0, this.matches.length - 1);
    this.refresh();
  }

  private async onKey(key: KeyEvent): Promise<void> {
    if (key.ctrl && key.name === "c") {
      this.quit();
      return;
    }
    if (this.busy) return;

    if (this.step === "result") {
      await this.onResultKey(key);
      return;
    }
    await this.onPickerKey(key);
  }

  /**
   * The search field is focused so that plain typing filters, which means every
   * key this screen claims has to be taken away from the input explicitly —
   * otherwise `r` would refetch instead of typing an "r".
   */
  private async onPickerKey(key: KeyEvent): Promise<void> {
    switch (key.name) {
      case "down":
        claim(key);
        this.moveCursor(1);
        return;
      case "up":
        claim(key);
        this.moveCursor(-1);
        return;
      case "return": {
        claim(key);
        const picked = this.matches[this.cursor];
        if (!picked) return;
        if (this.step === "source") await this.pickSource(picked);
        else await this.pickTarget(picked);
        return;
      }
      case "escape":
        claim(key);
        // Esc pops one step. On the first there is nowhere back to, so it
        // clears the filter instead.
        if (this.step === "target") this.toSourceStep();
        else {
          this.searchInput.value = "";
          this.onQueryChanged();
        }
        return;
      case "r":
        // Plain `r` belongs to the input here, so the refetch needs a modifier.
        if (!key.ctrl) return;
        claim(key);
        await this.refetch();
        return;
      default:
        return;
    }
  }

  /** Nothing is focused on this screen, so every key is ours to read. */
  private async onResultKey(key: KeyEvent): Promise<void> {
    switch (key.name) {
      case "escape":
        // The same branch usually gets asked about against several targets in a
        // row, so the cheap move is back to the target picker, not the start.
        this.toTargetStep("");
        return;
      case "b":
        this.toSourceStep();
        return;
      case "r":
        await this.refetch();
        return;
      case "q":
        this.quit();
        return;
      default:
        return;
    }
  }

  // --- steps -----------------------------------------------------------------

  private toSourceStep(): void {
    this.step = "source";
    this.source = null;
    this.comparison = null;
    this.searchInput.value = "";
    this.searchInput.focus();
    this.status = { kind: "info", message: "ready" };
    this.onQueryChanged();
  }

  private toTargetStep(seed: string): void {
    this.step = "target";
    this.comparison = null;
    this.searchInput.value = seed;
    this.searchInput.focus();
    this.status = { kind: "info", message: `checking ${this.source?.name ?? ""} against …` };
    this.onQueryChanged();
  }

  private async pickSource(branch: BranchRef): Promise<void> {
    this.source = branch;
    const seed = this.targetSeed;
    // Consumed: it seeds the first visit only, not every return to this step.
    this.targetSeed = "";
    this.toTargetStep(seed);
    if (seed.length > 0 && this.matches.length === 1) {
      await this.pickTarget(this.matches[0]!);
    }
  }

  private async pickTarget(target: BranchRef): Promise<void> {
    const source = this.source;
    if (!source) return;

    this.busy = true;
    this.setStatus("info", `checking ${source.name} against ${target.name} …`);
    try {
      this.comparison = await this.compare(source, target, this.workspace);
      this.busy = false;
      this.step = "result";
      this.searchInput.blur();
      this.setStatus(...summarize(this.comparison));
    } catch (error) {
      this.fail(error);
    }
  }

  private async refetch(): Promise<void> {
    this.busy = true;
    this.setStatus("info", "fetching …");
    try {
      this.workspace = await this.reload();
      this.matches = rankBranches(this.searchInput.value, this.candidates());
      this.cursor = Math.min(this.cursor, Math.max(this.matches.length - 1, 0));
      // The old answer was computed against the refs we just replaced.
      if (this.step === "result" && this.comparison) {
        const { target } = this.comparison;
        this.busy = false;
        await this.pickTarget(target);
        return;
      }
      this.busy = false;
      this.setStatus("ok", "refetched");
    } catch (error) {
      this.fail(error);
    }
  }

  /** Stops the app from touching renderables. Idempotent. */
  dispose(): void {
    this.disposed = true;
  }

  private quit(): void {
    this.dispose();
    this.renderer.destroy();
    process.exit(0);
  }
}

// --- pure helpers ----------------------------------------------------------

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * Stops a key the picker handles from also reaching the focused input, which
 * would otherwise type it as text.
 */
function claim(key: KeyEvent): void {
  key.preventDefault();
  key.stopPropagation();
}

export function shortSha(sha: string): string {
  return sha.slice(0, 9);
}

/**
 * The picker-list mark. Short, because it sits beside a branch name that is
 * already long, and silent for the ordinary case so the exceptions stand out.
 */
export function syncTag(sync: SyncState): string {
  switch (sync) {
    case "in-sync":
      return "";
    case "local-only":
      return "  · local only";
    case "diverged":
      return "  · local ≠ origin";
  }
}

/** The same fact spelled out, where there is room for it on the answer screen. */
export function syncNote(sync: SyncState): string {
  switch (sync) {
    case "in-sync":
      return "";
    case "local-only":
      return "  (local only — never pushed to origin)";
    case "diverged":
      return "  (local ref, differs from origin)";
  }
}

export function stateGlyph(state: Verdict["state"]): string {
  switch (state) {
    case "full":
      return "✓";
    case "partial":
      return "◐";
    case "absent":
      return "✗";
  }
}

function stateColor(state: Verdict["state"]): string {
  switch (state) {
    case "full":
      return theme.ok;
    case "partial":
      return theme.warn;
    case "absent":
      return theme.err;
  }
}

/**
 * On the ancestry path there is no honest ratio to print, so the line says what
 * it knows in words instead of inventing a count.
 */
export function describeVerdict(verdict: Verdict): string {
  switch (verdict.state) {
    case "full":
      return verdict.approximate
        ? "the whole branch is here"
        : `${verdict.present}/${verdict.total} commits`;
    case "absent":
      return verdict.approximate ? "the branch has not arrived" : `0/${verdict.total} commits`;
    case "partial":
      return `${verdict.present}/${verdict.total} commits · ${verdict.missing.length} missing`;
  }
}

export function noMissingReason(verdict: Verdict, baseRef = "the base branch"): string {
  if (verdict.approximate) return `${baseRef} absorbed the branch — git cannot list its commits`;
  return "nothing missing";
}

/** One line, so a stale answer is never read as an authoritative one. */
export function freshnessLabel(freshness: Freshness, now: number): string {
  if (freshness.stale) return "refs may be STALE";
  return `fetched ${formatAge(now - (freshness.fetchedAt ?? now))} ago`;
}

export function formatAge(ms: number): string {
  const seconds = Math.max(Math.floor(ms / 1000), 0);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/** One line for the status bar: the whole answer, without leaving the keyboard. */
export function summarize(comparison: Comparison): [Status["kind"], string] {
  const { target, verdict } = comparison;
  const kind: Status["kind"] =
    verdict.state === "full" ? "ok" : verdict.state === "partial" ? "warn" : "info";
  return [kind, `${target.name} ${stateGlyph(verdict.state)} ${describeVerdict(verdict)}`];
}

/**
 * Subsequence match: "517filter" finds "feature/PROJ-517/search-filter-sync".
 * Cheap enough to rerun over every branch on each keystroke.
 */
export function fuzzyMatch(query: string, candidate: string): boolean {
  if (query.length === 0) return true;
  const needle = query.toLowerCase();
  const haystack = candidate.toLowerCase();
  let at = 0;
  for (const char of needle) {
    if (char === " ") continue;
    at = haystack.indexOf(char, at);
    if (at === -1) return false;
    at += 1;
  }
  return true;
}

/** A contiguous hit is almost always the branch the user had in mind. */
export function scoreBranch(query: string, branch: BranchRef): number {
  if (query.length === 0) return 0;
  const needle = query.toLowerCase().replace(/\s+/g, "");
  const name = branch.name.toLowerCase();
  const index = name.indexOf(needle);
  if (index === 0) return 0;
  if (index > 0) return 1;
  return 2;
}

export function rankBranches(query: string, branches: readonly BranchRef[]): BranchRef[] {
  const target = query.trim();
  return branches
    .filter((b) => fuzzyMatch(target, b.name))
    .sort((a, b) => {
      const byScore = scoreBranch(target, a) - scoreBranch(target, b);
      return byScore !== 0 ? byScore : a.name.localeCompare(b.name);
    });
}
