import { loadConfig, requireGitHubToken, type Config } from '../config.ts';

const API = 'https://api.github.com';

export interface RateSnapshot {
  limit: number;
  remaining: number;
  used: number;
  /** Unix seconds. */
  reset: number;
}

/**
 * Tracks quota per rate-limit resource. GitHub buckets separately: `core` gets 5,000 req/hour
 * for a token, `search` only 30 req/minute. Mixing them up is how you get surprise 403s.
 */
export class Budget {
  requests = 0;
  notModified = 0;
  retries = 0;
  /** GraphQL is metered in points, not requests, and reports its own cost per query. */
  graphqlPoints = 0;
  private readonly resources = new Map<string, RateSnapshot>();

  record(resource: string, snapshot: RateSnapshot): void {
    this.resources.set(resource, snapshot);
  }

  get(resource: string): RateSnapshot | undefined {
    return this.resources.get(resource);
  }

  /** Requests that actually cost quota. 304s don't. */
  get billedRequests(): number {
    return this.requests - this.notModified;
  }

  toJSON(): Record<string, RateSnapshot> {
    return Object.fromEntries(this.resources);
  }

  summary(): string {
    const parts = [...this.resources].map(
      ([name, r]) => `${name} ${r.remaining}/${r.limit}`,
    );
    const points = this.graphqlPoints > 0 ? `, ${this.graphqlPoints} graphql points` : '';
    return `${this.requests} requests (${this.notModified} not-modified, ${this.retries} retries)${points}` +
      (parts.length ? ` | remaining: ${parts.join(', ')}` : '');
  }
}

export class BudgetExhaustedError extends Error {
  readonly resource: string;
  readonly resetAt: Date;

  constructor(resource: string, resetAt: Date) {
    super(
      `Rate budget for "${resource}" is down to the reserve floor; resets at ${resetAt.toISOString()}. ` +
        `Stopping cleanly — rerun after the reset and the watermarks will pick up where they left off.`,
    );
    this.name = 'BudgetExhaustedError';
    this.resource = resource;
    this.resetAt = resetAt;
  }
}

export class GitHubError extends Error {
  readonly status: number;
  readonly path: string;
  readonly body: string;

  constructor(status: number, path: string, body: string) {
    super(`GitHub ${status} on ${path}: ${body.slice(0, 300)}`);
    this.name = 'GitHubError';
    this.status = status;
    this.path = path;
    this.body = body;
  }
}

export interface GetOptions {
  /** Send If-None-Match. A 304 response costs no quota, so pass a stored etag whenever the URL is stable. */
  etag?: string | null;
  query?: Record<string, string | number | undefined>;
  /** Treat these statuses as a normal outcome instead of throwing. 404 and 451 are the usual pair. */
  tolerate?: number[];
}

export interface GetResult<T> {
  status: number;
  /** Undefined on 304 and on tolerated statuses. */
  data?: T;
  etag?: string;
  /** Raw Link header, for pagination. */
  link?: string;
}

const RETRYABLE_STATUS = new Set([500, 502, 503, 504]);
const MAX_ATTEMPTS = 4;
const MAX_SLEEP_MS = 90_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * fetch rejects only for network-level failures — a dropped socket, a reset connection, a body cut
 * off mid-stream (undici reports that last one as `TypeError: terminated`). HTTP status codes never
 * reject. So any throw from fetch is transient by definition and worth retrying.
 */
function isTransientFetchFailure(error: unknown): boolean {
  return error instanceof Error && error.name !== 'AbortError';
}

/**
 * Fetch AND read the body as one guarded operation, because undici raises
 * `TypeError: terminated` when the response body stream is cut off — at .text(), not at fetch().
 */
async function fetchText(
  url: URL,
  init: RequestInit,
): Promise<{ response: Response; text: string }> {
  const response = await fetch(url, init);
  // 304 has no body; text() yields an empty string, which is what we want.
  const text = response.status === 304 ? '' : await response.text();
  return { response, text };
}

function resourceFor(path: string): string {
  return path.startsWith('/search/') ? 'search' : 'core';
}

function parseRate(headers: Headers): RateSnapshot | undefined {
  const limit = headers.get('x-ratelimit-limit');
  const remaining = headers.get('x-ratelimit-remaining');
  if (!limit || !remaining) return undefined;
  return {
    limit: Number.parseInt(limit, 10),
    remaining: Number.parseInt(remaining, 10),
    used: Number.parseInt(headers.get('x-ratelimit-used') ?? '0', 10),
    reset: Number.parseInt(headers.get('x-ratelimit-reset') ?? '0', 10),
  };
}

/** Pull the `rel="next"` URL out of a Link header. */
export function nextLink(link: string | undefined): string | undefined {
  if (!link) return undefined;
  for (const part of link.split(',')) {
    const match = /<([^>]+)>\s*;\s*rel="next"/.exec(part.trim());
    if (match) return match[1];
  }
  return undefined;
}

export class GitHubRest {
  private lastRequestAt = 0;
  private readonly config: Config;
  readonly budget: Budget;

