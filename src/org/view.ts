/**
 * Organisations, rolled up from the repositories already measured. PURE: no database, no clock except
 * what is passed in, no console.
 *
 * The aggregation happens here rather than in SQL on purpose. Every line below is a judgement about
 * how to combine per-repository measurements, and this project's rule is that judgement lives where a
 * fixture can reach it. A corpus of a thousand repositories is nothing to aggregate in memory, so
 * there is no performance argument for pushing these decisions into a query nobody can test.
 *
 * The four combining decisions, and why each is the way it is:
 *
 *   Verdict        the MODAL verdict across measured repositories, ties broken toward the worse one.
 *                  Not the worst (one dormant repo out of forty does not make an organisation
 *                  dormant) and not the best (that is how a marketing page describes itself).
 *   Median reply   the median of the per-repository medians. This is the typical REPOSITORY, not the
 *                  typical pull request, and the field is named to keep anyone from forgetting that.
 *   Merge rate     POOLED: total merged over total decided. Not the mean of the per-repo rates, which
 *                  would let a repository with two decided PRs outvote one with two hundred.
 *   Setup cost     a distribution, never an average. Averaging `light`/`moderate`/`heavy` would
 *                  invent a number out of an ordinal, which is the one thing this tool does not do.
 */

/** One repository's contribution to its organisation's rollup. */
export interface OrgRepoRow {
  login: string;
  displayName: string | null;
  /** Null when the organisation has no repositories in the corpus at all. */
  repoFullName: string | null;
  primaryLanguage: string | null;
  stars: number | null;
  responsiveness: string | null;
  confidence: string | null;
  medianHoursResponse: number | null;
  noResponseRate: number | null;
  mergedPrs: number | null;
  closedUnmergedPrs: number | null;
  setupWeight: string | null;
  contributorAgreement: string | null;
  /** Issues passing the shared candidate gates in this repository. */
  candidates: number;
  /** hype | rising | steady | cooling, or null when velocity is unmeasured. */
  momentum: string | null;
  /** Stars gained across the measured span. Null when unmeasured. */
  starsGained: number | null;
}

/** A curated claim, straight from `org_tags`. */
export interface OrgTagRow {
  login: string;
  kind: string;
  value: string;
  source: string | null;
  reviewedAt: string;
}

export interface SetupDistribution {
  light: number;
  moderate: number;
  heavy: number;
  unknown: number;
}

export interface OrgRow {
  login: string;
  displayName: string | null;
  /** Repositories in the corpus, excluding ones GitHub says are gone. */
  repos: number;
  /** Of those, how many have attention metrics. The denominator for every verdict below. */
  measuredRepos: number;
  /**
   * The modal verdict across measured repositories, or null when none are measured.
   *
   * Null is not "unknown as a verdict" — `unknown` is a real measured outcome meaning the evidence was
   * too thin to call. Null means nothing here has been looked at yet.
   */
  responsiveness: string | null;
  /** How many measured repositories share the modal verdict. Lets the reader discount 2 of 4. */
  agreeing: number;
  /** Median of the per-repository medians. The typical repository, not the typical pull request. */
  medianRepoHoursResponse: number | null;
  /** Pooled: merged / decided across the organisation. Null when nothing was decided. */
  mergeRate: number | null;
  /** The denominator behind `mergeRate`, so a 100% from two PRs can be seen for what it is. */
  decidedPrs: number;
  setup: SetupDistribution;
  /** Repositories whose CONTRIBUTING mentions a CLA. Usually an organisation-wide fact. */
  claRepos: number;
  dcoRepos: number;
  /** Summed across repositories. A scale indicator, not a measurement of anything. */
  stars: number;
  /** The most common primary language, or null when nothing declares one. */
  primaryLanguage: string | null;
  openCandidates: number;
  /** Repositories contributing at least one candidate. */
  candidateRepos: number;
  /**
   * The modal momentum verdict across repositories where velocity IS measured.
   *
   * Ties break toward the worse verdict, as with responsiveness, and for the same reason: `hype` is the
   * expensive thing to be wrong about. Null when nothing in the organisation has enough star history.
   */
  momentum: string | null;
  /** Repositories with a measured velocity. The denominator for the verdict above. */
  momentumRepos: number;
  /**
   * Stars gained across the organisation, summed.
   *
   * A sum, labelled as one. Adding growth across repositories is meaningful in a way that adding
   * responsiveness verdicts would not be, but it is still scale rather than quality.
   */
  starsGained: number | null;
  /** GSoC years, ascending, from curated tags. */
  gsocYears: number[];
  /** The oldest review date among this organisation's curated tags. Staleness is the reader's call. */
  tagsReviewedAt: string | null;
}

