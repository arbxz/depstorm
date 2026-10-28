import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  detectReleaseSystem,
  isTagTriggered,
  nextPatch,
  planRelease,
  readCargoPackage,
  releaseRepository,
  releaseTags,
  setCargoLockVersion,
  setCargoVersion,
  setJsonVersion,
} from "../src/release.js";
import {
  cleanupTempDirs,
  commitAll,
  createRepo,
  git,
  projectInfo,
  readFile,
  silenceLogs,
  tempDir,
  writeFile,
} from "./helpers/repo.js";

silenceLogs();
after(cleanupTempDirs);

const CARGO_TOML = `[package]
name = "gnom"
version = "0.1.1"
edition = "2021"

[dependencies]
serde = { version = "1", features = ["derive"] }
`;

const CARGO_LOCK = `[[package]]
name = "gimli"
version = "0.1.1"

[[package]]
name = "gnom"
version = "0.1.1"
dependencies = [
 "serde",
]
`;

const TAG_WORKFLOW = `name: Release
on:
  push:
    tags:
      - "v*"
  workflow_dispatch:
jobs:
  release:
    runs-on: windows-latest
`;

describe("version rewriting", () => {
  it("bumps the patch of a plain release only", () => {
    assert.equal(nextPatch("0.1.9"), "0.1.10");
    assert.equal(nextPatch("2.0.0-rc.1"), null);
  });

  it("rewrites the top-level JSON version and leaves nested ones alone", () => {
    const raw = `{\n  "name": "x",\n  "version": "0.1.1",\n  "engines": {\n    "version": "0.1.1"\n  }\n}\n`;
    const out = setJsonVersion(raw, "0.1.2");
    assert.equal(JSON.parse(out).version, "0.1.2");
    assert.equal(JSON.parse(out).engines.version, "0.1.1");
  });

  it("reads and rewrites the [package] version, not a dependency's", () => {
    assert.deepEqual(readCargoPackage(CARGO_TOML), { name: "gnom", version: "0.1.1" });
    const out = setCargoVersion(CARGO_TOML, "0.1.2");
    assert.match(out, /^version = "0.1.2"$/m);
    assert.match(out, /serde = \{ version = "1"/);
  });

  it("rewrites only the crate's own lockfile entry", () => {
    const out = setCargoLockVersion(CARGO_LOCK, "gnom", "0.1.2");
    assert.match(out, /name = "gnom"\nversion = "0.1.2"/);
    assert.match(out, /name = "gimli"\nversion = "0.1.1"/);
  });

  it("ignores a workspace-inherited Cargo version", () => {
    const raw = `[package]\nname = "a"\nversion.workspace = true\n`;
    assert.equal(readCargoPackage(raw), null);
  });
});

describe("release evidence", () => {
  it("recognises a workflow triggered by a pushed tag", () => {
    assert.equal(isTagTriggered(TAG_WORKFLOW), true);
    assert.equal(
      isTagTriggered("on:\n  push:\n    branches: [main]\njobs:\n  ci:\n    steps: []\n"),
      false,
    );
  });

  it("counts semver tags only, newest first", () => {
    assert.deepEqual(
      releaseTags(["step1", "v0.1.0", "v0.1.10", "v0.1.2", "nightly"]),
      ["v0.1.10", "v0.1.2", "v0.1.0"],
    );
  });

  it("finds no release system from a version field alone", async () => {
    const dir = createRepo({ files: { "package.json": '{"version":"1.0.0"}\n' } });
    assert.equal(await detectReleaseSystem(dir, ["step1", "step2"]), null);
  });

  it("refuses to pick one of several disagreeing versions", async () => {
    const dir = createRepo({
      files: {
        "package.json": '{\n  "version": "0.1.1"\n}\n',
        "src-tauri/tauri.conf.json": '{\n  "version": "0.1.0"\n}\n',
      },
    });
    await assert.rejects(detectReleaseSystem(dir, ["v0.1.1"]), /disagree/);
  });
});

/** A gnom-shaped app with an origin it has pushed v0.1.1 and one more commit to. */
function tauriApp(): { dir: string; origin: string } {
  const dir = createRepo({
    branch: "master",
    files: {
      "package.json": '{\n  "name": "gnom",\n  "version": "0.1.1"\n}\n',
      "src-tauri/tauri.conf.json": '{\n  "productName": "gnom",\n  "version": "0.1.1"\n}\n',
      "src-tauri/Cargo.toml": CARGO_TOML,
      "src-tauri/Cargo.lock": CARGO_LOCK,
      ".github/workflows/release.yml": TAG_WORKFLOW,
    },
  });
  git(dir, "tag", "v0.1.1");
  writeFile(dir, "src.js", "a fix\n");
  commitAll(dir, "Fix something");

  const origin = tempDir("depstorm-origin-");
  git(origin, "init", "-q", "--bare", ".");
  git(dir, "remote", "add", "origin", origin);
  git(dir, "push", "-q", "-u", "origin", "master", "--tags");
  return { dir, origin };
}

describe("releaseRepository", () => {
  it("bumps every version file, commits, tags and pushes both", async () => {
    const { dir, origin } = tauriApp();

    const outcome = await releaseRepository(projectInfo(dir), "master", "Notes.");

    assert.deepEqual(outcome, { version: "0.1.2", tag: "v0.1.2", publishedBy: "workflow" });
    assert.equal(JSON.parse(readFile(dir, "package.json")).version, "0.1.2");
    assert.equal(JSON.parse(readFile(dir, "src-tauri/tauri.conf.json")).version, "0.1.2");
    assert.match(readFile(dir, "src-tauri/Cargo.toml"), /^version = "0.1.2"$/m);
    assert.match(readFile(dir, "src-tauri/Cargo.lock"), /name = "gnom"\nversion = "0.1.2"/);
    assert.equal(git(dir, "log", "-1", "--format=%s"), "Release 0.1.2");
    assert.equal(git(origin, "rev-parse", "master"), git(dir, "rev-parse", "HEAD"));
    assert.equal(git(origin, "rev-parse", "v0.1.2^{commit}"), git(dir, "rev-parse", "HEAD"));
  });

  it("skips a repository with no origin to release to", async () => {
    const dir = createRepo({
      files: { "package.json": '{\n  "version": "1.0.0"\n}\n' },
    });
    git(dir, "tag", "v1.0.0");
    writeFile(dir, "src.js", "x\n");
    commitAll(dir, "More");

    const plan = await planRelease(projectInfo(dir), "main");
    assert.deepEqual(plan, { skip: "no origin remote to release to" });
  });

  it("releases with depstorm's own backup files still in the tree", async () => {
    const { dir } = tauriApp();
    // Where a fix earlier in the same run leaves them until it unwinds
    writeFile(dir, "package.json.depstorm-backup", "{}\n");

    const outcome = await releaseRepository(projectInfo(dir), "master", "Notes.");

    assert.equal(outcome?.tag, "v0.1.2");
    assert.equal(
      git(dir, "show", "--name-only", "--format=", "HEAD").includes("depstorm-backup"),
      false,
    );
  });

  it("does nothing when the last tag is already the head", async () => {
    const { dir } = tauriApp();
    await releaseRepository(projectInfo(dir), "master", "Notes.");
    const head = git(dir, "rev-parse", "HEAD");

    assert.equal(await releaseRepository(projectInfo(dir), "master", "Notes."), null);
    assert.equal(git(dir, "rev-parse", "HEAD"), head);
  });

  it("will not release commits origin does not have", async () => {
    const { dir } = tauriApp();
    writeFile(dir, "src.js", "unpushed\n");
    commitAll(dir, "Local only");
    const head = git(dir, "rev-parse", "HEAD");

    assert.equal(await releaseRepository(projectInfo(dir), "master", "Notes."), null);
    assert.equal(git(dir, "rev-parse", "HEAD"), head);
    assert.equal(git(dir, "tag", "--list", "v0.1.2"), "");
  });

  it("removes its commit and tag when the push is rejected", async () => {
    const { dir, origin } = tauriApp();
    // A hook that rejects every push stands in for a protected branch.
    writeFile(origin, "hooks/pre-receive", "#!/bin/sh\nexit 1\n");
    fs.chmodSync(path.join(origin, "hooks", "pre-receive"), 0o755);
    const head = git(dir, "rev-parse", "HEAD");

    const outcome = await releaseRepository(projectInfo(dir), "master", "Notes.");

    assert.equal(outcome, null);
    assert.equal(git(dir, "rev-parse", "HEAD"), head);
    assert.equal(git(dir, "tag", "--list", "v0.1.2"), "");
    assert.equal(git(dir, "status", "--porcelain"), "");
  });
});
