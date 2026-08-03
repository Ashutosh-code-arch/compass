import { db } from '../db.ts';
import { fetchCandidates, type ShortlistFilters } from './candidates.ts';
import {
  buildRepoContext,
  distinguishingLines,
  formatHours,
  rankCandidates,
  scoreCandidate,
  type Candidate,
} from './score.ts';
import { DEFAULT_MIN_SCORE } from './weights.ts';

export interface ShortlistOptions extends ShortlistFilters {
  limit?: number;
  minScore?: number;
  /**
   * Maximum rows from any one repository.
   *
   * Repo-level signals dominate the score, so a single project with a large labelled backlog takes
   * over the list — one real run returned twelve of its top twenty from the same repository, all on
   * an identical score. The point of a shortlist is a set of distinct options.
   */
  perRepo?: number;
}

/**
 * The ranked list. Each row carries the two or three signals that most account for its position,
 * because a rank you cannot interrogate is a rank you cannot correct.
 */
export async function shortlist(options: ShortlistOptions = {}): Promise<void> {
  const candidates = await fetchCandidates(options);

  if (candidates.length === 0) {
    console.log(
      '\nNo candidates. Either no issues are synced yet, every one is assigned or already judged, ' +
        'or the filters excluded everything.\n' +
        'Try: npm run compass -- shortlist --include-dormant --min-score 0\n',
    );
    return;
  }

  const minScore = options.minScore ?? DEFAULT_MIN_SCORE;
  const ranked = rankCandidates(candidates, { minScore });

  if (candidates.length >= (options.fetchLimit ?? 50000)) {
    console.log(
      `\nWarning: hit the ${options.fetchLimit ?? 50000}-row fetch cap, so this ranks a subset. ` +
        `Raise it or narrow the filters.`,
    );
  }

  if (ranked.length === 0) {
    console.log(
      `\n${candidates.length} open issues considered, none scoring at least ${minScore}.\n` +
        `Lower the bar with --min-score 0, or widen the corpus.\n`,
    );
    return;
  }

  const perRepo = options.perRepo ?? 2;
  const seen = new Map<string, number>();
  const held = new Map<string, number>();
  const shown: typeof ranked = [];

  for (const scored of ranked) {
    const repo = scored.candidate.repoFullName;
    const count = seen.get(repo) ?? 0;
    if (count >= perRepo) {
      held.set(repo, (held.get(repo) ?? 0) + 1);
      continue;
    }
    seen.set(repo, count + 1);
    shown.push(scored);
    if (shown.length >= (options.limit ?? 20)) break;
  }

  const scores = ranked.map((scored) => scored.score);
  console.log(
    `\n${ranked.length} of ${candidates.length} open unassigned issues score at least ${minScore} ` +
      `(range ${Math.min(...scores)}–${Math.max(...scores)}, median ${median(scores)}).`,
  );
  console.log(
    `Showing ${shown.length} from ${seen.size} repositories, at most ${perRepo} each ` +
      `(--per-repo to change).\n`,
  );

  for (const [index, scored] of shown.entries()) {
    const { candidate } = scored;
    console.log(
      `${String(index + 1).padStart(3)}. [${String(scored.score).padStart(3)}]  ` +
        `${candidate.repoFullName}#${candidate.number}  ${candidate.title.slice(0, 70)}`,
    );

    // Issue-level lines only: the repo facts are on the context line below, and repeating them made
    // every row identical.
    const issueLines = distinguishingLines(scored);
    const evidence =
      issueLines.length > 0
        ? issueLines
            .map((line) => `${line.points > 0 ? '+' : ''}${line.points} ${line.signal} (${line.detail})`)
            .join('  ')
        : 'nothing notable about the issue itself — ranked on the project';
    const context = [
      candidate.responsiveness ?? 'unmeasured',
      candidate.medianHoursResponse !== null ? formatHours(candidate.medianHoursResponse) : null,
      candidate.setupWeight && candidate.setupWeight !== 'unknown' ? `setup ${candidate.setupWeight}` : null,
      candidate.primaryLanguage,
    ]
      .filter((part): part is string => Boolean(part))
      .join(' · ');

    const more = held.get(candidate.repoFullName);
    console.log(`      ${evidence}`);
    console.log(`      ${context}`);
    console.log(`      ${candidate.htmlUrl}`);
    if (more && (seen.get(candidate.repoFullName) ?? 0) >= perRepo) {
      console.log(`      (+${more} more scoring candidates in this repo)`);
    }
  }

  console.log(
    `\nThe score has no units and predicts nothing — it orders candidates by the weights in ` +
      `src/rank/weights.ts.`,
  );
  console.log(
    `Full breakdown for any row:  npm run compass -- why ${ranked[0]!.candidate.repoFullName}#${ranked[0]!.candidate.number}\n`,
  );
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : Math.round((sorted[mid - 1]! + sorted[mid]!) / 2);
}

