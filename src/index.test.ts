import { describe, expect, test } from "bun:test";

import { USAGE, resolveInvocation } from "./index";

describe("resolveInvocation", () => {
  test("starts with both pickers empty when called bare", () => {
    expect(resolveInvocation([])).toEqual({ help: false, source: "", target: "", fetch: true });
  });

  test("seeds the source picker from the first argument", () => {
    expect(resolveInvocation(["PROJ-517"])).toMatchObject({ source: "PROJ-517", target: "" });
  });

  test("seeds both pickers, which answers the question in one command", () => {
    expect(resolveInvocation(["PROJ-517", "testing"])).toMatchObject({
      source: "PROJ-517",
      target: "testing",
    });
  });

  test("recognises both help flags", () => {
    expect(resolveInvocation(["-h"]).help).toBe(true);
    expect(resolveInvocation(["--help"]).help).toBe(true);
  });

  test("--no-fetch skips the startup fetch", () => {
    expect(resolveInvocation(["--no-fetch"]).fetch).toBe(false);
  });

  test("--no-fetch still allows both seeds, wherever it sits", () => {
    expect(resolveInvocation(["--no-fetch", "PROJ-517", "testing"])).toMatchObject({
      source: "PROJ-517",
      target: "testing",
      fetch: false,
    });
    expect(resolveInvocation(["PROJ-517", "--no-fetch", "testing"])).toMatchObject({
      source: "PROJ-517",
      target: "testing",
      fetch: false,
    });
  });

  test("ignores a third positional rather than misreading it as a target", () => {
    expect(resolveInvocation(["a", "b", "c"])).toMatchObject({ source: "a", target: "b" });
  });

  test("does not treat a branch name as a help flag", () => {
    expect(resolveInvocation(["hotfix"]).help).toBe(false);
  });
});

describe("USAGE", () => {
  test("names the command the way the user actually invokes it", () => {
    expect(USAGE).toContain("shipped [source] [target]");
  });

  test("says it runs against the repository you are standing in", () => {
    expect(USAGE).toContain("repository you are standing in");
  });

  test("shows the single-command form", () => {
    expect(USAGE).toContain("shipped PROJ-517 testing");
  });

  test("documents the fetch opt-out", () => {
    expect(USAGE).toContain("--no-fetch");
  });

  test("promises nothing about how branches are named", () => {
    // The tool compares whatever two branches it is given. Naming a branch here
    // would be a default in disguise, and defaults were the whole problem.
    for (const leaked of ["testing-us", "us-testing", "testing-dx", "staging"]) {
      expect(USAGE).not.toContain(leaked);
    }
  });

  test("names no particular repository or directory layout", () => {
    for (const leaked of ["SHIPPED_ROOT", "~/dev", "/Users/", "/home/"]) {
      expect(USAGE).not.toContain(leaked);
    }
  });
});
