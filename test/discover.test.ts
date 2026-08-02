import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import {
  discoverProjects,
  resolveExplicitProjects,
} from "../src/discover.js";
import {
  cleanupTempDirs,
  silenceLogs,
  tempDir,
  testConfig,
  writeFile,
  writeJson,
} from "./helpers/repo.js";

silenceLogs();
after(cleanupTempDirs);

const names = (projects: { name: string }[]) => projects.map((p) => p.name).sort();

describe("discoverProjects", () => {
  it("finds a project at the root itself", async () => {
    const root = tempDir();
    writeJson(root, "package.json", { name: "solo" });

    const found = await discoverProjects([root], testConfig({ scanDepth: 0 }));

    assert.deepEqual(names(found), ["solo"]);
  });

  it("stops descending into a leaf project", async () => {
    const root = tempDir();
    writeJson(root, "app/package.json", { name: "app" });
    writeJson(root, "app/vendored/package.json", { name: "vendored" });

    const found = await discoverProjects([root], testConfig({ scanDepth: 5 }));

    assert.deepEqual(
      names(found),
      ["app"],
      "a project's own subdirectories are its source, not separate projects",
    );
  });

  it("descends into an npm/yarn workspace root and finds its members", async () => {
    const root = tempDir();
    writeJson(root, "repo/package.json", {
      name: "monorepo",
      workspaces: ["packages/*"],
    });
    writeJson(root, "repo/packages/app/package.json", { name: "@w/app" });
    writeJson(root, "repo/packages/lib/package.json", { name: "@w/lib" });

    const found = await discoverProjects([root], testConfig({ scanDepth: 5 }));

    assert.deepEqual(names(found), ["@w/app", "@w/lib", "monorepo"]);
  });

  it("descends into a pnpm workspace root", async () => {
    const root = tempDir();
    writeJson(root, "repo/package.json", { name: "pnpm-root" });
    writeFile(root, "repo/pnpm-workspace.yaml", "packages:\n  - packages/*\n");
    writeJson(root, "repo/packages/one/package.json", { name: "one" });

    const found = await discoverProjects([root], testConfig({ scanDepth: 5 }));

    assert.deepEqual(names(found), ["one", "pnpm-root"]);
  });

  it("treats scanDepth as levels below the root", async () => {
    const root = tempDir();
    writeJson(root, "a/package.json", { name: "one-deep" });
    writeJson(root, "b/c/package.json", { name: "two-deep" });
    writeJson(root, "d/e/f/package.json", { name: "three-deep" });

    assert.deepEqual(
      names(await discoverProjects([root], testConfig({ scanDepth: 1 }))),
      ["one-deep"],
    );
    assert.deepEqual(
      names(await discoverProjects([root], testConfig({ scanDepth: 2 }))),
      ["one-deep", "two-deep"],
    );
    assert.deepEqual(
      names(await discoverProjects([root], testConfig({ scanDepth: 3 }))),
      ["one-deep", "three-deep", "two-deep"],
    );
  });

  it("honours excludeDirs and skips dot directories", async () => {
    const root = tempDir();
    writeJson(root, "keep/package.json", { name: "keep" });
    writeJson(root, "node_modules/dep/package.json", { name: "dep" });
    writeJson(root, ".hidden/package.json", { name: "hidden" });
    writeJson(root, "custom/package.json", { name: "custom" });

    const found = await discoverProjects(
      [root],
      testConfig({ scanDepth: 3, excludeDirs: ["node_modules", "custom"] }),
    );

    assert.deepEqual(names(found), ["keep"]);
  });

  it("does not report the same project twice for overlapping roots", async () => {
    const root = tempDir();
    writeJson(root, "app/package.json", { name: "app" });

    const found = await discoverProjects(
      [root, path.join(root, "app")],
      testConfig({ scanDepth: 3 }),
    );

    assert.deepEqual(names(found), ["app"]);
  });

  it("ignores a malformed package.json without crashing", async () => {
    const root = tempDir();
    writeFile(root, "broken/package.json", "{ not json");
    writeJson(root, "fine/package.json", { name: "fine" });

    const found = await discoverProjects([root], testConfig({ scanDepth: 3 }));

    assert.deepEqual(names(found), ["fine"]);
  });

  it("skips a missing root instead of throwing", async () => {
    const root = tempDir();
    writeJson(root, "app/package.json", { name: "app" });

    const found = await discoverProjects(
      [path.join(root, "does-not-exist"), root],
      testConfig({ scanDepth: 3 }),
    );

    assert.deepEqual(names(found), ["app"]);
  });

  it("falls back to the directory name when package.json has no name", async () => {
    const root = tempDir();
    writeJson(root, "unnamed/package.json", { version: "1.0.0" });

    const found = await discoverProjects([root], testConfig({ scanDepth: 2 }));

    assert.deepEqual(names(found), ["unnamed"]);
  });
});

describe("package manager detection", () => {
  const cases: Array<[string, string]> = [
    ["pnpm-lock.yaml", "pnpm"],
    ["yarn.lock", "yarn"],
    ["package-lock.json", "npm"],
  ];

  for (const [lockfile, expected] of cases) {
    it(`detects ${expected} from ${lockfile}`, async () => {
      const root = tempDir();
      writeJson(root, "app/package.json", { name: "app" });
      writeFile(root, `app/${lockfile}`, "\n");

      const [project] = await discoverProjects([root], testConfig({ scanDepth: 2 }));

      assert.equal(project?.packageManager, expected);
    });
  }

  it("defaults to npm when there is no lockfile", async () => {
    const root = tempDir();
    writeJson(root, "app/package.json", { name: "app" });

    const [project] = await discoverProjects([root], testConfig({ scanDepth: 2 }));

    assert.equal(project?.packageManager, "npm");
  });
});

describe("resolveExplicitProjects", () => {
  it("resolves listed paths and skips ones without a package.json", async () => {
    const root = tempDir();
    writeJson(root, "good/package.json", { name: "good" });

    const found = await resolveExplicitProjects([
      path.join(root, "good"),
      path.join(root, "missing"),
    ]);

    assert.deepEqual(names(found), ["good"]);
  });

  it("skips an unreadable package.json", async () => {
    const root = tempDir();
    writeFile(root, "broken/package.json", "{{{");

    const found = await resolveExplicitProjects([path.join(root, "broken")]);

    assert.deepEqual(found, []);
  });
});
