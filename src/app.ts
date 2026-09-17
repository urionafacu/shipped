/**
 * shipped TUI.
 *
 * One screen: the branch you worked on at the top, and underneath it every
 * branch of this repository that carries its commits, newest tip first. Nothing
 * is asked — "which branch should I compare against" is the answer, not the
 * question, and the repository already knows every place the work could be.
 *
 * A picker survives for the one case that genuinely needs a decision: a fragment
 * that names more than one branch.
 *
 * The whole screen is a projection of the fields below: key handlers mutate
 * state and call refresh(), nothing draws on its own.
 */

import {
  BoxRenderable,
  TextRenderable,
  type CliRenderer,
  type KeyEvent,
} from "@opentui/core";

import { byRecency, scanTargets, type ScanHandlers } from "./git-bridge";
import { loadWorkspace } from "./git-bridge";
import type {
  BranchRef,
  Freshness,
  Hit,
  ScanSummary,
  SourceContext,
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

/** `choose` only appears when a fragment names more than one branch. */
type Stage = "choose" | "answer";

interface Status {
  kind: "info" | "ok" | "warn" | "err";
  message: string;
}

/**
 * The two ways this screen reaches git. Injectable so the answer can be driven
 * from fixtures instead of needing a real clone on the test machine.
 */
export interface AppDeps {
  scan?: (
    source: BranchRef,
    workspace: Workspace,
    handlers: ScanHandlers,
  ) => Promise<ScanSummary>;
  reload?: () => Promise<Workspace>;
}

/** The fragment from the command line, if there was one. */
export interface Seeds {
  source?: string;
}

/**
 * Rows the chrome takes before any branch is listed: root padding, the header,
 * the section line, the footer, this box's own borders, and the gaps between
 * them. Deliberately generous — it only sizes the pool, and `drawList` asks the
 * laid-out box how many of those rows actually fit before writing to them.
 */
const CHROME_HEIGHT = 13;

/** Borders, top and bottom, inside the box's laid-out height. */
const LIST_BORDERS = 2;

/** Columns reserved on the right of a row for the ratio and the age. */
const RATIO_WIDTH = 8;
const AGE_WIDTH = 6;

/** One rendered line. Only lines that stand for a hit can be selected. */
interface Row {
  text: string;
  fg: string;
  /** Index into the visible hits, or null for expansion and summary lines. */
  hit: number | null;
}

export class ShippedApp {
  private stage: Stage = "answer";
  private workspace: Workspace;

  /** Offered only when the fragment was ambiguous. */
  private choices: BranchRef[] = [];

  private source: BranchRef | null = null;
  private context: SourceContext | null = null;
  private hits: Hit[] = [];
  /** Target names whose missing commits are listed under them. */
  private expanded = new Set<string>();
  /** Whether the branches the source was built on are listed too. */
  private showBuiltOn = false;

  private scanned = 0;
  private total = 0;
  private scanning = false;
  private summary: ScanSummary | null = null;

  private cursor = 0;
  /** Index of the first line drawn, so the list scrolls without a ScrollBox. */
  private window = 0;

  private busy = false;
  private disposed = false;
  private status: Status = { kind: "info", message: "" };

  private readonly root: BoxRenderable;
  private readonly titleText: TextRenderable;
  private readonly subtitleText: TextRenderable;
  private readonly sectionText: TextRenderable;
  private readonly listBox: BoxRenderable;
  private readonly listRows: TextRenderable[] = [];
  private readonly statusText: TextRenderable;
  private readonly helpText: TextRenderable;

  private readonly scan: NonNullable<AppDeps["scan"]>;
  private readonly reload: NonNullable<AppDeps["reload"]>;

  constructor(
    private readonly renderer: CliRenderer,
    workspace: Workspace,
    seeds: Seeds = {},
    deps: AppDeps = {},
  ) {
    this.workspace = workspace;
    this.scan = deps.scan ?? scanTargets;
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
    this.titleText = new TextRenderable(renderer, {
      id: "title",
      fg: theme.accent,
      attributes: 1,
    });
    this.subtitleText = new TextRenderable(renderer, { id: "subtitle", fg: theme.dim });
    header.add(this.titleText);
    header.add(this.subtitleText);
    this.root.add(header);

    this.sectionText = new TextRenderable(renderer, {
      id: "section",
      flexShrink: 0,
      height: 1,
      fg: theme.dim,
    });
    this.root.add(this.sectionText);

    this.listBox = new BoxRenderable(renderer, {
      id: "list",
      flexDirection: "column",
      flexGrow: 1,
      border: true,
      borderColor: theme.border,
      backgroundColor: theme.panel,
      paddingX: 1,
      // Without this, a pool taller than the box does not shrink: flex lays the
      // surplus rows out past the bottom border, straight over the status line
      // and the footer, and what the user reads is branch names bleeding
      // through the help text.
      overflow: "hidden",
    });
    // A fixed pool of rows windowed by hand, rather than renderables rebuilt as
    // results stream in.
    const visibleRows = Math.max(renderer.height - CHROME_HEIGHT, 3);
    for (let i = 0; i < visibleRows; i++) {
      const row = new TextRenderable(renderer, { id: `row-${i}`, height: 1, fg: theme.fg });
      this.listRows.push(row);
      this.listBox.add(row);
    }
    this.root.add(this.listBox);

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

    this.begin(seeds.source ?? "");
  }

  // --- opening move ----------------------------------------------------------

  /**
   * A fragment that names one branch has already answered "which one?", and so
   * has standing on a branch and typing nothing. Only a genuinely ambiguous
   * fragment is worth a screen.
   */
  private begin(fragment: string): void {
    const matches = resolveSource(fragment, this.workspace);

    if (matches.length === 1) {
      void this.start(matches[0]!).catch((error: unknown) => this.fail(error));
      return;
    }

    this.stage = "choose";
    this.choices = byRecency(matches);
    this.cursor = 0;
    this.window = 0;
    if (matches.length === 0) {
      this.status = {
        kind: "err",
        message: fragment
          ? `no branch matches "${fragment}"`
          : "detached HEAD — name a branch to ask about",
      };
    }
    this.refresh();
  }

  private async start(source: BranchRef): Promise<void> {
    this.stage = "answer";
    this.source = source;
    this.hits = [];
    this.expanded.clear();
    this.showBuiltOn = false;
    this.summary = null;
    this.scanned = 0;
    this.total = this.workspace.branches.length - 1;
    this.scanning = true;
    this.cursor = 0;
    this.window = 0;
    this.status = { kind: "info", message: "" };
    this.refresh();

    const handlers: ScanHandlers = {
      onHit: (hit) => {
        // Kept sorted rather than appended: the scan runs several branches at a
        // time, so results can arrive a little out of the order they were asked
        // for, and the list has to stay true to its own ordering.
        this.hits.push(hit);
        this.hits.sort(
          (a, b) =>
            b.target.committedAt - a.target.committedAt || a.target.name.localeCompare(b.target.name),
        );
        this.refresh();
      },
      onProgress: (scanned, total) => {
        this.scanned = scanned;
        this.total = total;
        // Redrawing on all several hundred of these would spend more time
        // painting the counter than comparing branches.
        if (scanned % 16 === 0) this.refresh();
      },
    };

    try {
      this.summary = await this.scan(source, this.workspace, handlers);
      this.context = this.summary.context;
    } finally {
      this.scanning = false;
    }
    this.refresh();
  }

  // --- state -> screen -------------------------------------------------------

  /** Hits worth listing: everything, unless a stacked ancestor is being hidden. */
  private visibleHits(): Hit[] {
    if (this.showBuiltOn) return this.hits;
    return this.hits.filter((hit) => !builtOn(hit));
  }

  private builtOnCount(): number {
    return this.hits.filter(builtOn).length;
  }

  /** Every line the list would draw, selectable or not. */
  private rows(): Row[] {
    if (this.stage === "choose") {
      return this.choices.map((branch, i) => ({
        text: chooseRow(branch, i === this.cursor, this.contentWidth(), Date.now()),
        fg: i === this.cursor ? theme.accent : theme.fg,
        hit: i,
      }));
    }

    const width = this.contentWidth();
    const now = Date.now();
    const visible = this.visibleHits();
    const rows: Row[] = [];

    for (const [i, hit] of visible.entries()) {
      const selected = i === this.cursor;
      rows.push({
        text: hitRow(hit, selected, width, now),
        fg: selected ? theme.accent : stateColor(hit.verdict.state),
        hit: i,
      });
      if (!this.expanded.has(hit.target.name)) continue;
      for (const line of expansionLines(hit)) {
        rows.push({ text: line, fg: theme.dim, hit: null });
      }
    }

    const builtOn = this.builtOnCount();
    if (builtOn > 0 && !this.showBuiltOn) {
      rows.push({
        text: pad(`   ${builtOn} more your branch was built on`, width - 10) + "h to show",
        fg: theme.dim,
        hit: null,
      });
    }

    if (rows.length === 0) {
      rows.push({
        text: this.scanning ? "  looking …" : "  nowhere yet — this work has not left this branch",
        fg: theme.dim,
        hit: null,
      });
    }
    return rows;
  }

  /**
   * Width available for a row's text.
   *
   * Derived from the terminal rather than from the laid-out box: the first draw
   * happens in the constructor, before any layout pass, when every renderable
   * still measures zero — and a row built against a width of zero is what
   * "where this work isscanning 0/653" looked like on a real terminal.
   */
  private contentWidth(): number {
    // Root padding, the box's borders and its horizontal padding, both sides.
    return Math.max(this.renderer.width - 6, 20);
  }

  /** Same reasoning, for the full-width lines outside the box. */
  private lineWidth(): number {
    return Math.max(this.renderer.width - 2, 24);
  }

  private refresh(): void {
    // A scan is async: it can resolve after the app was torn down, and touching
    // a destroyed renderable throws. Bail instead.
    if (this.disposed) return;

    this.titleText.content = this.title();
    this.subtitleText.content = this.subtitle();
    this.subtitleText.fg = this.workspace.warnings.length > 0 ? theme.warn : theme.dim;
    this.sectionText.content = this.section();

    this.drawList();

    const prefix = this.busy ? "… " : "";
    this.statusText.content = `${prefix}${this.status.message || this.absentLine()}`;
    this.statusText.fg =
      this.status.kind === "err"
        ? theme.err
        : this.status.kind === "ok"
          ? theme.ok
          : this.status.kind === "warn"
            ? theme.warn
            : theme.dim;

    this.helpText.content = this.help();
    this.renderer.requestRender();
  }

  private title(): string {
    if (this.stage === "choose") {
      return this.choices.length > 0
        ? `shipped  ${this.choices.length} branches match`
        : "shipped";
    }
    const source = this.source;
    return source ? `shipped  ${source.name}${syncTag(source.sync)}` : "shipped";
  }

  private subtitle(): string {
    const { repo, baseRef, freshness, warnings } = this.workspace;
    const where = repo.worktree ? `${repo.name} (worktree)` : repo.name;
    const age = freshnessLabel(freshness, Date.now());
    const warn = warnings.length > 0 ? ` · ! ${warnings[0]}` : "";

    if (this.stage === "choose") {
      return `${where} · ${this.workspace.branches.length} branches · ${age}${warn}`;
    }
    return `${originLabel(this.context, baseRef)} · ${where} · ${age}${warn}`;
  }

  private section(): string {
    const width = this.lineWidth();
    if (this.stage === "choose") return pad(" pick the one you mean", width);

    const hits = this.visibleHits().length;
    const right = this.scanning
      ? `scanning ${this.scanned}/${this.total} · ${hits} ${plural(hits, "hit")}`
      : `${this.total} branches · ${hits} ${plural(hits, "hit")}`;
    return pad(" where this work is", width - right.length) + right;
  }

  /** The branches with none of the work, counted so the list never reads as truncated. */
  private absentLine(): string {
    const summary = this.summary;
    if (this.stage !== "answer" || summary === null) return "";
    if (summary.absent === 0) return "";
    return ` ${summary.absent} ${plural(summary.absent, "branch", "branches")} do not have it`;
  }

  private help(): string {
    if (this.stage === "choose") return " ↑/↓ move · enter pick · q quit";
    const builtOn = this.builtOnCount() > 0 ? " · h built on" : "";
    return ` ↑/↓ move · enter what is missing${builtOn} · r refetch · q quit`;
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
    const rows = this.rows();
    const height = this.listCapacity();

    // Scroll by the line the cursor sits on, not by the cursor itself: an
    // expanded hit is several lines tall.
    const cursorLine = Math.max(
      rows.findIndex((row) => row.hit === this.cursor),
      0,
    );
    if (cursorLine < this.window) this.window = cursorLine;
    else if (height > 0 && cursorLine >= this.window + height) {
      this.window = cursorLine - height + 1;
    }
    this.window = clamp(this.window, 0, Math.max(rows.length - height, 0));

    for (const [i, renderable] of this.listRows.entries()) {
      const row = i < height ? rows[this.window + i] : undefined;
      renderable.content = row?.text ?? "";
      renderable.fg = row?.fg ?? theme.fg;
    }
  }

  private setStatus(kind: Status["kind"], message: string): void {
    this.status = { kind, message };
    this.refresh();
  }

  private fail(error: unknown): void {
    this.busy = false;
    this.scanning = false;
    this.setStatus("err", error instanceof Error ? error.message : String(error));
  }

  // --- input -----------------------------------------------------------------

  private selectable(): number {
    return this.stage === "choose" ? this.choices.length : this.visibleHits().length;
  }

  private moveCursor(delta: number): void {
    const count = this.selectable();
    if (count === 0) return;
    this.cursor = clamp(this.cursor + delta, 0, count - 1);
    this.refresh();
  }

  /** Nothing is focused on either screen, so every key is ours to read. */
  private async onKey(key: KeyEvent): Promise<void> {
    if (key.ctrl && key.name === "c") {
      this.quit();
      return;
    }
    if (this.busy) return;

    switch (key.name) {
      case "down":
      case "j":
        this.moveCursor(1);
        return;
      case "up":
      case "k":
        this.moveCursor(-1);
        return;
      case "return":
        await this.onEnter();
        return;
      case "h":
        if (this.stage === "answer" && this.builtOnCount() > 0) {
          this.showBuiltOn = !this.showBuiltOn;
          this.cursor = 0;
          this.window = 0;
          this.refresh();
        }
        return;
      case "r":
        if (this.stage === "answer") await this.refetch();
        return;
      case "q":
        this.quit();
        return;
      default:
        return;
    }
  }

  private async onEnter(): Promise<void> {
    if (this.stage === "choose") {
      const picked = this.choices[this.cursor];
      if (picked) await this.start(picked);
      return;
    }
    // Expanding in place rather than opening a screen: there is one answer per
    // row, so there is nothing to navigate to.
    const hit = this.visibleHits()[this.cursor];
    if (!hit) return;
    if (this.expanded.has(hit.target.name)) this.expanded.delete(hit.target.name);
    else this.expanded.add(hit.target.name);
    this.refresh();
  }

  private async refetch(): Promise<void> {
    const source = this.source;
    if (!source) return;

    this.busy = true;
    this.setStatus("info", "fetching …");
    try {
      this.workspace = await this.reload();
      this.busy = false;
      // The branch may have been renamed or deleted out from under us.
      const again = this.workspace.branches.find((b) => b.name === source.name);
      if (!again) {
        this.setStatus("err", `${source.name} is gone from this repository`);
        return;
      }
      await this.start(again);
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

export function shortSha(sha: string): string {
  return sha.slice(0, 9);
}

function plural(count: number, one: string, many = `${one}s`): string {
  return count === 1 ? one : many;
}

function pad(text: string, width: number): string {
  return text.length >= width ? text : text + " ".repeat(width - text.length);
}

/** Keeps a long branch name from pushing the ratio off the right edge. */
export function truncate(text: string, width: number): string {
  if (width <= 1) return text.slice(0, Math.max(width, 0));
  return text.length <= width ? text : `${text.slice(0, width - 1)}…`;
}

/**
 * Which branch the source's own commits were counted against, or that there are
 * none left to count. Said in the subtitle because it changes what every ratio
 * on the screen means.
 */
export function originLabel(context: SourceContext | null, baseRef: string): string {
  if (context === null) return `vs ${baseRef}`;
  if (context.strategy === "ancestry") return `absorbed by ${baseRef}`;
  return `${context.own.length} ${plural(context.own.length, "commit")} vs ${baseRef}`;
}

/**
 * A branch the source already contains is not a place the work arrived — it is
 * where the work came from, and it will report a partial hit forever.
 *
 * Only partial hits fold. Merging into a branch and then rebasing onto it leaves
 * that branch an ancestor too, but the hit is then full, and hiding a full hit
 * would hide the answer.
 */
export function builtOn(hit: Hit): boolean {
  return hit.ancestor && hit.verdict.state === "partial";
}

/** How much of the work is there. On the ancestry path there is no honest ratio. */
export function describeRatio(verdict: Verdict): string {
  if (verdict.approximate) return verdict.state === "full" ? "all of it" : "none";
  return `${verdict.present}/${verdict.total}`;
}

/** Coarse on purpose: the question is "did I push this days ago", not an hour. */
export function relativeDay(committedAt: number, now: number): string {
  const days = Math.floor((now / 1000 - committedAt) / 86_400);
  if (days <= 0) return "today";
  return `${days}d`;
}

function stateColor(state: Verdict["state"]): string {
  switch (state) {
    case "full":
      return theme.ok;
    case "partial":
      return theme.warn;
    case "absent":
      return theme.dim;
  }
}

/**
 * The branch, how much of the work it has, and how recently anything landed on
 * it — the three things the ordering and the answer are made of.
 */
export function hitRow(hit: Hit, selected: boolean, width: number, now: number): string {
  const age = relativeDay(hit.target.committedAt, now);
  const ratio = describeRatio(hit.verdict);
  const nameWidth = Math.max(width - 3 - RATIO_WIDTH - AGE_WIDTH, 8);
  const name = truncate(`${hit.target.name}${syncTag(hit.target.sync)}`, nameWidth);
  return `${selected ? " › " : "   "}${pad(name, nameWidth)}${pad(ratio, RATIO_WIDTH)}${age}`;
}

/** Same shape, without a ratio: nothing has been compared yet on this screen. */
export function chooseRow(branch: BranchRef, selected: boolean, width: number, now: number): string {
  const age = relativeDay(branch.committedAt, now);
  const nameWidth = Math.max(width - 3 - AGE_WIDTH, 8);
  const name = truncate(`${branch.name}${syncTag(branch.sync)}`, nameWidth);
  return `${selected ? " › " : "   "}${pad(name, nameWidth)}${age}`;
}

/** What is not there yet, listed under the row rather than on a screen of its own. */
export function expansionLines(hit: Hit): string[] {
  const { verdict, target } = hit;
  if (verdict.approximate) {
    return [`     ${target.ref} — the base absorbed this branch, so git cannot list its commits`];
  }
  if (verdict.missing.length === 0) return [`     nothing missing from ${target.ref}`];
  return [
    `     ${verdict.missing.length} missing from ${target.ref}`,
    ...verdict.missing.map((commit) => `     ${shortSha(commit.sha)}  ${commit.subject}`),
  ];
}

/**
 * The list mark. Short, because it sits beside a branch name that is already
 * long, and silent for the ordinary case so the exceptions stand out.
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

/**
 * Subsequence match: "517filter" finds "feature/PROJ-517/search-filter-sync".
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

/**
 * Which branches the command line could have meant.
 *
 * An exact name wins outright, so `shipped develop` never opens a picker just
 * because some feature branch also contains those letters. With no fragment at
 * all the question is about the branch you are standing on, which is the reason
 * to be running this from inside a repository in the first place.
 */
export function resolveSource(fragment: string, workspace: Workspace): BranchRef[] {
  const query = fragment.trim();
  if (query.length === 0) {
    const head = workspace.branches.find((b) => b.name === workspace.head);
    return head ? [head] : [];
  }
  const exact = workspace.branches.find((b) => b.name === query);
  if (exact) return [exact];
  return rankBranches(query, workspace.branches);
}