/**
 * Worse verdicts sort first when the count ties.
 *
 * Being told an organisation is responsive when half its repositories are not is the expensive error:
 * it costs an evening. Being told it is slow when half are fine costs a second look.
 */
const VERDICT_SEVERITY: Record<string, number> = { dormant: 0, unknown: 1, slow: 2, responsive: 3 };

/** Worse first on a tie, as above: being told an organisation is `rising` when it is `hype` costs more. */
const MOMENTUM_SEVERITY: Record<string, number> = { hype: 0, cooling: 1, steady: 2, rising: 3 };

/** Best first, for the default ordering. */
const VERDICT_RANK: Record<string, number> = { responsive: 0, slow: 1, unknown: 2, dormant: 3 };

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  // Even counts average the two middles; the input is a set of repository medians, so this stays a
  // statistic about repositories rather than being smuggled into one about pull requests.
  return sorted.length % 2 === 1
    ? sorted[middle]!
    : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

/** The most frequent value, ties broken by the supplied comparator. Null when there is nothing. */
function modal(values: string[], tieBreak: (a: string, b: string) => number): {
  value: string | null;
  count: number;
} {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);

  let best: { value: string; count: number } | null = null;
  for (const [value, count] of counts) {
    if (best === null || count > best.count || (count === best.count && tieBreak(value, best.value) < 0)) {
      best = { value, count };
    }
  }
  return best ?? { value: null, count: 0 };
}

/**
 * Groups per-repository rows into per-organisation rows.
 *
 * Organisations with no repositories in the corpus are kept, with `repos: 0`. That is not an empty
 * row to be tidied away — it is the answer to "which of these 185 GSoC organisations have I never
 * looked at", which is the most actionable thing the GSoC import produces.
 */
