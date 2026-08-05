import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, type GsocOutlook, type OrgFilters, type OrgRow, type SetupDistribution } from './api.ts';
import { ResponsivenessMeter, formatHours } from './components.tsx';

const DEFAULT_FILTERS: OrgFilters = { limit: 50, sort: 'attention' };

/**
 * Clearing a control has to be expressible.
 *
 * `exactOptionalPropertyTypes` makes an absent key and an explicitly-undefined one different types,
 * but an emptied input needs to say "remove this" — so the patch type admits undefined and the setter
 * deletes the key rather than storing it. Same shape as the shortlist's `FilterPatch`, for the same
 * reason.
 */
type OrgFilterPatch = { [K in keyof OrgFilters]?: OrgFilters[K] | undefined };

/**
 * The organisation table.
 *
 * The screen that answers the question asked first and that nothing in this tool could answer before:
 * *which organisations are worth my time?* Aggregators list issues carrying a label and the official
 * GSoC page lists descriptions and technology tags. Neither can say whether anyone will read your pull
 * request, and the three middle columns here do nothing else.
 *
 * Rows are not scored. The ordering is a documented ordinal cascade — verdict, then merge rate, then
 * available work — so any position can be explained by pointing at a column rather than at a weight.
 */
export function Organisations({ onDrillIn }: { onDrillIn: (login: string) => void }) {
  const [filters, setFilters] = useState<OrgFilters>(DEFAULT_FILTERS);

  const query = useQuery({
    queryKey: ['orgs', filters],
    queryFn: () => api.orgs(filters),
  });

  const patch = (update: OrgFilterPatch): void =>
    setFilters((current) => {
      const next: OrgFilters = { ...current };
      for (const key of Object.keys(update) as (keyof OrgFilters)[]) {
        const value = update[key];
        if (value === undefined) delete next[key];
        else (next as Record<string, unknown>)[key] = value;
      }
      return next;
    });

  return (
    <div className="layout">
      <aside className="filters">
        <div className="filters__group">
          <p className="filters__legend">Which organisations</p>

          <label className="field">
            <span className="field__label">Order by</span>
            <select
              value={filters.sort ?? 'attention'}
              onChange={(event) => patch({ sort: event.target.value as OrgFilters['sort'] })}
            >
              <option value="attention">Do they reply?</option>
              <option value="candidates">Open work available</option>
              <option value="name">Name</option>
            </select>
          </label>

          <label className="field">
            <span className="field__label">GSoC</span>
            <select
              value={filters.gsoc === undefined ? '' : String(filters.gsoc)}
              onChange={(event) =>
                patch({
                  gsoc:
                    event.target.value === ''
                      ? undefined
                      : event.target.value === 'any'
                        ? 'any'
                        : Number(event.target.value),
                })
              }
            >
              <option value="">any organisation</option>
              <option value="any">in GSoC, any year</option>
              <option value="2026">GSoC 2026</option>
              <option value="2025">GSoC 2025</option>
            </select>
          </label>

          <label className="check">
            <input
              type="checkbox"
              checked={filters.uncoveredOnly === true}
              onChange={(event) => patch({ uncoveredOnly: event.target.checked || undefined })}
            />
            Only ones never measured
          </label>

          <label className="field">
            <span className="field__label">Minimum repositories</span>
            <input
              type="number"
              placeholder="any"
              value={filters.minRepos ?? ''}
              onChange={(event) => {
                const parsed = Number.parseInt(event.target.value, 10);
                patch({ minRepos: Number.isFinite(parsed) && parsed > 0 ? parsed : undefined });
              }}
            />
          </label>
        </div>

        <button
          type="button"
          className="btn"
          onClick={() => setFilters(DEFAULT_FILTERS)}
          style={{ marginBottom: 16 }}
        >
          Reset filters
        </button>

        <p className="filters__note">
          A GSoC year is a filter, not a season. The contributions that get a student accepted land
          before the list is announced, so this stays available all year rather than appearing in
          February.
        </p>
      </aside>

      <main className="main">
        <div className="wrap">
          {query.isPending && <p className="state">Rolling up…</p>}

          {query.isError && (
            <div className="notice">
              <p>{(query.error as Error).message}</p>
            </div>
          )}

          {query.data && (
            <>
              <GsocLine outlook={query.data.gsoc} />

              <p className="filters__note" style={{ border: 0 }}>
                {query.data.summary.shown} of {query.data.summary.organizations} organisations,{' '}
                {query.data.summary.openCandidates.toLocaleString()} open candidates between them.
              </p>

              {query.data.notices.map((notice) => (
                <div key={notice} className="notice">
                  <p className="notice__body">{notice}</p>
                </div>
              ))}

              {query.data.rows.length === 0 && (
                <p className="state">No organisations matched those filters.</p>
              )}

              {query.data.rows.map((row) => (
                <OrgCard key={row.login} row={row} onDrillIn={onDrillIn} />
              ))}

              <p className="unmeasured-note">
                Verdicts are the most common across an organisation’s <strong>measured</strong>{' '}
                repositories, with the count shown. Merge rate is pooled rather than averaged, so a
                busy repository outweighs a quiet one. Setup is a distribution: these are ordinals and
                averaging them would invent a number.
              </p>
            </>
          )}
        </div>
      </main>
    </div>
  );
}

