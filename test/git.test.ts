import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  commitFixes,
  createFixBranch,
  ensureCleanTree,
  getCurrentBranch,
  getSourceBranch,
  hasBranch,
  mergeBranch,
  redactGitError,
  restoreStash,
  revertTouchedFiles,
  switchBack,
} from "../src/git.js";
import {
  cleanupTempDirs,
  commitAll,
  createRepo,
  currentBranch,
  fileExists,
  git,
  isDirty,
  localBranches,
  projectInfo,
  readFile,
  silenceLogs,
  captureLogs,
  stashCount,
  testConfig,
  writeFile,
} from "./helpers/repo.js";

silenceLogs();
after(cleanupTempDirs);

const LOCK_FILES = ["package.json", "package-lock.json"];

describe("ensureCleanTree", () => {
  it("passes through a clean tree without creating a stash", async () => {
    const dir = createRepo();
    const result = await ensureCleanTree(projectInfo(dir), testConfig());

    assert.equal(result.ok, true);
    assert.equal(result.stash, undefined);
    assert.equal(stashCount(dir), 0);
  });

  it("leaves a pre-existing stash alone when the tree is clean", async () => {
    const dir = createRepo();
    writeFile(dir, "src.js", "user work\n");
    git(dir, "stash", "push", "-m", "user-stash");

    const result = await ensureCleanTree(projectInfo(dir), testConfig());

    assert.equal(result.stash, undefined);
    assert.equal(stashCount(dir), 1);
    assert.match(git(dir, "stash", "list"), /user-stash/);
  });

  it("skips a dirty project instead of stashing when unattended", async () => {
    const dir = createRepo();
    writeFile(dir, "src.js", "work in progress\n");

    const result = await ensureCleanTree(
      projectInfo(dir),
      testConfig({ autoStash: false }),
    );

    assert.equal(result.ok, false, "must not proceed with a dirty tree");
    assert.equal(result.stash, undefined);
    assert.equal(stashCount(dir), 0, "must not stash without consent");
    assert.equal(
      readFile(dir, "src.js").trim(),
      "work in progress",
      "work in progress must be left untouched",
    );
  });

  it("stashes when autoStash is enabled and reports a handle", async () => {
    const dir = createRepo();
    writeFile(dir, "src.js", "work in progress\n");

    const result = await ensureCleanTree(
      projectInfo(dir),
      testConfig({ autoStash: true }),
    );

    assert.equal(result.ok, true);
    assert.ok(result.stash?.sha, "a stash handle must be returned");
    assert.equal(isDirty(dir), false);
    assert.equal(stashCount(dir), 1);
  });

  it("does not stash during a dry run", async () => {
    const dir = createRepo();
    writeFile(dir, "src.js", "work in progress\n");

    const result = await ensureCleanTree(
      projectInfo(dir),
      testConfig({ autoStash: true, dryRun: true }),
    );

    assert.equal(result.ok, false);
    assert.equal(stashCount(dir), 0);
  });
});

