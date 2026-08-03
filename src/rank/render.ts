/**
 * Terminal rendering for the ranking commands. Presentation only: every value printed here arrives
 * already computed from `data.ts`.
 *
 * The prose for the empty and degraded cases lives here rather than in the view, because the remedy
 * differs by surface — the CLI's answer to "nothing scored" is a flag to retype, the UI's is a
 * control to move.
 */

import { formatHours, type ScoreLine } from './score.ts';
import {
  getJournal,
  getShortlist,
  getWhy,
  recordDecision,
  type DecideOptions,
  type ShortlistOptions,
} from './data.ts';
import { MIN_PAIRS_FOR_MEAN, type ShortlistNotice, type ShortlistView } from './view.ts';

export type { DecideOptions, ShortlistOptions };

function renderNotice(notice: ShortlistNotice): string {
  switch (notice.kind) {
    case 'no-candidates':
      return (
        '\nNo candidates. Either no issues are synced yet, every one is assigned or already judged, ' +
        'or the filters excluded everything.\n' +
        'Try: npm run compass -- shortlist --include-dormant --min-score 0\n'
      );
    case 'none-scoring':
      return (
        `\n${notice.considered} open issues considered, none scoring at least ${notice.minScore}.\n` +
        `Lower the bar with --min-score 0, or widen the corpus.\n`
      );
    case 'fetch-cap-hit':
      return (
        `\nWarning: hit the ${notice.fetchLimit}-row fetch cap, so this ranks a subset. ` +
        `Raise it or narrow the filters.`
      );
  }
}

/** The ranked list. Each row carries the signals that most account for its position. */
export async function shortlist(options: ShortlistOptions = {}): Promise<void> {
  printShortlist(await getShortlist(options));
}

function printShortlist(view: ShortlistView): void {
  for (const notice of view.notices) console.log(renderNotice(notice));
  if (view.rows.length === 0) return;

  const { summary } = view;
  const range = summary.scoreRange;
  console.log(
    `\n${summary.scoring} of ${summary.considered} open unassigned issues score at least ` +
      `${summary.minScore}` +
      (range ? ` (range ${range.min}–${range.max}, median ${range.median})` : '') +
      `.`,
  );
  console.log(
    `Showing ${summary.shown} from ${summary.repos} repositories, at most ${summary.perRepo} each ` +
      `(--per-repo to change).\n`,
  );

  for (const row of view.rows) {
    console.log(
      `${String(row.rank).padStart(3)}. [${String(row.score).padStart(3)}]  ` +
        `${row.issue.repoFullName}#${row.issue.number}  ${row.issue.title.slice(0, 70)}`,
    );

    const evidence =
      row.evidence.length > 0
        ? row.evidence.map(inlineLine).join('  ')
        : 'nothing notable about the issue itself — ranked on the project';
    const context = [
      row.context.responsiveness ?? 'unmeasured',
      row.context.medianHoursResponse !== null
        ? formatHours(row.context.medianHoursResponse)
        : null,
      row.context.setupWeight && row.context.setupWeight !== 'unknown'
        ? `setup ${row.context.setupWeight}`
        : null,
      row.context.primaryLanguage,
    ]
      .filter((part): part is string => Boolean(part))
      .join(' · ');

    console.log(`      ${evidence}`);
    console.log(`      ${context}`);
    console.log(`      ${row.issue.htmlUrl}`);
    if (row.heldBackInRepo > 0) {
      console.log(`      (+${row.heldBackInRepo} more scoring candidates in this repo)`);
    }
  }

  console.log(
    `\nThe score has no units and predicts nothing — it orders candidates by the weights in ` +
      `src/rank/weights.ts.`,
  );
  const top = view.rows[0]!;
  console.log(
    `Full breakdown for any row:  npm run compass -- why ${top.issue.repoFullName}#${top.issue.number}\n`,
  );
}

function inlineLine(line: ScoreLine): string {
  return `${line.points > 0 ? '+' : ''}${line.points} ${line.signal} (${line.detail})`;
}

