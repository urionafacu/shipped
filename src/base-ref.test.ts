import { describe, expect, test } from "bun:test";

import { BASE_FALLBACKS, NO_BASE_HINT, baseRefFromSymbolic, pickBaseFallback } from "./base-ref";

describe("baseRefFromSymbolic", () => {
  test("shortens the ref git printed", () => {
    expect(baseRefFromSymbolic("refs/remotes/origin/develop\n")).toBe("origin/develop");
  });

  test("works for a repository on main", () => {
    expect(baseRefFromSymbolic("refs/remotes/origin/main\n")).toBe("origin/main");
  });

  test("keeps a slash inside the branch name", () => {
    expect(baseRefFromSymbolic("refs/remotes/origin/release/2024\n")).toBe("origin/release/2024");
  });

  test("returns null for output that is not a remote ref", () => {
    expect(baseRefFromSymbolic("refs/heads/develop\n")).toBeNull();
    expect(baseRefFromSymbolic("")).toBeNull();
  });
});

describe("pickBaseFallback", () => {
  test("prefers develop", () => {
    expect(pickBaseFallback(new Set(["origin/develop", "origin/main"]))).toBe("origin/develop");
  });

  test("falls back to main", () => {
    expect(pickBaseFallback(new Set(["origin/main", "origin/master"]))).toBe("origin/main");
  });

  test("falls back to master", () => {
    expect(pickBaseFallback(new Set(["origin/master"]))).toBe("origin/master");
  });

  test("returns null when the repository has none of them", () => {
    // Turned into an actionable error upstream rather than a wrong answer.
    expect(pickBaseFallback(new Set(["origin/trunk"]))).toBeNull();
  });

  test("tries them in the declared order", () => {
    const seen = BASE_FALLBACKS.map((ref) => pickBaseFallback(new Set([ref])));
    expect(seen).toEqual([...BASE_FALLBACKS]);
  });
});

describe("BASE_FALLBACKS", () => {
  test("names only conventional default branches, never a team's own scheme", () => {
    // These are a last resort for a clone with no origin/HEAD, not a guess at
    // how anyone names their branches — the fallbacks are git's own defaults.
    expect([...BASE_FALLBACKS]).toEqual(["origin/develop", "origin/main", "origin/master"]);
  });
});

describe("NO_BASE_HINT", () => {
  test("says what to run rather than only what failed", () => {
    expect(NO_BASE_HINT).toContain("git remote set-head origin -a");
  });
});