describe("restoreStash", () => {
  it("pops its own stash by identity, not by position", async () => {
    const dir = createRepo();
    const project = projectInfo(dir);

    // A stash the user made earlier
    writeFile(dir, "src.js", "USER-A\n");
    git(dir, "stash", "push", "-m", "user-stash-A");

    // depstorm's stash
    writeFile(dir, "src.js", "DEPSTORM-B\n");
    const { stash } = await ensureCleanTree(
      project,
      testConfig({ autoStash: true }),
    );
    assert.ok(stash);

    // Another user stash lands on top afterwards
    writeFile(dir, "src.js", "USER-C\n");
    git(dir, "stash", "push", "-m", "user-stash-C");

    assert.equal(stashCount(dir), 3);
    assert.match(
      git(dir, "stash", "list").split("\n")[0] ?? "",
      /user-stash-C/,
      "depstorm's stash must not be on top for this test to be meaningful",
    );

    await restoreStash(project, stash);

    assert.equal(
      readFile(dir, "src.js").trim(),
      "DEPSTORM-B",
      "popping by position would have restored USER-C",
    );

    const remaining = git(dir, "stash", "list");
    assert.match(remaining, /user-stash-A/, "user stash A must survive");
    assert.match(remaining, /user-stash-C/, "user stash C must survive");
    assert.equal(stashCount(dir), 2);
  });

  it("leaves the stash list untouched when its own stash is gone", async () => {
    const dir = createRepo();
    const project = projectInfo(dir);

    writeFile(dir, "src.js", "DEPSTORM\n");
    const { stash } = await ensureCleanTree(
      project,
      testConfig({ autoStash: true }),
    );
    assert.ok(stash);

    // Someone else drops it, then makes an unrelated stash
    git(dir, "stash", "drop", "stash@{0}");
    writeFile(dir, "src.js", "UNRELATED\n");
    git(dir, "stash", "push", "-m", "unrelated");

    await restoreStash(project, stash);

    assert.equal(stashCount(dir), 1, "the unrelated stash must not be popped");
    assert.match(git(dir, "stash", "list"), /unrelated/);
  });
});

describe("createFixBranch", () => {
  it("creates a dated branch and checks it out", async () => {
    const dir = createRepo();
    const project = projectInfo(dir);

    const branch = await createFixBranch(project);

    assert.ok(branch);
    assert.match(branch, /^audit-fix\/\d{4}-\d{2}-\d{2}$/);
    assert.equal(currentBranch(dir), branch);
  });

  it("never reuses an existing branch on a second run the same day", async () => {
    const dir = createRepo();
    const project = projectInfo(dir);

    const first = await createFixBranch(project);
    assert.ok(first);
    await switchBack(project, "main");

    const second = await createFixBranch(project);

    assert.ok(second);
    assert.notEqual(second, first, "a second run must get its own branch");
    assert.equal(localBranches(dir).filter((b) => b.startsWith("audit-fix/")).length, 2);
  });
});

describe("commitFixes", () => {
  it("stages only the manifest and lockfile", async () => {
    const dir = createRepo();
    const project = projectInfo(dir);

    writeFile(dir, "package-lock.json", '{"lockfileVersion":3,"fixed":true}\n');
    writeFile(dir, "src.js", "UNRELATED WORK\n");
    writeFile(dir, "notes.txt", "untracked\n");

    const committed = await commitFixes(project, LOCK_FILES, 2, true);
    assert.equal(committed, true);

    const changed = git(dir, "show", "--name-only", "--format=", "HEAD")
      .split("\n")
      .filter(Boolean);

    assert.deepEqual(changed, ["package-lock.json"]);
    assert.equal(
      readFile(dir, "src.js").trim(),
      "UNRELATED WORK",
      "unrelated work must remain uncommitted in the working tree",
    );
    assert.equal(fileExists(dir, "notes.txt"), true);
  });

  it("records that a count was unverified", async () => {
    const dir = createRepo();
    writeFile(dir, "package-lock.json", '{"v":2}\n');

    await commitFixes(projectInfo(dir), LOCK_FILES, 1, false);

    assert.match(git(dir, "log", "-1", "--format=%s"), /unverified/);
  });

  it("reports nothing to commit when the files are unchanged", async () => {
    const dir = createRepo();
    const committed = await commitFixes(projectInfo(dir), LOCK_FILES, 0, true);
    assert.equal(committed, false);
  });
});

