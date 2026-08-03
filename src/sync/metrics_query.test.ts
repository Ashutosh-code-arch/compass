import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parse, validate, buildSchema, Kind, type OperationDefinitionNode } from 'graphql';
import {
  buildMaintainerRoster,
  buildMetricsQuery,
  mapPullRequest,
  type GqlPullRequest,
} from './metrics_query.ts';

/**
 * A trimmed stand-in for GitHub's schema, covering exactly the fields the query touches. Enough to
 * catch a misspelled field, a wrong argument name, or an undeclared variable — the failures that
 * would otherwise surface as a wasted API call.
 */
const SCHEMA = buildSchema(`
  enum PullRequestState { OPEN CLOSED MERGED }
  enum PullRequestOrderField { CREATED_AT UPDATED_AT }
  enum OrderDirection { ASC DESC }
  input PullRequestOrder { field: PullRequestOrderField!, direction: OrderDirection! }

  interface Actor { login: String! }
  type User implements Actor { login: String! }
  type Bot implements Actor { login: String! }

  type PullRequestReview {
    state: String!
    submittedAt: String
    authorAssociation: String!
    author: Actor
  }
  type PullRequestReviewConnection { nodes: [PullRequestReview] }

  type IssueComment {
    createdAt: String!
    authorAssociation: String!
    author: Actor
  }
  type IssueCommentConnection { nodes: [IssueComment] }

  type PullRequest {
    number: Int!
    createdAt: String!
    closedAt: String
    mergedAt: String
    state: PullRequestState!
    authorAssociation: String!
    author: Actor
    mergedBy: Actor
    reviews(first: Int): PullRequestReviewConnection
    comments(first: Int): IssueCommentConnection
  }
  type PullRequestConnection { nodes: [PullRequest] }
  type UserConnection { nodes: [User] }

  type Repository {
    nameWithOwner: String!
    assignableUsers(first: Int): UserConnection
    pullRequests(first: Int, orderBy: PullRequestOrder, states: [PullRequestState!]): PullRequestConnection
  }

  type RateLimit { limit: Int!, cost: Int!, remaining: Int!, resetAt: String! }

  type Query {
    rateLimit: RateLimit
    repository(owner: String!, name: String!): Repository
  }
`);

test('generated query is valid GraphQL against the schema for every batch size', () => {
  for (const batchSize of [1, 2, 5, 10, 20]) {
    const source = buildMetricsQuery(batchSize);
    const document = parse(source);
    const errors = validate(SCHEMA, document);
    assert.deepEqual(
      errors.map((error) => error.message),
      [],
      `batch size ${batchSize} produced validation errors`,
    );
  }
});

test('every repo alias is declared and wired to its own variables', () => {
  const batchSize = 5;
  const document = parse(buildMetricsQuery(batchSize));
  const operation = document.definitions.find(
    (definition): definition is OperationDefinitionNode =>
      definition.kind === Kind.OPERATION_DEFINITION,
  );
  assert.ok(operation);

  const declared = new Set(
    operation.variableDefinitions?.map((definition) => definition.variable.name.value) ?? [],
  );
  for (let index = 0; index < batchSize; index += 1) {
    assert.ok(declared.has(`o${index}`), `missing $o${index}`);
    assert.ok(declared.has(`n${index}`), `missing $n${index}`);
  }
  assert.equal(declared.size, 3 + batchSize * 2, 'no stray or missing variables');

  const aliases = operation.selectionSet.selections
    .filter((selection) => selection.kind === Kind.FIELD)
    .map((selection) => selection.alias?.value)
    .filter((alias): alias is string => alias !== undefined);
  assert.deepEqual(aliases, ['r0', 'r1', 'r2', 'r3', 'r4']);
});

test('rateLimit is always requested so cost is measured, not estimated', () => {
  assert.match(buildMetricsQuery(1), /rateLimit\s*{[^}]*cost/);
});

// ---------------------------------------------------------------------------
// Response mapping
// ---------------------------------------------------------------------------

function node(overrides: Partial<GqlPullRequest> = {}): GqlPullRequest {
  return {
    number: 1,
    createdAt: '2026-06-01T00:00:00Z',
    closedAt: null,
    mergedAt: null,
    state: 'OPEN',
    authorAssociation: 'CONTRIBUTOR',
    author: { login: 'outsider', __typename: 'User' },
    mergedBy: null,
    reviews: { nodes: [] },
    comments: { nodes: [] },
    ...overrides,
  };
}

