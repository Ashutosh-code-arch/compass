import { parseArgs } from 'node:util';
import { defined, nonNegativeInt, positiveInt, signedInt } from './params.ts';
import { closeDb } from './db.ts';
import { migrate } from './migrate.ts';
import { prune } from './prune.ts';
import {
  explainRepo,
  maintainers,
  responders,
  setupReport,
  type MaintainerSort,
  type SetupSort,
} from './report.ts';
import { status } from './status.ts';
import { seed } from './sync/seed.ts';
import { syncIssues } from './sync/issues.ts';
import { syncMetrics } from './sync/metrics.ts';
import { syncRepos } from './sync/repos.ts';
import { syncSetup } from './sync/setup.ts';
import { decide, journal, shortlist, why } from './rank/render.ts';
import { gsocImport, orgs } from './org/render.ts';
import { rossImport } from './org/ross_import.ts';
import { claims } from './claims/render.ts';
import { isMomentum, MOMENTUM_VERDICTS } from './velocity/index.ts';
import { isWeightSet, WEIGHT_SETS } from './rank/weight_sets.ts';
import type { OrgSort } from './org/view.ts';
import { serve } from './http/server.ts';
import { addAndPrepare } from './sync/add.ts';

const USAGE = `
opensource-compass — corpus, responsiveness, setup cost, ranked shortlist

  migrate                            apply pending SQL migrations
  add owner/name                     add a project you care about, then make it rankable
      [--metadata-only]              (fetches its issues, metrics and setup by default)
  seed [--dry-run] [--only id,id]    discover repos via the seed queries
       [--max-pages N]
  sync repos [--stale-hours 24]      refresh repo metadata (conditional GETs)
             [--limit N] [--repo owner/name]
  sync issues [--limit N]            incremental issue sync
              [--repo owner/name]
              [--backfill-max-pages N] [--incremental-max-pages N]
  sync metrics [--stale-days 7]      maintainer responsiveness, via GraphQL
               [--limit N] [--repo owner/name]
               [--window-days 180] [--pr-count 40] [--batch-size 5]
               [--grace-days 7]
  sync setup [--stale-days 30]       setup complexity from files at HEAD
             [--limit N] [--repo owner/name] [--batch-size 3]
  sync all                           repos, issues, metrics, then setup
  orgs [--sort attention|candidates|name] [--momentum hype|rising|steady|cooling]
                                     organisations ranked by whether anyone reads outside work
       [--gsoc 2026|any] [--language X] [--min-repos N]
       [--uncovered]                  only ones with no repositories in the corpus
       [--limit 50] [--offset N]
  gsoc import <file> --year N --source "..."
                                     tag organisations as GSoC participants for a year
             [--replace]              drop that year's existing tags first
  ross import <file> --quarter 2026Q1 --source "..."
                                     ingest a ROSS Index dataset: who is growing, and who funds them
  shortlist [--limit 20] [--min-score 20] [--per-repo 2]
                                     ranked issues, with the evidence for each
            [--org login]             drill into one organisation from the orgs table
            [--stack react|js|django|...]  what it is BUILT with, from dependencies + topics
            [--language X] [--labelled] [--max-setup light|moderate]
            [--min-stars N] [--max-stars N] [--include-dormant]
            [--exclude-claimed]      drop issues a claim check found taken
            [--momentum hype|rising|steady|cooling]
                                     growth crossed with review capacity
            [--weights career-leverage]
                                     score against a named set for this run only
            [--fetch-limit 50000]  rows fetched before ranking; a hit cap is reported
  why owner/name#123                 itemised score breakdown for one issue
  claims owner/name#123              is it actually free? reads the comment thread
         [--cached]                  reuse an earlier check instead of fetching
  decide owner/name#123 <verdict>    record a judgement; removes it from the shortlist
         [--hours N] [--actual-hours N] [--reason "..."]
         verdicts: shortlisted rejected started abandoned submitted
                   merged closed_unmerged stalled
  journal [--limit N]                what you decided, predicted vs actual
  prune [--dormant] [--heavy]        pause repos not worth issue-syncing (dry run by default)
        [--min-confidence medium|high] [--apply] [--unpause]

  setup [--sort weight|services|env|runtime]
        [--limit N] [--weight light|moderate|heavy] [--max-services N]
  maintainers [--sort median|ignored|stale|reviewed|merge]
              [--limit N] [--min-prs N] [--bucket dormant|slow|moderate|responsive]
  explain owner/name                 per-PR evidence behind one repo's metrics
  responders [--limit N] [--repo owner/name]
                                     who answers external PRs; exposes bot first-responders
  status                             corpus counts, journal, recent runs + budget usage
  serve [--port 8787] [--host 127.0.0.1]
                                     JSON API over the reports, for the UI

Env: DATABASE_URL, GITHUB_TOKEN (see .env.example)
`;