describe("revertTouchedFiles", () => {
  it("restores only the given paths and destroys nothing else", async () => {
    const dir = createRepo();
    const project = projectInfo(dir);
    const originalLock = readFile(dir, "package-lock.json");

    writeFile(dir, "package-lock.json", '{"lockfileVersion":3,"broken":true}\n');
    writeFile(dir, "src.js", "UNRELATED EDIT\n");
    writeFile(dir, "untracked.txt", "precious\n");
    writeFile(dir, "scratch/notes.md", "notes\n");

    await revertTouchedFiles(project, LOCK_FILES);

    assert.equal(readFile(dir, "package-lock.json"), originalLock);
    assert.equal(
      readFile(dir, "src.js").trim(),
      "UNRELATED EDIT",
      "`git checkout -- .` would have discarded this",
    );
    assert.equal(
      fileExists(dir, "untracked.txt"),
      true,
      "`git clean -fd` would have deleted this",
    );
    assert.equal(
      fileExists(dir, "scratch/notes.md"),
      true,
      "`git clean -fd` would have deleted this directory",
    );
  });

  it("is a no-op for an empty path list", async () => {
    const dir = createRepo();
    writeFile(dir, "src.js", "EDITED\n");

    await revertTouchedFiles(projectInfo(dir), []);

    assert.equal(readFile(dir, "src.js").trim(), "EDITED");
  });
});

describe("mergeBranch", () => {
  async function repoWithFixBranch() {
    const dir = createRepo();
    const project = projectInfo(dir);
    const target = currentBranch(dir);

    git(dir, "checkout", "-qb", "audit-fix/test");
    writeFile(dir, "package-lock.json", '{"lockfileVersion":3,"fixed":true}\n');
    commitAll(dir, "fix");
    git(dir, "checkout", "-q", target);

    return { dir, project, target };
  }

  it("merges locally and does not push when push is false", async () => {
    const { dir, project, target } = await repoWithFixBranch();

    const merged = await mergeBranch(project, "audit-fix/test", target, {
      push: false,
    });

    assert.equal(merged, true);
    assert.match(readFile(dir, "package-lock.json"), /"fixed":true/);
    assert.equal(git(dir, "remote"), "", "no remote — nothing could be pushed");
  });

  it("keeps the fix branch when a requested push fails", async () => {
    const { dir, project, target } = await repoWithFixBranch();

    // No remote configured, so the push cannot succeed
    const merged = await mergeBranch(project, "audit-fix/test", target, {
      push: true,
      deleteBranch: true,
    });

    assert.equal(merged, true, "the local merge still succeeded");
    assert.equal(
      await hasBranch(project, "audit-fix/test"),
      true,
      "the branch must survive so the work is not stranded",
    );
  });

  it("refuses to merge a branch into itself", async () => {
    const dir = createRepo();
    const target = currentBranch(dir);

    const merged = await mergeBranch(projectInfo(dir), target, target, {
      push: false,
    });

    assert.equal(merged, false);
  });

  it("aborts and reports failure on a conflict", async () => {
    const dir = createRepo();
    const project = projectInfo(dir);
    const target = currentBranch(dir);

    git(dir, "checkout", "-qb", "audit-fix/conflict");
    writeFile(dir, "src.js", "branch version\n");
    commitAll(dir, "branch change");

    git(dir, "checkout", "-q", target);
    writeFile(dir, "src.js", "target version\n");
    commitAll(dir, "target change");

    const merged = await mergeBranch(project, "audit-fix/conflict", target, {
      push: false,
    });

    assert.equal(merged, false);
    assert.equal(
      git(dir, "status", "--porcelain").includes("UU"),
      false,
      "the conflicted merge must be aborted, not left in progress",
    );
    assert.equal(readFile(dir, "src.js").trim(), "target version");
  });
});

describe("switchBack", () => {
  it("returns to the original branch", async () => {
    const dir = createRepo();
    const project = projectInfo(dir);
    const original = currentBranch(dir);

    await createFixBranch(project);
    assert.notEqual(currentBranch(dir), original);

    await switchBack(project, original);

    assert.equal(currentBranch(dir), original);
  });

  it("is a no-op when already on the branch", async () => {
    const dir = createRepo();
    const original = currentBranch(dir);

    await switchBack(projectInfo(dir), original);

    assert.equal(currentBranch(dir), original);
  });
});

describe("getCurrentBranch / hasBranch", () => {
  it("reports the checked-out branch", async () => {
    const dir = createRepo({ branch: "main" });
    assert.equal(await getCurrentBranch(projectInfo(dir)), "main");
  });

  it("detects branch presence", async () => {
    const dir = createRepo({ branch: "main" });
    const project = projectInfo(dir);

    assert.equal(await hasBranch(project, "main"), true);
    assert.equal(await hasBranch(project, "nope"), false);
  });
});