test('a maintainer review counts as the first response', () => {
  const observation = mapPullRequest(
    node({
      reviews: {
        nodes: [
          {
            state: 'CHANGES_REQUESTED',
            submittedAt: '2026-06-02T00:00:00Z',
            authorAssociation: 'MEMBER',
            author: { login: 'maint', __typename: 'User' },
          },
        ],
      },
    }),
  );
  assert.equal(observation.firstResponseAt, '2026-06-02T00:00:00Z');
  assert.equal(observation.firstResponseBy, 'maint');
  assert.equal(observation.changesRequested, true);
  assert.equal(observation.lastActionAt, '2026-06-02T00:00:00Z');
});

test('the earliest maintainer signal wins, whether review or comment', () => {
  const observation = mapPullRequest(
    node({
      reviews: {
        nodes: [
          {
            state: 'APPROVED',
            submittedAt: '2026-06-05T00:00:00Z',
            authorAssociation: 'OWNER',
            author: { login: 'owner', __typename: 'User' },
          },
        ],
      },
      comments: {
        nodes: [
          {
            createdAt: '2026-06-03T00:00:00Z',
            authorAssociation: 'MEMBER',
            author: { login: 'maint', __typename: 'User' },
          },
        ],
      },
    }),
  );
  assert.equal(observation.firstResponseAt, '2026-06-03T00:00:00Z', 'the comment came first');
  assert.equal(observation.lastActionAt, '2026-06-05T00:00:00Z', 'review timestamps drive liveness');
});

test('outsider and bot chatter is not a maintainer response', () => {
  const observation = mapPullRequest(
    node({
      comments: {
        nodes: [
          {
            createdAt: '2026-06-02T00:00:00Z',
            authorAssociation: 'CONTRIBUTOR',
            author: { login: 'bystander', __typename: 'User' },
          },
          {
            createdAt: '2026-06-02T01:00:00Z',
            authorAssociation: 'MEMBER',
            author: { login: 'ci-bot[bot]', __typename: 'Bot' },
          },
        ],
      },
    }),
  );
  assert.equal(observation.firstResponseAt, null);
});

test("the author's own comments never count, even for a maintainer's own PR", () => {
  const observation = mapPullRequest(
    node({
      authorAssociation: 'MEMBER',
      author: { login: 'maint', __typename: 'User' },
      comments: {
        nodes: [
          {
            createdAt: '2026-06-02T00:00:00Z',
            authorAssociation: 'MEMBER',
            author: { login: 'maint', __typename: 'User' },
          },
        ],
      },
    }),
  );
  assert.equal(observation.firstResponseAt, null);
  assert.equal(observation.authorAssociation, 'MEMBER', 'and it is excluded as an insider PR later');
});

test('pending reviews are invisible to the contributor and do not count', () => {
  const observation = mapPullRequest(
    node({
      reviews: {
        nodes: [
          {
            state: 'PENDING',
            submittedAt: null,
            authorAssociation: 'MEMBER',
            author: { login: 'maint', __typename: 'User' },
          },
        ],
      },
    }),
  );
  assert.equal(observation.firstResponseAt, null);
  assert.equal(observation.lastActionAt, null);
});

test('bot-authored PRs are flagged for exclusion', () => {
  const observation = mapPullRequest(
    node({ author: { login: 'dependabot[bot]', __typename: 'Bot' }, authorAssociation: 'NONE' }),
  );
  assert.equal(observation.authorIsBot, true);
});

test('deleted accounts and null nodes do not throw', () => {
  const observation = mapPullRequest(
    node({
      author: null,
      reviews: { nodes: [null] },
      comments: { nodes: [null] },
    }),
  );
  assert.equal(observation.authorLogin, null);
  assert.equal(observation.authorIsBot, false);
  assert.equal(observation.firstResponseAt, null);
});

test('merged and closed states map through', () => {
  assert.equal(mapPullRequest(node({ state: 'MERGED', mergedAt: '2026-06-04T00:00:00Z' })).state, 'MERGED');
  assert.equal(mapPullRequest(node({ state: 'CLOSED', closedAt: '2026-06-04T00:00:00Z' })).state, 'CLOSED');
  assert.equal(mapPullRequest(node({ state: 'OPEN' })).state, 'OPEN');
});

// ---------------------------------------------------------------------------
// A merge is maintainer attention
// ---------------------------------------------------------------------------

test('a human merge counts as a response even with no comment or review', () => {
  // The incoherent case from the real corpus: 100% ignored alongside a 100% merge rate.
  const observation = mapPullRequest(
    node({
      state: 'MERGED',
      mergedAt: '2026-06-02T00:00:00Z',
      mergedBy: { login: 'maint', __typename: 'User' },
    }),
  );
  assert.equal(observation.firstResponseAt, '2026-06-02T00:00:00Z');
  assert.equal(observation.firstResponseBy, 'maint');
  assert.equal(observation.firstResponseAssociation, 'MERGED_BY');
  assert.equal(observation.lastActionAt, '2026-06-02T00:00:00Z', 'a merge is a sign of life');
});

