import { RATE_LIMIT_FRAGMENT } from '../github/graphql.ts';
import { isBotActor, isInsider, type PrObservation } from '../metrics/compute.ts';

/**
 * One query covers several repositories via aliases. Batching does not reduce the point cost —
 * GitHub sums the aliases — but it cuts round trips substantially, and the cost is read back from
 * the response so the budget is measured rather than estimated.
 *
 * owner and name arrive as declared GraphQL variables rather than interpolated strings.
 */
export function buildMetricsQuery(batchSize: number): string {
  const declarations = ['$prCount: Int!', '$reviewCount: Int!', '$commentCount: Int!'];
  const aliases: string[] = [];

  for (let index = 0; index < batchSize; index += 1) {
    declarations.push(`$o${index}: String!`, `$n${index}: String!`);
    aliases.push(`  r${index}: repository(owner: $o${index}, name: $n${index}) { ...RepoPrs }`);
  }

  return `query MaintainerMetrics(${declarations.join(', ')}) {
  ${RATE_LIMIT_FRAGMENT}
${aliases.join('\n')}
}

fragment RepoPrs on Repository {
  nameWithOwner
  assignableUsers(first: 50) { nodes { login } }
  pullRequests(first: $prCount, orderBy: { field: CREATED_AT, direction: DESC }, states: [OPEN, CLOSED, MERGED]) {
    nodes {
      number
      createdAt
      closedAt
      mergedAt
      state
      authorAssociation
      author { login __typename }
      mergedBy { login __typename }
      reviews(first: $reviewCount) {
        nodes {
          state
          submittedAt
          authorAssociation
          author { login __typename }
        }
      }
      comments(first: $commentCount) {
        nodes {
          createdAt
          authorAssociation
          author { login __typename }
        }
      }
    }
  }
}`;
}

interface GqlActor {
  login: string;
  __typename: string;
}

interface GqlReview {
  state: string;
  submittedAt: string | null;
  authorAssociation: string;
  author: GqlActor | null;
}

interface GqlComment {
  createdAt: string;
  authorAssociation: string;
  author: GqlActor | null;
}

export interface GqlPullRequest {
  number: number;
  createdAt: string;
  closedAt: string | null;
  mergedAt: string | null;
  state: string;
  authorAssociation: string;
  author: GqlActor | null;
  mergedBy: GqlActor | null;
  reviews?: { nodes?: (GqlReview | null)[] | null } | null;
  comments?: { nodes?: (GqlComment | null)[] | null } | null;
}

export interface GqlRepository {
  nameWithOwner: string;
  /** Users who can be assigned to issues and PRs — i.e. those holding triage or write access. */
  assignableUsers?: { nodes: ({ login: string } | null)[] } | null;
  pullRequests: { nodes: (GqlPullRequest | null)[] };
}

export interface MapOptions {
  ignoreLogins?: ReadonlySet<string>;
  /** Lowercased maintainer logins, from buildMaintainerRoster. */
  roster?: ReadonlySet<string>;
}

/**
 * The maintainer roster for one repository.
 *
 * This exists because `authorAssociation` only reports MEMBER when the org membership is PUBLIC.
 * Maintainers with private membership return CONTRIBUTOR, so an association-only check rendered them
 * invisible — whole organisations came back as 0 responses and 0 merges on 40 external PRs, which
 * read as dormancy and was nothing of the kind.
 *
 * Sources, most to least direct: assignableUsers (write access, definitionally), anyone who merged
 * a PR (merging requires write access), and anyone the API did label as an insider.
 */
export function buildMaintainerRoster(
  repository: Pick<GqlRepository, 'assignableUsers'>,
  nodes: GqlPullRequest[],
  ignoreLogins?: ReadonlySet<string>,
): Set<string> {
  const roster = new Set<string>();
  const add = (login: string | null | undefined, typename?: string): void => {
    if (!login) return;
    if (isBotActor(login, typename, ignoreLogins)) return;
    roster.add(login.toLowerCase());
  };

  for (const user of repository.assignableUsers?.nodes ?? []) add(user?.login);

  for (const pr of nodes) {
    add(pr.mergedBy?.login, pr.mergedBy?.__typename);
    if (isInsider(pr.authorAssociation)) add(pr.author?.login, pr.author?.__typename);
    for (const review of reviewsOf(pr)) {
      if (isInsider(review.authorAssociation)) add(review.author?.login, review.author?.__typename);
    }
    for (const comment of commentsOf(pr)) {
      if (isInsider(comment.authorAssociation)) add(comment.author?.login, comment.author?.__typename);
    }
  }

  return roster;
}

/**
 * A response counts only if it comes from a maintainer (OWNER / MEMBER / COLLABORATOR) who is not
 * a bot and not the PR author. Counting replies from fellow outsiders would measure community
 * chatter, not whether anyone with merge rights is paying attention.
 *
 * The actor and association behind every first response are kept in `detail` so this strict filter
 * can be audited — some projects run triage teams whose members show up as CONTRIBUTOR, and that
 * would read as silence here.
 */