describe("getSourceBranch", () => {
  it("prefers a per-project override over the global setting", () => {
    const project = projectInfo("/tmp/x", { name: "web" });
    const config = testConfig({
      sourceBranch: "main",
      projectBranches: { web: "develop" },
    });

    assert.equal(getSourceBranch(project, config), "develop");
  });

  it("falls back to the global source branch", () => {
    const project = projectInfo("/tmp/x", { name: "api" });
    const config = testConfig({
      sourceBranch: "main",
      projectBranches: { web: "develop" },
    });

    assert.equal(getSourceBranch(project, config), "main");
  });

  it("is undefined when nothing is configured", () => {
    assert.equal(getSourceBranch(projectInfo("/tmp/x"), testConfig()), undefined);
  });
});

describe("redactGitError", () => {
  it("removes credentials embedded in a remote URL", () => {
    const err = new Error(
      "fatal: unable to access 'https://alice:s3cr3t-token@github.com/o/r.git/'",
    );
    const clean = redactGitError(err);

    assert.ok(!clean.includes("s3cr3t-token"));
    assert.ok(!clean.includes("alice:s3cr3t"));
    assert.match(clean, /\*\*\*/);
  });

  it("removes bare provider tokens", () => {
    const clean = redactGitError(
      "remote: rejected token ghp_AbCdEfGhIjKlMnOpQrStUvWxYz0123 and glpat-XYZ1234567890abc",
    );

    assert.ok(!clean.includes("ghp_AbCdEfGhIjKlMnOpQrStUvWxYz0123"));
    assert.ok(!clean.includes("glpat-XYZ1234567890abc"));
  });

  it("leaves ordinary messages intact", () => {
    assert.equal(redactGitError("merge conflict in src.js"), "merge conflict in src.js");
  });
});

describe("depstorm's own backup files", () => {
  it("does not report an error on a tree dirtied only by depstorm's backups", async () => {
    const dir = createRepo();

    // What backupProjectFiles leaves behind while a fix is in flight
    writeFile(dir, "package.json.depstorm-backup", '{"name":"fixture"}\n');
    writeFile(dir, "package-lock.json.depstorm-backup", '{"v":3}\n');

    const capture = captureLogs();
    let result;
    try {
      result = await ensureCleanTree(
        projectInfo(dir),
        testConfig({ autoStash: true }),
      );
    } finally {
      capture.restore();
    }

    assert.equal(result.ok, true);
    assert.equal(result.stash, undefined);
    assert.equal(stashCount(dir), 0);
    assert.deepEqual(
      capture.errors(),
      [],
      "a repo dirty only with depstorm's own artifacts must not raise an error",
    );
  });

  it("still stashes real work when backups sit alongside it", async () => {
    const dir = createRepo();
    writeFile(dir, "src.js", "real user work\n");
    writeFile(dir, "package.json.depstorm-backup", '{"name":"fixture"}\n');

    const result = await ensureCleanTree(
      projectInfo(dir),
      testConfig({ autoStash: true }),
    );

    assert.equal(result.ok, true);
    assert.ok(result.stash, "genuine changes must still be stashed");
    assert.equal(stashCount(dir), 1);
    assert.equal(readFile(dir, "src.js").trim(), "original");
  });

  it("does not report an error when only untracked files differ", async () => {
    const dir = createRepo();
    writeFile(dir, "brand-new.txt", "untracked\n");

    // `git stash push` (no -u) creates nothing here. The old code then asked
    // for stash@{0} and surfaced a fatal error on an otherwise fine repo.
    const capture = captureLogs();
    let result;
    try {
      result = await ensureCleanTree(
        projectInfo(dir),
        testConfig({ autoStash: true }),
      );
    } finally {
      capture.restore();
    }

    assert.equal(result.stash, undefined, "no entry was created, so no handle");
    assert.equal(stashCount(dir), 0);
    assert.equal(fileExists(dir, "brand-new.txt"), true);
    assert.deepEqual(
      capture.errors(),
      [],
      "an untracked-only tree is not a stash failure",
    );
  });
});

