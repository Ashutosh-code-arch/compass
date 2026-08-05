/**
 * Reading a curated list of GitHub organisations. PURE: text in, logins out.
 *
 * Why a file rather than a fetch. The GSoC organisation list is published as a web page whose shape
 * changes yearly, and the names on it are *programme* names — "CERN-HSF", "Python Software
 * Foundation" — which are not GitHub logins. Something has to map "Python Software Foundation" to
 * `python`, and no scraper can do that reliably. A human doing it once a year is the honest design,
 * and it is exactly what the `curated` provenance class means: a human list, carrying a review date.
 *
 * The failure mode this module is built around is the one the roadmap names: **a source returning
 * nothing must record "unknown", never "none".** A changed page, a failed download, or a wrong path
 * all produce an empty file, and an importer that accepts one would conclude that no organisation
 * participates in GSoC. So an empty parse is refused rather than committed, and `--replace` can never
 * delete a year's tags on the strength of a file that turned out to be empty.
 */

/** GitHub logins: alphanumeric and single hyphens, no leading or trailing hyphen, up to 39 chars. */
const LOGIN = /^[a-z\d](?:[a-z\d]|-(?=[a-z\d])){0,38}$/i;

export interface ParsedOrgList {
  /** Valid logins, deduplicated, in file order. */
  logins: string[];
  /** Lines that looked like content but were not a login, with their line numbers. */
  rejected: { line: number; text: string }[];
}

/**
 * One login per line. Blank lines and `#` comments are ignored; an inline `#` ends the login.
 *
 * `owner/name` is accepted and reduced to `owner`, because a list copied out of a repository index
 * will often carry full names and silently rejecting those would look like an empty source.
 *
 * Rejected lines are returned rather than skipped. A file with 185 lines that yields 40 logins has
 * something wrong with it, and the caller can only say so if it is told what did not parse.
 */
export function parseOrgList(text: string): ParsedOrgList {
  const logins: string[] = [];
  const seen = new Set<string>();
  const rejected: { line: number; text: string }[] = [];

  const lines = text.split(/\r?\n/);
  for (const [index, raw] of lines.entries()) {
    const withoutComment = raw.split('#')[0] ?? '';
    const trimmed = withoutComment.trim();
    if (trimmed === '') continue;

    // A full name reduces to its owner. Anything after a second slash is not a repository reference.
    const parts = trimmed.split('/');
    const candidate = (parts.length <= 2 ? parts[0] : '')?.trim() ?? '';

    if (candidate === '' || !LOGIN.test(candidate)) {
      rejected.push({ line: index + 1, text: trimmed });
      continue;
    }

    const key = candidate.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    logins.push(candidate);
  }

  return { logins, rejected };
}

export class OrgListError extends Error {}

/**
 * Refuses a list that cannot be trusted, before anything is written.
 *
 * Two refusals, both deliberate:
 *
 *   Empty          the source failed, and "no organisation participates in GSoC" is a false finding
 *                  rather than a gap. This is the project's `null` \u2260 `0` rule in a new place.
 *   Mostly garbage more rejected lines than accepted ones means the file is not what the caller
 *                  thinks it is — a CSV, an HTML dump, a list of programme names. Importing the few
 *                  lines that happened to parse would produce a plausible, wrong, dated claim.
 */
export function assertUsableOrgList(parsed: ParsedOrgList, path: string): void {
  if (parsed.logins.length === 0) {
    throw new OrgListError(
      `${path} contained no organisation logins. Refusing to import: an empty source is a failure, ` +
        `not a finding that nobody participates. Expected one GitHub login per line.`,
    );
  }

  if (parsed.rejected.length > parsed.logins.length) {
    const examples = parsed.rejected
      .slice(0, 3)
      .map((entry) => `line ${entry.line}: ${JSON.stringify(entry.text)}`)
      .join('; ');
    throw new OrgListError(
      `${path}: ${parsed.rejected.length} line(s) did not parse as GitHub logins and only ` +
        `${parsed.logins.length} did. Refusing to import a file this far from the expected format. ` +
        `Examples — ${examples}. Note that GSoC publishes programme names, not logins: ` +
        `"Python Software Foundation" has to become "python" by hand.`,
    );
  }
}
