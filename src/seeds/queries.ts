/**
 * The corpus definition. This file is the one you are meant to keep editing.
 *
 * GitHub's search API caps any single query at 1,000 results (10 pages x 100), so breadth comes
 * from having many narrow queries rather than one broad one. Each query carries an `id` that is
 * written to repos.discovered_via, so you can later ask "which of my queries actually produced
 * repos I contributed to" and retire the ones that never do.
 *
 * On the star range: below roughly 500 stars, a project is often one person's side project and
 * abandonment risk dominates. Above roughly 50k, labelled beginner issues get claimed within
 * hours and you are competing with a firehose. The 1k-30k band is where an outside contributor
 * has both a maintainer who responds and a queue that isn't picked clean.
 */

export type SearchSort = 'stars' | 'forks' | 'updated' | 'help-wanted-issues';

export interface SeedContext {
  /** ISO date N days ago, for `pushed:>` qualifiers. */
  pushedSince: (days: number) => string;
}

export interface SeedQuery {
  id: string;
  note: string;
  build: (ctx: SeedContext) => string;
  /** Each page is 100 repos. Default 3 (=300) keeps a full seed run cheap. */
  maxPages?: number;
  sort?: SearchSort;
  enabled?: boolean;
}

/** Applied to every query: no archived husks, no template scaffolds, no private repos. */
const BASE = 'is:public archived:false template:false';

/** Recent push activity is the cheapest liveness signal available at search time. */
const active = (ctx: SeedContext, days = 30) => `pushed:>${ctx.pushedSince(days)}`;

export const SEED_QUERIES: SeedQuery[] = [
  {
    id: 'ts-gfi',
    note: 'TypeScript projects with a real beginner queue, not just one stale label.',
    build: (ctx) =>
      `${BASE} ${active(ctx)} language:TypeScript stars:1000..30000 good-first-issues:>3`,
    sort: 'help-wanted-issues',
    maxPages: 3,
  },
  {
    id: 'ts-help-wanted',
    note: 'Wider TypeScript net via help-wanted, which more projects actually curate.',
    build: (ctx) =>
      `${BASE} ${active(ctx)} language:TypeScript stars:1500..40000 help-wanted-issues:>5`,
    sort: 'updated',
    maxPages: 3,
  },
  {
    id: 'python-gfi',
    note: 'Python beginner queue.',
    build: (ctx) => `${BASE} ${active(ctx)} language:Python stars:1000..30000 good-first-issues:>3`,
    sort: 'help-wanted-issues',
    maxPages: 3,
  },
  {
    id: 'python-nlp',
    note: 'NLP tooling — adjacent to your own research, so review comments teach you something.',
    build: (ctx) =>
      `${BASE} ${active(ctx, 45)} language:Python topic:nlp stars:500..40000 help-wanted-issues:>1`,
    sort: 'updated',
    maxPages: 2,
  },
  {
    id: 'python-llm-infra',
    note: 'Inference/serving stacks. Fast-moving, so the issue queue is rarely picked clean.',
    build: (ctx) =>
      `${BASE} ${active(ctx, 21)} language:Python topic:llm stars:500..60000 help-wanted-issues:>1`,
    sort: 'updated',
    maxPages: 2,
  },
  {
    id: 'node-backend',
    note: 'Node/NestJS/Express-flavoured server projects.',
    build: (ctx) =>
      `${BASE} ${active(ctx)} language:JavaScript topic:nodejs stars:1000..30000 help-wanted-issues:>3`,
    sort: 'help-wanted-issues',
    maxPages: 2,
  },
  {
    id: 'java-spring',
    note: 'Spring ecosystem. Slower review cycles but very explicit conventions.',
    build: (ctx) =>
      `${BASE} ${active(ctx, 45)} language:Java stars:800..30000 good-first-issues:>1`,
    sort: 'help-wanted-issues',
    maxPages: 2,
  },
  {
    id: 'go-help-wanted',
    note: 'Go infra projects tend to have small, well-scoped issues and terse reviewers.',
    build: (ctx) => `${BASE} ${active(ctx)} language:Go stars:1000..30000 help-wanted-issues:>5`,
    sort: 'help-wanted-issues',
    maxPages: 2,
  },
  {
    id: 'devtools',
    note: 'Developer tooling regardless of language — usually good docs and testable changes.',
    build: (ctx) =>
      `${BASE} ${active(ctx)} topic:developer-tools stars:1000..30000 good-first-issues:>2`,
    sort: 'updated',
    maxPages: 2,
  },
  {
    id: 'docs-friendly',
    note: 'A deliberate low-risk on-ramp: projects that label documentation work.',
    build: (ctx) =>
      `${BASE} ${active(ctx)} stars:2000..50000 good-first-issues:>10`,
    sort: 'help-wanted-issues',
    maxPages: 2,
    enabled: false,
  },
];

export function activeQueries(): SeedQuery[] {
  return SEED_QUERIES.filter((query) => query.enabled !== false);
}

export function makeSeedContext(now = new Date()): SeedContext {
  return {
    pushedSince: (days) => {
      const date = new Date(now.getTime() - days * 86_400_000);
      return date.toISOString().slice(0, 10);
    },
  };
}
