import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  findDuplicateOverrides,
  overridePackageName,
  readOverrides,
} from "../src/overrides.js";
import { silenceLogs } from "./helpers/repo.js";

silenceLogs();

describe("overridePackageName", () => {
  it("splits a plain name from its range", () => {
    assert.equal(overridePackageName("brace-expansion@>=4.0.0 <5.0.9"), "brace-expansion");
  });

  it("keeps a bare name intact", () => {
    assert.equal(overridePackageName("lodash"), "lodash");
  });

  it("does not split a scope at its leading @", () => {
    assert.equal(
      overridePackageName("@babel/traverse@<7.23.2"),
      "@babel/traverse",
      "a leading @ is a scope, not a separator",
    );
    assert.equal(overridePackageName("@types/node"), "@types/node");
  });
});

describe("findDuplicateOverrides", () => {
  it("finds the stacked-up entries pnpm audit --fix leaves behind", () => {
    const duplicates = findDuplicateOverrides({
      "brace-expansion@>=5.0.0 <5.0.6": ">=5.0.6",
      "brace-expansion@>=3.0.0 <5.0.7": ">=5.0.7",
      "brace-expansion@>=4.0.0 <5.0.8": ">=5.0.8",
      "js-yaml@>=4.0.0 <4.3.0": ">=4.3.0",
      "simple-git@<3.36.0": ">=3.36.0",
    });

    assert.deepEqual(
      duplicates.map((d) => d.package).sort(),
      ["brace-expansion"],
    );
    assert.equal(duplicates[0]?.keys.length, 3);
  });

  it("reports nothing when every package appears once", () => {
    assert.deepEqual(
      findDuplicateOverrides({ "lodash@<4": ">=4", "minimist@<1.2.6": ">=1.2.6" }),
      [],
    );
  });

  it("handles an absent override block", () => {
    assert.deepEqual(findDuplicateOverrides(undefined), []);
    assert.deepEqual(findDuplicateOverrides({}), []);
  });
});

describe("readOverrides", () => {
  it("reads the pnpm block", () => {
    assert.deepEqual(readOverrides({ pnpm: { overrides: { a: "1" } } }), { a: "1" });
  });

  it("reads the npm block", () => {
    assert.deepEqual(readOverrides({ overrides: { a: "1" } }), { a: "1" });
  });

  it("reads yarn resolutions", () => {
    assert.deepEqual(readOverrides({ resolutions: { a: "1" } }), { a: "1" });
  });

  it("returns nothing when the manifest declares none", () => {
    assert.equal(readOverrides({ name: "x" }), undefined);
    assert.equal(readOverrides({ overrides: [] }), undefined);
  });
});
