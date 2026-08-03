import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseIssueRef } from './view.ts';
import {
  buildRepoContext,
  distinguishingLines,
  rankCandidates,
  scoreCandidate,
  topLines,
  type Candidate,
} from './score.ts';
import { WEIGHTS } from './weights.ts';

const NOW = new Date('2026-07-31T00:00:00Z');
const DAY = 86_400_000;

/** A deliberately neutral candidate: nothing measured, nothing notable. */
function candidate(overrides: Partial<Candidate> = {}): Candidate {
  return {
    issueId: 1,
    repoFullName: 'owner/name',
    number: 1,
    title: 'Something',
    labels: [],
    commentCount: 6,
    createdAtGh: new Date(NOW.getTime() - 100 * DAY).toISOString(),
    authorAssociation: 'NONE',
    bodyLength: 400,
    htmlUrl: 'https://example.invalid/1',
    primaryLanguage: null,
    topics: [],
    stars: 500,
    responsiveness: null,
    confidence: null,
    medianHoursResponse: null,
    noResponseRate: null,
    mergeRate: null,
    mergedPrs: null,
    closedUnmergedPrs: null,
    setupWeight: null,
    composeServices: null,
    envVarCount: null,
    hasDevcontainer: null,
    taskRunner: null,
    hasContributing: null,
    ciRunsOnPr: null,
    ...overrides,
  };
}

function pointsFor(scored: ReturnType<typeof scoreCandidate>, signal: string): number {
  return scored.lines.filter((line) => line.signal === signal).reduce((sum, line) => sum + line.points, 0);
}

test('a candidate with nothing measured scores near zero and says what is missing', () => {
  const scored = scoreCandidate(candidate(), NOW);
  assert.equal(scored.score, 0);
  assert.deepEqual(scored.unmeasured.sort(), ['merge rate', 'responsiveness', 'setup'].sort());
});

test('every line carries the raw value that produced it', () => {
  const scored = scoreCandidate(
    candidate({
      responsiveness: 'responsive',
      confidence: 'high',
      medianHoursResponse: 6,
      setupWeight: 'light',
      composeServices: 1,
      envVarCount: 2,
    }),
    NOW,
  );
  for (const line of scored.lines) {
    assert.ok(line.detail.length > 0, `${line.signal} has no detail`);
  }
  const responsiveness = scored.lines.find((line) => line.signal === 'responsiveness');
  assert.match(responsiveness!.detail, /responsive/);
  assert.match(responsiveness!.detail, /6h/);
});

test('the score is the sum of its lines, always', () => {
  const scored = scoreCandidate(
    candidate({
      responsiveness: 'responsive',
      confidence: 'high',
      labels: ['good first issue'],
      primaryLanguage: 'TypeScript',
      setupWeight: 'light',
      hasDevcontainer: true,
      commentCount: 1,
      stars: 5000,
    }),
    NOW,
  );
  assert.equal(scored.score, scored.lines.reduce((sum, line) => sum + line.points, 0));
});

// --- the case that motivated putting merge rate here ------------------------

test('a project that answers fast and merges nothing is penalised, not rewarded', () => {
  /*
   * Observed in the corpus: every outside PR answered within two hours, ten of sixteen closed
   * unmerged. Responsiveness alone called it "responsive". Fast triage is not a project that lands
   * your work, and the ranking has to be able to tell them apart.
   */
  const triageOnly = scoreCandidate(
    candidate({
      responsiveness: 'responsive',
      confidence: 'high',
      medianHoursResponse: 1,
      mergeRate: 0.1,
      mergedPrs: 1,
      closedUnmergedPrs: 9,
    }),
    NOW,
  );
  const generous = scoreCandidate(
    candidate({
      responsiveness: 'responsive',
      confidence: 'high',
      medianHoursResponse: 1,
      mergeRate: 0.8,
      mergedPrs: 8,
      closedUnmergedPrs: 2,
    }),
    NOW,
  );

  assert.ok(pointsFor(triageOnly, 'merge rate') < 0, 'closing everything must cost');
  assert.ok(pointsFor(generous, 'merge rate') > 0);
  assert.ok(
    generous.score - triageOnly.score >= 40,
    'the gap must be large enough to reorder the list',
  );
  assert.match(
    triageOnly.lines.find((line) => line.signal === 'merge rate')!.detail,
    /answers, then closes/,
  );
});

