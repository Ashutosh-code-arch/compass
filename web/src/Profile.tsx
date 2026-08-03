import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type Profile as ProfileShape, type SetupWeight } from './api.ts';

/**
 * The settings screen is laid out as a ledger on purpose: these preferences become lines in the
 * score breakdown, at exactly the point values shown here. Editing a number here and seeing the same
 * number appear under "the project" in a row's breakdown is the whole mental model.
 */
export function Profile() {
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: ['profile'], queryFn: () => api.profile() });
  const [draft, setDraft] = useState<ProfileShape | null>(null);

  useEffect(() => {
    if (query.data && draft === null) setDraft(query.data.profile);
  }, [query.data, draft]);

  const save = useMutation({
    mutationFn: () => api.saveProfile(draft!),
    onSuccess: async (result) => {
      setDraft(result.profile);
      // The ranking changes the moment this lands, so nothing already fetched is still true.
      await queryClient.invalidateQueries({ queryKey: ['profile'] });
      await queryClient.invalidateQueries({ queryKey: ['shortlist'] });
      await queryClient.invalidateQueries({ queryKey: ['why'] });
    },
  });

  if (query.isPending || draft === null) {
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

  const { defaults, maxPoints } = query.data;
  const usingDefaults = Object.keys(draft.languagePoints).length === 0;
  const patch = (update: Partial<ProfileShape>): void =>
    setDraft((current) => ({ ...current!, ...update }));

  return (
    <div className="layout layout--single">
      <main className="main">
        <div className="wrap">
          <header className="summary">
            <h1 className="summary__count">What you want to work on</h1>
            <div className="summary__meta">
              <span>
                These become lines in every score breakdown, at the points shown. Keep them within ±
                {maxPoints} so they rank candidates rather than override what was measured.
              </span>
            </div>
          </header>

          <section className="panel">
            <h2 className="panel__title">Languages</h2>
            {usingDefaults ? (
              <p className="panel__note">
                Using the built-in defaults:{' '}
                {Object.entries(defaults.languagePoints)
                  .map(([name, points]) => `${name} ${points}`)
                  .join(', ')}
                . Adding one of your own replaces the whole set — deleting a language should mean it
                stops scoring, not that it quietly returns to its default.
              </p>
            ) : (
              <p className="panel__note">
                Your list replaces the defaults entirely. A language you have not listed scores
                nothing — an unfamiliar language is a cost, not a disqualification.
              </p>
            )}
            <PointsLedger
              entries={draft.languagePoints}
              maxPoints={maxPoints}
              placeholder="e.g. TypeScript"
              onChange={(languagePoints) => patch({ languagePoints })}
            />
            {usingDefaults && (
              <button
                type="button"
                className="btn"
                onClick={() => patch({ languagePoints: { ...defaults.languagePoints } })}
              >
                Start from the defaults
              </button>
            )}
          </section>

          <section className="panel">
            <h2 className="panel__title">Subjects</h2>
            <p className="panel__note">
              Matched against a project’s GitHub topics. Several matches pay once, at the best rate —
              a repo tagged react, frontend and typescript should not collect three payments for one
              fact about itself.
            </p>
            <PointsLedger
              entries={draft.topicPoints}
              maxPoints={maxPoints}
              placeholder="e.g. developer-tools"
              onChange={(topicPoints) => patch({ topicPoints })}
            />
          </section>

          <section className="panel">
            <h2 className="panel__title">Steer away from</h2>
            <p className="panel__note">
              These subtract points; they do not exclude. Use the shortlist filters to exclude. Your
              terms are added to the built-in list of structural warnings (needs-design, blocked),
              which stays in force regardless.
            </p>
            <TermList
              label="Project topics"
              terms={draft.avoidTopics}
              placeholder="e.g. blockchain"
              onChange={(avoidTopics) => patch({ avoidTopics })}
            />
            <TermList
              label="Issue labels"
              terms={draft.avoidLabels}
              placeholder="e.g. legacy"
              onChange={(avoidLabels) => patch({ avoidLabels })}
            />
          </section>

          <section className="panel">
            <h2 className="panel__title">Default filters</h2>
            <p className="panel__note">
              Applied to every shortlist unless you change the controls for a single look. Below
              roughly 500 stars, abandonment risk starts to dominate; above roughly 50,000 the
              labelled beginner issues are usually claimed within hours.
            </p>
            <div className="pair">
              <label className="field">
                <span className="field__label">Fewest stars</span>
                <input
                  type="number"
                  min="0"
                  value={draft.minStars ?? ''}
                  placeholder="no floor"
                  onChange={(event) => patch({ minStars: intOrNull(event.target.value) })}
                />
              </label>
              <label className="field">
                <span className="field__label">Most stars</span>
                <input
                  type="number"
                  min="0"
                  value={draft.maxStars ?? ''}
                  placeholder="no ceiling"
                  onChange={(event) => patch({ maxStars: intOrNull(event.target.value) })}
                />
              </label>
            </div>
            <label className="field" style={{ maxWidth: 260 }}>
              <span className="field__label">Most setup you will tolerate</span>
              <select
                value={draft.maxSetupWeight ?? ''}
                onChange={(event) =>
                  patch({ maxSetupWeight: (event.target.value || null) as SetupWeight | null })
                }
              >
                <option value="">any</option>
                <option value="light">light only</option>
                <option value="moderate">light or moderate</option>
                <option value="heavy">any, including heavy</option>
              </select>
            </label>
          </section>

          {save.isError && <p className="dialog__error">{(save.error as Error).message}</p>}

          <div className="panel__actions">
            <button
              type="button"
              className="btn btn--primary"
              disabled={save.isPending}
              onClick={() => save.mutate()}
            >
              {save.isPending ? 'Saving…' : 'Save and re-rank'}
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => setDraft(query.data.profile)}
              disabled={save.isPending}
            >
              Discard changes
            </button>
            {save.isSuccess && !save.isPending && (
              <span className="panel__saved">Saved. The shortlist has been re-ranked.</span>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}

function intOrNull(value: string): number | null {
  if (value.trim() === '') return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

/**
 * A name/points table. Deliberately the same shape as the score ledger: right-aligned monospaced
 * points, then the name.
 */
function PointsLedger({
  entries,
  maxPoints,
  placeholder,
  onChange,
}: {
  entries: Record<string, number>;
  maxPoints: number;
  placeholder: string;
  onChange: (entries: Record<string, number>) => void;
}) {
  const [name, setName] = useState('');
  const [points, setPoints] = useState('');

  const add = (): void => {
    const trimmed = name.trim();
    const value = Number.parseInt(points, 10);
    if (trimmed === '' || !Number.isFinite(value)) return;
    onChange({ ...entries, [trimmed]: Math.max(-maxPoints, Math.min(maxPoints, value)) });
    setName('');
    setPoints('');
  };

  const rows = Object.entries(entries).sort((a, b) => b[1] - a[1]);

  return (
    <>
      <table className="ledger">
        <tbody>
          {rows.length === 0 && (
            <tr>
              <td colSpan={3} className="ledger__detail">
                Nothing listed.
              </td>
            </tr>
          )}
          {rows.map(([key, value]) => (
            <tr key={key}>
              <td className={`ledger__pts ledger__pts--${value < 0 ? 'debit' : 'credit'}`}>
                {value > 0 ? '+' : ''}
                {value}
              </td>
              <td className="ledger__signal">{key}</td>
              <td className="ledger__detail">
                <input
                  type="range"
                  min={-maxPoints}
                  max={maxPoints}
                  value={value}
                  aria-label={`Points for ${key}`}
                  onChange={(event) =>
                    onChange({ ...entries, [key]: Number.parseInt(event.target.value, 10) })
                  }
                />
                <button
                  type="button"
                  className="linkish"
                  aria-label={`Remove ${key}`}
                  onClick={() => {
                    const next = { ...entries };
                    delete next[key];
                    onChange(next);
                  }}
                >
                  remove
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="adder">
        <input
          type="text"
          value={name}
          placeholder={placeholder}
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => event.key === 'Enter' && add()}
        />
        <input
          type="number"
          value={points}
          placeholder="points"
          min={-maxPoints}
          max={maxPoints}
          onChange={(event) => setPoints(event.target.value)}
          onKeyDown={(event) => event.key === 'Enter' && add()}
        />
        <button type="button" className="btn" onClick={add}>
          Add
        </button>
      </div>
    </>
  );
}

function TermList({
  label,
  terms,
  placeholder,
  onChange,
}: {
  label: string;
  terms: string[];
  placeholder: string;
  onChange: (terms: string[]) => void;
}) {
  const [value, setValue] = useState('');
  const add = (): void => {
    const term = value.trim();
    if (term === '' || terms.includes(term)) {
      setValue('');
      return;
    }
    onChange([...terms, term]);
    setValue('');
  };

  return (
    <div className="terms">
      <span className="field__label">{label}</span>
      <div className="terms__list">
        {terms.length === 0 && <span className="ledger__detail">Nothing listed.</span>}
        {terms.map((term) => (
          <span key={term} className="tag">
            {term}
            <button
              type="button"
              aria-label={`Remove ${term}`}
              onClick={() => onChange(terms.filter((other) => other !== term))}
            >
              ×
            </button>
          </span>
        ))}
      </div>
      <div className="adder">
        <input
          type="text"
          value={value}
          placeholder={placeholder}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => event.key === 'Enter' && add()}
        />
        <button type="button" className="btn" onClick={add}>
          Add
        </button>
      </div>
    </div>
  );
}
