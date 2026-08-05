/**
 * Is there paperwork between you and a merged pull request? PURE: text and paths in, verdict out.
 *
 * Two quite different things, kept apart because the response to each differs:
 *
 *   CLA  a Contributor License Agreement. A signature, often through a third party, sometimes
 *        needing an employer's involvement. For some people it is a hard stop, and finding out after
 *        writing the code is the worst time to find out.
 *   DCO  a Developer Certificate of Origin. A `Signed-off-by` line on each commit. No signature, no
 *        third party, and forgetting it costs one amended commit.
 *
 * Reporting both as "agreement required" would throw away the only distinction that changes what you
 * do, so they are separate verdicts and `both` is a real answer.
 *
 * The honest-absence rule: `none` is returned only when a CONTRIBUTING file was actually read.
 * Having looked nowhere is not evidence of absence, and a confident "no CLA" that walks someone into
 * a signature wall is the exact failure this exists to prevent.
 */

/** Mirrors the CHECK constraint in migration 011; `agreement.test.ts` asserts they agree. */
export const AGREEMENT_KINDS = ['cla', 'dco', 'both', 'none'] as const;

export type ContributorAgreement = (typeof AGREEMENT_KINDS)[number];

export interface AgreementFinding {
  /** Null means unmeasured. Never a stand-in for "none". */
  agreement: ContributorAgreement | null;
  /** The phrases and paths that produced the verdict, so it can be argued with. */
  evidence: string[];
}

/**
 * Phrases that indicate a CLA, each with the label recorded as evidence.
 *
 * The bare acronym is matched case-sensitively. Lowercase "cla" as a standalone word is far more
 * likely to be a fragment of something else than an actual reference to the agreement, and this file
 * is one where a false positive is worse than a miss: it would tell you a project is closed to you
 * when it is not.
 */
const CLA_PHRASES: [RegExp, string][] = [
  [/contributor licen[sc]e agreement/i, 'contributor license agreement'],
  [/\bCLA\b/, 'CLA'],
  [/cla-assistant|cla\.github|easycla|clabot/i, 'CLA bot'],
  [/sign(?:ing|ed)?\s+(?:the\s+)?(?:contributor\s+)?licen[sc]e/i, 'signing the licence'],
  [/corporate contributor agreement/i, 'corporate contributor agreement'],
];

/**
 * Phrases that indicate a DCO.
 *
 * Deliberately excludes a bare "sign off". "A maintainer must sign off on the design first" is a
 * common sentence in a CONTRIBUTING file and has nothing to do with the certificate — matching it
 * would attach a DCO verdict to projects that have no such requirement.
 */
const DCO_PHRASES: [RegExp, string][] = [
  [/developer certificate of origin/i, 'developer certificate of origin'],
  [/\bDCO\b/, 'DCO'],
  [/signed-off-by/i, 'Signed-off-by'],
  [/--signoff/i, '--signoff'],
  [/commit\s+(?:-\w+\s+)*-s\b/, 'commit -s'],
];

/** Exact filenames that are bot configuration for one or the other. */
const CLA_FILENAMES = new Set(['.clabot', '.cla-signatures', 'cla.json', 'easycla.yml']);
const DCO_FILENAMES = new Set(['.dco.yml', 'dco.yml']);

/**
 * Whether a path's filename refers to CLA or DCO tooling.
 *
 * Tokenised rather than matched as a substring, because `declarations.yaml` contains "cla" and
 * `mdco.py` contains "dco". A substring test here would have quietly mislabelled real repositories,
 * and the evidence column would have shown a filename that looks nothing like a reason.
 */
function fileMentions(path: string, keyword: 'cla' | 'dco'): boolean {
  const basename = (path.split('/').pop() ?? '').toLowerCase();
  const exact = keyword === 'cla' ? CLA_FILENAMES : DCO_FILENAMES;
  if (exact.has(basename)) return true;
  return basename.split(/[^a-z0-9]+/).includes(keyword);
}

/**
 * Only configuration-shaped files count.
 *
 * A repository documenting CLA tooling — an examples directory, a docs page about somebody else's
 * workflow — is not one that requires a CLA. Restricting to workflow and config files is what keeps
 * this from firing on projects that merely mention the subject.
 */
function isConfigPath(path: string): boolean {
  return /\.(ya?ml|json)$/i.test(path) && (path.startsWith('.github/') || !path.includes('/'));
}

export interface AgreementInput {
  /** The text of the located CONTRIBUTING file, or null when there was none to read. */
  contributingText: string | null | undefined;
  /** Every path in the file tree. Bot configuration counts even with no CONTRIBUTING file. */
  treePaths: string[];
  /** GitHub stopped listing. Absence proves nothing; presence still does. */
  treeTruncated: boolean;
}

export function detectContributorAgreement(input: AgreementInput): AgreementFinding {
  const evidence: string[] = [];
  let cla = false;
  let dco = false;

  const text = input.contributingText ?? '';
  if (text.trim() !== '') {
    for (const [pattern, label] of CLA_PHRASES) {
      if (pattern.test(text)) {
        cla = true;
        evidence.push(label);
      }
    }
    for (const [pattern, label] of DCO_PHRASES) {
      if (pattern.test(text)) {
        dco = true;
        evidence.push(label);
      }
    }
  }

  for (const path of input.treePaths) {
    if (!isConfigPath(path)) continue;
    if (fileMentions(path, 'cla')) {
      cla = true;
      evidence.push(path);
    }
    if (fileMentions(path, 'dco')) {
      dco = true;
      evidence.push(path);
    }
  }

  // Positive findings stand even under truncation: seeing a thing is not affected by not having seen
  // everything. Only the absence verdict has to be withheld.
  if (cla && dco) return { agreement: 'both', evidence: trim(evidence) };
  if (cla) return { agreement: 'cla', evidence: trim(evidence) };
  if (dco) return { agreement: 'dco', evidence: trim(evidence) };

  // Nothing found. Whether that means "none" or "unmeasured" turns entirely on whether there was a
  // CONTRIBUTING file to read, because that is where a project states this.
  if (input.treeTruncated) return { agreement: null, evidence: [] };
  if (text.trim() === '') return { agreement: null, evidence: [] };
  return { agreement: 'none', evidence: [] };
}

/** Deduplicated and capped: the column is a reason, not a log. */
function trim(evidence: string[]): string[] {
  return [...new Set(evidence)].slice(0, 6);
}
