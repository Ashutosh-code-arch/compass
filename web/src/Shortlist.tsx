import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, type Filters, type ShortlistRow } from './api.ts';
import {
  EvidenceChip,
  Ledger,
  Notice,
  ProvenanceBar,
  RowContextLine,
} from './components.tsx';
import { DecideDialog } from './DecideDialog.tsx';

const DEFAULT_FILTERS: Filters = { limit: 20, perRepo: 2 };

/**
 * Clearing a control has to be expressible.
 *
 * `exactOptionalPropertyTypes` makes an absent key and an explicitly-undefined one different types,
 * but a filter input that has been emptied needs to say "remove this", so the patch type admits
 * undefined and the setter deletes the key rather than storing it.
 */
type FilterPatch = { [K in keyof Filters]?: Filters[K] | undefined };

export function Shortlist() {
  const [filters, setFilters] = useState<Filters>(DEFAULT_FILTERS);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [deciding, setDeciding] = useState<ShortlistRow | null>(null);

  const query = useQuery({
    queryKey: ['shortlist', filters],
    queryFn: () => api.shortlist(filters),
  });

  const patch = (update: FilterPatch): void =>
    setFilters((current) => {
      // Assign key by key rather than spreading: spreading the patch would widen every property to
      // include undefined, which is exactly what the Filters type is trying to rule out.
      const next: Filters = { ...current };
      for (const key of Object.keys(update) as (keyof Filters)[]) {
        const value = update[key];
        if (value === undefined) delete next[key];
        else (next as Record<string, unknown>)[key] = value;
      }
      // Any change to what is being ranked returns to page one. Staying on page four of a result
      // set that just shrank to two pages shows an empty screen that looks like "no matches".
      if (!('offset' in update)) delete next.offset;
      return next;
    });

  return (
    <div className="layout">
      <FilterRail filters={filters} patch={patch} onReset={() => setFilters(DEFAULT_FILTERS)} />

      <main className="main">
        <div className="wrap">
          {query.isPending && <p className="state">Ranking…</p>}

          {query.isError && (
            <div className="notice">
              <p className="notice__title">Cannot reach the API</p>
              <p className="notice__body">
                {(query.error as Error).message}. Start it with{' '}
                <code>npm run serve</code> and confirm <code>DATABASE_URL</code> is set.
              </p>
            </div>
          )}

          {query.data && (
            <>
              {query.data.notices.map((notice) => (
                <Notice key={notice.kind} notice={notice} />
              ))}

              {query.data.rows.length > 0 && (
                <>
                  <Summary summary={query.data.summary} />
                  <ol className="rows">
                    {query.data.rows.map((row) => {
                      const key = `${row.issue.repoFullName}#${row.issue.number}`;
                      return (
                        <Row
                          key={key}
                          row={row}
                          open={expanded === key}
                          onToggle={() => setExpanded(expanded === key ? null : key)}
                          onDecide={() => setDeciding(row)}
                        />
                      );
                    })}
                  </ol>
                  <Pager
                    summary={query.data.summary}
                    onPage={(offset) => {
                      patch({ offset });
                      // Guarded: not every environment implements it, and a page change is not
                      // worth an exception.
                      window.scrollTo?.({ top: 0 });
                    }}
                  />
                  <p className="filters__note" style={{ marginTop: 16, border: 0 }}>
                    The score has no units and predicts nothing. It orders candidates by the weights
                    in <code>src/rank/weights.ts</code>, which have never been validated against an
                    outcome — disagree with any line and change it there.
                  </p>
                </>
              )}
            </>
          )}
        </div>
      </main>

      {deciding && (
        <DecideDialog
          repoFullName={deciding.issue.repoFullName}
          number={deciding.issue.number}
          title={deciding.issue.title}
          onClose={() => setDeciding(null)}
        />
      )}
    </div>
  );
}

function Summary({ summary }: { summary: NonNullable<Awaited<ReturnType<typeof api.shortlist>>>['summary'] }) {
  const range = summary.scoreRange;
  return (
    <header className="summary">
      <h1 className="summary__count">
        <em>{summary.scoring.toLocaleString()}</em> of{' '}
        {summary.considered.toLocaleString()} open unassigned issues clear the bar
      </h1>
      <div className="summary__meta">
        <span>
          showing {summary.offset + 1}–{summary.offset + summary.shown} of {summary.total}, from{' '}
          {summary.repos} {summary.repos === 1 ? 'project' : 'projects'}
        </span>
        <span>at most {summary.perRepo} per project</span>
        {range && (
          <span>
            scores {range.min}–{range.max}, median {range.median}
          </span>
        )}
      </div>
    </header>
  );
}

