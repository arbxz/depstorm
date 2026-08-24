import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { repoRelativeTouched } from "../src/pipeline.js";
import {
  cleanupTempDirs,
  projectInfo,
  silenceLogs,
  tempDir,
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