export function rollUpOrgs(rows: OrgRepoRow[], tags: OrgTagRow[] = []): OrgRow[] {
  const byLogin = new Map<string, OrgRepoRow[]>();
  for (const row of rows) {
    const existing = byLogin.get(row.login);
    if (existing) existing.push(row);
    else byLogin.set(row.login, [row]);
  }

  const tagsByLogin = new Map<string, OrgTagRow[]>();
  for (const tag of tags) {
    const existing = tagsByLogin.get(tag.login);
    if (existing) existing.push(tag);
    else tagsByLogin.set(tag.login, [tag]);
  }

  const out: OrgRow[] = [];
  for (const [login, group] of byLogin) {
    const repos = group.filter((row) => row.repoFullName !== null);
    const verdicts = repos
      .map((row) => row.responsiveness)
      .filter((verdict): verdict is string => verdict !== null);

    const verdict = modal(
      verdicts,
      (a, b) => (VERDICT_SEVERITY[a] ?? 1) - (VERDICT_SEVERITY[b] ?? 1),
    );

    const merged = repos.reduce((sum, row) => sum + (row.mergedPrs ?? 0), 0);
    const closed = repos.reduce((sum, row) => sum + (row.closedUnmergedPrs ?? 0), 0);
    const decided = merged + closed;

    const setup: SetupDistribution = { light: 0, moderate: 0, heavy: 0, unknown: 0 };
    for (const row of repos) {
      // A repository with no setup facts at all is not counted as `unknown`. `unknown` is a verdict
      // the reader reached from a truncated tree; not having looked is a different state, and the
      // distribution summing to fewer than `repos` is how that shows.
      if (row.setupWeight !== null && row.setupWeight in setup) {
        setup[row.setupWeight as keyof SetupDistribution] += 1;
      }
    }

    const momentumVerdicts = repos
      .map((row) => row.momentum)
      .filter((verdict): verdict is string => verdict !== null);
    const momentum = modal(
      momentumVerdicts,
      (a, b) => (MOMENTUM_SEVERITY[a] ?? 2) - (MOMENTUM_SEVERITY[b] ?? 2),
    );
    const gainedValues = repos
      .map((row) => row.starsGained)
      .filter((gained): gained is number => gained !== null);

    const orgTags = tagsByLogin.get(login) ?? [];
    const gsocYears = orgTags
      .filter((tag) => tag.kind === 'gsoc_year')
      .map((tag) => Number(tag.value))
      .filter((year) => Number.isFinite(year))
      .sort((a, b) => a - b);

    const reviewDates = orgTags.map((tag) => tag.reviewedAt).sort();

    out.push({
      login,
      displayName: group.find((row) => row.displayName !== null)?.displayName ?? null,
      repos: repos.length,
      measuredRepos: verdicts.length,
      responsiveness: verdict.value,
      agreeing: verdict.count,
      medianRepoHoursResponse: median(
        repos
          .map((row) => row.medianHoursResponse)
          .filter((hours): hours is number => hours !== null),
      ),
      mergeRate: decided === 0 ? null : merged / decided,
      decidedPrs: decided,
      setup,
      claRepos: repos.filter(
        (row) => row.contributorAgreement === 'cla' || row.contributorAgreement === 'both',
      ).length,
      dcoRepos: repos.filter(
        (row) => row.contributorAgreement === 'dco' || row.contributorAgreement === 'both',
      ).length,
      stars: repos.reduce((sum, row) => sum + (row.stars ?? 0), 0),
      primaryLanguage: modal(
        repos
          .map((row) => row.primaryLanguage)
          .filter((language): language is string => language !== null),
        (a, b) => a.localeCompare(b),
      ).value,
      openCandidates: repos.reduce((sum, row) => sum + row.candidates, 0),
      candidateRepos: repos.filter((row) => row.candidates > 0).length,
      momentum: momentum.value,
      momentumRepos: momentumVerdicts.length,
      // Null rather than 0 when nothing was measured: no growth measured is not zero growth.
      starsGained: gainedValues.length === 0 ? null : gainedValues.reduce((sum, n) => sum + n, 0),
      gsocYears,
      // The OLDEST review date, not the newest. An organisation carrying one tag checked yesterday and
      // three checked eighteen months ago should read as eighteen months stale, because the reader is
      // about to trust all four.
      tagsReviewedAt: reviewDates[0] ?? null,
    });
  }

  return out;
}

export type OrgSort = 'attention' | 'candidates' | 'name';

/**
 * The default ordering, and deliberately not a score.
 *
 * A composite number would be a fifth invented measurement and would hide exactly the tradeoff the
 * reader is here to make. Instead this is a documented ordinal cascade: verdict, then merge rate, then
 * how much work is actually available, then name. Every step is a value already on the row, so a
 * surprising position can be explained by pointing at a column.
 *
 * Unmeasured organisations sort last rather than first. They are not bad, but a list is a
 * recommendation whatever you call it, and putting "we have never looked at this" at the top would be
 * one.
 */
export function sortOrgs(rows: OrgRow[], sort: OrgSort = 'attention'): OrgRow[] {
  const ordered = [...rows];

  if (sort === 'name') {
    return ordered.sort((a, b) => a.login.localeCompare(b.login));
  }

  if (sort === 'candidates') {
    return ordered.sort(
      (a, b) => b.openCandidates - a.openCandidates || a.login.localeCompare(b.login),
    );
  }

  return ordered.sort((a, b) => {
    const rankA = a.responsiveness === null ? 9 : (VERDICT_RANK[a.responsiveness] ?? 9);
    const rankB = b.responsiveness === null ? 9 : (VERDICT_RANK[b.responsiveness] ?? 9);
    if (rankA !== rankB) return rankA - rankB;

    // Nulls last within a verdict band: no decided PRs is not a zero merge rate.
    const rateA = a.mergeRate ?? -1;
    const rateB = b.mergeRate ?? -1;
    if (rateA !== rateB) return rateB - rateA;

    if (a.openCandidates !== b.openCandidates) return b.openCandidates - a.openCandidates;
    return a.login.localeCompare(b.login);
  });
}