test('merge rate is ignored until the denominator is real', () => {
  const thin = scoreCandidate(
    candidate({ mergeRate: 0, mergedPrs: 0, closedUnmergedPrs: 2 }),
    NOW,
  );
  assert.equal(pointsFor(thin, 'merge rate'), 0);
  assert.ok(thin.unmeasured.some((entry) => entry.includes('merge rate')));
});

test('thin repo samples have their repo signals halved', () => {
  const confident = scoreCandidate(candidate({ responsiveness: 'responsive', confidence: 'high' }), NOW);
  const thin = scoreCandidate(candidate({ responsiveness: 'responsive', confidence: 'low' }), NOW);

  assert.equal(pointsFor(confident, 'responsiveness'), WEIGHTS.responsiveness['responsive']);
  assert.equal(
    pointsFor(thin, 'responsiveness'),
    Math.round(WEIGHTS.responsiveness['responsive']! * WEIGHTS.lowConfidenceMultiplier),
  );
  assert.match(thin.lines.find((line) => line.signal === 'responsiveness')!.detail, /halved/);
});

test('unmeasured setup scores zero rather than penalising the repo', () => {
  // Slice 3 reads root-level files only, so "unknown" is a limitation, not a finding.
  const unknown = scoreCandidate(candidate({ setupWeight: 'unknown' }), NOW);
  assert.equal(pointsFor(unknown, 'setup'), 0);
  assert.ok(unknown.unmeasured.includes('setup'));

  const heavy = scoreCandidate(candidate({ setupWeight: 'heavy' }), NOW);
  assert.ok(pointsFor(heavy, 'setup') < 0);
});

test('onboarding aids are counted separately from setup weight', () => {
  const heavyWithHelp = scoreCandidate(
    candidate({
      setupWeight: 'heavy',
      hasDevcontainer: true,
      taskRunner: 'make',
      hasContributing: true,
      ciRunsOnPr: true,
    }),
    NOW,
  );
  const heavyAlone = scoreCandidate(candidate({ setupWeight: 'heavy' }), NOW);

  assert.ok(pointsFor(heavyWithHelp, 'onboarding') > 0);
  assert.equal(pointsFor(heavyAlone, 'onboarding'), 0);
  assert.ok(
    heavyWithHelp.score > heavyAlone.score,
    'a documented path in must be visible in the ranking',
  );
});

// --- issue-level signals ---------------------------------------------------

test('invited labels beat merely tractable ones and are not double counted', () => {
  const invited = scoreCandidate(candidate({ labels: ['good first issue', 'documentation'] }), NOW);
  assert.equal(pointsFor(invited, 'invited'), WEIGHTS.invitedLabel);
  assert.equal(pointsFor(invited, 'tractable'), 0, 'no stacking');

  const tractable = scoreCandidate(candidate({ labels: ['documentation'] }), NOW);
  assert.equal(pointsFor(tractable, 'tractable'), WEIGHTS.tractableLabel);
});

test('labels signalling a design argument cost points even on an invited issue', () => {
  const scored = scoreCandidate(candidate({ labels: ['good first issue', 'needs design'] }), NOW);
  assert.ok(pointsFor(scored, 'avoid') < 0);
});

test('label matching is case and separator tolerant', () => {
  for (const label of ['Good First Issue', 'good-first-issue', 'help wanted']) {
    assert.ok(pointsFor(scoreCandidate(candidate({ labels: [label] }), NOW), 'invited') > 0, label);
  }
});

test('comment count reads as contention in both directions', () => {
  assert.ok(pointsFor(scoreCandidate(candidate({ commentCount: 0 }), NOW), 'uncontested') > 0);
  assert.ok(pointsFor(scoreCandidate(candidate({ commentCount: 30 }), NOW), 'contested') < 0);
  assert.equal(pointsFor(scoreCandidate(candidate({ commentCount: 7 }), NOW), 'uncontested'), 0);
});

test('age is scored at both ends and not in the middle', () => {
  const fresh = candidate({ createdAtGh: new Date(NOW.getTime() - 10 * DAY).toISOString() });
  const middling = candidate({ createdAtGh: new Date(NOW.getTime() - 200 * DAY).toISOString() });
  const ancient = candidate({ createdAtGh: new Date(NOW.getTime() - 900 * DAY).toISOString() });

  assert.ok(pointsFor(scoreCandidate(fresh, NOW), 'fresh') > 0);
  assert.equal(scoreCandidate(middling, NOW).score, 0);
  assert.ok(pointsFor(scoreCandidate(ancient, NOW), 'stale') < 0);
});

