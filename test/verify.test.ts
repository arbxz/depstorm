import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { onlyFailsWhereBaselineDid } from "../src/pipeline.js";
import { verifyCommands } from "../src/verify.js";
import type { BuildResult, ProjectInfo } from "../src/types.js";

const project = (packageManager: ProjectInfo["packageManager"]): ProjectInfo => ({
  name: "p",
  path: ".",
  packageManager,
  hasGit: false,
});

describe("verifyCommands", () => {
  const pkg = {
    scripts: { build: "vite build", lint: "oxlint", test: "vitest run" },
  };

  it("keeps the requested order and skips scripts the project lacks", () => {
    const labels = verifyCommands(project("pnpm"), pkg, [
      "build",
      "typecheck",
      "lint",
      "test",
    ]).map((c) => c.label);
    assert.deepEqual(labels, ["build", "lint", "test"]);
  });

  it("runs tests with CI=1 so runners do not watch", () => {
    const test = verifyCommands(project("pnpm"), pkg, ["test"])[0];
    assert.deepEqual(test.env, { CI: "1" });
    assert.deepEqual(test.args, ["run", "test"]);
  });

  it("switches off a jest watch the script asks for", () => {
    const watching = { scripts: { test: "jest --watchAll" } };
    assert.deepEqual(
      verifyCommands(project("pnpm"), watching, ["test"])[0].args,
      ["run", "test", "--watchAll=false"],
    );
    assert.deepEqual(
      verifyCommands(project("npm"), watching, ["test"])[0].args,
      ["run", "test", "--", "--watchAll=false"],
    );
  });
});

describe("onlyFailsWhereBaselineDid", () => {
  const failed = (...steps: string[]): BuildResult => ({
    success: false,
    skipped: false,
    output: "",
    failedSteps: steps,
  });

  it("excuses a step that was already failing", () => {
    assert.equal(onlyFailsWhereBaselineDid(failed("lint"), failed("lint")), true);
  });

  it("does not let a failing lint excuse a build the fix broke", () => {
    assert.equal(
      onlyFailsWhereBaselineDid(failed("lint", "build"), failed("lint")),
      false,
    );
  });

  it("keeps the old rule when a result names no steps", () => {
    const bare: BuildResult = { success: false, skipped: false, output: "" };
    assert.equal(onlyFailsWhereBaselineDid(bare, failed("build")), true);
  });
});