test('a queue merge still counts as attention, and is labelled as one', () => {
  /*
   * Reversed from an earlier version that ignored automated merges. That broke every Prow-based
   * project: Kubernetes and friends approve with "/lgtm" comments and let k8s-ci-robot merge, so
   * kueue reported 19 of 21 external PRs as "too recent to judge" while 11 had already merged.
   *
   * The guard was redundant anyway — bot-AUTHORED PRs are excluded upstream, so anything here is an
   * outside human's work, and a queue only lands it because a maintainer approved it.
   */
  const observation = mapPullRequest(
    node({
      state: 'MERGED',
      mergedAt: '2026-06-02T00:00:00Z',
      mergedBy: { login: 'k8s-ci-robot', __typename: 'User' },
    }),
  );
  assert.equal(observation.firstResponseAt, '2026-06-02T00:00:00Z');
  assert.equal(
    observation.firstResponseAssociation,
    'MERGED_BY_QUEUE',
    'the audit trail must distinguish a queue merge from a human one',
  );
  assert.equal(observation.lastActionAt, '2026-06-02T00:00:00Z');
});

test('a human merge is labelled differently from a queue merge', () => {
  const byHuman = mapPullRequest(
    node({
      state: 'MERGED',
      mergedAt: '2026-06-02T00:00:00Z',
      mergedBy: { login: 'maintainer', __typename: 'User' },
    }),
  );
  assert.equal(byHuman.firstResponseAssociation, 'MERGED_BY');
  assert.equal(byHuman.firstResponseBy, 'maintainer');
});

test('a merged PR is never left unattributed, whoever merged it', () => {
  // The invariant `status` checks: merged_prs > 0 with responded_prs = 0 should now be impossible.
  for (const merger of [
    { login: 'human', __typename: 'User' },
    { login: 'k8s-ci-robot', __typename: 'User' },
    { login: 'mergify[bot]', __typename: 'Bot' },
    null,
  ]) {
    const observation = mapPullRequest(
      node({ state: 'MERGED', mergedAt: '2026-06-02T00:00:00Z', mergedBy: merger }),
    );
    assert.notEqual(observation.firstResponseAt, null, JSON.stringify(merger));
  }
});

test('an earlier review still beats the merge timestamp', () => {
  const observation = mapPullRequest(
    node({
      state: 'MERGED',
      mergedAt: '2026-06-10T00:00:00Z',
      mergedBy: { login: 'maint', __typename: 'User' },
      reviews: {
        nodes: [
          {
            state: 'APPROVED',
            submittedAt: '2026-06-03T00:00:00Z',
            authorAssociation: 'MEMBER',
            author: { login: 'reviewer', __typename: 'User' },
          },
        ],
      },
    }),
  );
  assert.equal(observation.firstResponseAt, '2026-06-03T00:00:00Z');
  assert.equal(observation.lastActionAt, '2026-06-10T00:00:00Z', 'merge is the latest action');
});

test('an ignored login stops a MEMBER bot account counting as a response', () => {
  const withWelcomeBot = node({
    comments: {
      nodes: [
        {
          createdAt: '2026-06-01T00:00:30Z',
          authorAssociation: 'MEMBER',
          author: { login: 'projectmod', __typename: 'User' },
        },
      ],
    },
  });
  assert.equal(mapPullRequest(withWelcomeBot).firstResponseAt, '2026-06-01T00:00:30Z');
  assert.equal(
    mapPullRequest(withWelcomeBot, { ignoreLogins: new Set(['projectmod']) }).firstResponseAt,
    null,
    'the ignore list removes it',
  );
});

test('a maintainer whose login ends in bot still counts as the merger', () => {
  // Regression for the klembot case: the human merger was read as automation, so a repo that
  // merges most external PRs reported resp=0, no last action, and a dormant verdict.
  const observation = mapPullRequest(
    node({
      state: 'MERGED',
      mergedAt: '2026-06-02T00:00:00Z',
      mergedBy: { login: 'klembot', __typename: 'User' },
    }),
  );
  assert.equal(observation.firstResponseAt, '2026-06-02T00:00:00Z');
  assert.equal(observation.firstResponseBy, 'klembot');
  assert.equal(observation.lastActionAt, '2026-06-02T00:00:00Z');
});

