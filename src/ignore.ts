import {
  emptySeverityMap,
  type AuditResult,
  type IgnoreRule,
  type Vulnerability,
} from "./types.js";

/**
 * Suppression of known-but-accepted advisories.
 *
 * Without this, `--fail-on high` survives exactly until the first advisory a
 * team has consciously decided to live with — a dev-only transitive, or one
 * with no patch yet — after which the gate is either red forever or turned
 * off. Both outcomes are worse than recording the decision.
 *
 * Two deliberate constraints keep the list from rotting into a graveyard:
 * every rule must carry a `reason`, and an `expires` date makes the
 * suppression lapse on its own rather than outliving the problem silently.
 */

/**
 * Pull a stable identifier out of an advisory URL.
 *
 * Registries hand back different URL shapes, so the recognisable identifiers
 * are matched first and the trailing path segment is the fallback.
 */
export function advisoryId(url: string): string | undefined {
  const ghsa = /GHSA-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}/i.exec(url);
  if (ghsa) return ghsa[0].toUpperCase();

  const cve = /CVE-\d{4}-\d{4,}/i.exec(url);
  if (cve) return cve[0].toUpperCase();

  const trailing = /\/([^/?#]+)\/?$/.exec(url);
  return trailing?.[1];
}

/**
 * Whether a rule has lapsed.
 *
 * The date is inclusive — "expires: 2026-12-31" covers all of the 31st — and
 * compared in UTC so a run does not change its mind based on where it runs.
 */
export function isExpired(rule: IgnoreRule, now: Date = new Date()): boolean {
  if (rule.expires === undefined) return false;
  const deadline = Date.parse(`${rule.expires}T23:59:59.999Z`);
  if (Number.isNaN(deadline)) return false;
  return now.getTime() > deadline;
}

export function matchesRule(
  vulnerability: Vulnerability,
  rule: IgnoreRule,
): boolean {
  if (rule.package !== undefined && rule.package !== vulnerability.name) {
    return false;
  }

  if (rule.advisory !== undefined) {
    const id = advisoryId(vulnerability.url);
    if (id === undefined) return false;
    if (id.toUpperCase() !== rule.advisory.toUpperCase()) return false;
  }

  // A rule with neither field is rejected when the config is loaded, so
  // reaching this point means at least one condition was checked and passed.
  return true;
}

/** Rules that have lapsed and are no longer suppressing anything. */
export function expiredRules(
  rules: IgnoreRule[] | undefined,
  now: Date = new Date(),
): IgnoreRule[] {
  return (rules ?? []).filter((rule) => isExpired(rule, now));
}

/**
 * Remove suppressed advisories from an audit result and recount.
 *
 * Suppressed entries are kept on `ignored` rather than dropped, so a report
 * can still show what is being lived with — a suppression nobody can see is
 * indistinguishable from a bug.
 *
 * A failed audit is returned untouched: its counts are already meaningless,
 * and filtering them would dress an unknown state up as a curated one.
 */
export function applyIgnores(
  result: AuditResult,
  rules: IgnoreRule[] | undefined,
  now: Date = new Date(),
): AuditResult {
  if (result.error !== undefined) return result;

  const active = (rules ?? []).filter((rule) => !isExpired(rule, now));
  if (active.length === 0) return result;

  const kept: Vulnerability[] = [];
  const ignored: Vulnerability[] = [];

  for (const vulnerability of result.vulnerabilities) {
    if (active.some((rule) => matchesRule(vulnerability, rule))) {
      ignored.push(vulnerability);
    } else {
      kept.push(vulnerability);
    }
  }

  if (ignored.length === 0) return result;

  // npm reports the whole chain above a vulnerable package — roarr because it
  // uses sprintf-js, global-agent because it uses roarr. Suppressing only the
  // root left the rest counted, usually as breaking, with "npm audit fix
  // --force" as the suggested remedy for an advisory already accepted. A
  // package flagged only through suppressed packages is suppressed with them.
  //
  // npm's chains can loop (app-builder-lib and dmg-builder each list the
  // other), so this starts from every inherited-only entry and discards the
  // ones that trace back to anything still counted, until nothing changes.
  // What survives reaches a vulnerability only through suppressed ones.
  const suppressedNames = new Set(ignored.map((v) => v.name));
  const candidates = new Set(
    kept
      .filter((v) => v.inheritedFrom !== undefined && v.inheritedFrom.length > 0)
      .map((v) => v.name),
  );
  let changed = true;
  while (changed) {
    changed = false;
    for (const vulnerability of kept) {
      if (!candidates.has(vulnerability.name)) continue;
      const traced = (vulnerability.inheritedFrom ?? []).every(
        (name) => suppressedNames.has(name) || candidates.has(name),
      );
      if (!traced) {
        candidates.delete(vulnerability.name);
        changed = true;
      }
    }
  }
  // ...and of those, only the ones that do lead to a suppressed advisory. A
  // loop with no way out to one has nothing accepted behind it.
  const reaches = new Set<string>();
  changed = true;
  while (changed) {
    changed = false;
    for (const vulnerability of kept) {
      if (!candidates.has(vulnerability.name) || reaches.has(vulnerability.name)) {
        continue;
      }
      const leads = (vulnerability.inheritedFrom ?? []).some(
        (name) => suppressedNames.has(name) || reaches.has(name),
      );
      if (leads) {
        reaches.add(vulnerability.name);
        changed = true;
      }
    }
  }
  for (let i = kept.length - 1; i >= 0; i--) {
    const vulnerability = kept[i];
    if (vulnerability === undefined || !reaches.has(vulnerability.name)) {
      continue;
    }
    kept.splice(i, 1);
    ignored.push(vulnerability);
  }

  const bySeverity = emptySeverityMap();
  for (const vulnerability of kept) bySeverity[vulnerability.severity]++;

  return {
    ...result,
    vulnerabilities: kept,
    totalCount: kept.length,
    fixableCount: kept.filter((v) => v.fixAvailable && !v.fixIsBreaking).length,
    breakingFixCount: kept.filter((v) => v.fixIsBreaking).length,
    bySeverity,
    ignored,
  };
}

/**
 * Validate the `ignore` section of a config file.
 *
 * Returns problems rather than throwing so the config loader can report every
 * fault in one go, the way it does for the rest of the file.
 */
export function parseIgnoreRules(raw: unknown): {
  rules: IgnoreRule[];
  problems: string[];
} {
  const problems: string[] = [];

  if (!Array.isArray(raw)) {
    return { rules: [], problems: [`"ignore" must be an array`] };
  }

  const rules: IgnoreRule[] = [];

  raw.forEach((entry, index) => {
    const at = `"ignore[${index}]"`;

    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      problems.push(`${at} must be an object`);
      return;
    }

    const input = entry as Record<string, unknown>;
    const optionalString = (key: string): string | undefined => {
      const value = input[key];
      if (value === undefined) return undefined;
      if (typeof value !== "string" || value.trim() === "") {
        problems.push(`${at}.${key} must be a non-empty string`);
        return undefined;
      }
      return value.trim();
    };

    const pkg = optionalString("package");
    const advisory = optionalString("advisory");
    const reason = optionalString("reason");
    const expires = optionalString("expires");

    if (pkg === undefined && advisory === undefined) {
      problems.push(`${at} needs a "package" or an "advisory" to match on`);
    }

    // An undocumented suppression is how an ignore list turns into a place
    // vulnerabilities go to be forgotten.
    if (reason === undefined) {
      problems.push(`${at} needs a "reason" explaining why this is accepted`);
    }

    if (expires !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(expires)) {
      problems.push(`${at}.expires must be a date in YYYY-MM-DD form`);
    } else if (expires !== undefined && Number.isNaN(Date.parse(expires))) {
      problems.push(`${at}.expires is not a real date`);
    }

    if (reason === undefined || (pkg === undefined && advisory === undefined)) {
      return;
    }

    rules.push({
      ...(pkg !== undefined ? { package: pkg } : {}),
      ...(advisory !== undefined ? { advisory } : {}),
      reason,
      ...(expires !== undefined ? { expires } : {}),
    });
  });

  return { rules, problems };
}
