/**
 * Is this issue actually free? PURE: comments in, verdict out. No database, no network, no clock
 * except what is passed in.
 *
 * The problem this exists for. On a popular repository a `good first issue` with 23 comments is
 * usually twenty people asking "can I work on this?" and one person three days in without an
 * assignment. GitHub's `assignee` field is empty in every one of those cases, so the shortlist — which
 * correctly excludes assigned issues — treats the whole pile as free work. It is the largest remaining
 * way this tool can waste an evening.
 *
 * Why this is careful rather than clever. Every rule here can be wrong in two directions, and they
 * cost different amounts:
 *
 *   False "claimed"  you skip an issue that was free. You lose an option, and never find out.
 *   False "free"     you spend an evening on work somebody else is already doing. You find out at
 *                    the worst possible moment.
 *
 * Neither is acceptable, so the phrasing rules are narrow and stated rather than fuzzy. A comment must
 * be first-person and volitional to count as a claim: "I would like to work on this" is a claim,
 * "is anyone working on this?" is a question, and "can you take this?" is delegation. Matching on
 * "working on this" alone would collapse all three.
 *
 * There is no attempt at natural language understanding. The rules are a list a reader can predict and
 * argue with, and every verdict carries the comment that produced it so it can be checked.
 */

/** Mirrors the CHECK constraint in migration 012; `detect.test.ts` asserts they agree. */
export const CLAIM_VERDICTS = ['free', 'claimed', 'contested', 'in-progress', 'stale-claim'] as const;

export type ClaimVerdict = (typeof CLAIM_VERDICTS)[number];

export interface ClaimComment {
  author: string | null;
  /** GitHub's `__typename`, so bots can be excluded without guessing from the login. */
  authorType?: string | null;
  authorAssociation: string | null;
  body: string;
  createdAt: string;
}

/**
 * How long a bare request to work on something stays believable.
 *
 * Fourteen days. Someone who asked "can I take this?" three weeks ago and has pushed nothing has, in
 * practice, moved on, and treating that as claimed forever would hide issues that are genuinely
 * available. Anyone reporting actual work is handled separately and does not expire on this clock,
 * because a half-finished branch does not evaporate the way an intention does.
 */
export const CLAIM_FRESH_DAYS = 14;

/**
 * First-person intent to take the work.
 *
 * Anchored on a first-person subject in every case. The anchor is what separates a claim from a
 * question about somebody else's claim, and it is the difference the whole module turns on.
 */
