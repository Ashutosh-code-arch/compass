export interface Config {
  databaseUrl: string;
  /**
   * Empty when unset.
   *
   * Deliberately not required at load: everything that reads the corpus — `migrate`, `shortlist`,
   * `why`, `journal`, the whole API and UI — needs Postgres and nothing else. Demanding a token up
   * front meant a database restored onto a machine without one could not even be queried, and it
   * made the UI's "no token configured" screen unreachable, because the server died before it could
   * render it. `requireGitHubToken()` is the check, and it lives where the network calls are.
   */
  githubToken: string;
  /** Abort a run rather than spend the last of the hourly quota. */
  minRateRemaining: number;
  /** Parallel in-flight requests. GitHub asks for modest concurrency; 3 is polite and fast enough. */
  concurrency: number;
  /** Courtesy floor between request starts, guards the undocumented secondary limits. */
  minRequestIntervalMs: number;
  userAgent: string;
  /**
   * Extra logins to treat as bots, lowercase. Populate from the `responders` report: any account
   * with dozens of responses at a ~0 hour median is an automated first-responder, and counting it
   * as maintainer attention both flatters the median and hides the true ignore rate.
   */
  ignoredLogins: ReadonlySet<string>;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing ${name}. Copy .env.example to .env and fill it in, or export it in your shell.`,
    );
  }
  return value;
}

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) throw new Error(`${name} must be an integer, got "${raw}"`);
  return parsed;
}

let cached: Config | undefined;

export function loadConfig(): Config {
  if (cached) return cached;
  cached = {
    databaseUrl: required('DATABASE_URL'),
    githubToken: process.env['GITHUB_TOKEN'] ?? '',
    minRateRemaining: intEnv('GITHUB_MIN_REMAINING', 300),
    concurrency: intEnv('SYNC_CONCURRENCY', 3),
    minRequestIntervalMs: intEnv('SYNC_MIN_INTERVAL_MS', 120),
    userAgent: process.env['GITHUB_USER_AGENT'] ?? 'opensource-compass/0.1 (personal)',
    ignoredLogins: new Set(
      (process.env['COMPASS_IGNORE_LOGINS'] ?? '')
        .split(',')
        .map((login) => login.trim().toLowerCase())
        .filter(Boolean),
    ),
  };
  return cached;
}

/**
 * Asserts a token before anything tries to reach GitHub.
 *
 * Called by the REST and GraphQL clients at construction, so a sync fails immediately with an
 * actionable message rather than on the first 401 several requests in.
 */
export function requireGitHubToken(): string {
  const token = loadConfig().githubToken;
  if (!token) {
    throw new Error(
      'Missing GITHUB_TOKEN. Reading the corpus does not need one, but syncing does. ' +
        'Copy .env.example to .env and fill it in, or export it in your shell.',
    );
  }
  return token;
}
