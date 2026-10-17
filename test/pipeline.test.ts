import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mergeTarget, repoRelativeTouched } from "../src/pipeline.js";
import {
  cleanupTempDirs,
  projectInfo,
  silenceLogs,
  tempDir,
  testConfig,
  writeJson,
} from "./helpers/repo.js";

silenceLogs();
after(cleanupTempDirs);

describe("repoRelativeTouched", () => {
  it("returns bare filenames when the project is the repository root", async () => {
    const dir = tempDir();
    writeJson(dir, "package.json", { name: "root" });
    writeJson(dir, "package-lock.json", { lockfileVersion: 3 });

    assert.deepEqual(await repoRelativeTouched(projectInfo(dir), dir), [
      "package.json",
      "package-lock.json",
    ]);
  });

  it("prefixes the subdirectory when the project is nested", async () => {
    const repo = tempDir();
    const project = path.join(repo, "packages", "api");
    writeJson(project, "package.json", { name: "api" });
    writeJson(project, "package-lock.json", { lockfileVersion: 3 });

    const paths = await repoRelativeTouched(projectInfo(project), repo);

    assert.deepEqual(
      paths,
      ["packages/api/package.json", "packages/api/package-lock.json"],
      "staging happens from the repository root, so a bare filename would resolve to the wrong file",
    );
  });

  it("uses forward slashes, which git wants on every platform", async () => {
    const repo = tempDir();
    const project = path.join(repo, "a", "b");
    writeJson(project, "package.json", { name: "deep" });

    const paths = await repoRelativeTouched(projectInfo(project), repo);

    assert.deepEqual(paths, ["a/b/package.json"]);
    assert.ok(
      !paths.some((p) => p.includes("\\")),
      "path.relative yields backslashes on Windows",
    );
  });

  it("lists only files that exist", async () => {
    const repo = tempDir();
    writeJson(repo, "package.json", { name: "no-lockfile" });

    assert.deepEqual(await repoRelativeTouched(projectInfo(repo), repo), [
      "package.json",
    ]);
  });
});

describe("mergeTarget", () => {
  const projects = [projectInfo("/repos/app")];

  it("merges back into the branch the run started on when sourceBranch is \"current\"", () => {
    const config = testConfig({ sourceBranch: "current" });
    assert.equal(mergeTarget(projects, config, "feature/notes"), "feature/notes");
  });

  it("never hands the \"current\" sentinel to git as a branch name", () => {
    const config = testConfig({ sourceBranch: " Current " });
    assert.equal(mergeTarget(projects, config, undefined), undefined);
  });

  it("uses a named source branch as given", () => {
    const config = testConfig({ sourceBranch: "main" });
    assert.equal(mergeTarget(projects, config, "feature/notes"), "main");
  });

  it("prefers a per-project branch override", () => {
    const config = testConfig({
      sourceBranch: "current",
      projectBranches: { app: "develop" },
    });
    assert.equal(mergeTarget(projects, config, "feature/notes"), "develop");
  });
});
