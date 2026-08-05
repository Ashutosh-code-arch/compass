/**
 * What you want to work on. PURE: shape, defaults, and validation, no database.
 *
 * The governing rule is that `weights.ts` stays the default. An empty profile must score exactly as
 * the tool scored before this file existed, so every field falls back to a constant rather than to
 * zero. That is what makes the profile safe to ship without re-tuning anything, and it is why
 * `languagePoints` is empty-means-defaults rather than empty-means-nothing-scores.
 */

import { isWeightSet, WEIGHT_SETS, type WeightSetName } from './weight_sets.ts';
import { LANGUAGE_POINTS } from './weights.ts';

export const SETUP_WEIGHTS = ['light', 'moderate', 'heavy'] as const;
export type SetupWeight = (typeof SETUP_WEIGHTS)[number];

export interface Profile {
  /** Language -> points. Empty means the LANGUAGE_POINTS defaults apply. */
  languagePoints: Record<string, number>;
  /** Topic -> points, matched against `repos.topics`. Empty means topics do not score. */
  topicPoints: Record<string, number>;
  /** Subject matter to steer away from, matched against `repos.topics`. */
  avoidTopics: string[];
  /** Extends the built-in AVOID_LABELS rather than replacing it. */
  avoidLabels: string[];
  minStars: number | null;
  maxStars: number | null;
  maxSetupWeight: SetupWeight | null;
  /**
   * Which named weight set to score against. Null is the default set.
   *
   * A whole set rather than more preference points, because the thing `career-leverage` needs to do is
   * REMOVE a penalty, and preference points can only add. Offsetting a −6 with a +6 would have worked
   * arithmetically and produced a breakdown showing two contradictory lines, which is worse than either.
   */
  weightSet: WeightSetName | null;
}

export const EMPTY_PROFILE: Profile = {
  languagePoints: {},
  topicPoints: {},
  avoidTopics: [],
  avoidLabels: [],
  minStars: null,
  maxStars: null,
  maxSetupWeight: null,
  weightSet: null,
};

/**
 * How far a single preference may move a candidate.
 *
 * The largest built-in weight is 22 (responsiveness), and a preference that outranks every measured
 * signal turns the ranking into a filter — which the shortlist already has, properly, as hard gates.
 * A language you love should lift a project above its peers, not rescue one where nobody reviews
 * outside work.
 */
export const MAX_PREFERENCE_POINTS = 25;

/** The scoring view of a profile: defaults already resolved, so scoring never reaches for a constant. */
export interface ResolvedProfile {
  weightSet: WeightSetName;
  languagePoints: Record<string, number>;
  topicPoints: Record<string, number>;
  avoidTopics: string[];
  avoidLabels: string[];
}

/**
 * Applies the defaults.
 *
 * `languagePoints` falls back wholesale rather than merging key by key: a merge would mean that
 * deleting TypeScript in the settings screen silently reinstates its default of 14, which is the
 * opposite of what deleting it means.
 */
export function resolveProfile(profile: Profile = EMPTY_PROFILE): ResolvedProfile {
  const hasLanguages = Object.keys(profile.languagePoints).length > 0;
  return {
    weightSet: profile.weightSet ?? 'default',
    languagePoints: hasLanguages ? lowerKeys(profile.languagePoints) : lowerKeys(LANGUAGE_POINTS),
    topicPoints: lowerKeys(profile.topicPoints),
    avoidTopics: profile.avoidTopics.map(normaliseTerm),
    avoidLabels: profile.avoidLabels.map(normaliseTerm),
  };
}

/** GitHub topics are lowercase; languages are not. Compare on one casing throughout. */
function lowerKeys(source: Record<string, number>): Record<string, number> {
  return Object.fromEntries(
    Object.entries(source).map(([key, value]) => [normaliseTerm(key), value]),
  );
}

export function normaliseTerm(term: string): string {
  return term.trim().toLowerCase();
}

export class ProfileError extends Error {}

/**
 * Validates untrusted input from the settings screen.
 *
 * Rejects rather than coerces. A points value that arrives as "fourteen" is a bug somewhere, and
 * silently reading it as 0 would quietly change every ranking without anything appearing wrong.
 */
export function parseProfile(input: unknown): Profile {
  if (typeof input !== 'object' || input === null) {
    throw new ProfileError('Expected an object');
  }
  const body = input as Record<string, unknown>;

  const profile: Profile = {
    languagePoints: points(body['languagePoints'], 'languagePoints'),
    topicPoints: points(body['topicPoints'], 'topicPoints'),
    avoidTopics: terms(body['avoidTopics'], 'avoidTopics'),
    avoidLabels: terms(body['avoidLabels'], 'avoidLabels'),
    minStars: count(body['minStars'], 'minStars'),
    maxStars: count(body['maxStars'], 'maxStars'),
    maxSetupWeight: setupWeight(body['maxSetupWeight']),
    weightSet: weightSetOf(body['weightSet']),
  };

  if (
    profile.minStars !== null &&
    profile.maxStars !== null &&
    profile.minStars > profile.maxStars
  ) {
    throw new ProfileError(
      `minStars (${profile.minStars}) cannot exceed maxStars (${profile.maxStars})`,
    );
  }
  return profile;
}

function points(value: unknown, field: string): Record<string, number> {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new ProfileError(`${field} must be an object mapping names to points`);
  }
  const out: Record<string, number> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    const name = key.trim();
    if (name === '') throw new ProfileError(`${field} has an entry with an empty name`);
    if (typeof raw !== 'number' || !Number.isFinite(raw)) {
      throw new ProfileError(`${field}["${name}"] must be a number, got ${JSON.stringify(raw)}`);
    }
    if (!Number.isInteger(raw)) {
      // The breakdown prints these verbatim; a fractional line would imply a precision the
      // preference does not have.
      throw new ProfileError(`${field}["${name}"] must be a whole number, got ${raw}`);
    }
    if (Math.abs(raw) > MAX_PREFERENCE_POINTS) {
      throw new ProfileError(
        `${field}["${name}"] is ${raw}; keep preferences within ±${MAX_PREFERENCE_POINTS} so they ` +
          `rank candidates rather than override the measured signals. Use the filters to exclude.`,
      );
    }
    out[name] = raw;
  }
  return out;
}

function terms(value: unknown, field: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new ProfileError(`${field} must be a list`);
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== 'string') {
      throw new ProfileError(`${field} must contain only text, got ${JSON.stringify(entry)}`);
    }
    const term = entry.trim();
    if (term !== '') seen.add(term);
  }
  return [...seen];
}

function count(value: unknown, field: string): number | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new ProfileError(`${field} must be a whole number of zero or more`);
  }
  return value;
}

/** Refused rather than coerced: an unknown set silently falling back to default would be a lie. */
function weightSetOf(value: unknown): WeightSetName | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !isWeightSet(value)) {
    throw new ProfileError(`weightSet must be one of: ${WEIGHT_SETS.join(', ')}`);
  }
  return value;
}

function setupWeight(value: unknown): SetupWeight | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !(SETUP_WEIGHTS as readonly string[]).includes(value)) {
    throw new ProfileError(`maxSetupWeight must be one of: ${SETUP_WEIGHTS.join(', ')}`);
  }
  return value as SetupWeight;
}
