import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { classifyRule } from "../src/sonar.js";
import { silenceLogs } from "./helpers/repo.js";

silenceLogs();

describe("classifyRule", () => {
  it("reports a bug-risk rule as an error", () => {
    assert.equal(classifyRule({ type: "problem" }), "error");
  });

  it("reports a stylistic rule as a warning", () => {
    assert.equal(classifyRule({ type: "suggestion" }), "warn");
  });

  it("separates the two, so the severity breakdown carries information", () => {
    assert.notEqual(
      classifyRule({ type: "problem" }),
      classifyRule({ type: "suggestion" }),
      "registering every rule at 'warn' made every issue 'moderate' and the distribution meaningless",
    );
  });

  it("drops deprecated rules rather than reporting what the user cannot act on", () => {
    assert.equal(classifyRule({ type: "problem", deprecated: true }), "off");
    assert.equal(
      classifyRule({ type: "suggestion", deprecated: { replacedBy: ["x"] } }),
      "off",
    );
  });

  it("falls back to a warning for unfamiliar metadata", () => {
    assert.equal(classifyRule(undefined), "warn");
    assert.equal(classifyRule({}), "warn");
    assert.equal(classifyRule({ type: "layout" }), "warn");
  });
});

describe("classifyRule against the real plugin", () => {
  it("produces both levels across the installed rule set", async () => {
    let plugin: { rules?: Record<string, { meta?: unknown }> };
    try {
      const mod = await import("eslint-plugin-sonarjs");
      plugin = (mod.default ?? mod) as typeof plugin;
    } catch {
      // eslint-plugin-sonarjs is an optionalDependency
      return;
    }

    const levels = Object.values(plugin.rules ?? {}).map((rule) =>
      classifyRule(rule.meta as Parameters<typeof classifyRule>[0]),
    );

    assert.ok(levels.includes("error"), "some SonarJS rules are bug-risk rules");
    assert.ok(levels.includes("warn"), "some SonarJS rules are stylistic");
    assert.ok(
      levels.includes("off"),
      "the plugin ships deprecated rules that should not be registered",
    );
  });
});