/** Itemised breakdown for a single issue: every line, with the raw value behind it. */
export async function why(ref: string): Promise<void> {
  const view = await getWhy(ref);
  if (!view) {
    console.log(
      `\n${ref} is not a current candidate. It may be closed, assigned, already judged, ` +
        `or in a repo that is not synced.\n`,
    );
    return;
  }

  console.log(`\n${view.issue.repoFullName}#${view.issue.number}  —  score ${view.score}`);
  console.log(`${view.issue.title}`);
  console.log(`${view.issue.htmlUrl}\n`);

  const allLines = [...view.repoLines, ...view.issueLines];
  const width = Math.max(...allLines.map((line) => line.signal.length), 12);
  const show = (line: ScoreLine): void => {
    console.log(
      `  ${line.points > 0 ? '+' : ''}${String(line.points).padStart(4)}  ` +
        `${line.signal.padEnd(width)}  ${line.detail}`,
    );
  };

  console.log('  the project');
  if (view.repoLines.length === 0) console.log('    nothing measured');
  view.repoLines.forEach(show);
  console.log(`    subtotal ${view.repoSubtotal}`);

  console.log('\n  this issue');
  if (view.issueLines.length === 0) console.log('    nothing notable');
  view.issueLines.forEach(show);
  console.log(`    subtotal ${view.issueSubtotal}`);

  console.log(`  ${'='.repeat(6)}`);
  console.log(`  ${String(view.score).padStart(5)}  total`);

  if (view.unmeasured.length > 0) {
    console.log(`\nNot measured, contributing nothing either way: ${view.unmeasured.join(', ')}.`);
  }
  console.log(`\nLabels: ${view.issue.labels.length > 0 ? view.issue.labels.join(', ') : 'none'}`);
  console.log(`Weights live in src/rank/weights.ts — disagree with a line and change it there.\n`);
}

export async function decide(
  ref: string,
  verdict: string,
  options: DecideOptions = {},
): Promise<void> {
  const record = await recordDecision(ref, verdict, options);
  console.log(`\nRecorded: ${record.repoFullName}#${record.number} — ${record.verdict}`);
  console.log(`  ${record.title.slice(0, 80)}`);
  console.log(`It will no longer appear in the shortlist.\n`);
}

export async function journal(limit = 30): Promise<void> {
  const view = await getJournal(limit);

  if (view.entries.length === 0) {
    console.log(
      '\nNothing recorded yet. As you work through the shortlist:\n' +
        '  npm run compass -- decide owner/name#123 rejected --reason "needs design discussion"\n' +
        '  npm run compass -- decide owner/name#456 started --hours 4\n' +
        '  npm run compass -- decide owner/name#456 merged --actual-hours 11\n',
    );
    return;
  }

  console.log('');
  for (const entry of view.entries) {
    const hours =
      entry.ratio !== null
        ? `${entry.predictedHours}h predicted, ${entry.actualHours}h actual ` +
          `(${entry.ratio.toFixed(1)}x)`
        : entry.predictedHours !== null
          ? `${entry.predictedHours}h predicted`
          : entry.actualHours !== null
            ? `${entry.actualHours}h actual`
            : '';

    console.log(
      `${entry.lastAt.slice(0, 10)}  ${entry.trail.join(' -> ').padEnd(28)} ` +
        `${entry.repoFullName}#${entry.number}${hours ? `  ${hours}` : ''}`,
    );
    console.log(`            ${entry.title.slice(0, 76)}`);
    if (entry.reason) console.log(`            "${entry.reason}"`);
  }

  if (view.complete === 0) {
    console.log(
      `\nNo issue yet has both a prediction and an outcome. Record --hours when you start and ` +
        `--actual-hours when you finish; ${MIN_PAIRS_FOR_MEAN} of those and this reports your ` +
        `estimation bias.`,
    );
  } else if (view.meanRatio === null) {
    console.log(
      `\n${view.complete} issue(s) with both a prediction and an outcome. ${MIN_PAIRS_FOR_MEAN} is ` +
        `where the average starts meaning anything.`,
    );
  } else {
    console.log(
      `\nAcross ${view.complete} completed issues, actual time averaged ` +
        `${view.meanRatio.toFixed(1)}x your prediction.`,
    );
  }
  console.log('');
}
