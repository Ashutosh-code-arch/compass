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
import { serve } from './http/server.ts';

const USAGE = `
opensource-compass — corpus, responsiveness, setup cost, ranked shortlist

  migrate                            apply pending SQL migrations
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
  shortlist [--limit 20] [--min-score 20] [--per-repo 2]
                                     ranked issues, with the evidence for each
            [--language X] [--labelled] [--max-setup light|moderate]
            [--min-stars N] [--max-stars N] [--include-dormant]
            [--fetch-limit 50000]  rows fetched before ranking; a hit cap is reported
  why owner/name#123                 itemised score breakdown for one issue
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
  'backfill-max-pages': { type: 'string' },
  'incremental-max-pages': { type: 'string' },
  help: { type: 'boolean', short: 'h' },
} as const;

const SORTS = new Set<MaintainerSort>(['median', 'ignored', 'stale', 'reviewed', 'merge']);
const SETUP_SORTS = new Set<SetupSort>(['weight', 'services', 'env', 'runtime']);

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
          labelledOnly: values.labelled,
          includeDormant: values['include-dormant'],
          maxSetupWeight: values['max-setup'],
          minStars: positiveInt(values['min-stars']),
          maxStars: positiveInt(values['max-stars']),
          fetchLimit: positiveInt(values['fetch-limit']),
        }),
      );
      return;
    }

    case 'why': {
      if (!subcommand) throw new Error('why needs an issue: why owner/name#123');
      await why(subcommand);
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
