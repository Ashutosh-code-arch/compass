import { loadConfig } from '../config.ts';
import { db, jsonb } from '../db.ts';
import { GitHubGraphQL } from '../github/graphql.ts';
import { mapLimit } from '../github/rest.ts';
import type { SetupFacts } from '../setup/parse.ts';
import { buildSetupQuery, mapSetupRepository, type GqlSetupRepository } from './setup_query.ts';
import { withSyncRun, type RunSummary } from './run.ts';

export interface SyncSetupOptions {
  /** Repository layout changes slowly; a month-old reading is still a good reading. */
  staleDays?: number;
  limit?: number;
  repo?: string;
  /** Repos per GraphQL request. Kept low because this query returns file contents. */
  batchSize?: number;
}

interface SetupTarget {
  id: number;
  owner: string;
  name: string;
  full_name: string;
}

/**
 * Reads a fixed set of files at HEAD for each repo and derives setup facts from them.
 *
 * Batch size is deliberately smaller than the metrics sync: this query returns blob text, so the
 * constraint is response size rather than rate-limit points.
 */
export async function syncSetup(options: SyncSetupOptions = {}): Promise<RunSummary> {
  const staleDays = options.staleDays ?? 30;
  const batchSize = Math.max(1, Math.min(options.batchSize ?? 3, 10));
  const pool = db();

  const targets = options.repo
    ? (
        await pool.query<SetupTarget>(
          `select id, owner, name, full_name from repos where full_name = $1`,
          [options.repo],
        )
      ).rows
    : (
        await pool.query<SetupTarget>(
          `select r.id, r.owner, r.name, r.full_name
             from repos r
             left join setup_facts f on f.repo_id = r.id
            where r.sync_state = 'active'
              and (f.computed_at is null
                   or f.computed_at < now() - make_interval(days => $1::int))
            order by f.computed_at nulls first, r.stars desc
            limit $2`,
          [staleDays, options.limit ?? 300],
        )
      ).rows;

  if (targets.length === 0) {
    console.log(`Nothing to inspect (all setup facts newer than ${staleDays}d).`);
  } else {
    console.log(`Reading setup files for ${targets.length} repos (batches of ${batchSize})...`);
  }

  const batches: SetupTarget[][] = [];
  for (let index = 0; index < targets.length; index += batchSize) {
    batches.push(targets.slice(index, index + batchSize));
  }

  return withSyncRun('setup', async (ctx) => {
    const graphql = new GitHubGraphQL(ctx.budget);
    void loadConfig();
    let inspected = 0;
    let missing = 0;
    const distribution: Record<string, number> = {};

    const started = Date.now();
    let done = 0;
    let failedBatches = 0;
    const errors: string[] = [];

    await mapLimit(batches, 2, async (batch, batchIndex) => {
      try {
        await processBatch(batch);
      } catch (err) {
        if (err instanceof Error && err.name === 'BudgetExhaustedError') throw err;
        failedBatches += 1;
        const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
        if (errors.length < 5) errors.push(message.slice(0, 300));
        console.warn(
          `[setup] batch ${batchIndex + 1} (${batch[0]?.full_name}) failed: ${message.slice(0, 160)}`,
        );
      }

      done += batch.length;
      if (done % 100 < batch.length || done === targets.length) {
        const elapsed = Math.round((Date.now() - started) / 1000);
        console.log(`  ${done}/${targets.length} repos  ${elapsed}s  ${ctx.budget.graphqlPoints} points`);
      }
    });

    async function processBatch(batch: SetupTarget[]): Promise<void> {
      const query = buildSetupQuery(batch.length);
      const variables: Record<string, unknown> = {};
      batch.forEach((target, index) => {
        variables[`o${index}`] = target.owner;
        variables[`n${index}`] = target.name;
      });

      const { data, partialErrors } = await graphql.query<
        Record<string, GqlSetupRepository | null>
      >(query, variables);

      for (const [index, target] of batch.entries()) {
        const repository = data[`r${index}`];

        if (!repository) {
          const error = partialErrors.find((entry) => entry.path?.[0] === `r${index}`);
          missing += 1;
          await pool.query(
            `update repos set sync_state = 'gone', sync_error = $2 where id = $1`,
            [target.id, `setup: ${error?.type ?? 'NOT_FOUND'} ${error?.message ?? ''}`.slice(0, 500)],
          );
          continue;
        }

        const facts = mapSetupRepository(repository);
        await storeSetupFacts(target.id, facts);
        inspected += 1;
        ctx.reposSeen += 1;
        distribution[facts.setupWeight] = (distribution[facts.setupWeight] ?? 0) + 1;
      }
    }

    ctx.detail = { inspected, missing, failedBatches, sampleErrors: errors, staleDays, batchSize, distribution };
    console.log(`Inspected ${inspected}, unreachable ${missing}, failed batches ${failedBatches}`);
    if (Object.keys(distribution).length > 0) {
      console.log(
        `Setup weight: ${Object.entries(distribution)
          .sort((a, b) => b[1] - a[1])
          .map(([weight, count]) => `${weight} ${count}`)
          .join(', ')}`,
      );
    }
  });
}

const SETUP_COLUMNS = [
  'repo_id',
  'computed_at',
  'tree_truncated',
  'files_seen',
  'compose_path',
  'compose_services',
  'compose_service_names',
  'compose_builds_local',
  'has_dockerfile',
  'has_devcontainer',
  'runtimes',
  'package_manager',
  'is_monorepo',
  'env_example_path',
  'env_var_count',
  'has_contributing',
  'has_readme',
  'task_runner',
  'ci_workflow_count',
  'ci_runs_on_pr',
  'external_services',
  'needs_database',
  'needs_cache',
  'needs_queue',
  'setup_weight',
  'signals',
];

async function storeSetupFacts(repoId: number, facts: SetupFacts): Promise<void> {
  const values = [
    repoId,
    new Date().toISOString(),
    facts.treeTruncated,
    facts.filesSeen,
    facts.composePath,
    facts.composeServices,
    facts.composeServiceNames,
    facts.composeBuildsLocal,
    facts.hasDockerfile,
    facts.hasDevcontainer,
    jsonb(facts.runtimes),
    facts.packageManager,
    facts.isMonorepo,
    facts.envExamplePath,
    facts.envVarCount,
    facts.hasContributing,
    facts.hasReadme,
    facts.taskRunner,
    facts.ciWorkflowCount,
    facts.ciRunsOnPr,
    facts.externalServices,
    facts.needsDatabase,
    facts.needsCache,
    facts.needsQueue,
    facts.setupWeight,
    jsonb({
      composeServiceNames: facts.composeServiceNames,
      runtimes: facts.runtimes,
      externalServices: facts.externalServices,
    }),
  ];

  const placeholders = values.map((_unused, index) => `$${index + 1}`).join(', ');
  const updates = SETUP_COLUMNS.slice(1)
    .map((column) => `${column} = excluded.${column}`)
    .join(', ');

  await db().query(
    `insert into setup_facts (${SETUP_COLUMNS.join(', ')}) values (${placeholders})
     on conflict (repo_id) do update set ${updates}`,
    values,
  );
}