test('a thin issue body costs points and a detailed one earns them', () => {
  assert.ok(pointsFor(scoreCandidate(candidate({ bodyLength: 40 }), NOW), 'thin description') < 0);
  assert.ok(pointsFor(scoreCandidate(candidate({ bodyLength: 2000 }), NOW), 'detailed') > 0);
});

test('language preference applies and unlisted languages are neutral', () => {
  assert.ok(pointsFor(scoreCandidate(candidate({ primaryLanguage: 'TypeScript' }), NOW), 'language') > 0);
  assert.equal(pointsFor(scoreCandidate(candidate({ primaryLanguage: 'COBOL' }), NOW), 'language'), 0);
});

// --- ranking ---------------------------------------------------------------

test('ranking sorts by score and applies the minimum', () => {
  const strong = candidate({
    issueId: 1, number: 1, labels: ['good first issue'], primaryLanguage: 'TypeScript',
    responsiveness: 'responsive', confidence: 'high', setupWeight: 'light', commentCount: 0,
  });
  const weak = candidate({ issueId: 2, number: 2, labels: ['needs design'], commentCount: 40 });

  const ranked = rankCandidates([weak, strong], { minScore: 20, now: NOW });
  assert.equal(ranked.length, 1);
  assert.equal(ranked[0]?.candidate.number, 1);

  const all = rankCandidates([weak, strong], { minScore: -100, now: NOW });
  assert.equal(all.length, 2);
  assert.ok(all[0]!.score > all[1]!.score, 'descending');
});

test('topLines surfaces the largest contributors regardless of sign', () => {
  const scored = scoreCandidate(
    candidate({
      responsiveness: 'responsive', confidence: 'high', labels: ['good first issue'],
      mergeRate: 0.05, mergedPrs: 1, closedUnmergedPrs: 19,
    }),
    NOW,
  );
  const top = topLines(scored, 2).map((line) => line.signal);
  assert.ok(top.includes('merge rate'), 'a large penalty is as informative as a large bonus');
});

