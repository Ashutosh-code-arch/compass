/**
 * The momentum module's public surface.
 *
 * Exists so `rank/view.ts` can import the pure description helper and the `RepoMomentum` type without
 * reaching into `data.ts`, which touches the database. A PURE module importing a file that imports
 * `db.ts` would compile and would quietly break the rule that makes the test suite fast.
 */

export {
  assessMomentum,
  computeVelocity,
  describeMomentum,
  isMomentum,
  velocityBetween,
  DEFAULT_WINDOW_DAYS,
  MIN_SPAN_DAYS,
  MOMENTUM_VERDICTS,
  type Momentum,
  type MomentumFinding,
  type StarSample,
  type Velocity,
} from './compute.ts';

export type { RepoMomentum } from './types.ts';
