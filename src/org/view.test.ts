import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  assembleOrgs,
  filterOrgs,
  rollUpOrgs,
  sortOrgs,
  type OrgRepoRow,
  type OrgRow,
  type OrgTagRow,
} from './view.ts';

function repo(overrides: Partial<OrgRepoRow> = {}): OrgRepoRow {
  return {
    login: 'acme',
    displayName: null,
    repoFullName: 'acme/widgets',
    primaryLanguage: 'TypeScript',
    stars: 1000,
    responsiveness: 'responsive',
    confidence: 'high',
    medianHoursResponse: 6,
    noResponseRate: 0.1,
    mergedPrs: 8,
    closedUnmergedPrs: 2,
    setupWeight: 'light',
    contributorAgreement: null,
    candidates: 3,
    momentum: null,
    starsGained: null,
    ...overrides,
  };
}

function one(rows: OrgRepoRow[], tags: OrgTagRow[] = []): OrgRow {
  const rolled = rollUpOrgs(rows, tags);
  assert.equal(rolled.length, 1);
  return rolled[0]!;
}

// --------------------------------------------------------------- the verdict

test('the verdict is the most common across measured repositories, with its denominator', () => {
  const row = one([
    repo({ repoFullName: 'acme/a', responsiveness: 'responsive' }),
    repo({ repoFullName: 'acme/b', responsiveness: 'responsive' }),
    repo({ repoFullName: 'acme/c', responsiveness: 'dormant' }),
  ]);
  assert.equal(row.responsiveness, 'responsive');
  assert.equal(row.agreeing, 2);
  assert.equal(row.measuredRepos, 3);
});

/**
 * One dormant repository out of forty does not make an organisation dormant, and one responsive
 * repository out of forty does not make it responsive. The modal verdict is the only combination that
 * gets both of those right.
 */
test('a single outlier does not decide the verdict', () => {
  const many = Array.from({ length: 9 }, (_, index) =>
    repo({ repoFullName: `acme/r${index}`, responsiveness: 'responsive' }),
  );
  const row = one([...many, repo({ repoFullName: 'acme/dead', responsiveness: 'dormant' })]);
  assert.equal(row.responsiveness, 'responsive');
  assert.equal(row.agreeing, 9);
});

/**
 * A tie breaks toward the worse verdict, deliberately. Being told an organisation is responsive when
 * half of it is not costs you an evening; being told it is slow when half of it is fine costs a second
 * look.
 */
test('a tie breaks toward the worse verdict', () => {
  const row = one([
    repo({ repoFullName: 'acme/a', responsiveness: 'responsive' }),
    repo({ repoFullName: 'acme/b', responsiveness: 'slow' }),
  ]);
  assert.equal(row.responsiveness, 'slow');
});

test('no measured repository means a null verdict, not unknown', () => {
  const row = one([repo({ responsiveness: null, medianHoursResponse: null })]);
  // `unknown` is a real measured outcome meaning the evidence was too thin. Never having looked is a
  // different state and must not borrow its name.
  assert.equal(row.responsiveness, null);
  assert.equal(row.measuredRepos, 0);
});

// ----------------------------------------------------------------- the middle

test('the median reply is a median of per-repository medians', () => {
  const row = one([
    repo({ repoFullName: 'acme/a', medianHoursResponse: 2 }),
    repo({ repoFullName: 'acme/b', medianHoursResponse: 6 }),
    repo({ repoFullName: 'acme/c', medianHoursResponse: 100 }),
  ]);
  // Not the mean, which 100 would drag to 36.
  assert.equal(row.medianRepoHoursResponse, 6);
});

test('repositories with no median contribute nothing rather than zero', () => {
  const row = one([
    repo({ repoFullName: 'acme/a', medianHoursResponse: 10 }),
    repo({ repoFullName: 'acme/b', medianHoursResponse: null }),
  ]);
  assert.equal(row.medianRepoHoursResponse, 10);
});

/**
 * Pooled, not averaged. The mean of the rates here is 75%, which lets a repository with two decided
 * pull requests outvote one with two hundred.
 */
test('merge rate is pooled across repositories and carries its denominator', () => {
  const row = one([
    repo({ repoFullName: 'acme/busy', mergedPrs: 50, closedUnmergedPrs: 50 }),
    repo({ repoFullName: 'acme/quiet', mergedPrs: 2, closedUnmergedPrs: 0 }),
  ]);
  assert.equal(row.decidedPrs, 102);
  assert.equal(Math.round(row.mergeRate! * 100), 51);
});

