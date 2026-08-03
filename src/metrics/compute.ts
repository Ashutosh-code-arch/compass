/**
 * Pure functions. No network, no database — so the statistics can be tested against synthetic
 * cases where the right answer is known by construction.
 */

/** Associations that mean "inside the project". Their PRs say nothing about outsider experience. */
const INSIDER_ASSOCIATIONS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);

/**
 * Bot PRs must be excluded or every ratio is meaningless: a repo with Dependabot enabled produces
 * a stream of PRs that are auto-merged in minutes without human review, which would make a dormant
 * project look extremely responsive.
 *
 * The harder case, found by running this against a real corpus: bots that are *ordinary user
 * accounts* with a MEMBER association. A welcome bot commenting instantly on every PR reads as a
 * maintainer answering in zero hours, which both flatters the median and hides the true ignore
 * rate. GitHub Apps are identifiable (__typename Bot, or a "[bot]" login suffix); these are not.
 * Hence the suffix heuristics below plus COMPASS_IGNORE_LOGINS, which you populate from the
 * `responders` report — any account with hundreds of responses at a 0-hour median is a bot.
 */
const BOT_LOGINS = new Set([
  'dependabot',
  'dependabot-preview',
  'renovate',
  'renovate-bot',
  'greenkeeper',
  'snyk-bot',
  'mergify',
  'codecov',
  'sonarcloud',
  'netlify',
  'vercel',
  'allcontributors',
  'stale',
  'imgbot',
  'pre-commit-ci',
  'restyled-io',
  'deepsource-autofix',
  'coderabbitai',
  'github-actions',
  'web-flow',
  'pyup-bot',
  'whitesource-bolt-for-github',
  'codesandbox',
  'changeset-bot',
  'socket-security',
  'gitguardian',
  'semantic-release-bot',
  'renovate-approve',
  'copilot-pull-request-reviewer',
  // Known automation whose logins end in "bot" or "robot" with no separator to key on. Named
  // explicitly because a suffix rule for these would also swallow real people — see below.
  'grafanabot',
  'mattermod',
  'k8s-ci-robot',
  'openshift-ci-robot',
  'openshift-merge-robot',
  'tensorflower-gardener',
  'facebook-github-bot',
  'google-cla',
  'codecov-commenter',
  'sonarqubecloud',
  'dosubot',
  'gitpod-io',
  'linear-app',
  'graphite-app',
  // Service accounts that hold write access and so are promoted by the maintainer roster. Each was
  // observed answering PRs instantly with a CONTRIBUTOR association, which read as fast maintainer
  // attention: mattermost-build alone made a repo with 3 external PRs look "responsive".
  'mattermost-build',
  'chromium-autoroll',
  'copybara-service',
  'elasticmachine',
  'apache-actions',
]);

/**
 * A SEPARATOR is required before the suffix. An earlier version matched /bot$/ outright, which
 * classified the human logins klembot, abbot, talbot and elliotbot as automation — discarding a real
 * maintainer's merges and comments, and reporting an active project as 100% ignored and dormant.
 *
 * The consequence of that direction of error is severe (a healthy repo looks dead) while the
 * consequence of the other is mild (one bot inflates a median, and `responders` will surface it).
 * So these patterns are deliberately conservative, and behaviour-based detection via the
 * `responders` report plus COMPASS_IGNORE_LOGINS is the intended mechanism for the rest.
 */
const BOT_PATTERNS = [
  /[-_.](bot|ci|robot|automation|build|builder|deploy|release|jenkins|runner)$/i,
  /^(bot|ci)[-_]/i,
];

export function isBotActor(
  login: string | null | undefined,
  typename?: string,
  ignoreLogins?: ReadonlySet<string>,
): boolean {
  if (typename === 'Bot' || typename === 'Mannequin') return true;
  if (!login) return false;
  const lower = login.toLowerCase();
  if (ignoreLogins?.has(lower)) return true;
  const normalized = lower.replace(/\[bot\]$/, '');
  if (BOT_LOGINS.has(normalized)) return true;
  return BOT_PATTERNS.some((pattern) => pattern.test(normalized));
}

export function isInsider(association: string | null | undefined): boolean {
  return association !== null && association !== undefined && INSIDER_ASSOCIATIONS.has(association);
}

export interface PrObservation {
  number: number;
  authorLogin: string | null;
  authorAssociation: string;
  authorIsBot: boolean;
  /**
   * Resolved insider status, which may come from the maintainer roster rather than the API's
   * authorAssociation. Falls back to the association when absent.
   */
  authorIsInsider?: boolean;
  createdAt: string;
  mergedAt: string | null;
  closedAt: string | null;
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  /**
   * Earliest maintainer attention: a review, a comment, or the merge itself. A merge is the
   * strongest form of attention there is, and projects that squash-merge without commenting were
   * previously scoring as total silence.
   */
  firstResponseAt: string | null;
  firstResponseBy: string | null;
  firstResponseAssociation: string | null;
  changesRequested: boolean;
  /** Latest maintainer review, comment, or merge — any sign a human is present. */
  lastActionAt: string | null;
}

