import type { ScoreLine, ShortlistNotice, RowContext } from './api.ts';

/**
 * Nothing this tool measures is continuous, so nothing here is drawn as continuous.
 *
 * Responsiveness and setup weight are ordinal buckets, and a bucket drawn as a percentage or a
 * smooth bar claims a precision the underlying verdict does not have. Discrete cells, plus the word
 * itself, is the honest rendering.
 */
function StepMeter({
  filled,
  total,
  label,
  tone = 'neutral',
  title,
}: {
  filled: number | null;
  total: number;
  label: string;
  tone?: 'neutral' | 'cost';
  title?: string;
}) {
  const unmeasured = filled === null;
  return (
    <span
      className={`meter${unmeasured ? ' meter--unmeasured' : ''}`}
      title={title ?? label}
    >
      <span className="meter__cells" aria-hidden="true">
        {Array.from({ length: total }, (_unused, index) => {
          const on = !unmeasured && index < filled;
          return (
            <i
              key={index}
              className={`meter__cell${on ? ` meter__cell--${tone === 'cost' ? 'warn' : 'on'}` : ''}`}
            />
          );
        })}
      </span>
      <span className="meter__label">{label}</span>
    </span>
  );
}

const RESPONSIVENESS_STEPS: Record<string, number> = {
  dormant: 1,
  slow: 2,
  moderate: 3,
  responsive: 4,
};

const SETUP_STEPS: Record<string, number> = { light: 1, moderate: 2, heavy: 3 };

/** More cells lit means more maintainer attention: higher is better, so the neutral ink tone. */
export function ResponsivenessMeter({ value }: { value: string | null }) {
  const step = value ? RESPONSIVENESS_STEPS[value] : undefined;
  return (
    <StepMeter
      filled={step ?? null}
      total={4}
      label={step ? value! : 'responsiveness not measured'}
      title="How maintainers treat outside pull requests"
    />
  );
}

/** More cells lit means more work before you can run it: higher is costlier, so the ochre tone. */
export function SetupMeter({ value }: { value: string | null }) {
  const step = value && value !== 'unknown' ? SETUP_STEPS[value] : undefined;
  return (
    <StepMeter
      filled={step ?? null}
      total={3}
      tone="cost"
      label={step ? `${value} setup` : 'setup not measured'}
      title="What it costs to get the project running locally"
    />
  );
}

/** An unmeasured value renders as a dash. It is never a zero. */
export function Measured({
  value,
  render,
}: {
  value: number | string | null;
  render?: (value: never) => string;
}) {
  if (value === null) return <span className="dash" title="not measured">—</span>;
  return <>{render ? render(value as never) : value}</>;
}

export function formatHours(hours: number): string {
  return hours < 48 ? `${Math.round(hours)}h` : `${Math.round(hours / 24)}d`;
}

/**
 * The signature element: where a row's score actually came from.
 *
 * Repo-level weights dominate the ranking, which means a high score often describes the project
 * rather than the issue. That is the single most useful thing to know before opening a candidate,
 * and it is invisible in the evidence lines because those are capped at four. The bar is drawn to
 * scale from the full subtotals; debits are hatched and sit apart from the credits.
 */
export function ProvenanceBar({
  subtotals,
  score,
}: {
  subtotals: { repo: number; issue: number };
  score: number;
}) {
  const parts = [
    { key: 'repo', value: subtotals.repo, name: 'the project' },
    { key: 'issue', value: subtotals.issue, name: 'this issue' },
  ];
  const span = parts.reduce((total, part) => total + Math.abs(part.value), 0);

  return (
    <div className="prov">
      <div
        className="prov__track"
        role="img"
        aria-label={
          `Score ${score}: ${subtotals.repo} from the project, ${subtotals.issue} from this issue`
        }
      >
        {span > 0 &&
          parts
            .filter((part) => part.value !== 0)
            .map((part) => (
              <span
                key={part.key}
                className={
                  part.value < 0
                    ? 'prov__seg prov__seg--debit'
                    : `prov__seg prov__seg--${part.key}`
                }
                style={{ width: `${(Math.abs(part.value) / span) * 100}%` }}
              />
            ))}
      </div>
      <div className="prov__key">
        <span>
          the project <b>{subtotals.repo > 0 ? `+${subtotals.repo}` : subtotals.repo}</b>
        </span>
        <span>
          this issue <b>{subtotals.issue > 0 ? `+${subtotals.issue}` : subtotals.issue}</b>
        </span>
      </div>
    </div>
  );
}

