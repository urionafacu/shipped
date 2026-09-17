import { describe, expect, test } from "bun:test";

import { USAGE, resolveInvocation } from "./index";

describe("resolveInvocation", () => {
  test("names no branch when called bare, which means the one you are on", () => {
    expect(resolveInvocation([])).toEqual({ help: false, source: "", fetch: true });
  });

  test("takes the branch to ask about from the first argument", () => {
    expect(resolveInvocation(["PROJ-517"])).toMatchObject({ source: "PROJ-517" });
  });

  test("recognises both help flags", () => {
    expect(resolveInvocation(["-h"]).help).toBe(true);
    expect(resolveInvocation(["--help"]).help).toBe(true);
  });

  test("--no-fetch skips the startup fetch", () => {
    expect(resolveInvocation(["--no-fetch"]).fetch).toBe(false);
  });

  test("--no-fetch reads the same wherever it sits", () => {
    expect(resolveInvocation(["--no-fetch", "PROJ-517"])).toMatchObject({
      source: "PROJ-517",
      fetch: false,
    });
    expect(resolveInvocation(["PROJ-517", "--no-fetch"])).toMatchObject({
      source: "PROJ-517",
      fetch: false,
    });
  });

  test("ignores a second positional, since there is no second question to ask", () => {
    // `shipped A B` used to mean "compare A against B". The target is now the
    // answer rather than an argument, so a stray word must not silently change
    // which branch is being asked about.
    expect(resolveInvocation(["a", "b"])).toMatchObject({ source: "a" });
  });

  test("does not treat a branch name as a help flag", () => {
    expect(resolveInvocation(["hotfix"]).help).toBe(false);
  });
});

describe("USAGE", () => {
  test("names the command the way the user actually invokes it", () => {
    expect(USAGE).toContain("shipped [branch]");
  });

  test("says it runs against the repository you are standing in", () => {
    expect(USAGE).toContain("repository you are standing in");
  });

  test("says the branch is optional, because standing on it is the common case", () => {
    expect(USAGE).toContain("Defaults to the branch you have checked out");
  });

  test("documents the fetch opt-out", () => {
    expect(USAGE).toContain("--no-fetch");
  });

  test("asks for no second branch", () => {
    // The tool no longer has a target to be told about: it finds them.
    expect(USAGE).not.toContain("[target]");
    expect(USAGE).not.toContain("compare it against");
  });

  test("promises nothing about how branches are named", () => {
    // Naming a branch here would be a default in disguise, and defaults were
    // the whole problem.
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