export interface MetricsInput {
  windowDays: number;
  /** An open, unanswered PR older than this counts as stalled. */
  staleDays: number;
  /**
   * Below this age, an unanswered PR is "too recent to judge" rather than ignored. Without it the
   * ignore rate punishes a repo for however busy the last week happened to be.
   */
  graceDays?: number;
  now?: Date;
}

export interface RepoMetrics {
  windowDays: number;
  staleDays: number;
  graceDays: number;

  prsScanned: number;
  prsInWindow: number;
  insiderPrs: number;
  botPrs: number;
  externalPrs: number;

  respondedPrs: number;
  /** Unresponded but younger than graceDays: excluded from noResponseRate entirely. */
  tooRecentPrs: number;
  /** Denominator of noResponseRate: responded + unresponded-and-old-enough. */
  decidablePrs: number;
  medianHoursResponse: number | null;
  p90HoursResponse: number | null;
  noResponseRate: number | null;

  mergedPrs: number;
  closedUnmergedPrs: number;
  openPrs: number;
  mergeRate: number | null;
  medianHoursToMerge: number | null;

  changesRequestedRate: number | null;
  openStalePrs: number;
  openStaleRate: number | null;
  hoursSinceLastAction: number | null;

  confidence: 'none' | 'low' | 'medium' | 'high';
  responsiveness: 'unknown' | 'dormant' | 'slow' | 'moderate' | 'responsive';

  perPr: {
    number: number;
    createdAt: string;
    outcome: 'merged' | 'closed_unmerged' | 'open';
    responseHours: number | null;
    responseBy: string | null;
    responseAssociation: string | null;
    changesRequested: boolean;
    stalled: boolean;
    tooRecent: boolean;
  }[];
}

const HOUR_MS = 3_600_000;

function hoursBetween(from: string, to: string): number {
  return (new Date(to).getTime() - new Date(from).getTime()) / HOUR_MS;
}

function round(value: number | null, places = 2): number | null {
  if (value === null || !Number.isFinite(value)) return null;
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * Nearest-rank rather than interpolated. At these sample sizes interpolation invents precision
 * the data does not have.
 */
export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil(p * sorted.length) - 1;
  return sorted[Math.min(Math.max(rank, 0), sorted.length - 1)]!;
}

/** Sample-size bucket. Anything below `medium` should not be ranked on. */
export function confidenceFor(externalPrs: number): RepoMetrics['confidence'] {
  if (externalPrs === 0) return 'none';
  if (externalPrs < 5) return 'low';
  if (externalPrs < 15) return 'medium';
  return 'high';
}

/**
 * Ordinal, not a score. The thresholds are opening guesses — the honest calibration comes from
 * the decisions journal, once it has enough rows to say which buckets predicted your outcomes.
 *
 * Order matters: dormancy is checked before speed, because a repo that ignores most outsiders is
 * a bad bet no matter how fast it answered the few it did.
 */
export function classifyResponsiveness(
  metrics: Pick<
    RepoMetrics,
    | 'externalPrs'
    | 'respondedPrs'
    | 'openPrs'
    | 'noResponseRate'
    | 'medianHoursResponse'
    | 'hoursSinceLastAction'
    | 'openStaleRate'
  >,
): RepoMetrics['responsiveness'] {
  if (metrics.externalPrs < 3) return 'unknown';

  const noResponse = metrics.noResponseRate ?? 0;
  const sinceAction = metrics.hoursSinceLastAction;

  // Neglect first: ignoring most outsiders is disqualifying however fast the few answers came.
  if (noResponse >= 0.6) return 'dormant';

  // No maintainer has reviewed, commented on, or merged an outside PR in the window at all.
  if (sinceAction === null || sinceAction > 90 * 24) return 'dormant';

  /**
   * openStaleRate is a ratio over OPEN PRs only, so its denominator is often tiny — a project that
   * merges everything within a day can have three open PRs, two of them ancient, and score 67%.
   * Requiring a real denominator stops that from overriding good response numbers.
   */
  if (metrics.openPrs >= 5 && (metrics.openStaleRate ?? 0) >= 0.7) return 'dormant';

  /**
   * A median over one or two responses is not a measurement. Rather than let it drive a confident
   * bucket, say so: high ignore rates already routed the genuinely dead repos to dormant above.
   */
  if (metrics.respondedPrs < 3) return 'unknown';

  const responseMedian = metrics.medianHoursResponse;
  if (responseMedian === null) return 'unknown';

  if (noResponse >= 0.35 || responseMedian > 14 * 24) return 'slow';
  if (responseMedian > 3 * 24) return 'moderate';
  return 'responsive';
}