test('issue references parse and reject malformed input', () => {
  assert.deepEqual(parseIssueRef('owner/name#123'), { fullName: 'owner/name', number: 123 });
  assert.deepEqual(parseIssueRef('  a-b/c.d#7  '), { fullName: 'a-b/c.d', number: 7 });
  for (const bad of ['owner/name', '#123', 'owner#123', 'owner/name#abc', '']) {
    assert.throws(() => parseIssueRef(bad), /owner\/name#123/, bad);
  }
});

// ---------------------------------------------------------------------------
// Scope: from a real shortlist where an epic ranked second
// ---------------------------------------------------------------------------

test('feature requests and tracking issues are pushed below comparable small work', () => {
  const small = candidate({
    title: 'CLAUDE.md: update stale requires-python reference',
    labels: ['good first issue'],
  });
  const epic = candidate({
    title: 'Master FR: Pen, Stylus, Handwriting, and Drawing Tablet Support',
    labels: ['good first issue'],
  });
  const tracking = candidate({ title: 'Tracking issue for Python 3.13 support', labels: ['help wanted'] });

  assert.equal(pointsFor(scoreCandidate(small, NOW), 'scope'), 0, 'ordinary work is untouched');
  assert.ok(pointsFor(scoreCandidate(epic, NOW), 'scope') < 0);
  assert.ok(pointsFor(scoreCandidate(tracking, NOW), 'scope') < 0);
  assert.ok(
    scoreCandidate(small, NOW).score > scoreCandidate(epic, NOW).score,
    'an invited label on an epic must not outrank a real small task',
  );
});

test('scope patterns match the observed title shapes and nothing else', () => {
  const scoped = [
    'FR: Improved Pen Width and Writing Ergonomics',
    '[RFC] New plugin architecture',
    'Epic: authentication overhaul',
    'Proposal: change the config format',
    'Umbrella issue for Windows support',
    'Rewrite the scheduler',
  ];
  const ordinary = [
    'Ansible hover fails on windows',
    'Add Unit Tests for Feedback Template Validation',
    'Enhance Distribution Documentation with Mathematical Explanations',
    'Improve survival example',
    // "feature" appearing mid-title is a description, not a scope marker
    'Crash when the export feature is used twice',
    'Refactor the parser tests',
  ];
  for (const title of scoped) {
    assert.ok(pointsFor(scoreCandidate(candidate({ title }), NOW), 'scope') < 0, title);
  }
  for (const title of ordinary) {
    assert.equal(pointsFor(scoreCandidate(candidate({ title }), NOW), 'scope'), 0, title);
  }
});

test('only one scope penalty applies even when several patterns match', () => {
  const scored = scoreCandidate(candidate({ title: '[RFC] Epic: tracking issue for the rewrite' }), NOW);
  assert.equal(scored.lines.filter((line) => line.signal === 'scope').length, 1);
});

test('a sprawling body is a specification, not a task', () => {
  assert.ok(pointsFor(scoreCandidate(candidate({ bodyLength: 9000 }), NOW), 'sprawling') < 0);
  assert.ok(pointsFor(scoreCandidate(candidate({ bodyLength: 1200 }), NOW), 'detailed') > 0);
  assert.equal(pointsFor(scoreCandidate(candidate({ bodyLength: 9000 }), NOW), 'detailed'), 0);
});

// ---------------------------------------------------------------------------
// The panel has to distinguish issues, not repeat repo facts
// ---------------------------------------------------------------------------

test('every line declares whether it is about the project or the issue', () => {
  const scored = scoreCandidate(
    candidate({
      responsiveness: 'responsive', confidence: 'high', mergeRate: 0.8, mergedPrs: 8,
      closedUnmergedPrs: 2, setupWeight: 'light', primaryLanguage: 'Python',
      labels: ['good first issue'], commentCount: 1, bodyLength: 900, stars: 5000,
    }),
    NOW,
  );
  for (const line of scored.lines) {
    assert.ok(line.about === 'repo' || line.about === 'issue', `${line.signal} untagged`);
  }
  assert.ok(scored.lines.some((line) => line.about === 'repo'));
  assert.ok(scored.lines.some((line) => line.about === 'issue'));
});

test('two issues in the same repo produce identical repo lines and different issue lines', () => {
  /*
   * The defect this fixes: a real shortlist showed "+22 responsiveness +16 merge rate +16 invited"
   * on nineteen of twenty rows, because repo signals carry the largest weights. The panel explained
   * why the repository was good and nothing about why one issue outranked another.
   */
  const shared = {
    responsiveness: 'responsive', confidence: 'high', mergeRate: 0.8, mergedPrs: 8,
    closedUnmergedPrs: 2, setupWeight: 'light', primaryLanguage: 'Python', stars: 5000,
  } as const;

  const good = scoreCandidate(
    candidate({ ...shared, labels: ['good first issue'], commentCount: 1, bodyLength: 900 }),
    NOW,
  );
  const poor = scoreCandidate(
    candidate({
      ...shared, title: 'Epic: rewrite everything', labels: ['needs design'],
      commentCount: 40, bodyLength: 20,
    }),
    NOW,
  );

  const repoOf = (scored: typeof good): string =>
    JSON.stringify(scored.lines.filter((line) => line.about === 'repo'));
  assert.equal(repoOf(good), repoOf(poor), 'same project, same repo lines');

  const goodIssue = distinguishingLines(good).map((line) => line.signal);
  const poorIssue = distinguishingLines(poor).map((line) => line.signal);
  assert.notDeepEqual(goodIssue, poorIssue);
  assert.ok(goodIssue.includes('invited'));
  assert.ok(poorIssue.includes('scope') || poorIssue.includes('avoid'));
});

test('distinguishingLines returns nothing rather than falling back to repo facts', () => {
  // An unremarkable issue in a strong repo: the honest display is "nothing notable".
  const scored = scoreCandidate(
    candidate({
      responsiveness: 'responsive', confidence: 'high', setupWeight: 'light',
      primaryLanguage: 'Python', commentCount: 7, bodyLength: 400,
      createdAtGh: new Date(NOW.getTime() - 200 * DAY).toISOString(),
    }),
    NOW,
  );
  assert.deepEqual(distinguishingLines(scored), []);
  assert.ok(topLines(scored).length > 0, 'topLines still sees everything');
});

test('a bare [REQUEST] title is a feature request', () => {
  // Reached position 11 of a real shortlist: the pattern matched "FR:" but not a plain "REQUEST".
  for (const title of ['[REQUEST]: Partial classes and .net support', 'Request: add dark mode']) {
    assert.ok(pointsFor(scoreCandidate(candidate({ title }), NOW), 'scope') < 0, title);
  }
  assert.equal(
    pointsFor(scoreCandidate(candidate({ title: 'Requesting clarification on the API' }), NOW), 'scope'),
    0,
    'a word mid-sentence is not a scope marker',
  );
});

// ---------------------------------------------------------------------------
// Issue mills: only visible across issues
// ---------------------------------------------------------------------------

/**
 * From a real shortlist: lingdojo/kana-dojo took positions 4 and 5 with eighteen more queued.
 * Issue #26732 in a small app, titles like "[Good First Issue] Add new Video Game Quote 50", a dozen
 * opened the same day. Every per-issue signal read as excellent.
 */
function milledIssue(index: number): Candidate {
  return candidate({
    issueId: 1000 + index,
    number: 26000 + index,
    repoFullName: 'mill/farm',
    title: `[Good First Issue] Add new Video Game Quote ${index}`,
    labels: ['good first issue'],
    commentCount: 1,
    createdAtGh: new Date(NOW.getTime() - 1 * DAY).toISOString(),
    authorAssociation: 'COLLABORATOR',
    bodyLength: 700,
    primaryLanguage: 'TypeScript',
    stars: 400,
    responsiveness: 'responsive',
    confidence: 'high',
    medianHoursResponse: 1,
    mergeRate: 0.9,
    mergedPrs: 18,
    closedUnmergedPrs: 2,
    setupWeight: 'light',
  });
}

test('a burst of invited issues in one repo is penalised', () => {
  const mill = Array.from({ length: 20 }, (_unused, index) => milledIssue(index));
  const context = buildRepoContext(mill, NOW);
  assert.equal(context.get('mill/farm')?.invitedRecent, 20);

  const alone = scoreCandidate(milledIssue(1), NOW);
  const inContext = scoreCandidate(milledIssue(1), NOW, context.get('mill/farm'));

  assert.equal(pointsFor(alone, 'issue mill'), 0, 'invisible without repository context');
  assert.ok(pointsFor(inContext, 'issue mill') < 0);
  assert.ok(
    alone.score - inContext.score >= 30,
    'the penalty must be enough to clear the top of the list',
  );
});

test('a normal repo with a few invited issues is untouched', () => {
  const normal = Array.from({ length: 4 }, (_unused, index) =>
    candidate({
      issueId: index,
      number: index,
      repoFullName: 'real/project',
      labels: ['good first issue'],
      createdAtGh: new Date(NOW.getTime() - 2 * DAY).toISOString(),
    }),
  );
  const context = buildRepoContext(normal, NOW);
  assert.equal(context.get('real/project')?.invitedRecent, 4);
  assert.equal(pointsFor(scoreCandidate(normal[0]!, NOW, context.get('real/project')), 'issue mill'), 0);
});

test('old invited issues do not count as a burst', () => {
  // A long-standing backlog of labelled issues is normal; a burst opened this week is not.
  const backlog = Array.from({ length: 30 }, (_unused, index) =>
    candidate({
      issueId: index,
      number: index,
      repoFullName: 'real/project',
      labels: ['good first issue'],
      createdAtGh: new Date(NOW.getTime() - (60 + index) * DAY).toISOString(),
    }),
  );
  const context = buildRepoContext(backlog, NOW);
  assert.equal(context.get('real/project')?.invitedRecent, 0);
});

test('ranking applies the mill penalty so a farm cannot dominate the list', () => {
  const mill = Array.from({ length: 20 }, (_unused, index) => milledIssue(index));
  const real = candidate({
    issueId: 9999,
    number: 1,
    repoFullName: 'real/project',
    title: 'Fix crash when parsing empty config',
    labels: ['good first issue'],
    commentCount: 1,
    createdAtGh: new Date(NOW.getTime() - 5 * DAY).toISOString(),
    authorAssociation: 'MEMBER',
    bodyLength: 800,
    primaryLanguage: 'Python',
    stars: 5000,
    responsiveness: 'responsive',
    confidence: 'high',
    medianHoursResponse: 6,
    mergeRate: 0.7,
    mergedPrs: 10,
    closedUnmergedPrs: 4,
    setupWeight: 'light',
  });

  const ranked = rankCandidates([...mill, real], { minScore: -200, now: NOW });
  assert.equal(ranked[0]?.candidate.repoFullName, 'real/project', 'real work ranks first');
});

test('decision issues are scoped down', () => {
  const scored = scoreCandidate(
    candidate({ title: '💡 Decide what "Overdue" means: planned-past vs deadline-past' }),
    NOW,
  );
  assert.ok(pointsFor(scored, 'scope') < 0);
  assert.equal(
    pointsFor(scoreCandidate(candidate({ title: 'Decided to close this' }), NOW), 'scope'),
    0,
  );
});
