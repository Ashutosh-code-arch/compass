/**
 * JSON API over the existing report functions.
 *
 * Deliberately thin. The data functions in `rank/data.ts` already return exactly what a client
 * needs, so this layer only parses query strings, maps a few error shapes onto status codes, and
 * serialises. Any logic that appears here is logic that belongs in the view layer where it can be
 * tested without a socket.
 *
 * No auth: single user, bound to localhost by default. GitHub OAuth belongs with multi-user, and
 * adding it now would be scaffolding for a requirement that does not exist yet.
 */

import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import {
  getJournal,
  getProfile,
  getShortlist,
  getWhy,
  recordDecision,
  saveProfile,
  type ShortlistOptions,
} from '../rank/data.ts';
import { MAX_PREFERENCE_POINTS, parseProfile, ProfileError } from '../rank/profile.ts';
import { LANGUAGE_POINTS } from '../rank/weights.ts';
import { isVerdict, VERDICTS } from '../rank/view.ts';
import { defined, flag, nonNegativeInt, positiveInt, signedInt } from '../params.ts';
import {
  activeJob,
  corpusSummary,
  isRunKind,
  JobBusyError,
  JobConfigError,
  clearAddError,
  lastAddError,
  nextStep,
  recentRuns,
  runningInDatabase,
  startAdd,
  RUN_KINDS,
  startJob,
  type JobOptions,
} from './jobs.ts';
import { getLanguages, getStacks } from '../rank/data.ts';
import { parseRepoRef, RepoNotFoundError } from '../sync/add.ts';
import { STACK_LABELS } from '../setup/stack.ts';
import { loadConfig } from '../config.ts';

/** Bad input is the client's fault; these read as 400 rather than 500. */
class BadRequest extends Error {}

function str(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new BadRequest('Expected a single value, got a list');
  return value === '' ? undefined : value;
}

/**
 * Query string to shortlist filters.
 *
 * Names match the CLI flags so that a URL and a command line are transcribable into each other,
 * which matters a great deal when the CLI is the debugging tool for the API.
 */
export function shortlistQuery(query: Record<string, unknown>): ShortlistOptions {
  const get = (name: string): string | undefined => str(query[name]);
  return defined({
    limit: positiveInt(get('limit')),
    offset: nonNegativeInt(get('offset')),
    minScore: signedInt(get('min-score')),
    stack: get('stack'),
    perRepo: positiveInt(get('per-repo')),
    language: get('language'),
    labelledOnly: flag(get('labelled')),
    includeDormant: flag(get('include-dormant')),
    maxSetupWeight: get('max-setup'),
    minStars: positiveInt(get('min-stars')),
    maxStars: positiveInt(get('max-stars')),
    fetchLimit: positiveInt(get('fetch-limit')),
  });
}

interface DecisionBody {
  ref?: unknown;
  verdict?: unknown;
  predictedHours?: unknown;
  actualHours?: unknown;
  reason?: unknown;
}

/** Staleness windows accept 0, meaning "refresh everything now"; limits must be positive. */
function numberOrUndefined(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const parsed = typeof value === 'number' ? value : Number(value);
  const floor = field === 'limit' ? 1 : 0;
  if (!Number.isInteger(parsed) || parsed < floor) {
    throw new BadRequest(`${field} must be a whole number of ${floor} or more`);
  }
  return parsed;
}

function hours(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new BadRequest(`${field} must be a positive number, got ${JSON.stringify(value)}`);
  }
  return parsed;
}

/** The Vite build output. Absent until `npm run web:build` has been run at least once. */
const WEB_ROOT = fileURLToPath(new URL('../../public/', import.meta.url));

export interface BuildOptions {
  /** Serve the built frontend from the same origin. Off in tests; on for `serve`. */
  serveWeb?: boolean;
}

