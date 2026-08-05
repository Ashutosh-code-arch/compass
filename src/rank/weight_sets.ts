/**
 * Named weight sets. PURE.
 *
 * **The roadmap said "the profile system already supports alternative weights". It did not.** The
 * profile carried preference points — language, topic, avoid terms, capped at ±25 — layered on top of a
 * single module-level `WEIGHTS` constant that `score.ts` read directly in forty-four places. There was
 * no mechanism for a different set, and the career-leverage idea needed one. `docs/roadmap.md` has been
 * corrected.
 *
 * What a set is: a shallow override over `WEIGHTS`, named, opt-in, and listed in one place. It is not a
 * fork of the scoring model, and adding a set must never require touching `score.ts`.
 *
 * **Every number in every set here is a belief, and none has been validated against an outcome.** That
 * is equally true of the default set — see `weights.ts` — but it matters more here, because choosing a
 * non-default set feels like tuning and is actually guessing differently. The journal is the only thing
 * that can settle any of it.
 */

import { WEIGHTS } from './weights.ts';

export const WEIGHT_SETS = ['default', 'career-leverage'] as const;

export type WeightSetName = (typeof WEIGHT_SETS)[number];

export function isWeightSet(value: string): value is WeightSetName {
  return (WEIGHT_SETS as readonly string[]).includes(value);
}

/**
 * `WEIGHTS` is declared `as const`, which makes every number a literal type — so `points: 4` has type
 * `4` and an override of `2` is a type error. Widening restores "these are numbers" without dropping
 * `as const`, which would change inference at the forty-odd sites that read the constant directly.
 */
type Widen<T> = T extends number
  ? number
  : T extends string
    ? string
    : T extends boolean
      ? boolean
      : { -readonly [K in keyof T]: Widen<T[K]> };

export type Weights = Widen<typeof WEIGHTS>;

/**
 * Optimised for visibility rather than for a comfortable evening.
 *
 * The user this exists for wants a merged pull request in a project a hiring manager or a GSoC mentor
 * has heard of. That is a different objective from "finish something tonight", and three of the default
 * weights actively fight it:
 *
 *   stars.huge      −6 above 60,000 stars. The default set is right that enormous projects have crowded
 *                   queues — but those are exactly the marquee repositories this objective is about, and
 *                   a penalty heavy enough to clear the top of the list makes them unreachable. Set to 0
 *                   rather than positive: removing an obstacle is defensible, and claiming that fame is
 *                   itself a merit would be inventing a signal.
 *   stars.sweetSpot +4 for 1k–30k. Kept but halved. It is still true that mid-sized projects are easier;
 *                   it is just not what is being optimised.
 *   setup.*         setup cost is paid once and then you stay. Halved, not removed — a heavy setup can
 *                   still end an evening before it starts, and the first contribution is the one most
 *                   likely to be abandoned.
 *
 * Deliberately NOT changed: responsiveness and merge rate keep their full weight. If nobody reads
 * outside pull requests then a famous project is worth less than an obscure one, not more, and no career
 * objective survives a pull request nobody merges.
 */
const CAREER_LEVERAGE: DeepPartial<Weights> = {
  stars: {
    sweetSpot: { min: 1000, max: 30000, points: 2 },
    huge: { over: 60000, points: 0 },
  },
  setupWeight: {
    light: 6,
    heavy: -7,
  },
};

type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };

const OVERRIDES: Record<WeightSetName, DeepPartial<Weights>> = {
  default: {},
  'career-leverage': CAREER_LEVERAGE,
};

/**
 * The weights for a named set.
 *
 * A shallow merge one level into each group, which is all any set has needed: an override names a group
 * and replaces the keys it mentions. A deep recursive merge would let a set silently half-specify a
 * nested rule like `issueMill` and produce a combination nobody wrote down.
 */
export function resolveWeights(name: WeightSetName = 'default'): Weights {
  const overrides = OVERRIDES[name] ?? {};
  const merged = { ...WEIGHTS } as Record<string, unknown>;

  for (const [group, value] of Object.entries(overrides)) {
    const base = (WEIGHTS as Record<string, unknown>)[group];
    merged[group] =
      base !== null && typeof base === 'object' && typeof value === 'object' && value !== null
        ? { ...(base as object), ...(value as object) }
        : value;
  }

  return merged as Weights;
}

/** What a set changes, for the settings screen and for `explain`. */
export function describeWeightSet(name: WeightSetName): string {
  if (name === 'career-leverage') {
    return (
      'Drops the penalty on very large projects, halves the mid-size bonus and halves setup cost. ' +
      'Responsiveness and merge rate are untouched: a famous project where nobody merges outside work ' +
      'is worth less than an obscure one, not more.'
    );
  }
  return 'The weights in weights.ts, unchanged.';
}