test('no decided pull requests means a null merge rate, not zero', () => {
  const row = one([repo({ mergedPrs: 0, closedUnmergedPrs: 0 })]);
  assert.equal(row.mergeRate, null);
  assert.equal(row.decidedPrs, 0);
});

test('setup is a distribution, and missing facts are absent from it', () => {
  const row = one([
    repo({ repoFullName: 'acme/a', setupWeight: 'light' }),
    repo({ repoFullName: 'acme/b', setupWeight: 'heavy' }),
    repo({ repoFullName: 'acme/c', setupWeight: 'unknown' }),
    repo({ repoFullName: 'acme/d', setupWeight: null }),
  ]);
  assert.deepEqual(row.setup, { light: 1, moderate: 0, heavy: 1, unknown: 1 });
  // Four repositories, three classified: the distribution summing short is how "not read yet" shows.
  assert.equal(row.repos, 4);
});

test('CLA and DCO counts include repositories requiring both', () => {
  const row = one([
    repo({ repoFullName: 'acme/a', contributorAgreement: 'cla' }),
    repo({ repoFullName: 'acme/b', contributorAgreement: 'both' }),
    repo({ repoFullName: 'acme/c', contributorAgreement: 'dco' }),
    repo({ repoFullName: 'acme/d', contributorAgreement: 'none' }),
  ]);
  assert.equal(row.claRepos, 2);
  assert.equal(row.dcoRepos, 2);
});

// ------------------------------------------------------- organisations, tags

/**
 * The row that makes the GSoC import worth running. An organisation from a curated list that has
 * never been measured is not an empty row to tidy away — it is the answer to "which of these have I
 * never looked at", and dropping it would leave the table describing only what discovery happened to
 * find.
 */
test('an organisation with no repositories survives as a row', () => {
  const row = one([
    {
      login: 'cern-hsf',
      displayName: null,
      repoFullName: null,
      primaryLanguage: null,
      stars: null,
      responsiveness: null,
      confidence: null,
      medianHoursResponse: null,
      noResponseRate: null,
      mergedPrs: null,
      closedUnmergedPrs: null,
      setupWeight: null,
      contributorAgreement: null,
      candidates: 0,
      momentum: null,
      starsGained: null,
    },
  ]);
  assert.equal(row.repos, 0);
  assert.equal(row.responsiveness, null);
  assert.equal(row.stars, 0);
});

test('GSoC years are sorted and the oldest review date is the one reported', () => {
  const tags: OrgTagRow[] = [
    { login: 'acme', kind: 'gsoc_year', value: '2026', source: null, reviewedAt: '2026-08-01' },
    { login: 'acme', kind: 'gsoc_year', value: '2024', source: null, reviewedAt: '2025-01-15' },
    { login: 'acme', kind: 'funding', value: 'yc-w22', source: null, reviewedAt: '2024-06-30' },
  ];
  const row = one([repo()], tags);
  assert.deepEqual(row.gsocYears, [2024, 2026]);
  // The OLDEST, because the reader is about to trust all three claims at once.
  assert.equal(row.tagsReviewedAt, '2024-06-30');
});

test('a non-numeric year is ignored rather than becoming NaN', () => {
  const row = one([repo()], [
    { login: 'acme', kind: 'gsoc_year', value: 'twenty-six', source: null, reviewedAt: '2026-01-01' },
  ]);
  assert.deepEqual(row.gsocYears, []);
});

// -------------------------------------------------------------------- sorting

function org(overrides: Partial<OrgRow> = {}): OrgRow {
  return {
    login: 'org',
    displayName: null,
    repos: 1,
    measuredRepos: 1,
    responsiveness: 'responsive',
    agreeing: 1,
    medianRepoHoursResponse: 5,
    mergeRate: 0.5,
    decidedPrs: 10,
    setup: { light: 1, moderate: 0, heavy: 0, unknown: 0 },
    claRepos: 0,
    dcoRepos: 0,
    stars: 100,
    primaryLanguage: 'Go',
    openCandidates: 5,
    candidateRepos: 1,
    momentum: null,
    momentumRepos: 0,
    starsGained: null,
    gsocYears: [],
    tagsReviewedAt: null,
    ...overrides,
  };
}