const OPTIONS = {
  'dry-run': { type: 'boolean' },
  only: { type: 'string' },
  'max-pages': { type: 'string' },
  'stale-hours': { type: 'string' },
  'stale-days': { type: 'string' },
  'window-days': { type: 'string' },
  'grace-days': { type: 'string' },
  'pr-count': { type: 'string' },
  'batch-size': { type: 'string' },
  'min-prs': { type: 'string' },
  bucket: { type: 'string' },
  weight: { type: 'string' },
  'max-services': { type: 'string' },
  'min-score': { type: 'string' },
  'per-repo': { type: 'string' },
  'max-setup': { type: 'string' },
  'min-stars': { type: 'string' },
  'fetch-limit': { type: 'string' },
  'max-stars': { type: 'string' },
  'include-dormant': { type: 'boolean' },
  stack: { type: 'string' },
  'metadata-only': { type: 'boolean' },
  labelled: { type: 'boolean' },
  apply: { type: 'boolean' },
  dormant: { type: 'boolean' },
  heavy: { type: 'boolean' },
  unpause: { type: 'boolean' },
  'min-confidence': { type: 'string' },
  language: { type: 'string' },
  hours: { type: 'string' },
  'actual-hours': { type: 'string' },
  reason: { type: 'string' },
  sort: { type: 'string' },
  limit: { type: 'string' },
  repo: { type: 'string' },
  port: { type: 'string' },
  host: { type: 'string' },
  offset: { type: 'string' },
  'backfill-max-pages': { type: 'string' },
  'incremental-max-pages': { type: 'string' },
  org: { type: 'string' },
  gsoc: { type: 'string' },
  uncovered: { type: 'boolean' },
  'min-repos': { type: 'string' },
  year: { type: 'string' },
  source: { type: 'string' },
  replace: { type: 'boolean' },
  cached: { type: 'boolean' },
  quarter: { type: 'string' },
  'exclude-claimed': { type: 'boolean' },
  momentum: { type: 'string' },
  weights: { type: 'string' },
  help: { type: 'boolean', short: 'h' },
} as const;

const SORTS = new Set<MaintainerSort>(['median', 'ignored', 'stale', 'reviewed', 'merge']);
const SETUP_SORTS = new Set<SetupSort>(['weight', 'services', 'env', 'runtime']);
const ORG_SORTS = new Set<OrgSort>(['attention', 'candidates', 'name']);

/**
 * `--momentum rising`, and nothing else.
 *
 * Refused rather than ignored, like `--stack` and `--gsoc`. A silently dropped momentum filter would
 * return the whole corpus under a heading claiming every row was vetted for review capacity, which is
 * the most misleading version of this failure yet.
 */
/** Refused rather than ignored: a weight set that silently fell back to default would be a lie. */
function parseWeightSet(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (!isWeightSet(value)) {
    throw new Error(`--weights takes one of: ${WEIGHT_SETS.join(', ')}. Got "${value}".`);
  }
  return value;
}

function parseMomentum(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (!isMomentum(value)) {
    throw new Error(`--momentum takes one of: ${MOMENTUM_VERDICTS.join(', ')}. Got "${value}".`);
  }
  return value;
}

/**
 * `--gsoc 2026` or `--gsoc any`.
 *
 * Anything else is refused rather than ignored. A silently dropped filter produces a plausible answer
 * to a question nobody asked — the same failure as the unrecognised `--stack` that once returned the
 * entire corpus.
 */
function parseGsocFilter(value: string | undefined): number | 'any' | undefined {
  if (value === undefined) return undefined;
  if (value === 'any') return 'any';
  // Shape-tested before parsing so the message can mention "any". positiveInt would throw first with
  // a true but less helpful error.
  const year = /^\d{4}$/.test(value) ? Number(value) : NaN;
  if (!Number.isInteger(year) || year < 2005 || year > 2100) {
    throw new Error(`--gsoc takes a four-digit year or "any", not "${value}". GSoC began in 2005.`);
  }
  return year;
}

/**
 * Returns 'listening' when the process is expected to stay alive — the API server holds the
 * socket open and closing the connection pool underneath it would break the first request.
 */