describe("restoreStash conflict detection", () => {
  it("reports a conflicted pop as a failure, not a success", async () => {
    const dir = createRepo();
    const project = projectInfo(dir);

    // User work that depstorm stashes away
    writeFile(dir, "src.js", "USER EDIT\n");
    const { stash } = await ensureCleanTree(
      project,
      testConfig({ autoStash: true }),
    );
    assert.ok(stash);

    // A commit touching the same lines — exactly what a dependency fix does
    writeFile(dir, "src.js", "COMMITTED FIX\n");
    commitAll(dir, "fix(deps): conflicting change");

    const result = await restoreStash(project, stash);

    assert.equal(
      result.ok,
      false,
      "a pop that leaves conflict markers must not be reported as restored",
    );
    assert.equal(result.ok === false && result.reason, "conflict");
    assert.deepEqual(
      result.ok === false && result.reason === "conflict"
        ? result.conflicts
        : [],
      ["src.js"],
    );
    assert.match(readFile(dir, "src.js"), /<<<<<<</);
    assert.equal(
      stashCount(dir),
      1,
      "a conflicted pop keeps the stash so the work is recoverable",
    );
  });

  it("reports a clean pop as success", async () => {
    const dir = createRepo();
    const project = projectInfo(dir);

    writeFile(dir, "src.js", "USER EDIT\n");
    const { stash } = await ensureCleanTree(
      project,
      testConfig({ autoStash: true }),
    );
    assert.ok(stash);

    const result = await restoreStash(project, stash);

    assert.equal(result.ok, true);
    assert.equal(readFile(dir, "src.js").trim(), "USER EDIT");
    assert.equal(stashCount(dir), 0);
  });
});

describe("commitFixes from a repository root", () => {
  it("stages a nested project's files without sweeping up the rest", async () => {
    const repo = createRepo({
      files: {
        "README.md": "root\n",
        "api/package.json": '{"name":"api"}\n',
        "api/package-lock.json": '{"lockfileVersion":3}\n',
        "web/package.json": '{"name":"web"}\n',
      },
    });

    // A dependency fix in one nested project, plus unrelated work elsewhere
    writeFile(repo, "api/package-lock.json", '{"lockfileVersion":3,"fixed":1}\n');
    writeFile(repo, "web/package.json", '{"name":"web","touched":true}\n');
    writeFile(repo, "README.md", "edited by the user\n");

    const committed = await commitFixes(
      projectInfo(repo),
      ["api/package.json", "api/package-lock.json"],
      1,
      true,
    );

    assert.equal(committed, true);

    const changed = git(repo, "show", "--name-only", "--format=", "HEAD")
      .split("\n")
      .map((f) => f.trim())
      .filter(Boolean);

    assert.deepEqual(
      changed,
      ["api/package-lock.json"],
      "only the nested project's changed lockfile belongs in the commit",
    );
    assert.match(
      git(repo, "status", "--porcelain"),
      /web\/package\.json/,
      "unrelated work in another project must stay uncommitted",
    );
    assert.match(git(repo, "status", "--porcelain"), /README\.md/);
  });

  it("stages nothing when a bare filename is used from the repository root", async () => {
    const repo = createRepo({
      files: {
        "root.txt": "x\n",
        "api/package.json": '{"name":"api"}\n',
      },
    });

    writeFile(repo, "api/package.json", '{"name":"api","fixed":true}\n');

    // The pre-grouping bug: listTouchedFiles returns project-relative names,
    // and "package.json" does not exist at the repository root.
    const committed = await commitFixes(projectInfo(repo), ["package.json"], 1, true);

    assert.equal(
      committed,
      false,
      "a bare filename must not silently commit nothing — repoRelativeTouched exists for this",
    );
  });
});