export function computeMetrics(observations: PrObservation[], input: MetricsInput): RepoMetrics {
  const now = input.now ?? new Date();
  const graceDays = input.graceDays ?? 7;
  const windowStart = now.getTime() - input.windowDays * 24 * HOUR_MS;

  const inWindow = observations.filter((pr) => new Date(pr.createdAt).getTime() >= windowStart);
  const insider = (pr: PrObservation): boolean => pr.authorIsInsider ?? isInsider(pr.authorAssociation);
  const botPrs = inWindow.filter((pr) => pr.authorIsBot);
  const insiderPrs = inWindow.filter((pr) => !pr.authorIsBot && insider(pr));
  const external = inWindow.filter((pr) => !pr.authorIsBot && !insider(pr));

  const responseHours: number[] = [];
  const mergeHours: number[] = [];
  let merged = 0;
  let closedUnmerged = 0;
  let open = 0;
  let responded = 0;
  let tooRecent = 0;
  let changesRequested = 0;
  let openStale = 0;
  let lastActionMs: number | null = null;

  const perPr: RepoMetrics['perPr'] = [];

  for (const pr of external) {
    const outcome: 'merged' | 'closed_unmerged' | 'open' =
      pr.state === 'MERGED' || pr.mergedAt ? 'merged' : pr.state === 'CLOSED' ? 'closed_unmerged' : 'open';

    if (outcome === 'merged') {
      merged += 1;
      if (pr.mergedAt) mergeHours.push(hoursBetween(pr.createdAt, pr.mergedAt));
    } else if (outcome === 'closed_unmerged') {
      closedUnmerged += 1;
    } else {
      open += 1;
    }

    const ageDays = (now.getTime() - new Date(pr.createdAt).getTime()) / (24 * HOUR_MS);

    let hours: number | null = null;
    let isTooRecent = false;
    if (pr.firstResponseAt) {
      responded += 1;
      hours = hoursBetween(pr.createdAt, pr.firstResponseAt);
      // Clock skew or a response recorded before creation; treat as immediate rather than negative.
      if (hours < 0) hours = 0;
      responseHours.push(hours);
    } else if (ageDays < graceDays) {
      // Silence on a PR opened this week is not yet evidence of anything.
      isTooRecent = true;
      tooRecent += 1;
    }

    if (pr.changesRequested) changesRequested += 1;

    const stalled = outcome === 'open' && !pr.firstResponseAt && ageDays > input.staleDays;
    if (stalled) openStale += 1;

    if (pr.lastActionAt) {
      const ms = new Date(pr.lastActionAt).getTime();
      if (lastActionMs === null || ms > lastActionMs) lastActionMs = ms;
    }

    perPr.push({
      number: pr.number,
      createdAt: pr.createdAt,
      outcome,
      responseHours: round(hours),
      responseBy: pr.firstResponseBy,
      responseAssociation: pr.firstResponseAssociation,
      changesRequested: pr.changesRequested,
      stalled,
      tooRecent: isTooRecent,
    });
  }

  const n = external.length;
  const decided = merged + closedUnmerged;
  // Fixed-horizon denominator: everything answered, plus everything old enough that silence means
  // something. PRs that are merely young are excluded rather than counted either way.
  const decidable = n - tooRecent;

  const base = {
    windowDays: input.windowDays,
    staleDays: input.staleDays,
    graceDays,

    prsScanned: observations.length,
    prsInWindow: inWindow.length,
    insiderPrs: insiderPrs.length,
    botPrs: botPrs.length,
    externalPrs: n,

    respondedPrs: responded,
    tooRecentPrs: tooRecent,
    decidablePrs: decidable,
    // Over responded PRs only. See the migration comment: right-censored by construction.
    medianHoursResponse: round(median(responseHours)),
    p90HoursResponse: round(percentile(responseHours, 0.9)),
    noResponseRate: decidable > 0 ? round((decidable - responded) / decidable, 3) : null,

    mergedPrs: merged,
    closedUnmergedPrs: closedUnmerged,
    openPrs: open,
    // Open PRs are excluded because their outcome is unknown, not because it is favourable.
    mergeRate: decided > 0 ? round(merged / decided, 3) : null,
    medianHoursToMerge: round(median(mergeHours)),

    changesRequestedRate: n > 0 ? round(changesRequested / n, 3) : null,
    openStalePrs: openStale,
    openStaleRate: open > 0 ? round(openStale / open, 3) : null,
    hoursSinceLastAction:
      lastActionMs === null ? null : round((now.getTime() - lastActionMs) / HOUR_MS),

    confidence: confidenceFor(n),
    perPr,
  };

  return { ...base, responsiveness: classifyResponsiveness(base) };
}