export function buildServer(options: BuildOptions = {}): FastifyInstance {
  const app = Fastify({ logger: false });

  // Same origin for the app and the API, so the production path needs no CORS. In development Vite
  // proxies /api here instead, which keeps that true on both paths.
  const web = options.serveWeb === true && existsSync(WEB_ROOT);
  if (web) {
    void app.register(fastifyStatic, { root: WEB_ROOT, prefix: '/' });
  }

  app.get('/api/health', async () => ({ ok: true }));

  /** The vocabulary of the workflow board, so the UI does not hardcode its own copy. */
  app.get('/api/verdicts', async () => ({ verdicts: VERDICTS }));

  app.get('/api/shortlist', async (request) => {
    const options = shortlistQuery(request.query as Record<string, unknown>);
    return getShortlist(options);
  });

  /**
   * `owner/name#123` does not survive a path segment intact, so the reference is split across three
   * parameters and reassembled.
   */
  app.get<{ Params: { owner: string; name: string; number: string } }>(
    '/api/issues/:owner/:name/:number/why',
    async (request, reply) => {
      const { owner, name, number } = request.params;
      if (!/^\d+$/.test(number)) throw new BadRequest(`Issue number must be numeric, got "${number}"`);
      const view = await getWhy(`${owner}/${name}#${number}`);
      if (!view) {
        return reply.code(404).send({
          error: 'not a current candidate',
          detail:
            `${owner}/${name}#${number} may be closed, assigned, already judged, or in a repo ` +
            `that is not synced.`,
        });
      }
      return view;
    },
  );

  /** Canonical language names with repo counts, so the UI offers a list instead of a text box. */
  app.get('/api/languages', async () => ({ languages: await getLanguages() }));

  /** Detected frameworks present in the corpus, with counts, so the UI offers a list. */
  app.get('/api/stacks', async () => ({
    stacks: await getStacks(),
    labels: STACK_LABELS,
  }));

  /**
   * Adds a project by name and makes it rankable.
   *
   * 202 rather than 201: the metadata is written first, but the issue, metric and setup scans that
   * follow are still running when this responds, so the row exists and is not yet rankable. Poll
   * /api/sync to watch it finish.
   */
  app.post<{ Body: { ref?: unknown; metadataOnly?: unknown } }>(
    '/api/repos',
    async (request, reply) => {
      const ref = typeof request.body?.ref === 'string' ? request.body.ref.trim() : '';
      if (ref === '') throw new BadRequest('A repository reference is required, as owner/name');
      // Shape-checked here so an obvious typo is a 400 rather than a background job that fails
      // somewhere the user has to go looking for.
      parseRepoRef(ref);
      clearAddError();
      const started = await startAdd(ref, request.body?.metadataOnly === true);
      return reply.code(202).send({ started });
    },
  );

  app.get('/api/sync', async () => {
    const corpus = await corpusSummary();
    return {
      kinds: RUN_KINDS,
      active: activeJob(),
      /** What to press next, given what the corpus is missing. */
      nextStep: nextStep(corpus),
      /** A failed add leaves no useful trace in sync_runs, so it is surfaced separately. */
      lastAddError: lastAddError(),
      /** Rows the database still calls running: another terminal, or a process that died mid-run. */
      runningElsewhere: await runningInDatabase(),
      tokenConfigured: Boolean(loadConfig().githubToken),
      corpus,
      runs: await recentRuns(),
    };
  });

  app.post<{ Params: { kind: string }; Body: JobOptions }>(
    '/api/sync/:kind',
    async (request, reply) => {
      const { kind } = request.params;
      if (!isRunKind(kind)) {
        throw new BadRequest(`Unknown sync "${kind}". One of: ${RUN_KINDS.join(', ')}`);
      }
      const body = request.body ?? {};
      const options: JobOptions = defined({
        limit: numberOrUndefined(body.limit, 'limit'),
        staleHours: numberOrUndefined(body.staleHours, 'staleHours'),
        staleDays: numberOrUndefined(body.staleDays, 'staleDays'),
        repo: typeof body.repo === 'string' && body.repo.trim() !== '' ? body.repo.trim() : undefined,
      });
      // 202: accepted and under way. The run is not finished, and the response must not imply it is.
      return reply.code(202).send({ started: await startJob(kind, options) });
    },
  );

  app.get('/api/profile', async () => {
    const profile = await getProfile();
    // The settings screen needs the defaults to show what an empty profile falls back to, and the
    // ceiling to explain the validation before the user trips it.
    return { profile, defaults: { languagePoints: LANGUAGE_POINTS }, maxPoints: MAX_PREFERENCE_POINTS };
  });

  app.put('/api/profile', async (request) => {
    const profile = await saveProfile(parseProfile(request.body));
    return { profile };
  });

  app.get('/api/journal', async (request) => {
    const query = request.query as Record<string, unknown>;
    return getJournal(positiveInt(str(query['limit'])) ?? 30);
  });

  app.post<{ Body: DecisionBody }>('/api/decisions', async (request, reply) => {
    const body = request.body ?? {};
    const ref = typeof body.ref === 'string' ? body.ref : undefined;
    const verdict = typeof body.verdict === 'string' ? body.verdict : undefined;
    if (!ref || !verdict) throw new BadRequest('Both ref and verdict are required');
    if (!isVerdict(verdict)) {
      throw new BadRequest(`Unknown verdict "${verdict}". One of: ${VERDICTS.join(', ')}`);
    }

    const record = await recordDecision(
      ref,
      verdict,
      defined({
        predictedHours: hours(body.predictedHours, 'predictedHours'),
        actualHours: hours(body.actualHours, 'actualHours'),
        reason: typeof body.reason === 'string' && body.reason !== '' ? body.reason : undefined,
      }),
    );
    return reply.code(201).send(record);
  });

  /**
   * Error mapping.
   *
   * `parseIssueRef` and the verdict check throw plain Errors with messages written for a human, and
   * those are client mistakes rather than server faults. Anything unrecognised is a real 500 and the
   * message is kept off the wire.
   */
  app.setErrorHandler((error: unknown, request, reply) => {
    const message = error instanceof Error ? error.message : String(error);
    const clientFault =
      error instanceof BadRequest ||
      error instanceof ProfileError ||
      /^Expected |^Unknown verdict |is not in the corpus/.test(message);
    if (error instanceof RepoNotFoundError) return reply.code(404).send({ error: message });
    if (error instanceof JobBusyError) return reply.code(409).send({ error: message });
    // 503: the server is fine, but it is not configured to reach GitHub.
    if (error instanceof JobConfigError) return reply.code(503).send({ error: message });
    if (clientFault) {
      return reply.code(400).send({ error: message });
    }
    console.error(
      `[api] ${request.method} ${request.url}: ` +
        `${error instanceof Error ? (error.stack ?? message) : message}`,
    );
    return reply.code(500).send({ error: 'internal error' });
  });

  /**
   * A missing /api route is a 404 in JSON; anything else is a client-side route.
   *
   * The distinction matters: returning index.html for an unknown API path would hand a fetch() a
   * page of HTML and produce a parse error several layers away from the actual mistake.
   */
  app.setNotFoundHandler(async (request, reply) => {
    if (!web || request.url.startsWith('/api/') || request.method !== 'GET') {
      return reply.code(404).send({ error: `No route for ${request.method} ${request.url}` });
    }
    return reply.sendFile('index.html');
  });

  return app;
}

