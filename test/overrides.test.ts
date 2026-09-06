import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  boundOverrideValue,
  boundOverrides,
  detectIndent,
  findDuplicateOverrides,
  majorCeiling,
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

describe("boundOverrideValue", () => {
  it("caps the open-ended minimum pnpm audit --fix writes", () => {
    assert.equal(
      boundOverrideValue(">=7.3.5"),
      ">=7.3.5 <8.0.0",
      "an unbounded >= let pnpm satisfy a vite 7 advisory with vite 8",
    );
  });

  it("caps a 0.x range at the next minor, where its breaking changes land", () => {
    assert.equal(boundOverrideValue(">=0.25.0"), ">=0.25.0 <0.26.0");
  });

  it("leaves a value that already has a ceiling alone", () => {
    assert.equal(boundOverrideValue(">=1.2.3 <2.0.0"), ">=1.2.3 <2.0.0");
  });

  it("leaves ranges that carry their own ceiling alone", () => {
    assert.equal(boundOverrideValue("^1.2.3"), "^1.2.3");
    assert.equal(boundOverrideValue("~1.2.3"), "~1.2.3");
    assert.equal(boundOverrideValue("1.2.3"), "1.2.3");
  });

  it("refuses to touch a disjunction, where one ceiling would be wrong", () => {
    assert.equal(boundOverrideValue(">=1.2.3 || >=2.0.0"), ">=1.2.3 || >=2.0.0");
  });

  it("leaves a value with no readable version alone", () => {
    assert.equal(boundOverrideValue(">=latest"), ">=latest");
  });
});

describe("boundOverrides", () => {
  it("bounds only what needs it and reports each change", () => {
    const { bounded, changed } = boundOverrides({
      "vite@>=7.0.0 <=7.3.4": ">=7.3.5",
      "postcss@<=8.5.22": ">=8.5.23 <9.0.0",
      "nanoid@<3.3.18": ">=3.3.18",
    });

    assert.equal(bounded["vite@>=7.0.0 <=7.3.4"], ">=7.3.5 <8.0.0");
    assert.equal(bounded["nanoid@<3.3.18"], ">=3.3.18 <4.0.0");
    assert.equal(
      bounded["postcss@<=8.5.22"],
      ">=8.5.23 <9.0.0",
      "already bounded, so left exactly as it was",
    );
    assert.equal(changed.length, 2);
  });

  it("passes non-string values through untouched", () => {
    const { bounded, changed } = boundOverrides({ weird: 42 });
    assert.equal(bounded.weird, 42);
    assert.equal(changed.length, 0);
  });
});

describe("majorCeiling", () => {
  it("returns the next major for a 1.x-and-up version", () => {
    assert.equal(majorCeiling("7.3.5"), "8.0.0");
  });

  it("returns the next minor below 1.0.0", () => {
    assert.equal(majorCeiling("0.25.0"), "0.26.0");
  });

  it("returns null for something that is not a version", () => {
    assert.equal(majorCeiling("latest"), null);
  });
});

describe("detectIndent", () => {
  it("recognises tabs so a rewrite does not reformat the manifest", () => {
    assert.equal(detectIndent('{\n\t"name": "x"\n}\n'), "\t");
  });

  it("recognises a space width", () => {
    assert.equal(detectIndent('{\n    "name": "x"\n}\n'), 4);
  });

  it("falls back to two spaces when there is nothing to read", () => {
    assert.equal(detectIndent("{}"), 2);
  });
});