test('a merged PR always registers a response unless automation merged it', () => {
  // The invariant `status` now checks for: merged_prs > 0 with responded_prs = 0 is only legitimate
  // for merge queues.
  const humanMerged = mapPullRequest(
    node({ state: 'MERGED', mergedAt: '2026-06-02T00:00:00Z', mergedBy: { login: 'someone', __typename: 'User' } }),
  );
  assert.notEqual(humanMerged.firstResponseAt, null);

  const unknownMerger = mapPullRequest(node({ state: 'MERGED', mergedAt: '2026-06-02T00:00:00Z', mergedBy: null }));
  assert.notEqual(unknownMerger.firstResponseAt, null, 'an unknown merger is not assumed to be a bot');
});

// ---------------------------------------------------------------------------
// The maintainer roster: authorAssociation only says MEMBER for PUBLIC org membership
// ---------------------------------------------------------------------------

test('assignableUsers seeds the roster', () => {
  const roster = buildMaintainerRoster(
    { assignableUsers: { nodes: [{ login: 'Maria' }, { login: 'dev2' }, null] } },
    [],
  );
  assert.deepEqual([...roster].sort(), ['dev2', 'maria'], 'lowercased, nulls skipped');
});

test('anyone who merged a PR is a maintainer, since merging requires write access', () => {
  const roster = buildMaintainerRoster({ assignableUsers: null }, [
    node({ state: 'MERGED', mergedAt: '2026-06-02T00:00:00Z', mergedBy: { login: 'Merger', __typename: 'User' } }),
  ]);
  assert.ok(roster.has('merger'));
});

test('bots never enter the roster', () => {
  const roster = buildMaintainerRoster(
    { assignableUsers: { nodes: [{ login: 'dependabot[bot]' }, { login: 'k8s-ci-robot' }] } },
    [node({ state: 'MERGED', mergedAt: '2026-06-02T00:00:00Z', mergedBy: { login: 'mergify[bot]', __typename: 'Bot' } })],
  );
  assert.equal(roster.size, 0);
});

test('a maintainer reported as CONTRIBUTOR is still a response when rostered', () => {
  /*
   * The real-corpus failure. Private org membership makes authorAssociation return CONTRIBUTOR, so
   * whole organisations reported 0 responses on 40 external PRs and were classified dormant.
   */
  const pr = node({
    comments: {
      nodes: [
        {
          createdAt: '2026-06-03T00:00:00Z',
          authorAssociation: 'CONTRIBUTOR',
          author: { login: 'quietmaintainer', __typename: 'User' },
        },
      ],
    },
  });

  assert.equal(mapPullRequest(pr).firstResponseAt, null, 'association alone sees nothing');
  const withRoster = mapPullRequest(pr, { roster: new Set(['quietmaintainer']) });
  assert.equal(withRoster.firstResponseAt, '2026-06-03T00:00:00Z');
  assert.equal(withRoster.firstResponseBy, 'quietmaintainer');
});

test('a rostered PR author is an insider even when reported as CONTRIBUTOR', () => {
  // Otherwise a maintainer's own PR counts as external, and its fast merge flatters the numbers.
  const pr = node({ authorAssociation: 'CONTRIBUTOR', author: { login: 'quietmaintainer', __typename: 'User' } });
  assert.equal(mapPullRequest(pr).authorIsInsider, false);
  assert.equal(mapPullRequest(pr, { roster: new Set(['quietmaintainer']) }).authorIsInsider, true);
});

test('a genuine outsider is not promoted by the roster', () => {
  const pr = node({
    comments: {
      nodes: [
        {
          createdAt: '2026-06-03T00:00:00Z',
          authorAssociation: 'CONTRIBUTOR',
          author: { login: 'bystander', __typename: 'User' },
        },
      ],
    },
  });
  assert.equal(mapPullRequest(pr, { roster: new Set(['quietmaintainer']) }).firstResponseAt, null);
});

test('a degraded response with null connections does not throw', () => {
  /*
   * GraphQL returns `nodes: null` when a field-level error degrades part of the response. The types
   * declared these non-nullable, so one degraded PR threw "reviews.nodes is not iterable" and took
   * a whole 5-repo batch down with it.
   */
  const degraded = { ...node(), reviews: { nodes: null }, comments: null } as never;
  const observation = mapPullRequest(degraded);
  assert.equal(observation.firstResponseAt, null);
  assert.equal(observation.changesRequested, false);

  const roster = buildMaintainerRoster({ assignableUsers: null }, [degraded]);
  assert.equal(roster.size, 0, 'roster building must survive it too');

  const missingEntirely = { ...node(), reviews: undefined, comments: undefined } as never;
  assert.equal(mapPullRequest(missingEntirely).firstResponseAt, null);
});
