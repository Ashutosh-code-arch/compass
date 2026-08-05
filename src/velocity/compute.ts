/**
 * Momentum: how fast a project is growing, and whether that is good news. PURE.
 *
 * This is the first genuinely NEW measurement since the responsiveness engine, and it exists only
 * because migration 009 started recording star counts months before anything read them. Velocity
 * cannot be backfilled — two samples a week apart is a fact you either have or do not — so every day
 * between Phase 0 and now is what makes this file possible.
 *
 * Derived from this corpus rather than from an external index, which means it is dated, it is yours,
 * and it covers repositories no index lists.
 *
 * The reason it matters is not that fast growth is good. **It is that fast growth is usually bad for a
 * contributor, and nothing else can tell you when it is not.** Every discovery tool ranks by stars or
 * by growth; a project that went 0 to 119,000 stars in nine months has thousands of drive-by pull
 * requests, one or two maintainers, and no review capacity. Velocity finds what is hot. The
 * responsiveness engine is the only thing that says whether hot is contributable, and the combination
 * is what nobody else has.
 */

export interface StarSample {
  observedAt: string;
  stars: number;
}

export interface Velocity {
  /** Stars gained across the samples used. Negative is possible and is reported as such. */
  gained: number;
  /** Days actually spanned by the samples used — NOT the window that was asked for. */
  spanDays: number;
  /** Gained per day over that span. */
  perDay: number;
  /**
   * Growth relative to where it started: 1.5 means it added half its stars again.
   *
   * Null when the baseline is zero, because the multiple would be infinite and reporting a large
   * number would suggest a measurement rather than a division by nothing.
   */
  multiple: number | null;
  baseline: number;
  latest: number;
  samples: number;
}

/**
 * The shortest span that can distinguish growth from noise.
 *
 * A week. Two samples a day apart differ by whatever happened to be trending on that day, and dividing
 * by a span of one produces a per-day rate with a confidence interval wider than the answer. Below this
 * the honest output is null — unmeasured — not a small number.
 */
export const MIN_SPAN_DAYS = 7;

/** The default window. Long enough to smooth a viral week, short enough to still mean "now". */
export const DEFAULT_WINDOW_DAYS = 90;

export interface VelocityOptions {
  windowDays?: number;
  now: Date;
}

/**
 * Velocity from a repository's samples.
 *
 * Returns null rather than zero whenever the data cannot support an answer: fewer than two samples in
 * the window, or a span too short to mean anything. A project with no measured velocity is not a
 * project that is not growing, and the two must never render the same way.
 */
export function computeVelocity(samples: StarSample[], options: VelocityOptions): Velocity | null {
  const windowDays = options.windowDays ?? DEFAULT_WINDOW_DAYS;
  const cutoff = options.now.getTime() - windowDays * 86_400_000;

  const inWindow = samples
    .filter((sample) => Date.parse(sample.observedAt) >= cutoff)
    .sort((a, b) => Date.parse(a.observedAt) - Date.parse(b.observedAt));

  if (inWindow.length < 2) return null;
  return velocityBetween(inWindow[0]!, inWindow.at(-1)!, inWindow.length);
}

/**
 * The rules, in one place, given the two endpoints and how many samples they came from.
 *
 * Exported because the data layer aggregates to endpoints in SQL rather than fetching every sample: a
 * ninety-day window across a thousand repositories is tens of thousands of rows to answer a question
 * about two of them per repository. That aggregation is data selection and belongs in a query; the
 * minimum span, the null semantics, and the arithmetic are judgement and belong here. Both callers go
 * through this function so neither can drift.
 *
 * `samples` is passed in rather than inferred, so a velocity aggregated in SQL still reports the true
 * number of observations behind it instead of the two it was handed.
 */
export function velocityBetween(
  oldest: StarSample,
  newest: StarSample,
  samples: number,
): Velocity | null {
  const spanDays = (Date.parse(newest.observedAt) - Date.parse(oldest.observedAt)) / 86_400_000;
  if (!Number.isFinite(spanDays) || spanDays < MIN_SPAN_DAYS) return null;

  const gained = newest.stars - oldest.stars;
  return {
    gained,
    spanDays: Math.round(spanDays),
    perDay: round(gained / spanDays, 2),
    multiple: oldest.stars > 0 ? round(newest.stars / oldest.stars, 3) : null,
    baseline: oldest.stars,
    latest: newest.stars,
    samples,
  };
}

function round(value: number, places: number): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

// ---------------------------------------------------------------------------
// The hype filter
// ---------------------------------------------------------------------------

/**
 * What counts as a growth spike.
 *
 * Fifty stars a day, or half again the star count inside the window. Two tests rather than one because
 * they catch different projects: the absolute rate finds the thing on the front page this month, and
 * the multiple finds a small project tripling from four hundred stars, which is the same phenomenon at
 * a scale the absolute rate would miss.
 *
 * The calibration point is public: the Q1 2026 ROSS index was topped by repositories founded that year
 * sitting at 30,000 to 120,000 stars, which is on the order of four hundred stars a day sustained.
 * Fifty is comfortably below that and comfortably above a popular, stable project's ten to thirty.
 */
