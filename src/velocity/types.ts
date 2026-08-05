import type { MomentumFinding, Velocity } from './compute.ts';

/**
 * One repository's momentum. Declared apart from `data.ts` so that pure modules can name the type
 * without importing anything that opens a database connection.
 */
export interface RepoMomentum {
  repoFullName: string;
  velocity: Velocity | null;
  momentum: MomentumFinding;
}
