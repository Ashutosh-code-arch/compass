import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type RunKind, type RunRecord, type SyncStatus } from './api.ts';

/**
 * What each scan does and what it costs, in the reader's terms.
 *
 * The order is the pipeline order, and it matters: issues need repos, metrics need repos, and the
 * ranking needs all three. Running them out of order is not an error, it just does less than you
 * expect, which is worse.
 */
const SCANS: {
  kind: RunKind;
  title: string;
  what: string;
  cost: string;
  staleField?: 'staleHours' | 'staleDays';
  staleLabel?: string;
}[] = [
  {
    kind: 'seed',
    title: 'Find new projects',
    what: 'Runs the discovery searches to add repositories that are not in the corpus yet.',
    cost: 'The limit here caps pages per search, not repositories.',
  },
  {
    kind: 'repos',
    title: 'Refresh project metadata',
    what: 'Stars, primary language, topics, default branch. Cheap: unchanged repos answer 304 and cost no quota.',
    cost: 'One request per repository, minus the ones that have not changed.',
    staleField: 'staleHours',
    staleLabel: 'Skip repos refreshed within (hours)',
  },
  {
    kind: 'issues',
    title: 'Pull issues',
    what: 'Open issues for each project, incrementally after the first full pull.',
    cost: 'The heaviest scan. 100 issues per request.',
  },
  {
    kind: 'metrics',
    title: 'Measure maintainer attention',
    what: 'Whether outside pull requests get reviewed, how fast, and how often they merge. This is what responsiveness is built from.',
    cost: 'GraphQL. Roughly one request per few repositories.',
    staleField: 'staleDays',
    staleLabel: 'Skip repos measured within (days)',
  },
  {
    kind: 'setup',
    title: 'Read setup cost',
    what: 'Compose files, env templates, task runners, CI. Produces the light / moderate / heavy reading.',
    cost: 'GraphQL, returns file contents, so batches are kept small.',
    staleField: 'staleDays',
    staleLabel: 'Skip repos read within (days)',
  },
];

export function Sync() {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ['sync'],
    queryFn: () => api.syncStatus(),
    // Poll while something is running so the counters advance; otherwise leave the server alone.
    refetchInterval: (q) => (q.state.data?.active ? 2000 : false),
  });

  const start = useMutation({
    mutationFn: ({ kind, options }: { kind: RunKind; options: Record<string, number | string> }) =>
      api.startSync(kind, options),
    onSuccess: async (response) => {
      // Show it as running straight away, from the 202's own body.
      //
      // Waiting for the next poll left a gap of up to two seconds in which the click had visibly
      // done nothing — long enough to press the button again and collect a 409. The server is the
      // authority; this only fills the interval before it is asked again.
      queryClient.setQueryData(['sync'], (current: SyncStatus | undefined) =>
        current ? { ...current, active: response.started } : current,
      );
      await queryClient.invalidateQueries({ queryKey: ['sync'] });
    },
  });

  if (query.isPending) {
    return (
      <div className="layout layout--single">
        <main className="main">
          <p className="state">Loading…</p>
        </main>
      </div>
    );
  }

  if (query.isError) {
    return (
      <div className="layout layout--single">
        <main className="main">
          <div className="wrap">
            <div className="notice">
              <p className="notice__title">Cannot reach the API</p>
              <p className="notice__body">{(query.error as Error).message}</p>
            </div>
          </div>
        </main>
      </div>
    );
  }

  const status = query.data;

  return (
    <div className="layout layout--single">
      <main className="main">
        <div className="wrap">
          <header className="summary">
            <h1 className="summary__count">The corpus</h1>
            <div className="summary__meta">
              <span>Scanning talks to GitHub and spends a shared hourly budget.</span>
            </div>
          </header>

          <Corpus corpus={status.corpus} />

          {!status.tokenConfigured && (
            <div className="notice">
              <p className="notice__title">No GitHub token on this server</p>
              <p className="notice__body">
                Scanning needs one. Add <code>GITHUB_TOKEN</code> to <code>.env</code> and restart
                the server. Read-only access to public repositories is enough.
              </p>
            </div>
          )}

          {status.active && (
            <div className="running">
              <p className="running__title">
                <span className="running__pulse" aria-hidden="true" />
                {labelFor(status.active.kind)} is running
              </p>
              <p className="notice__body">
                Started {timeOf(status.active.startedAt)}. It keeps going if you close this tab, and
                it cannot be stopped from here — a stop button that cannot interrupt a request in
                flight would be a lie. It stops itself if the GitHub budget runs low, and resumes
                where it left off next time.
              </p>
            </div>
          )}

          {status.runningElsewhere.length > 0 && !status.active && (
            <div className="notice">
              <p className="notice__title">
                {status.runningElsewhere.length} run
                {status.runningElsewhere.length === 1 ? '' : 's'} still marked as running
              </p>
              <p className="notice__body">
                Either a scan is going in a terminal, or a previous one was killed before it could
                record how it ended. This server cannot tell which.{' '}
                {status.runningElsewhere
                  .map((run) => `${run.kind} #${run.runId} (${timeOf(run.startedAt)})`)
                  .join(', ')}
                .
              </p>
            </div>
          )}

          {start.isError && <p className="dialog__error">{(start.error as Error).message}</p>}

          {SCANS.map((scan) => (
            <ScanCard
              key={scan.kind}
              scan={scan}
              disabled={!status.tokenConfigured || status.active !== null || start.isPending}
              busy={status.active?.kind === scan.kind}
              onStart={(options) => start.mutate({ kind: scan.kind, options })}
            />
          ))}

          <h2 className="panel__title" style={{ marginTop: 22 }}>
            Recent scans
          </h2>
          {status.runs.length === 0 ? (
            <p className="panel__note">Nothing has run yet.</p>
          ) : (
            <table className="runs">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Scan</th>
                  <th>Outcome</th>
                  <th className="runs__num">Repos</th>
                  <th className="runs__num">Issues</th>
                  <th className="runs__num">Requests</th>
                </tr>
              </thead>
              <tbody>
                {status.runs.map((run) => (
                  <RunRow key={run.runId} run={run} />
                ))}
              </tbody>
            </table>
          )}
        </div>
      </main>
    </div>
  );
}