export function EvidenceChip({ line }: { line: ScoreLine }) {
  return (
    <span className={`chip chip--${line.points < 0 ? 'debit' : 'credit'}`}>
      <span className="chip__pts">
        {line.points > 0 ? '+' : ''}
        {line.points}
      </span>{' '}
      {line.signal} <span className="chip__detail">({line.detail})</span>
    </span>
  );
}

export function RowContextLine({ context }: { context: RowContext }) {
  return (
    <div className="row__context">
      <ResponsivenessMeter value={context.responsiveness} />
      <span>
        median reply{' '}
        {context.medianHoursResponse === null ? (
          <span className="dash" title="not measured">—</span>
        ) : (
          formatHours(context.medianHoursResponse)
        )}
      </span>
      <SetupMeter value={context.setupWeight} />
      {context.primaryLanguage && <span>{context.primaryLanguage}</span>}
      <span>{context.stars.toLocaleString()}★</span>
    </div>
  );
}

/**
 * The itemised breakdown. Two tables rather than one sorted list, because "is this a good project"
 * and "is this a good issue within it" are different questions and merging them hides which one the
 * score is answering.
 */
export function Ledger({
  caption,
  lines,
  subtotal,
  empty,
}: {
  caption: string;
  lines: ScoreLine[];
  subtotal: number;
  empty: string;
}) {
  return (
    <table className="ledger">
      <caption>{caption}</caption>
      <tbody>
        {lines.length === 0 && (
          <tr>
            <td colSpan={3} className="ledger__detail">
              {empty}
            </td>
          </tr>
        )}
        {lines.map((line) => (
          <tr key={`${line.signal}-${line.detail}`}>
            <td className={`ledger__pts ledger__pts--${line.points < 0 ? 'debit' : 'credit'}`}>
              {line.points > 0 ? '+' : ''}
              {line.points}
            </td>
            <td className="ledger__signal">{line.signal}</td>
            <td className="ledger__detail">{line.detail}</td>
          </tr>
        ))}
        <tr className="ledger__sub">
          <td className="ledger__pts">{subtotal}</td>
          <td colSpan={2}>subtotal</td>
        </tr>
      </tbody>
    </table>
  );
}

/**
 * Notices arrive from the server as structured kinds rather than sentences, so each surface writes
 * its own remedy. Here the remedy is a control to move, not a flag to retype.
 */
export function Notice({ notice }: { notice: ShortlistNotice }) {
  if (notice.kind === 'no-candidates') {
    return (
      <div className="notice">
        <p className="notice__title">Nothing to rank yet</p>
        <p className="notice__body">
          Either no issues have been synced, every open issue is assigned or already judged, or the
          filters excluded everything. Try clearing the filters, or turning on “include dormant
          projects”.
        </p>
      </div>
    );
  }
  if (notice.kind === 'none-scoring') {
    return (
      <div className="notice">
        <p className="notice__title">
          {notice.considered.toLocaleString()} issues considered, none scored {notice.minScore} or
          above
        </p>
        <p className="notice__body">
          Lower the minimum score, or widen the corpus. The score has no units, so the threshold is
          only meaningful relative to this corpus.
        </p>
      </div>
    );
  }
  return (
    <div className="notice">
      <p className="notice__title">This ranks a subset, not the corpus</p>
      <p className="notice__body">
        The query hit its {notice.fetchLimit.toLocaleString()}-row fetch cap, so the ranking saw
        whichever issues were updated most recently rather than all of them. Narrow the filters to
        get a ranking you can trust.
      </p>
    </div>
  );
}