/**
 * The calendar line, shown always.
 *
 * Deliberately a line and not a tab. A dark "GSoC — coming soon" tab would be dead UI for eight
 * months of the year and would teach precisely the wrong lesson, because the useful window is the one
 * before the organisations are announced.
 */
function GsocLine({ outlook }: { outlook: GsocOutlook }) {
  return (
    <div className="notice">
      <p className="notice__title">GSoC {outlook.year}</p>
      <p className="notice__body">
        {outlook.message}
        {outlook.estimated && (
          <em> Dates estimated from 2026; {outlook.year}’s are not published.</em>
        )}
      </p>
    </div>
  );
}

function setupSummary(distribution: SetupDistribution): string {
  const parts: string[] = [];
  if (distribution.light > 0) parts.push(`${distribution.light} light`);
  if (distribution.moderate > 0) parts.push(`${distribution.moderate} moderate`);
  if (distribution.heavy > 0) parts.push(`${distribution.heavy} heavy`);
  if (distribution.unknown > 0) parts.push(`${distribution.unknown} unknown`);
  return parts.join(' · ');
}

function OrgCard({ row, onDrillIn }: { row: OrgRow; onDrillIn: (login: string) => void }) {
  const uncovered = row.repos === 0;

  return (
    <article className="row">
      <div className="row__actions">
        <span className="row__repo">{row.login}</span>
        {row.gsocYears.length > 0 && (
          <span
            className="chip"
            title={`Curated, not measured. Last reviewed ${row.tagsReviewedAt ?? 'unknown'}`}
          >
            GSoC {row.gsocYears.join(', ')}
          </span>
        )}
      </div>

      {uncovered ? (
        <p className="row__context">
          Not in your corpus — nothing about it is measured. It came from a curated list, so the only
          claim here is that a human put it on one.
        </p>
      ) : (
        <div className="row__context">
          <ResponsivenessMeter value={row.responsiveness} />
          {row.measuredRepos > 1 && row.responsiveness !== null && (
            <span>
              {row.agreeing} of {row.measuredRepos} measured
            </span>
          )}
          <span>
            median reply{' '}
            {row.medianRepoHoursResponse === null ? (
              <span className="dash" title="not measured">
                —
              </span>
            ) : (
              formatHours(row.medianRepoHoursResponse)
            )}
          </span>
          <span>
            merge rate{' '}
            {row.mergeRate === null ? (
              <span className="dash" title="no decided pull requests">
                —
              </span>
            ) : (
              /* The denominator is not optional. 100% of two is not 74% of three hundred. */
              `${Math.round(row.mergeRate * 100)}% of ${row.decidedPrs}`
            )}
          </span>
          <span>
            {row.repos} repo{row.repos === 1 ? '' : 's'}
          </span>
          {row.primaryLanguage && <span>{row.primaryLanguage}</span>}
        </div>
      )}

      {!uncovered && (
        <p className="row__context">
          <span>setup {setupSummary(row.setup) || '—'}</span>
          {row.claRepos > 0 && (
            <span className="chip chip--debit" title="Resolve before you write the code">
              CLA in {row.claRepos} of {row.repos}
            </span>
          )}
        </p>
      )}

      <div className="row__actions">
        {row.openCandidates > 0 ? (
          <button type="button" className="btn btn--primary" onClick={() => onDrillIn(row.login)}>
            {row.openCandidates} open candidate{row.openCandidates === 1 ? '' : 's'} →
          </button>
        ) : (
          <span className="row__held">
            {uncovered ? 'Add a repository to measure it' : 'No open candidates right now'}
          </span>
        )}
      </div>
    </article>
  );
}