export const SURGE_PER_DAY = 50;
export const SURGE_MULTIPLE = 1.5;

/**
 * How long a project needs before it can be expected to have review capacity.
 *
 * Two years. Maintainer count, triage habits, and a review rota are things a project grows into, and a
 * repository younger than this that is also surging has almost certainly not had time. Youth is
 * reported separately rather than folded into the verdict, because a mature project can drown too and
 * the reader should see which case they have.
 */
export const YOUNG_DAYS = 730;

/** A queue this deep means the bottleneck is review, whatever the merge rate says. */
export const DROWNING_OPEN_PRS = 100;

export type Momentum = 'hype' | 'rising' | 'steady' | 'cooling';

export interface MomentumInput {
  velocity: Velocity | null;
  /** Days since the repository was created. Measured, from `repos.created_at_gh`. */
  ageDays: number | null;
  responsiveness: string | null;
  mergeRate: number | null;
  decidedPrs: number;
  openPrTotal: number | null;
}

export interface MomentumFinding {
  /** Null means velocity could not be measured. Not a verdict of `steady`. */
  verdict: Momentum | null;
  /** True when growth cleared either surge test. */
  surging: boolean;
  /** True when the project is too young to have built review capacity. */
  young: boolean;
  /**
   * Why the capacity half of the verdict came out as it did, in words.
   *
   * Null when capacity looks fine. Present so a `hype` verdict can be argued with instead of trusted —
   * it is a discouraging thing to tell someone about a project they are excited by, and it should
   * always be possible to see exactly which measurement produced it.
   */
  capacityConcern: string | null;
}

/**
 * Growth crossed with the ability to absorb it.
 *
 * Four outcomes, and the pair that matters is the first two:
 *
 *   hype     surging, and the evidence says nobody can review the result. The worst place to spend
 *            five hours, and the one every star-ranked list puts at the top.
 *   rising   surging, and maintainers are demonstrably reading outside work. The best place to be
 *            early — visible project, active mentors, and your pull request actually lands.
 *   steady   growing normally. Most good projects, most of the time.
 *   cooling  losing stars, or gaining none across the window.
 *
 * `hype` is deliberately never reached from growth alone. "This project is popular" is not a criticism,
 * and a verdict that amounted to one would be the tool substituting taste for measurement.
 */
export function assessMomentum(input: MomentumInput): MomentumFinding {
  const velocity = input.velocity;
  if (velocity === null) {
    return { verdict: null, surging: false, young: false, capacityConcern: null };
  }

  const young = input.ageDays !== null && input.ageDays < YOUNG_DAYS;
  const surging =
    velocity.perDay >= SURGE_PER_DAY ||
    (velocity.multiple !== null && velocity.multiple >= SURGE_MULTIPLE);

  // Ordered by how directly each measures "will anyone read my pull request".
  let capacityConcern: string | null = null;
  if (input.responsiveness === 'dormant') {
    capacityConcern = 'nobody answers outside pull requests';
  } else if (input.responsiveness === 'slow') {
    capacityConcern = 'outside pull requests wait a long time for a first reply';
  } else if (input.openPrTotal !== null && input.openPrTotal >= DROWNING_OPEN_PRS) {
    capacityConcern = `${input.openPrTotal} open pull requests waiting`;
  } else if (input.mergeRate !== null && input.decidedPrs >= 10 && input.mergeRate <= 0.4) {
    // The denominator matters: 1 of 2 merged is not evidence of anything.
    capacityConcern = `only ${Math.round(input.mergeRate * 100)}% of decided pull requests merge`;
  }

  if (velocity.gained <= 0) {
    return { verdict: 'cooling', surging: false, young, capacityConcern };
  }

  if (!surging) {
    return { verdict: 'steady', surging: false, young, capacityConcern };
  }

  return {
    verdict: capacityConcern === null ? 'rising' : 'hype',
    surging: true,
    young,
    capacityConcern,
  };
}

export const MOMENTUM_VERDICTS: Momentum[] = ['hype', 'rising', 'steady', 'cooling'];

export function isMomentum(value: string): value is Momentum {
  return (MOMENTUM_VERDICTS as string[]).includes(value);
}

/** One line, for a terminal row or a chip. Always carries the numbers that produced it. */
export function describeMomentum(finding: MomentumFinding, velocity: Velocity | null): string | null {
  if (finding.verdict === null || velocity === null) return null;

  const rate =
    velocity.perDay >= 1
      ? `+${Math.round(velocity.perDay)}/day`
      : `+${velocity.gained} in ${velocity.spanDays}d`;

  const parts = [`${finding.verdict} ${rate}`];
  if (finding.young) parts.push('young');
  if (finding.capacityConcern !== null) parts.push(finding.capacityConcern);
  return parts.join(' · ');
}