test('the default order is verdict, then merge rate, then available work', () => {
  const sorted = sortOrgs([
    org({ login: 'dormant-org', responsiveness: 'dormant' }),
    org({ login: 'slow-org', responsiveness: 'slow' }),
    org({ login: 'good-low-merge', responsiveness: 'responsive', mergeRate: 0.2 }),
    org({ login: 'good-high-merge', responsiveness: 'responsive', mergeRate: 0.9 }),
  ]);
  assert.deepEqual(sorted.map((row) => row.login), [
    'good-high-merge',
    'good-low-merge',
    'slow-org',
    'dormant-org',
  ]);
});

test('an unmeasured organisation sorts last, not first', () => {
  const sorted = sortOrgs([
    org({ login: 'never-looked', responsiveness: null, mergeRate: null }),
    org({ login: 'dormant-org', responsiveness: 'dormant' }),
  ]);
  // A list is a recommendation whatever it is called, and "we have never looked at this" does not
  // belong at the top of one.
  assert.deepEqual(sorted.map((row) => row.login), ['dormant-org', 'never-looked']);
});

test('no decided pull requests sorts below a real low rate', () => {
  const sorted = sortOrgs([
    org({ login: 'unknown-rate', mergeRate: null, decidedPrs: 0 }),
    org({ login: 'bad-rate', mergeRate: 0.05, decidedPrs: 40 }),
  ]);
  assert.deepEqual(sorted.map((row) => row.login), ['bad-rate', 'unknown-rate']);
});

test('sorting by candidates and by name are both available and deterministic', () => {
  const rows = [
    org({ login: 'b', openCandidates: 1 }),
    org({ login: 'a', openCandidates: 99 }),
  ];
  assert.deepEqual(sortOrgs(rows, 'candidates').map((r) => r.login), ['a', 'b']);
  assert.deepEqual(sortOrgs(rows, 'name').map((r) => r.login), ['a', 'b']);
});

// -------------------------------------------------------------------- filters

test('a GSoC year filter matches that year only', () => {
  const rows = [
    org({ login: 'in-2026', gsocYears: [2026] }),
    org({ login: 'in-2024', gsocYears: [2024] }),
    org({ login: 'never', gsocYears: [] }),
  ];
  assert.deepEqual(filterOrgs(rows, { gsoc: 2026 }).map((r) => r.login), ['in-2026']);
  assert.deepEqual(filterOrgs(rows, { gsoc: 'any' }).map((r) => r.login), ['in-2026', 'in-2024']);
});

test('the language filter is case-insensitive', () => {
  const rows = [org({ login: 'ts', primaryLanguage: 'TypeScript' })];
  // The casing GitHub uses is canonical and nobody types it that way. An exact match here returned an
  // empty result that looked like a real answer, once, in the shortlist.
  assert.equal(filterOrgs(rows, { language: 'typescript' }).length, 1);
});

test('uncoveredOnly keeps exactly the organisations with nothing measured', () => {
  const rows = [org({ login: 'measured', repos: 3 }), org({ login: 'not', repos: 0 })];
  assert.deepEqual(filterOrgs(rows, { uncoveredOnly: true }).map((r) => r.login), ['not']);
  assert.deepEqual(filterOrgs(rows, { minRepos: 1 }).map((r) => r.login), ['measured']);
});

// ------------------------------------------------------------------- assembly

test('the summary counts the filtered set and the notices explain the gaps', () => {
  const view = assembleOrgs(
    [
      repo({ login: 'acme' }),
      { ...repo({ login: 'ghost' }), responsiveness: null, medianHoursResponse: null },
      {
        ...repo({ login: 'cern-hsf' }),
        repoFullName: null,
        responsiveness: null,
        medianHoursResponse: null,
        candidates: 0,
      },
    ],
    [],
    { now: new Date('2026-08-04T00:00:00Z') },
  );

  assert.equal(view.summary.organizations, 3);
  assert.equal(view.summary.uncovered, 1);
  assert.equal(view.summary.unmeasured, 1);
  assert.ok(view.notices.some((notice) => notice.includes('no repositories in your corpus')));
  assert.ok(view.notices.some((notice) => notice.includes('sync metrics')));
});

test('pagination reports what it shows without losing the total', () => {
  const rows = Array.from({ length: 5 }, (_, index) =>
    repo({ login: `org${index}`, repoFullName: `org${index}/r` }),
  );
  const view = assembleOrgs(rows, [], { limit: 2, offset: 2 });
  assert.equal(view.summary.organizations, 5);
  assert.equal(view.summary.shown, 2);
});