const CLAIM_PATTERNS: [RegExp, string][] = [
  [/\b(?:can|could|may|might)\s+i\b[^?]{0,40}\b(?:work|take|try|tackle|pick|have|do|attempt|help)\b/i, 'asked to take it'],
  [/\bi(?:'|\u2019)?d?\s+(?:would\s+)?(?:like|love|want)\s+to\s+(?:work|take|try|tackle|pick|help|contribute)/i, 'offered to take it'],
  [/\bi(?:'|\u2019)?ll\s+(?:work\s+on|take|tackle|pick\s+(?:this\s+)?up|handle|give\s+this\s+a)\b/i, 'said they would take it'],
  [/\bi\s+am\s+(?:going\s+to|interested\s+in)\s+(?:work|tak|try|pick|contribut)/i, 'expressed intent'],
  [/\bi(?:'|\u2019)?m\s+(?:going\s+to|interested\s+in)\s+(?:work|tak|try|pick|contribut)/i, 'expressed intent'],
  [/\b(?:assign|please\s+assign)\s+(?:this\s+)?(?:to\s+)?me\b/i, 'asked to be assigned'],
  [/^\s*\/assign(?:\s+me)?\s*$/im, 'used /assign'],
  [/\bcan\s+i\s+be\s+assigned\b/i, 'asked to be assigned'],
  [/\bi\s+want\s+to\s+(?:solve|fix|implement)\s+this\b/i, 'expressed intent'],
  [/\btaking\s+this\s+(?:one\s+)?up\b/i, 'said they were taking it'],
  [/\bdibs\b/i, 'called dibs'],
];

/**
 * Reports of actual work, which is a different and stronger thing than intent.
 *
 * Someone with a branch pushed is not going to be talked out of it by your arriving later, and unlike
 * an expressed intention this does not go stale on a two-week clock.
 */
const PROGRESS_PATTERNS: [RegExp, string][] = [
  [/\b(?:opened|raised|submitted|created|pushed)\s+(?:a\s+)?(?:pr|pull\s+request|patch|fix)\b/i, 'opened a pull request'],
  [/\b(?:pr|pull\s+request)\s+(?:is\s+)?(?:up|open|ready|here|submitted)\b/i, 'says a pull request is up'],
  [/\bi(?:'|\u2019)?ve\s+(?:pushed|opened|started|implemented|got\s+a)\b/i, 'reports work done'],
  [/\bworking\s+on\s+(?:this|it)\s+(?:now|currently|already)\b/i, 'reports work in progress'],
  [/\bi\s+am\s+(?:currently\s+)?working\s+on\s+(?:this|it)\b/i, 'reports work in progress'],
  [/\bi(?:'|\u2019)?m\s+(?:currently\s+)?working\s+on\s+(?:this|it)\b/i, 'reports work in progress'],
  [/\bhere(?:'|\u2019)?s\s+my\s+(?:pr|pull\s+request|patch|attempt)\b/i, 'linked their work'],
];

/**
 * Vetoes, applied before anything else.
 *
 * Each of these is a real sentence that appears constantly in issue threads and each would otherwise
 * match a claim pattern:
 *
 *   "is anyone working on this?"      a question about other people's claims, not a claim
 *   "can you take this one?"          delegation, usually from a maintainer
 *   "are you still working on this?"  a maintainer checking whether a claim went stale
 *   "I'll take a look"                looking is not doing, and this phrase means neither
 *   "I would like to work on this if nobody else is" still a claim — deliberately NOT vetoed
 */
const VETO_PATTERNS: RegExp[] = [
  /\b(?:is|are)\s+(?:any\s?one|anybody|someone|somebody|you|they)\b[^.?!]{0,40}\bworking\s+on\b/i,
  /\b(?:any\s?one|anybody|someone|somebody)\s+(?:already\s+)?working\s+on\b/i,
  /\bcan\s+(?:you|someone|somebody|any\s?one)\b[^?]{0,30}\b(?:take|work|do|handle)\b/i,
  /\b(?:are|is)\s+you\s+still\b/i,
  /\btake\s+a\s+look\b/i,
  /\bhas\s+(?:any\s?one|anybody|this)\s+been\b/i,
  /\bwho\s+is\s+working\s+on\b/i,
  // Instructions, not intent. Repositories with assignment bots attract comments explaining how the
  // bot works — "you can use /assign me to claim issues here" — and the explanation contains the exact
  // phrase the claim rule looks for. Bots are already excluded; a human writing the same sentence was
  // not, and this is what a real thread taught the rule.
  /\b(?:use|using|type|typing|comment|commenting|run|running|with|write)\s+(?:the\s+)?[`'"]?\/?assign\b/i,
  /\bto\s+claim\s+(?:an?\s+)?(?:issue|issues|it)\b/i,
];

const BOUNTY_PATTERNS: [RegExp, string][] = [
  [/^\s*\/bounty\b/im, '/bounty command'],
  [/\bbounty\b/i, 'bounty mentioned'],
  [/\$\s?\d[\d,]*(?:\s*(?:usd|bounty|reward))?/i, 'a cash amount mentioned'],
  [/\balgora\b|\bgitcoin\b|\bbountysource\b|\bpolar\.sh\b/i, 'a bounty platform mentioned'],
];

/** Full URLs and `#123` cross-references, which is how a pull request usually arrives in a thread. */
const PR_URL = /https?:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/(\d+)/gi;

export interface ClaimEvent {
  author: string;
  at: string;
  /** Which rule fired, in words, so a verdict can be checked against the thread. */
  why: string;
  /** The comment, trimmed to something quotable. */
  excerpt: string;
}

export interface ClaimFinding {
  verdict: ClaimVerdict;
  /** Distinct non-bot people who expressed intent. */
  claimants: number;
  /** Every intent event, newest first. */
  claims: ClaimEvent[];
  /** Every report of actual work, newest first. */
  progress: ClaimEvent[];
  linkedPrs: string[];
  bountyHint: string | null;
  commentsRead: number;
  commentsTotal: number;
}

export interface DetectClaimsInput {
  comments: ClaimComment[];
  /** How many comments the thread has in total, which may exceed what was fetched. */
  commentsTotal: number;
  /** The issue's own author, whose intent counts but is worth distinguishing. */
  issueAuthor?: string | null;
  now: Date;
}

function isBot(comment: ClaimComment): boolean {
  if (comment.authorType === 'Bot') return true;
  // Deliberately narrow. A `bot` suffix misclassifies real people — the human login `klembot` is why
  // the ignore list in the metrics path exists — so the typename is trusted and the login is not.
  return comment.author === null;
}

function excerpt(body: string): string {
  const flat = body.replace(/\s+/g, ' ').trim();
  return flat.length <= 140 ? flat : `${flat.slice(0, 139)}\u2026`;
}

function daysBetween(from: string, to: Date): number {
  return (to.getTime() - Date.parse(from)) / 86_400_000;
}

/**
 * Reads a thread and says whether the issue is free.
 *
 * The ordering of the verdicts is not arbitrary. `in-progress` outranks everything, because somebody
 * with work in flight settles the question. `contested` outranks `claimed`, because several people
 * asking and nobody being assigned is worse than one person asking: it means the maintainers are not
 * managing assignment at all, and arriving as the twenty-first volunteer is the specific trap.
 */
export function detectClaims(input: DetectClaimsInput): ClaimFinding {
  const claims: ClaimEvent[] = [];
  const progress: ClaimEvent[] = [];
  const linkedPrs = new Set<string>();
  let bountyHint: string | null = null;

  for (const comment of input.comments) {
    const body = comment.body ?? '';

    for (const match of body.matchAll(PR_URL)) linkedPrs.add(match[0]);

    if (bountyHint === null) {
      for (const [pattern, label] of BOUNTY_PATTERNS) {
        if (pattern.test(body)) {
          bountyHint = label;
          break;
        }
      }
    }

    if (isBot(comment)) continue;
    const author = comment.author!;

    // Progress is checked before the veto list, because "I'm working on this now" is a report of work
    // and must not be discarded by the rule that exists to catch "is anyone working on this?".
    let matchedProgress = false;
    for (const [pattern, label] of PROGRESS_PATTERNS) {
      if (pattern.test(body)) {
        progress.push({ author, at: comment.createdAt, why: label, excerpt: excerpt(body) });
        matchedProgress = true;
        break;
      }
    }
    if (matchedProgress) continue;

    if (VETO_PATTERNS.some((pattern) => pattern.test(body))) continue;

    for (const [pattern, label] of CLAIM_PATTERNS) {
      if (pattern.test(body)) {
        claims.push({ author, at: comment.createdAt, why: label, excerpt: excerpt(body) });
        break;
      }
    }
  }

  const newestFirst = (a: ClaimEvent, b: ClaimEvent): number => Date.parse(b.at) - Date.parse(a.at);
  claims.sort(newestFirst);
  progress.sort(newestFirst);

  const claimants = new Set(claims.map((event) => event.author)).size;

  let verdict: ClaimVerdict;
  if (progress.length > 0 || linkedPrs.size > 0) {
    verdict = 'in-progress';
  } else if (claimants === 0) {
    verdict = 'free';
  } else if (daysBetween(claims[0]!.at, input.now) > CLAIM_FRESH_DAYS) {
    // Everyone who asked has gone quiet for longer than an intention survives. Reporting this as
    // claimed would hide an issue that is, in practice, available again.
    verdict = 'stale-claim';
  } else if (claimants > 1) {
    verdict = 'contested';
  } else {
    verdict = 'claimed';
  }

  return {
    verdict,
    claimants,
    claims,
    progress,
    linkedPrs: [...linkedPrs],
    bountyHint,
    commentsRead: input.comments.length,
    commentsTotal: input.commentsTotal,
  };
}

// ---------------------------------------------------------------------------
// Bounty labels, which need no fetch at all
// ---------------------------------------------------------------------------

/**
 * Bounty indications in an issue's labels.
 *
 * Labels are already in the corpus, so this is free and available for every issue rather than only for
 * the ones you open. Deliberately narrow: `help wanted` is not a bounty, and neither is `paid-plan`,
 * which is a product label on plenty of SaaS repositories.
 */
const BOUNTY_LABEL_PATTERNS: RegExp[] = [
  /^\s*\$/,
  /\bbounty\b/i,
  /\breward\b/i,
  /\bcash\b/i,
  /\balgora\b|\bgitcoin\b|\bpolar\b/i,
  /\ud83d\udcb0/,
];

export function bountyLabels(labels: string[]): string[] {
  return labels.filter((label) => BOUNTY_LABEL_PATTERNS.some((pattern) => pattern.test(label)));
}
