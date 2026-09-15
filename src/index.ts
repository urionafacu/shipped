#!/usr/bin/env bun
/** Entry point: resolve the repository from the cwd, index it, hand over to the TUI. */

import { createCliRenderer } from "@opentui/core";

import { ShippedApp } from "./app";
import { assertToolchain, GitError, loadWorkspace } from "./git-bridge";

export const USAGE = `shipped — is this branch's work already in that branch?

usage:
  shipped [source] [target] [--no-fetch]

  source       fragment of the branch you worked on, e.g. a ticket id.
  target       fragment of the branch to check it against.
  --no-fetch   skip the startup fetch and answer from the local refs.
               Faster, but the answer is only as fresh as your last fetch.

Runs against the repository you are standing in. Both branches are picked from
the ones this repository actually has — nothing is assumed about how you name
them. A fragment that matches exactly one branch skips its picker, so naming
both answers the question in a single command.

examples:
  cd path/to/your/repo && shipped
  shipped PROJ-517
  shipped PROJ-517 testing
`;

export interface Invocation {
  help: boolean;
  /** Seeds the source picker so a known ticket lands on its branch immediately. */
  source: string;
  /** Seeds the target picker. */
  target: string;
  fetch: boolean;
}

export function resolveInvocation(argv: string[]): Invocation {
  const help = argv.some((arg) => arg === "-h" || arg === "--help");
  const fetch = !argv.includes("--no-fetch");
  const positional = argv.filter((arg) => !arg.startsWith("-"));
  return { help, source: positional[0] ?? "", target: positional[1] ?? "", fetch };
}

async function main(): Promise<number> {
  const { help, source, target, fetch } = resolveInvocation(process.argv.slice(2));

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
    new ShippedApp(renderer, workspace, { source, target });
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
