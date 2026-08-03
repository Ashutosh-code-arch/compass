/**
 * Coercion for values that arrive as strings — CLI flags and HTTP query parameters.
 *
 * Both entry points need the same three flavours of integer, and they need to reject bad input the
 * same way. The distinctions are deliberate: a limit of 0 is meaningless, a score threshold of 0 is
 * useful, and a staleness window of 0 means "recompute everything now".
 */

export function positiveInt(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Expected a positive integer, got "${value}"`);
  }
  return parsed;
}

/** Score thresholds may legitimately be zero or negative. */
export function signedInt(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) throw new Error(`Expected an integer, got "${value}"`);
  return parsed;
}

/** Staleness windows legitimately accept 0, meaning "recompute everything now". */
export function nonNegativeInt(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`Expected a non-negative integer, got "${value}"`);
  }
  return parsed;
}

/**
 * Query-string booleans. `?labelled` and `?labelled=true` both mean true; an explicit `=false` means
 * false rather than "unset", because a UI toggle needs to be able to send the off state.
 */
export function flag(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  if (value === '' || value === 'true' || value === '1') return true;
  if (value === 'false' || value === '0') return false;
  throw new Error(`Expected true or false, got "${value}"`);
}

/**
 * Drops undefined-valued keys.
 *
 * `exactOptionalPropertyTypes` distinguishes an absent optional property from one explicitly set to
 * undefined, so options objects must be built by omission rather than by assigning undefined.
 */
export function defined<T extends object>(source: T): { [K in keyof T]-?: NonNullable<T[K]> } {
  return Object.fromEntries(
    Object.entries(source).filter(([, value]) => value !== undefined),
  ) as { [K in keyof T]-?: NonNullable<T[K]> };
}