export interface OrgFilters {
  /** A GSoC year, or 'any' for organisations tagged with any year. */
  gsoc?: number | 'any';
  /** hype | rising | steady | cooling. Excludes organisations whose velocity is unmeasured. */
  momentum?: string;
  /** Modal primary language, matched case-insensitively. */
  language?: string;
  /** Drop organisations with fewer than this many repositories in the corpus. */
  minRepos?: number;
  /** Only organisations with no repositories in the corpus: the list to run `add` against. */
  uncoveredOnly?: boolean;
}

export function filterOrgs(rows: OrgRow[], filters: OrgFilters = {}): OrgRow[] {
  return rows.filter((row) => {
    if (filters.gsoc === 'any' && row.gsocYears.length === 0) return false;
    if (typeof filters.gsoc === 'number' && !row.gsocYears.includes(filters.gsoc)) return false;
    if (
      filters.language !== undefined &&
      (row.primaryLanguage ?? '').toLowerCase() !== filters.language.toLowerCase()
    ) {
      return false;
    }
    if (filters.momentum !== undefined && row.momentum !== filters.momentum) return false;
    if (filters.minRepos !== undefined && row.repos < filters.minRepos) return false;
    if (filters.uncoveredOnly === true && row.repos > 0) return false;
    return true;
  });
}

export interface OrgSummary {
  organizations: number;
  shown: number;
  /** In the filtered set, how many have no repositories in the corpus. */
  uncovered: number;
  /** In the filtered set, how many have repositories but no attention metrics. */
  unmeasured: number;
  openCandidates: number;
}

export interface OrgsView {
  summary: OrgSummary;
  rows: OrgRow[];
  gsoc: GsocOutlook;
  notices: string[];
}

export interface AssembleOrgsOptions {
  filters?: OrgFilters;
  sort?: OrgSort;
  limit?: number;
  offset?: number;
  now?: Date;
}

export function assembleOrgs(
  rows: OrgRepoRow[],
  tags: OrgTagRow[] = [],
  options: AssembleOrgsOptions = {},
): OrgsView {
  const all = rollUpOrgs(rows, tags);
  const filtered = filterOrgs(all, options.filters);
  const sorted = sortOrgs(filtered, options.sort);

  const offset = options.offset ?? 0;
  const limit = options.limit ?? 50;
  const page = sorted.slice(offset, offset + limit);

  const notices: string[] = [];
  const uncovered = filtered.filter((row) => row.repos === 0).length;
  if (uncovered > 0 && options.filters?.uncoveredOnly !== true) {
    notices.push(
      `${uncovered} organisation(s) here have no repositories in your corpus. ` +
        `They came from a curated list, not from discovery — \`add owner/name\` to measure one.`,
    );
  }

  const unmeasured = filtered.filter((row) => row.repos > 0 && row.measuredRepos === 0).length;
  if (unmeasured > 0) {
    notices.push(
      `${unmeasured} organisation(s) have repositories but no attention metrics yet, so their ` +
        `verdict is a dash rather than a judgement. \`sync metrics\` fills those in.`,
    );
  }

  return {
    summary: {
      organizations: all.length,
      shown: page.length,
      uncovered,
      unmeasured,
      openCandidates: filtered.reduce((sum, row) => sum + row.openCandidates, 0),
    },
    rows: page,
    gsoc: gsocOutlook(options.now ?? new Date()),
    notices,
  };
}

// ---------------------------------------------------------------------------
// The GSoC calendar
// ---------------------------------------------------------------------------

/**
 * Google Summer of Code 2026's published dates, which are the only ones that exist.
 *
 * Organisations announced 19 February; mentor discussion until 15 March; applications 16–31 March;
 * coding 26 May to 23 August.
 *
 * Future years are ESTIMATED from these and are labelled as estimates everywhere they surface. The
 * programme has kept to roughly this shape for years, which makes February a good planning
 * assumption and a bad thing to state as fact.
 */
export const GSOC_2026 = {
  orgsAnnounced: '2026-02-19',
  applicationsOpen: '2026-03-16',
  applicationsClose: '2026-03-31',
  codingStarts: '2026-05-26',
  codingEnds: '2026-08-23',
} as const;