/**
 * Page controls.
 *
 * Deliberately previous/next with a position rather than numbered pages: the ranking is recomputed
 * on every request, so a page number is not a stable address for anything, and offering one implies
 * a permanence the data does not have.
 */
function Pager({
  summary,
  onPage,
}: {
  summary: { offset: number; shown: number; total: number; limit: number };
  onPage: (offset: number) => void;
}) {
  const size = summary.limit;
  const first = summary.offset === 0;
  const last = summary.offset + summary.shown >= summary.total;
  if (first && last) return null;

  return (
    <nav className="pager" aria-label="Shortlist pages">
      <button
        type="button"
        className="btn"
        disabled={first}
        onClick={() => onPage(Math.max(0, summary.offset - size))}
      >
        ← Previous
      </button>
      <span className="pager__where">
        {summary.offset + 1}–{summary.offset + summary.shown} of {summary.total}
      </span>
      <button
        type="button"
        className="btn"
        disabled={last}
        onClick={() => onPage(summary.offset + size)}
      >
        Next →
      </button>
    </nav>
  );
}

function Row({
  row,
  open,
  onToggle,
  onDecide,
}: {
  row: ShortlistRow;
  open: boolean;
  onToggle: () => void;
  onDecide: () => void;
}) {
  return (
    <li className="row">
      <button type="button" className="row__head" onClick={onToggle} aria-expanded={open}>
        <span className="row__rank">{String(row.rank).padStart(2, '0')}</span>

        <span>
          <span className="row__repo">
            {row.issue.repoFullName}#{row.issue.number}
          </span>
          <p className="row__title">{row.issue.title}</p>

          <ProvenanceBar subtotals={row.subtotals} score={row.score} />

          <span className="row__evidence">
            {row.evidence.length > 0 ? (
              row.evidence.map((line) => (
                <EvidenceChip key={`${line.signal}-${line.detail}`} line={line} />
              ))
            ) : (
              <span className="chip chip__detail">
                nothing notable about the issue itself — ranked on the project
              </span>
            )}
          </span>

          <RowContextLine context={row.context} />

          {row.heldBackInRepo > 0 && (
            <p className="row__held">
              +{row.heldBackInRepo} more scoring {row.heldBackInRepo === 1 ? 'issue' : 'issues'} in
              this project, held back by the per-project cap
            </p>
          )}
        </span>

        <span className="row__score">
          <span className="row__total">{row.score}</span>
          <br />
          <span className="row__unit">NO UNITS</span>
        </span>
      </button>

      {open && <WhyPanel repoFullName={row.issue.repoFullName} number={row.issue.number} />}

      <div className="row__actions">
        <button type="button" className="btn btn--primary" onClick={onDecide}>
          Record a decision
        </button>
        <a className="btn" href={row.issue.htmlUrl} target="_blank" rel="noreferrer">
          Open on GitHub ↗
        </a>
        <button type="button" className="btn" onClick={onToggle}>
          {open ? 'Hide the full breakdown' : 'Show the full breakdown'}
        </button>
      </div>
    </li>
  );
}

/**
 * The full itemised score. Fetched on expand rather than with the list: `why` re-queries the whole
 * candidate set to rebuild the repository context, so twenty of them eagerly would be twenty full
 * scans.
 */
function WhyPanel({ repoFullName, number }: { repoFullName: string; number: number }) {
  const query = useQuery({
    queryKey: ['why', repoFullName, number],
    queryFn: () => api.why(repoFullName, number),
  });

  if (query.isPending) return <div className="row__body"><p className="state">Loading the breakdown…</p></div>;
  if (query.isError) {
    return (
      <div className="row__body">
        <p className="state">{(query.error as Error).message}</p>
      </div>
    );
  }

  const why = query.data;
  return (
    <div className="row__body">
      <Ledger
        caption="the project"
        lines={why.repoLines}
        subtotal={why.repoSubtotal}
        empty="Nothing measured about this project."
      />
      <Ledger
        caption="this issue"
        lines={why.issueLines}
        subtotal={why.issueSubtotal}
        empty="Nothing notable about this issue on its own."
      />
      <table className="ledger">
        <tbody>
          <tr className="ledger__total">
            <td className="ledger__pts">{why.score}</td>
            <td colSpan={2}>total</td>
          </tr>
        </tbody>
      </table>

      {why.unmeasured.length > 0 && (
        <p className="unmeasured-note">
          Not measured, and contributing nothing either way: {why.unmeasured.join(', ')}. These are
          absent, not zero — an unmeasured project is not a bad one.
        </p>
      )}

      {why.issue.labels.length > 0 && (
        <p className="filters__note" style={{ border: 0 }}>
          Labels: {why.issue.labels.join(', ')}
        </p>
      )}
    </div>
  );
}