/** owner/name#123 */
export function parseIssueRef(ref: string): { fullName: string; number: number } {
  const match = /^([^#\s]+\/[^#\s]+)#(\d+)$/.exec(ref.trim());
  if (!match) {
    throw new Error(`Expected owner/name#123, got "${ref}"`);
  }
  return { fullName: match[1]!, number: Number.parseInt(match[2]!, 10) };
}

async function loadOne(
  ref: string,
): Promise<{ candidate: Candidate; context: ReturnType<typeof buildRepoContext> } | null> {
  const { fullName, number } = parseIssueRef(ref);
  // Reuse the same projection, without the gates: `why` must work on rejected rows too.
  const candidates = await fetchCandidates({ fetchLimit: 100000, includeDormant: true });
  const candidate = candidates.find(
    (entry) => entry.repoFullName === fullName && entry.number === number,
  );
  if (!candidate) return null;
  // Repository context has to be built from the full set, or a milled issue looks fine alone.
  return { candidate, context: buildRepoContext(candidates) };
}

/** Itemised breakdown for a single issue: every line, with the raw value behind it. */
export async function why(ref: string): Promise<void> {
  const loaded = await loadOne(ref);
  if (!loaded) {
    console.log(
      `\n${ref} is not a current candidate. It may be closed, assigned, already judged, ` +
        `or in a repo that is not synced.\n`,
    );
    return;
  }

  const { candidate } = loaded;
  const scored = scoreCandidate(candidate, new Date(), loaded.context.get(candidate.repoFullName));
  console.log(`\n${candidate.repoFullName}#${candidate.number}  —  score ${scored.score}`);
  console.log(`${candidate.title}`);
  console.log(`${candidate.htmlUrl}\n`);

  const width = Math.max(...scored.lines.map((line) => line.signal.length), 12);
  const show = (line: (typeof scored.lines)[number]): void => {
    console.log(
      `  ${line.points > 0 ? '+' : ''}${String(line.points).padStart(4)}  ` +
        `${line.signal.padEnd(width)}  ${line.detail}`,
    );
  };
  const byPoints = (a: { points: number }, b: { points: number }): number => b.points - a.points;

  // Two separate questions: is this a good project, and is this a good issue within it.
  const repoLines = scored.lines.filter((line) => line.about === 'repo').sort(byPoints);
  const issueLines = scored.lines.filter((line) => line.about === 'issue').sort(byPoints);

  console.log('  the project');
  if (repoLines.length === 0) console.log('    nothing measured');
  repoLines.forEach(show);
  console.log(`    subtotal ${repoLines.reduce((sum, line) => sum + line.points, 0)}`);

  console.log('\n  this issue');
  if (issueLines.length === 0) console.log('    nothing notable');
  issueLines.forEach(show);
  console.log(`    subtotal ${issueLines.reduce((sum, line) => sum + line.points, 0)}`);

  console.log(`  ${'='.repeat(6)}`);
  console.log(`  ${String(scored.score).padStart(5)}  total`);

  if (scored.unmeasured.length > 0) {
    console.log(
      `\nNot measured, contributing nothing either way: ${scored.unmeasured.join(', ')}.`,
    );
  }
  console.log(
    `\nLabels: ${candidate.labels.length > 0 ? candidate.labels.join(', ') : 'none'}`,
  );
  console.log(`Weights live in src/rank/weights.ts — disagree with a line and change it there.\n`);
}

// ---------------------------------------------------------------------------
// decisions journal
// ---------------------------------------------------------------------------

const VERDICTS = [
  'shortlisted',
  'rejected',
  'started',
  'abandoned',
  'submitted',
  'merged',
  'closed_unmerged',
  'stalled',
] as const;

export type Verdict = (typeof VERDICTS)[number];

export interface DecideOptions {
  predictedHours?: number;
  actualHours?: number;
  reason?: string;
}

/**
 * Records a judgement and removes the issue from future shortlists.
 *
 * This is Slice 5's journal, and it is what eventually makes the weights in weights.ts defensible:
 * predicted hours against actual, and which signals were present when you were right or wrong.
 * Nothing infers from it yet.
 */
export async function decide(
  ref: string,
  verdict: string,
  options: DecideOptions = {},
): Promise<void> {
  if (!(VERDICTS as readonly string[]).includes(verdict)) {
    throw new Error(`Unknown verdict "${verdict}". One of: ${VERDICTS.join(', ')}`);
  }
  const { fullName, number } = parseIssueRef(ref);

  const found = await db().query<{ id: number; title: string }>(
    `select i.id, i.title from issues i join repos r on r.id = i.repo_id
      where r.full_name = $1 and i.number = $2`,
    [fullName, number],
  );
  const issue = found.rows[0];
  if (!issue) {
    throw new Error(`${ref} is not in the corpus. Sync its repo first, or check the number.`);
  }

  await db().query(
    `insert into decisions (issue_id, verdict, predicted_hours, actual_hours, reason)
     values ($1, $2, $3, $4, $5)`,
    [
      issue.id,
      verdict,
      options.predictedHours ?? null,
      options.actualHours ?? null,
      options.reason ?? null,
    ],
  );

  console.log(`\nRecorded: ${ref} — ${verdict}`);
  console.log(`  ${issue.title.slice(0, 80)}`);
  console.log(`It will no longer appear in the shortlist.\n`);
}

/**
 * Prediction against outcome, which is the only honest basis for retuning the weights.
 *
 * Aggregated per ISSUE, not per row. Verdicts arrive as separate rows over time — `started --hours 4`
 * then later `merged --actual-hours 9` — so a per-row view could never pair a prediction with its
 * outcome and the accuracy line never appeared.
 */
export async function journal(limit = 30): Promise<void> {
  const rows = (
    await db().query<{
      full_name: string;
      number: number;
      title: string;
      trail: string;
      latest_verdict: string;
      predicted_hours: string | null;
      actual_hours: string | null;
      reason: string | null;
      last_at: Date;
    }>(
      `select r.full_name,
              i.number,
              i.title,
              string_agg(d.verdict, ' -> ' order by d.created_at)              as trail,
              (array_agg(d.verdict order by d.created_at desc))[1]             as latest_verdict,
              max(d.predicted_hours)                                           as predicted_hours,
              max(d.actual_hours)                                             as actual_hours,
              (array_agg(d.reason order by d.created_at desc)
                 filter (where d.reason is not null))[1]                       as reason,
              max(d.created_at)                                                as last_at
         from decisions d
         join issues i on i.id = d.issue_id
         join repos r on r.id = i.repo_id
        group by r.full_name, i.number, i.title
        order by max(d.created_at) desc
        limit $1`,
      [limit],
    )
  ).rows;

  if (rows.length === 0) {
    console.log(
      '\nNothing recorded yet. As you work through the shortlist:\n' +
        '  npm run compass -- decide owner/name#123 rejected --reason "needs design discussion"\n' +
        '  npm run compass -- decide owner/name#456 started --hours 4\n' +
        '  npm run compass -- decide owner/name#456 merged --actual-hours 11\n',
    );
    return;
  }

  console.log('');
  for (const row of rows) {
    const predicted = row.predicted_hours === null ? null : Number(row.predicted_hours);
    const actual = row.actual_hours === null ? null : Number(row.actual_hours);
    const hours =
      predicted !== null && actual !== null
        ? `${predicted}h predicted, ${actual}h actual (${(actual / predicted).toFixed(1)}x)`
        : predicted !== null
          ? `${predicted}h predicted`
          : actual !== null
            ? `${actual}h actual`
            : '';

    console.log(
      `${row.last_at.toISOString().slice(0, 10)}  ${row.trail.padEnd(28)} ` +
        `${row.full_name}#${row.number}${hours ? `  ${hours}` : ''}`,
    );
    console.log(`            ${row.title.slice(0, 76)}`);
    if (row.reason) console.log(`            "${row.reason}"`);
  }

  const complete = rows.filter((row) => row.predicted_hours !== null && row.actual_hours !== null);
  if (complete.length === 0) {
    console.log(
      `\nNo issue yet has both a prediction and an outcome. Record --hours when you start and ` +
        `--actual-hours when you finish; three of those and this reports your estimation bias.`,
    );
  } else if (complete.length < 3) {
    console.log(
      `\n${complete.length} issue(s) with both a prediction and an outcome. Three is where the ` +
        `average starts meaning anything.`,
    );
  } else {
    const ratio =
      complete.reduce(
        (sum, row) => sum + Number(row.actual_hours) / Number(row.predicted_hours),
        0,
      ) / complete.length;
    console.log(
      `\nAcross ${complete.length} completed issues, actual time averaged ` +
        `${ratio.toFixed(1)}x your prediction.`,
    );
  }
  console.log('');
}