export type GsocPhase = 'before-announcement' | 'applications' | 'coding' | 'between';

export interface GsocOutlook {
  /** The programme year this outlook is about. */
  year: number;
  phase: GsocPhase;
  /** Days until the next milestone. Null when the milestone date is unknown. */
  daysUntil: number | null;
  /** True whenever the date driving this was inferred from 2026 rather than published. */
  estimated: boolean;
  /**
   * One line, written to be shown always rather than as a seasonal tab.
   *
   * A "coming soon" tab would be dead UI for eight months and would teach the wrong lesson, because
   * the contributions that get a student accepted land BEFORE the announcement, not after it.
   */
  message: string;
}

function dayOf(iso: string): number {
  return Date.parse(`${iso}T00:00:00Z`);
}

function daysBetween(from: Date, toIso: string): number {
  return Math.ceil((dayOf(toIso) - from.getTime()) / 86_400_000);
}

/** Substitutes a year into one of the 2026 dates, for estimating a future cycle. */
function shiftYear(iso: string, year: number): string {
  return `${year}${iso.slice(4)}`;
}

/**
 * Where the GSoC cycle currently is, and what that implies for someone contributing now.
 *
 * PURE, with `now` passed in — the message changes four times a year and every one of those
 * transitions is testable because of it.
 */
export function gsocOutlook(now: Date): GsocOutlook {
  const nowMs = now.getTime();
  const year = now.getUTCFullYear();

  // Inside a published or estimated cycle for the current calendar year.
  const announced = dayOf(shiftYear(GSOC_2026.orgsAnnounced, year));
  const applicationsClose = dayOf(shiftYear(GSOC_2026.applicationsClose, year));
  const codingStarts = dayOf(shiftYear(GSOC_2026.codingStarts, year));
  const codingEnds = dayOf(shiftYear(GSOC_2026.codingEnds, year));
  const estimated = year !== 2026;

  if (nowMs < announced) {
    const days = daysBetween(now, shiftYear(GSOC_2026.orgsAnnounced, year));
    return {
      year,
      phase: 'before-announcement',
      daysUntil: days,
      estimated,
      message:
        `GSoC ${year} organisations are announced in about ${days} days` +
        `${estimated ? ' (estimated from 2026\u2019s 19 February)' : ''}. ` +
        `Contributions landing now are what mentors look at — the useful window is before the list, ` +
        `not after it.`,
    };
  }

  if (nowMs < applicationsClose) {
    return {
      year,
      phase: 'applications',
      daysUntil: daysBetween(now, shiftYear(GSOC_2026.applicationsClose, year)),
      estimated,
      message:
        `GSoC ${year} organisations are announced and applications close in about ` +
        `${daysBetween(now, shiftYear(GSOC_2026.applicationsClose, year))} days. Filter by ` +
        `\u2013\u2013gsoc ${year} to see which of them will actually review your work.`,
    };
  }

  if (nowMs < codingStarts) {
    return {
      year,
      phase: 'between',
      daysUntil: daysBetween(now, shiftYear(GSOC_2026.codingStarts, year)),
      estimated,
      message:
        `GSoC ${year} applications have closed. The next useful window is the run-up to ` +
        `${year + 1}, which opens now: mentors remember contributors from the autumn.`,
    };
  }

  if (nowMs < codingEnds) {
    return {
      year,
      phase: 'coding',
      daysUntil: daysBetween(now, shiftYear(GSOC_2026.codingEnds, year)),
      estimated,
      message:
        `GSoC ${year} coding is under way. If you are aiming at ${year + 1}, this is the best time ` +
        `to start contributing — the organisations are visible and the mentors are active.`,
    };
  }

  // After coding ends: the next cycle is the following year, and this is the most valuable stretch.
  const nextYear = year + 1;
  const days = daysBetween(now, shiftYear(GSOC_2026.orgsAnnounced, nextYear));
  return {
    year: nextYear,
    phase: 'before-announcement',
    daysUntil: days,
    estimated: true,
    message:
      `GSoC ${nextYear} organisations are announced in about ${days} days (estimated from 2026\u2019s ` +
      `19 February). This is the window that matters: contributions landing now are what mentors ` +
      `look at when the list appears.`,
  };
}
