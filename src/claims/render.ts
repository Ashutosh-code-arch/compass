/**
 * Terminal output for a claim check. Every value arrives already computed.
 *
 * The one rule this file exists to enforce: a verdict is never printed without its age and its
 * coverage. "free" is a statement about a moment, and a three-week-old "free" from the first 100
 * comments of a 400-comment thread is a different claim from a fresh one that read everything.
 */

import { checkClaims, type ClaimCheck } from './check.ts';

const LABELS: Record<string, string> = {
  free: 'nobody has asked for this',
  claimed: 'one person has asked and nobody was assigned',
  contested: 'several people have asked and nobody was assigned',
  'in-progress': 'somebody is already doing the work',
  'stale-claim': 'asked for a while ago, then nothing',
};

/** What to do about it, which is the only reason to run the check. */
const ADVICE: Record<string, string> = {
  free: 'Nothing in the thread suggests anyone else is on it.',
  claimed:
    'Comment before you start. The maintainers are not assigning, so arriving second is a real risk.',
  contested:
    'This is the pattern that wastes evenings: a queue of volunteers and no assignment. Unless you ' +
    'want to race, spend the time elsewhere.',
  'in-progress': 'Skip it. Somebody has work in flight, and a second pull request helps nobody.',
  'stale-claim':
    'Probably yours. Say so in the thread — the earlier request is old enough that nobody will mind.',
};

function ageOf(iso: string, now: Date): string {
  const hours = (now.getTime() - Date.parse(iso)) / 3_600_000;
  if (hours < 1) return 'just now';
  if (hours < 48) return `${Math.round(hours)}h ago`;
  return `${Math.round(hours / 24)} days ago`;
}

export function renderClaimCheck(check: ClaimCheck, now = new Date()): void {
  console.log(`\n${check.repoFullName}#${check.number}  ${check.title}`);
  console.log(check.htmlUrl);

  console.log(`\n  ${check.verdict.toUpperCase()} — ${LABELS[check.verdict] ?? 'unrecognised verdict'}`);
  console.log(`  ${ADVICE[check.verdict] ?? ''}`);

  // Age first, before any of the detail, because it governs how much the detail is worth.
  console.log(
    `\n  checked ${ageOf(check.checkedAt, now)}${check.fromCache ? ' (cached — re-run without --cached to refresh)' : ''}`,
  );
  console.log(
    check.commentsTotal > check.commentsRead
      ? `  read ${check.commentsRead} of ${check.commentsTotal} comments — the rest were not seen`
      : `  read all ${check.commentsRead} comment(s)`,
  );

  if (check.progress.length > 0) {
    console.log(`\n  work reported:`);
    for (const event of check.progress.slice(0, 3)) {
      console.log(`    ${event.author} ${ageOf(event.at, now)} — ${event.why}`);
      if (event.excerpt) console.log(`      "${event.excerpt}"`);
    }
  }

  if (check.claims.length > 0) {
    console.log(`\n  ${check.claimants} person(s) asked:`);
    for (const event of check.claims.slice(0, 5)) {
      console.log(`    ${event.author} ${ageOf(event.at, now)} — ${event.why}`);
      if (event.excerpt) console.log(`      "${event.excerpt}"`);
    }
    if (check.claims.length > 5) console.log(`    …and ${check.claims.length - 5} more`);
  }

  if (check.linkedPrs.length > 0) {
    console.log(`\n  pull requests referenced:`);
    for (const url of check.linkedPrs.slice(0, 5)) console.log(`    ${url}`);
  }

  const bounty = [...check.bountyLabels, ...(check.bountyHint ? [check.bountyHint] : [])];
  if (bounty.length > 0) console.log(`\n  bounty signals: ${bounty.join(', ')}`);

  console.log(
    `\n  A verdict is true as of the moment it was made. Nothing here is part of the score — see ` +
      `src/rank/score.ts for why.`,
  );
}

/** `claims owner/name#123`. */
export async function claims(ref: string, cached: boolean): Promise<void> {
  const check = await checkClaims(ref, { allowCache: cached });
  if (!check) {
    console.log(
      `${ref} is not in the corpus. Sync its repository first, or check the owner/name#123 spelling.`,
    );
    return;
  }
  renderClaimCheck(check);
}