function labelFor(kind: string): string {
  return SCANS.find((scan) => scan.kind === kind)?.title ?? kind;
}

function timeOf(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

/** Coverage is reported as a fraction, never a percentage: 3 of 4 repos is not "75% measured". */
function Corpus({ corpus }: { corpus: SyncStatus['corpus'] }) {
  const active = corpus.repos - corpus.pausedRepos;
  const facts: [string, string][] = [
    ['Projects', `${corpus.repos.toLocaleString()}${corpus.pausedRepos > 0 ? ` (${corpus.pausedRepos.toLocaleString()} paused)` : ''}`],
    ['Issues', `${corpus.issues.toLocaleString()} (${corpus.openIssues.toLocaleString()} open)`],
    ['With attention measured', `${corpus.reposWithMetrics.toLocaleString()} of ${corpus.repos.toLocaleString()}`],
    ['With setup read', `${corpus.reposWithSetup.toLocaleString()} of ${corpus.repos.toLocaleString()}`],
    ['Metadata over a day old', `${corpus.staleMetadata.toLocaleString()} of ${active.toLocaleString()} active`],
    ['Decisions recorded', corpus.decisions.toLocaleString()],
  ];
  return (
    <div className="corpus">
      {facts.map(([label, value]) => (
        <div key={label} className="corpus__fact">
          <span className="corpus__value">{value}</span>
          <span className="corpus__label">{label}</span>
        </div>
      ))}
    </div>
  );
}

function ScanCard({
  scan,
  disabled,
  busy,
  onStart,
}: {
  scan: (typeof SCANS)[number];
  disabled: boolean;
  busy: boolean;
  onStart: (options: Record<string, number | string>) => void;
}) {
  const [limit, setLimit] = useState('');
  const [stale, setStale] = useState('');
  const [repo, setRepo] = useState('');

  const build = (): Record<string, number | string> => {
    const options: Record<string, number | string> = {};
    const asInt = (value: string): number | null => {
      const parsed = Number.parseInt(value, 10);
      return Number.isInteger(parsed) ? parsed : null;
    };
    const l = asInt(limit);
    if (l !== null && l > 0) options['limit'] = l;
    const s = asInt(stale);
    if (s !== null && s >= 0 && scan.staleField) options[scan.staleField] = s;
    if (repo.trim() !== '') options['repo'] = repo.trim();
    return options;
  };

  return (
    <section className={`panel scan${busy ? ' scan--busy' : ''}`}>
      <h2 className="panel__title">{scan.title}</h2>
      <p className="panel__note">
        {scan.what} {scan.cost}
      </p>
      <div className="scan__controls">
        <label className="field">
          <span className="field__label">
            {scan.kind === 'seed' ? 'Pages per search' : 'How many projects'}
          </span>
          <input
            type="number"
            min="1"
            value={limit}
            placeholder="all"
            onChange={(event) => setLimit(event.target.value)}
          />
        </label>
        {scan.staleField && (
          <label className="field">
            <span className="field__label">{scan.staleLabel}</span>
            <input
              type="number"
              min="0"
              value={stale}
              placeholder="default"
              onChange={(event) => setStale(event.target.value)}
            />
          </label>
        )}
        {scan.kind !== 'seed' && (
          <label className="field">
            <span className="field__label">One project only</span>
            <input
              type="text"
              value={repo}
              placeholder="owner/name"
              onChange={(event) => setRepo(event.target.value)}
            />
          </label>
        )}
        <button
          type="button"
          className="btn btn--primary"
          disabled={disabled}
          onClick={() => onStart(build())}
        >
          {busy ? 'Running…' : 'Start'}
        </button>
      </div>
    </section>
  );
}

const OUTCOME: Record<string, string> = {
  ok: 'finished',
  running: 'running',
  failed: 'failed',
  // Not a failure: watermarks only advance for repos that completed, so the next run resumes.
  aborted_budget: 'stopped, budget low',
};

function RunRow({ run }: { run: RunRecord }) {
  return (
    <tr>
      <td className="runs__when">{timeOf(run.startedAt)}</td>
      <td>{labelFor(run.kind)}</td>
      <td>
        <span className={`outcome outcome--${run.status}`}>{OUTCOME[run.status] ?? run.status}</span>
        {run.error && <span className="runs__error">{run.error.slice(0, 90)}</span>}
      </td>
      <td className="runs__num">{run.reposUpserted.toLocaleString()}</td>
      <td className="runs__num">{run.issuesUpserted.toLocaleString()}</td>
      <td className="runs__num">
        {run.requests.toLocaleString()}
        {run.notModified > 0 && (
          <span className="runs__free" title="Answered 304 Not Modified, costing no quota">
            {' '}
            −{run.notModified.toLocaleString()} free
          </span>
        )}
      </td>
    </tr>
  );
}