/** Connections may be null, and so may their nodes, when a field-level error degrades the response. */
function reviewsOf(pr: GqlPullRequest): GqlReview[] {
  return (pr.reviews?.nodes ?? []).filter((review): review is GqlReview => review !== null);
}

function commentsOf(pr: GqlPullRequest): GqlComment[] {
  return (pr.comments?.nodes ?? []).filter((comment): comment is GqlComment => comment !== null);
}

function isMaintainerResponse(
  association: string,
  actor: GqlActor | null,
  prAuthorLogin: string | null,
  options: MapOptions,
): boolean {
  if (isBotActor(actor?.login, actor?.__typename, options.ignoreLogins)) return false;
  if (actor && prAuthorLogin && actor.login === prAuthorLogin) return false;
  if (isInsider(association)) return true;
  // Association says CONTRIBUTOR, but the roster knows they hold write access.
  return actor ? (options.roster?.has(actor.login.toLowerCase()) ?? false) : false;
}

export function mapPullRequest(node: GqlPullRequest, options: MapOptions = {}): PrObservation {
  const { ignoreLogins } = options;
  const authorLogin = node.author?.login ?? null;
  const reviews = reviewsOf(node);
  const comments = commentsOf(node);

  let firstResponseAt: string | null = null;
  let firstResponseBy: string | null = null;
  let firstResponseAssociation: string | null = null;
  let lastActionAt: string | null = null;
  let changesRequested = false;

  const consider = (at: string, actor: GqlActor | null, association: string): void => {
    if (!firstResponseAt || at < firstResponseAt) {
      firstResponseAt = at;
      firstResponseBy = actor?.login ?? null;
      firstResponseAssociation = association;
    }
  };

  const noteAction = (at: string): void => {
    if (!lastActionAt || at > lastActionAt) lastActionAt = at;
  };

  for (const review of reviews) {
    // PENDING reviews have not been submitted and are invisible to the contributor.
    if (!review.submittedAt || review.state === 'PENDING') continue;
    if (!isMaintainerResponse(review.authorAssociation, review.author, authorLogin, options)) {
      continue;
    }

    consider(review.submittedAt, review.author, review.authorAssociation);
    noteAction(review.submittedAt);
    if (review.state === 'CHANGES_REQUESTED') changesRequested = true;
  }

  for (const comment of comments) {
    if (!isMaintainerResponse(comment.authorAssociation, comment.author, authorLogin, options)) {
      continue;
    }
    consider(comment.createdAt, comment.author, comment.authorAssociation);
    // Comments count toward liveness too. Prow-based projects approve via "/lgtm" comments and let
    // a bot do the merge, so a review-only liveness signal marked them all dormant despite a 0%
    // ignore rate.
    noteAction(comment.createdAt);
  }

  /**
   * A merge is the strongest form of maintainer attention there is, whoever pressed the button.
   *
   * An earlier version ignored merges performed by automation, reasoning that a merge queue is not a
   * human paying attention. That was wrong, and it broke every Prow-based project: Kubernetes and
   * friends approve with "/lgtm" comments and let k8s-ci-robot do the merge, so kueue reported 19 of
   * 21 external PRs as "too recent to judge" while 11 of them had already merged.
   *
   * The guard was also redundant. Bot-AUTHORED PRs are excluded upstream via authorIsBot, so anything
   * reaching here is an outside human's work — and a merge queue only lands it because a maintainer
   * approved it somewhere. The merge timestamp is a conservative, later estimate of first attention,
   * which is the safe direction to err. The merger is still recorded so the audit trail shows which
   * merges came from a queue.
   */
  if (node.mergedAt) {
    const mergedByAutomation = isBotActor(
      node.mergedBy?.login,
      node.mergedBy?.__typename,
      ignoreLogins,
    );
    consider(node.mergedAt, node.mergedBy, mergedByAutomation ? 'MERGED_BY_QUEUE' : 'MERGED_BY');
    noteAction(node.mergedAt);
  }

  const state =
    node.state === 'MERGED' ? 'MERGED' : node.state === 'CLOSED' ? 'CLOSED' : 'OPEN';

  return {
    number: node.number,
    authorLogin,
    authorAssociation: node.authorAssociation,
    authorIsBot: isBotActor(authorLogin, node.author?.__typename, ignoreLogins),
    authorIsInsider:
      isInsider(node.authorAssociation) ||
      (authorLogin ? (options.roster?.has(authorLogin.toLowerCase()) ?? false) : false),
    createdAt: node.createdAt,
    mergedAt: node.mergedAt,
    closedAt: node.closedAt,
    state,
    firstResponseAt,
    firstResponseBy,
    firstResponseAssociation,
    changesRequested,
    lastActionAt,
  };
}