  constructor(budget: Budget, config?: Config) {
    this.budget = budget;
    this.config = config ?? loadConfig();
    // Fail here rather than on the first 401, several requests into a run.
    requireGitHubToken();
  }

  /**
   * The reserve floor exists so a long run degrades gracefully instead of dying mid-repo with
   * a partially advanced watermark. `search` has a tiny limit, so it gets a proportional floor.
   */
  private assertBudget(resource: string): void {
    const snapshot = this.budget.get(resource);
    if (!snapshot) return;
    const floor = resource === 'search' ? 2 : this.config.minRateRemaining;
    if (snapshot.remaining <= floor) {
      throw new BudgetExhaustedError(resource, new Date(snapshot.reset * 1000));
    }
  }

  private async throttle(): Promise<void> {
    const wait = this.lastRequestAt + this.config.minRequestIntervalMs - Date.now();
    if (wait > 0) await sleep(wait);
    this.lastRequestAt = Date.now();
  }

  async get<T>(pathOrUrl: string, options: GetOptions = {}): Promise<GetResult<T>> {
    const isAbsolute = pathOrUrl.startsWith('http');
    const url = new URL(isAbsolute ? pathOrUrl : `${API}${pathOrUrl}`);
    const path = url.pathname;

    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }

    const resource = resourceFor(path);
    const tolerate = new Set(options.tolerate ?? []);

    const headers: Record<string, string> = {
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      authorization: `Bearer ${this.config.githubToken}`,
      'user-agent': this.config.userAgent,
    };
    if (options.etag) headers['if-none-match'] = options.etag;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      this.assertBudget(resource);
      await this.throttle();

      let response: Response;
      let rawBody: string;
      try {
        const result = await fetchText(url, { headers });
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

      const rate = parseRate(response.headers);
      if (rate) this.budget.record(response.headers.get('x-ratelimit-resource') ?? resource, rate);

      if (response.status === 304) {
        this.budget.notModified += 1;
        return { status: 304 };
      }

      if (response.ok) {
        let data: T;
        try {
          data = JSON.parse(rawBody) as T;
        } catch {
          throw new GitHubError(response.status, path, `unparseable JSON: ${rawBody.slice(0, 200)}`);
        }
        return {
          status: response.status,
          data,
          ...(response.headers.get('etag') ? { etag: response.headers.get('etag')! } : {}),
          ...(response.headers.get('link') ? { link: response.headers.get('link')! } : {}),
        };
      }

      const body = rawBody;

      if (tolerate.has(response.status)) {
        return { status: response.status };
      }

      // 403/429 is either the primary limit (remaining hits 0) or a secondary limit
      // (retry-after present). Both are worth waiting out once.
      if (response.status === 403 || response.status === 429) {
        const retryAfter = response.headers.get('retry-after');
        let waitMs: number;
        if (retryAfter) {
          waitMs = Number.parseInt(retryAfter, 10) * 1000;
        } else if (rate && rate.remaining === 0) {
          waitMs = Math.max(0, rate.reset * 1000 - Date.now()) + 1_000;
        } else {
          // 403 with quota left is a permissions problem, not a throttle. Don't spin on it.
          throw new GitHubError(response.status, path, body);
        }

        if (waitMs > MAX_SLEEP_MS || attempt === MAX_ATTEMPTS) {
          throw new BudgetExhaustedError(resource, new Date(Date.now() + waitMs));
        }
        this.budget.retries += 1;
        console.warn(`[github] throttled on ${path}; waiting ${Math.round(waitMs / 1000)}s`);
        await sleep(waitMs);
        continue;
      }

      if (RETRYABLE_STATUS.has(response.status) && attempt < MAX_ATTEMPTS) {
        const waitMs = 2 ** attempt * 500 + Math.random() * 500;
        this.budget.retries += 1;
        await sleep(waitMs);
        continue;
      }

      throw new GitHubError(response.status, path, body);
    }

    throw new GitHubError(0, path, 'exhausted retry attempts');
  }

  /**
   * Follows Link headers. Yields a page at a time so callers can write to Postgres
   * incrementally rather than buffering a whole repo's issues in memory.
   */
  async *paginate<T>(
    path: string,
    query: Record<string, string | number | undefined>,
    options: { maxPages?: number; etag?: string | null } = {},
  ): AsyncGenerator<{ items: T[]; page: number; etag?: string }> {
    const maxPages = options.maxPages ?? 100;
    let url: string | undefined = path;
    let page = 1;
    let etag = options.etag;

    while (url && page <= maxPages) {
      const result: GetResult<T[]> = await this.get<T[]>(url, {
        // Only the first page has a stable URL worth an ETag; later pages come from Link.
        ...(page === 1 && etag ? { etag } : {}),
        ...(page === 1 ? { query } : {}),
      });

      if (result.status === 304) return;
      if (!result.data) return;

      yield {
        items: result.data,
        page,
        ...(page === 1 && result.etag ? { etag: result.etag } : {}),
      };

      etag = null;
      url = nextLink(result.link);
      page += 1;
    }
  }
}

/** Run tasks with bounded concurrency, preserving nothing about order. */
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;

  async function drain(): Promise<void> {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index]!, index);
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, drain));
  return results;
}
