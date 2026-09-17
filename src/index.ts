#!/usr/bin/env bun
/** Entry point: resolve the repository from the cwd, index it, hand over to the TUI. */

import { createCliRenderer } from "@opentui/core";

import { ShippedApp } from "./app";
import { assertToolchain, GitError, loadWorkspace } from "./git-bridge";

export const USAGE = `shipped — where did this branch's work end up?

usage:
  shipped [branch] [--no-fetch]

  branch       fragment of the branch to ask about, e.g. a ticket id.
               Defaults to the branch you have checked out.
  --no-fetch   skip the startup fetch and answer from the local refs.
               Faster, but the answer is only as fresh as your last fetch.

Runs against the repository you are standing in, worktrees included. It compares
the branch against every other branch this repository has — local ones too — and
lists the ones carrying its commits, newest first. Nothing is configured and no
branch name is built in: the repository is asked, never assumed.

The comparison is by patch-id, so work that arrived through a rebase or a
cherry-pick still counts as present.

examples:
  cd path/to/your/repo && shipped
  shipped PROJ-517
  shipped PROJ-517 --no-fetch
`;

export interface Invocation {
  help: boolean;
  /** Names the branch to ask about. Empty means the checked-out one. */
  source: string;
  fetch: boolean;
}

export function resolveInvocation(argv: string[]): Invocation {
  const help = argv.some((arg) => arg === "-h" || arg === "--help");
  const fetch = !argv.includes("--no-fetch");
  const positional = argv.filter((arg) => !arg.startsWith("-"));
  return { help, source: positional[0] ?? "", fetch };
}

async function main(): Promise<number> {
  const { help, source, fetch } = resolveInvocation(process.argv.slice(2));

  if (help) {
    process.stdout.write(USAGE);
    return 0;
  }

  try {
    await assertToolchain();
    const workspace = await loadWorkspace(process.cwd(), fetch);

    const renderer = await createCliRenderer({
      exitOnCtrlC: false,
      targetFps: 30,
      backgroundColor: "#0b1220",
    });
    new ShippedApp(renderer, workspace, { source });
    return 0;
  } catch (error) {
    const known = error instanceof GitError;
    process.stderr.write(`shipped: ${known ? error.message : String(error)}\n`);
    // Run outside a repository? The usage says where it expects to be run,
    // which the bare error does not.
    if (known && error.message.includes("not inside a git repository")) {
      process.stderr.write(`\n${USAGE}`);
    }
    return 1;
  }
}

if (import.meta.main) {
  const code = await main();
  if (code !== 0) process.exit(code);
}