async function main(): Promise<'listening' | void> {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    options: OPTIONS,
    allowPositionals: true,
  });

  if (values.help || positionals.length === 0) {
    console.log(USAGE);
    return;
  }

  const [command, subcommand] = positionals;

  switch (command) {
    case 'migrate':
      await migrate();
      return;

    case 'add': {
      const ref = positionals[1];
      if (!ref) throw new Error('Usage: add owner/name');
      await addAndPrepare(ref, defined({ metadataOnly: values['metadata-only'] }));
      return;
    }

    case 'status':
      await status();
      return;

    // Long-running: main() resolves once the socket is listening, and the open handle keeps the
    // process alive. closeDb() must not run here, so this returns the server rather than void.
    case 'serve':
      await serve(defined({ port: positiveInt(values.port), host: values.host }));
      return 'listening';

    case 'seed':
      await seed(
        defined({
          dryRun: values['dry-run'],
          only: values.only?.split(',').map((part) => part.trim()).filter(Boolean),
          maxPages: positiveInt(values['max-pages']),
        }),
      );
      return;

    case 'maintainers': {
      const sort = values.sort;
      if (sort !== undefined && !SORTS.has(sort as MaintainerSort)) {
        throw new Error(`Unknown sort "${sort}". Try: ${[...SORTS].join(', ')}`);
      }
      await maintainers(
        defined({
          sort: sort as MaintainerSort | undefined,
          limit: positiveInt(values.limit),
          minExternalPrs: positiveInt(values['min-prs']),
          bucket: values.bucket,
        }),
      );
      return;
    }

    case 'shortlist': {
      await shortlist(
        defined({
          limit: positiveInt(values.limit),
          minScore: signedInt(values['min-score']),
          perRepo: positiveInt(values['per-repo']),
          language: values.language,
          org: values.org,
          stack: values.stack,
          labelledOnly: values.labelled,
          excludeClaimed: values['exclude-claimed'],
          momentum: parseMomentum(values.momentum),
          includeDormant: values['include-dormant'],
          maxSetupWeight: values['max-setup'],
          minStars: positiveInt(values['min-stars']),
          maxStars: positiveInt(values['max-stars']),
          fetchLimit: positiveInt(values['fetch-limit']),
          weightSet: parseWeightSet(values.weights),
        }),
      );
      return;
    }

    case 'orgs': {
      const sort = values.sort;
      if (sort !== undefined && !ORG_SORTS.has(sort as OrgSort)) {
        throw new Error(`Unknown sort "${sort}". Try: ${[...ORG_SORTS].join(', ')}`);
      }
      await orgs(
        defined({
          sort: sort as OrgSort | undefined,
          gsoc: parseGsocFilter(values.gsoc),
          momentum: parseMomentum(values.momentum),
          language: values.language,
          minRepos: positiveInt(values['min-repos']),
          uncoveredOnly: values.uncovered,
          limit: positiveInt(values.limit),
          offset: nonNegativeInt(values.offset),
        }),
      );
      return;
    }

    case 'gsoc': {
      if (subcommand !== 'import') {
        throw new Error('Usage: gsoc import <file> --year 2026 --source "..."');
      }
      const path = positionals[2];
      if (!path) throw new Error('gsoc import needs a file: gsoc import gsoc-2026.txt --year 2026');

      const year = positiveInt(values.year);
      if (year === undefined) {
        throw new Error('gsoc import needs --year, e.g. --year 2026');
      }
      // Required, not defaulted. A curated claim with no provenance is indistinguishable from a
      // measurement, and it is the kind that goes stale without anyone noticing.
      const source = values.source;
      if (source === undefined || source.trim() === '') {
        throw new Error(
          'gsoc import needs --source, e.g. --source "summerofcode.withgoogle.com, read 2026-08-04". ' +
            'Every curated value carries where it came from.',
        );
      }

      await gsocImport(path, year, source, values.replace === true);
      return;
    }

    case 'ross': {
      if (subcommand !== 'import') {
        throw new Error('Usage: ross import <file> --quarter 2026Q1 --source "..."');
      }
      const path = positionals[2];
      if (!path) throw new Error('ross import needs a file: ross import ross-2026q1.csv --quarter 2026Q1');
      const quarter = values.quarter;
      if (quarter === undefined || quarter.trim() === '') {
        throw new Error('ross import needs --quarter, e.g. --quarter 2026Q1');
      }
      const source = values.source;
      if (source === undefined || source.trim() === '') {
        throw new Error(
          'ross import needs --source. Every curated value carries where it came from, e.g. ' +
            '--source "RunaCapital/ROSS-Index, read 2026-08-04".',
        );
      }
      await rossImport(path, quarter, source);
      return;
    }

    case 'why': {
      if (!subcommand) throw new Error('why needs an issue: why owner/name#123');
      await why(subcommand);
      return;
    }

    case 'claims': {
      if (!subcommand) throw new Error('claims needs an issue: claims owner/name#123');
      await claims(subcommand, values.cached === true);
      return;
    }

    case 'decide': {
      const [, ref, verdict] = positionals;
      if (!ref || !verdict) {
        throw new Error('decide needs an issue and a verdict: decide owner/name#123 rejected');
      }
      await decide(
        ref,
        verdict,
        defined({
          predictedHours: positiveInt(values.hours),
          actualHours: positiveInt(values['actual-hours']),
          reason: values.reason,
        }),
      );
      return;
    }

    case 'prune': {
      await prune(
        defined({
          apply: values.apply,
          // --heavy alone should not silently also prune dormant repos.
          dormant: values.dormant ?? (values.heavy ? false : true),
          heavy: values.heavy,
          minConfidence: values['min-confidence'],
          unpause: values.unpause,
        }),
      );
      return;
    }

    case 'journal': {
      await journal(positiveInt(values.limit) ?? 30);
      return;
    }

    case 'setup': {
      const sort = values.sort;
      if (sort !== undefined && !SETUP_SORTS.has(sort as SetupSort)) {
        throw new Error(`Unknown sort "${sort}". Try: ${[...SETUP_SORTS].join(', ')}`);
      }
      await setupReport(
        defined({
          sort: sort as SetupSort | undefined,
          limit: positiveInt(values.limit),
          weight: values.weight,
          maxServices: positiveInt(values['max-services']),
        }),
      );
      return;
    }

    case 'responders': {
      await responders(positiveInt(values.limit) ?? 30, values.repo);
      return;
    }

    case 'explain': {
      if (!subcommand) throw new Error('explain needs a repo: explain owner/name');
      await explainRepo(subcommand);
      return;
    }

    case 'sync': {
      const repoOptions = defined({
        staleHours: nonNegativeInt(values['stale-hours']),
        limit: positiveInt(values.limit),
        repo: values.repo,
      });
      const issueOptions = defined({
        limit: positiveInt(values.limit),
        repo: values.repo,
        backfillMaxPages: positiveInt(values['backfill-max-pages']),
        incrementalMaxPages: positiveInt(values['incremental-max-pages']),
      });
      const metricOptions = defined({
        staleDays: nonNegativeInt(values['stale-days']),
        limit: positiveInt(values.limit),
        repo: values.repo,
        windowDays: positiveInt(values['window-days']),
        graceDays: nonNegativeInt(values['grace-days']),
        prCount: positiveInt(values['pr-count']),
        batchSize: positiveInt(values['batch-size']),
      });

      if (subcommand === 'repos') {
        await syncRepos(repoOptions);
        return;
      }
      if (subcommand === 'issues') {
        await syncIssues(issueOptions);
        return;
      }
      if (subcommand === 'metrics') {
        await syncMetrics(metricOptions);
        return;
      }
      const setupOptions = defined({
        staleDays: nonNegativeInt(values['stale-days']),
        limit: positiveInt(values.limit),
        repo: values.repo,
        batchSize: positiveInt(values['batch-size']),
      });
      if (subcommand === 'setup') {
        await syncSetup(setupOptions);
        return;
      }
      if (subcommand === 'all' || subcommand === undefined) {
        await syncRepos(repoOptions);
        await syncIssues(issueOptions);
        await syncMetrics(metricOptions);
        await syncSetup(setupOptions);
        return;
      }
      throw new Error(
        `Unknown sync target "${subcommand}". Try repos, issues, metrics, setup, or all.`,
      );
    }

    default:
      throw new Error(`Unknown command "${command}".${USAGE}`);
  }
}

// process.exit() abandons pending stdout writes. When stdout is a pipe rather than a TTY those
// writes are buffered and asynchronous, so exiting immediately can discard a whole run's output.
// Setting exitCode and letting the loop drain is the safe form; closeDb releases the pool's
// handles, so nothing keeps the process alive afterwards.
process.on('unhandledRejection', (reason) => {
  console.error(`\nUnhandled rejection: ${reason instanceof Error ? reason.stack : String(reason)}`);
  process.exitCode = 1;
});

main()
  .then((outcome) => (outcome === 'listening' ? undefined : closeDb()))
  .catch(async (err: unknown) => {
    console.error(
      `\n${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`,
    );
    if (err instanceof Error && err.cause !== undefined) {
      // undici puts the real reason here: "SocketError: other side closed" and friends.
      console.error(`caused by: ${String(err.cause)}`);
    }
    if (process.env['COMPASS_DEBUG'] && err instanceof Error && err.stack) {
      console.error(err.stack);
    }
    await closeDb().catch(() => {});
    process.exitCode = 1;
  });
