import { loadConfig, requireGitHubToken, type Config } from '../config.ts';
import { Budget, BudgetExhaustedError } from './rest.ts';

const ENDPOINT = 'https://api.github.com/graphql';

/** Every query should request this so cost accounting is measured rather than guessed. */
export const RATE_LIMIT_FRAGMENT = `rateLimit { limit cost remaining resetAt }`;

interface RateLimitBlock {
  limit: number;
  cost: number;
  remaining: number;
  resetAt: string;
}

export interface GraphQLErrorEntry {
  type?: string;
  message: string;
  path?: (string | number)[];
}

export interface GraphQLResponse<T> {
  data?: T & { rateLimit?: RateLimitBlock };
  errors?: GraphQLErrorEntry[];
}

export class GraphQLRequestError extends Error {
  readonly errors: GraphQLErrorEntry[];

  constructor(errors: GraphQLErrorEntry[]) {
    super(`GraphQL error: ${errors.map((e) => e.message).join('; ').slice(0, 400)}`);
    this.name = 'GraphQLRequestError';
    this.errors = errors;
  }
}

const MAX_ATTEMPTS = 4;
const RETRYABLE_HTTP = new Set([500, 502, 503, 504]);
/** GitHub also enforces roughly 2,000 points/minute on GraphQL beyond the hourly limit. */
const MAX_SLEEP_MS = 90_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Errors that concern one aliased sub-query rather than the whole request. GitHub answers a
 * batched query with HTTP 200, nulls for the aliases that failed, and an errors array carrying
 * the path — so a single deleted repo must not discard the other repos in the batch.
 */
/**
 * fetch rejects only for network-level failures — a dropped socket, a reset connection, a body cut
 * off mid-stream. HTTP status codes never reject. So any throw here is transient by definition.
 */
function isTransientFetchFailure(error: unknown): boolean {
  return error instanceof Error && error.name !== 'AbortError';
}

/**
 * Fetch AND read the body as one guarded operation.
 *
 * This matters: undici raises `TypeError: terminated` when the response *body stream* is cut off,
 * which surfaces at .json()/.text() rather than at fetch(). Retrying only around fetch() therefore
 * caught nothing, and a single truncated response still killed a whole batch.
 */
async function fetchText(
  url: string,
  init: RequestInit,
): Promise<{ response: Response; text: string }> {
  const response = await fetch(url, init);
  const text = await response.text();
  return { response, text };
}

function isPartial(error: GraphQLErrorEntry): boolean {
  return (
    (error.path !== undefined && error.path.length > 0) ||
    error.type === 'NOT_FOUND' ||
    error.type === 'FORBIDDEN'
  );
}

export class GitHubGraphQL {
  private lastRequestAt = 0;
  private readonly config: Config;
  readonly budget: Budget;

  constructor(budget: Budget, config?: Config) {
    this.budget = budget;
    this.config = config ?? loadConfig();
    requireGitHubToken();
  }

  private assertBudget(): void {
    const snapshot = this.budget.get('graphql');
    if (snapshot && snapshot.remaining <= this.config.minRateRemaining / 10) {
      throw new BudgetExhaustedError('graphql', new Date(snapshot.reset * 1000));
    }
  }

  private async throttle(): Promise<void> {
    const wait = this.lastRequestAt + this.config.minRequestIntervalMs - Date.now();
    if (wait > 0) await sleep(wait);
    this.lastRequestAt = Date.now();
  }

  /**
   * Returns data plus any per-alias errors. Throws only when the whole request failed, so callers
   * can process the aliases that did resolve.
   */
  async query<T>(
    query: string,
    variables: Record<string, unknown> = {},
  ): Promise<{ data: T; partialErrors: GraphQLErrorEntry[] }> {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      this.assertBudget();
      await this.throttle();

      let response: Response;
      let rawBody: string;
      try {
        const result = await fetchText(ENDPOINT, {
          method: 'POST',
          headers: {
            accept: 'application/vnd.github+json',
            authorization: `Bearer ${this.config.githubToken}`,
            'content-type': 'application/json',
            'user-agent': this.config.userAgent,
          },
          body: JSON.stringify({ query, variables }),
        });
        response = result.response;
        rawBody = result.text;
      } catch (err) {
        this.budget.requests += 1;
        if (attempt < MAX_ATTEMPTS && isTransientFetchFailure(err)) {
          this.budget.retries += 1;
          await sleep(2 ** attempt * 750 + Math.random() * 500);
          continue;
        }
        throw err;
      }
      this.budget.requests += 1;

      if (RETRYABLE_HTTP.has(response.status) && attempt < MAX_ATTEMPTS) {
        this.budget.retries += 1;
        await sleep(2 ** attempt * 500 + Math.random() * 500);
        continue;
      }

      if (response.status === 429 || response.status === 403) {
        const retryAfter = Number.parseInt(response.headers.get('retry-after') ?? '0', 10) * 1000;
        if (retryAfter > 0 && retryAfter <= MAX_SLEEP_MS && attempt < MAX_ATTEMPTS) {
          this.budget.retries += 1;
          console.warn(`[graphql] throttled; waiting ${Math.round(retryAfter / 1000)}s`);
          await sleep(retryAfter);
          continue;
        }
        throw new BudgetExhaustedError('graphql', new Date(Date.now() + Math.max(retryAfter, 60_000)));
      }

      if (!response.ok) {
        throw new Error(`GraphQL HTTP ${response.status}: ${rawBody.slice(0, 300)}`);
      }

      /**
       * A 200 carrying an empty or malformed body is a transient server condition, not a permanent
       * error — observed in the wild as "unparseable JSON (0 bytes)", which took out a batch mid-run.
       * Retry it like any other network hiccup.
       */
      let body: GraphQLResponse<T>;
      try {
        if (rawBody.trim().length === 0) throw new Error('empty body');
        body = JSON.parse(rawBody) as GraphQLResponse<T>;
      } catch {
        if (attempt < MAX_ATTEMPTS) {
          this.budget.retries += 1;
          console.warn(
            `[graphql] unusable body (${rawBody.length} bytes) on attempt ${attempt}; retrying`,
          );
          await sleep(2 ** attempt * 750 + Math.random() * 500);
          continue;
        }
        throw new Error(
          `GraphQL returned an unusable body after ${MAX_ATTEMPTS} attempts ` +
            `(${rawBody.length} bytes): ${rawBody.slice(0, 200)}`,
        );
      }

      // Cost is reported by the server, so the budget reflects reality rather than my node maths.
      const rate = body.data?.rateLimit;
      if (rate) {
        this.budget.graphqlPoints += rate.cost;
        this.budget.record('graphql', {
          limit: rate.limit,
          remaining: rate.remaining,
          used: rate.limit - rate.remaining,
          reset: Math.floor(new Date(rate.resetAt).getTime() / 1000),
        });
      }

      const errors = body.errors ?? [];
      const rateLimited = errors.find((error) => error.type === 'RATE_LIMITED');
      if (rateLimited) {
        const snapshot = this.budget.get('graphql');
        throw new BudgetExhaustedError(
          'graphql',
          snapshot ? new Date(snapshot.reset * 1000) : new Date(Date.now() + 60_000),
        );
      }

      const fatal = errors.filter((error) => !isPartial(error));
      if (fatal.length > 0) throw new GraphQLRequestError(fatal);

      if (!body.data) throw new GraphQLRequestError(errors.length ? errors : [{ message: 'empty response' }]);

      return { data: body.data, partialErrors: errors };
    }

    throw new Error('GraphQL: exhausted retry attempts');
  }
}