export interface ServeOptions {
  port?: number;
  host?: string;
}

export async function serve(options: ServeOptions = {}): Promise<FastifyInstance> {
  const app = buildServer({ serveWeb: true });
  // Localhost by default: this is a single-user tool with no authentication, and binding 0.0.0.0
  // would put an unauthenticated write endpoint on the network.
  const host = options.host ?? process.env['COMPASS_HOST'] ?? '127.0.0.1';
  const port = options.port ?? positiveInt(process.env['COMPASS_PORT']) ?? 8787;
  await app.listen({ port, host });
  const hasWeb = existsSync(WEB_ROOT);
  console.log(`\nCompass listening on http://${host}:${port}`);
  console.log(
    hasWeb
      ? `  the app is at http://${host}:${port}/`
      : `  no frontend build found — run \`npm run web:build\`, or \`npm run web:dev\` for hot reload`,
  );
  console.log(`  GET  /api/shortlist?limit=20&min-score=20&per-repo=2&language=TypeScript`);
  console.log(`  GET  /api/issues/:owner/:name/:number/why`);
  console.log(`  GET  /api/journal?limit=30`);
  console.log(`  POST /api/decisions   {"ref":"owner/name#123","verdict":"started","predictedHours":4}`);
  console.log(`  GET  /api/verdicts    /api/health\n`);
  return app;
}