/**
 * Languages come from the corpus, with GitHub's casing.
 *
 * This was a text box, and typing "typescript" returned nothing at all — the match was exact, so a
 * wrong capital produced an empty shortlist that looked like a real answer. The server now matches
 * case-insensitively as well, but the picker is the actual fix: you cannot mistype a list.
 */
function LanguagePicker({
  value,
  onChange,
}: {
  value: string | undefined;
  onChange: (language: string | undefined) => void;
}) {
  const query = useQuery({
    queryKey: ['languages'],
    queryFn: () => api.languages(),
    staleTime: 5 * 60_000,
  });

  return (
    <label className="field">
      <span className="field__label">Language</span>
      <select
        value={value ?? ''}
        disabled={query.isPending}
        onChange={(event) => onChange(event.target.value || undefined)}
      >
        <option value="">{query.isPending ? 'loading…' : 'any language'}</option>
        {/* A language the corpus no longer has must still show, or the control would silently
            disagree with the filter that is actually applied. */}
        {value && !query.data?.languages.some((entry) => entry.language === value) && (
          <option value={value}>{value} (not in the corpus)</option>
        )}
        {query.data?.languages.map((entry) => (
          <option key={entry.language} value={entry.language}>
            {entry.language} ({entry.repos})
          </option>
        ))}
      </select>
    </label>
  );
}

function FilterRail({
  filters,
  patch,
  onReset,
}: {
  filters: Filters;
  patch: (update: FilterPatch) => void;
  onReset: () => void;
}) {
  const numeric = (value: string): number | undefined => {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
  };

  return (
    <aside className="filters">
      <div className="filters__group">
        <p className="filters__legend">What counts</p>

        <LanguagePicker
          value={filters.language}
          onChange={(language) => patch({ language })}
        />

        <label className="field">
          <span className="field__label">Most setup you will tolerate</span>
          <select
            value={filters.maxSetupWeight ?? ''}
            onChange={(event) => patch({ maxSetupWeight: event.target.value || undefined })}
          >
            <option value="">any</option>
            <option value="light">light only</option>
            <option value="moderate">light or moderate</option>
          </select>
        </label>

        <div className="pair">
          <label className="field">
            <span className="field__label">Min stars</span>
            <input
              type="number"
              value={filters.minStars ?? ''}
              placeholder="any"
              onChange={(event) => patch({ minStars: numeric(event.target.value) })}
            />
          </label>
          <label className="field">
            <span className="field__label">Max stars</span>
            <input
              type="number"
              value={filters.maxStars ?? ''}
              placeholder="any"
              onChange={(event) => patch({ maxStars: numeric(event.target.value) })}
            />
          </label>
        </div>

        <label className="check">
          <input
            type="checkbox"
            checked={filters.labelledOnly ?? false}
            onChange={(event) => patch({ labelledOnly: event.target.checked })}
          />
          Only issues inviting contributors
        </label>

        <label className="check">
          <input
            type="checkbox"
            checked={filters.includeDormant ?? false}
            onChange={(event) => patch({ includeDormant: event.target.checked })}
          />
          Include dormant projects
        </label>
      </div>

      <div className="filters__group">
        <p className="filters__legend">How much to show</p>

        <div className="pair">
          <label className="field">
            <span className="field__label">Rows</span>
            <input
              type="number"
              value={filters.limit ?? ''}
              onChange={(event) => patch({ limit: numeric(event.target.value) })}
            />
          </label>
          <label className="field">
            <span className="field__label">Per project</span>
            <input
              type="number"
              value={filters.perRepo ?? ''}
              onChange={(event) => patch({ perRepo: numeric(event.target.value) })}
            />
          </label>
        </div>

        <label className="field">
          <span className="field__label">Minimum score</span>
          <input
            type="number"
            value={filters.minScore ?? ''}
            placeholder="20"
            onChange={(event) => {
              const parsed = Number.parseInt(event.target.value, 10);
              patch({ minScore: Number.isFinite(parsed) ? parsed : undefined });
            }}
          />
        </label>
      </div>

      <button type="button" className="btn" onClick={onReset} style={{ marginBottom: 16 }}>
        Reset filters
      </button>

      <p className="filters__note">
        Assigned, locked, and already-judged issues are excluded outright rather than ranked low —
        they are someone else’s work, not a weak option. Dormant projects are excluded for the same
        reason: no label or easy setup makes up for nobody reading your pull request.
      </p>
    </aside>
  );
}
