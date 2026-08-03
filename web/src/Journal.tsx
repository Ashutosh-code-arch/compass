import { useQuery } from '@tanstack/react-query';
import { api, type JournalEntry, type JournalView } from './api.ts';

const MIN_PAIRS_FOR_MEAN = 3;

export function Journal() {
  const query = useQuery({ queryKey: ['journal'], queryFn: () => api.journal(50) });

  return (
    <div className="layout layout--single">
      <main className="main">
        <div className="wrap">
          {query.isPending && <p className="state">Loading…</p>}

          {query.isError && (
            <div className="notice">
              <p className="notice__title">Cannot reach the API</p>
              <p className="notice__body">{(query.error as Error).message}</p>
            </div>
          )}

          {query.data && (
            <>
              <Calibration view={query.data} />
              {query.data.entries.length === 0 ? (
                <Empty />
              ) : (
                query.data.entries.map((entry) => (
                  <Entry key={`${entry.repoFullName}#${entry.number}`} entry={entry} />
                ))
              )}
            </>
          )}
        </div>
      </main>
    </div>
  );
}

/**
 * The one figure in this application that is a measurement rather than a preference.
 *
 * It is withheld below three pairs by the server, and the UI must not go looking for it in the
 * individual entries and average them itself — that is precisely the fabricated precision the whole
 * project is built to avoid. Below the threshold, show the progress instead of the number.
 */
function Calibration({ view }: { view: JournalView }) {
  if (view.meanRatio !== null) {
    const over = view.meanRatio > 1;
    return (
      <div className="calibration">
        <p className="calibration__figure">{view.meanRatio.toFixed(1)}×</p>
        <p className="calibration__note">
          Across {view.complete} finished issues, the work took {over ? 'longer' : 'less time'} than
          you predicted — on average {view.meanRatio.toFixed(1)} times your estimate. This is the
          only number here fitted to anything you actually did.
        </p>
      </div>
    );
  }

  return (
    <div className="calibration">
      <p className="calibration__figure">
        {view.complete} of {MIN_PAIRS_FOR_MEAN}
        <span className="progress-pips">
          {Array.from({ length: MIN_PAIRS_FOR_MEAN }, (_unused, index) => (
            <i key={index} data-on={index < view.complete} />
          ))}
        </span>
      </p>
      <p className="calibration__note">
        {view.complete === 0
          ? 'No issue yet has both a prediction and an outcome.'
          : `${view.complete} issue${view.complete === 1 ? '' : 's'} so far with both a prediction and an outcome.`}{' '}
        Record the hours you expect when you start, and the hours it took when you finish.{' '}
        {MIN_PAIRS_FOR_MEAN} complete pairs is where an average starts meaning anything, and about
        fifteen is where the ranking weights become defensible.
      </p>
    </div>
  );
}

function Empty() {
  return (
    <div className="notice">
      <p className="notice__title">Nothing recorded yet</p>
      <p className="notice__body">
        Open the shortlist, pick something, and record what you decided — including the issues you
        turn down. Rejections keep the shortlist from offering you the same thing next week, and the
        hours are what eventually turn the ranking weights from an opinion into a measurement.
      </p>
    </div>
  );
}

function Entry({ entry }: { entry: JournalEntry }) {
  return (
    <article className="entry">
      <div className="entry__head">
        <div>
          <span className="entry__repo">
            {entry.repoFullName}#{entry.number}
          </span>
          <h2 className="entry__title">{entry.title}</h2>
        </div>
        <span className="entry__date">{entry.lastAt.slice(0, 10)}</span>
      </div>

      <p className="trail">
        {entry.trail.map((step, index) => (
          <span key={`${step}-${index}`} style={{ display: 'contents' }}>
            {index > 0 && <span className="trail__arrow">→</span>}
            <span
              className={`trail__step${index === entry.trail.length - 1 ? ' trail__step--last' : ''}`}
            >
              {step.replace(/_/g, ' ')}
            </span>
          </span>
        ))}
      </p>

      <Hours entry={entry} />

      {entry.reason && <p className="entry__reason">{entry.reason}</p>}
    </article>
  );
}

function Hours({ entry }: { entry: JournalEntry }) {
  if (entry.predictedHours === null && entry.actualHours === null) return null;

  return (
    <p className="hours">
      <span>
        predicted{' '}
        {entry.predictedHours === null ? (
          <span className="dash" title="not recorded">—</span>
        ) : (
          `${entry.predictedHours}h`
        )}
      </span>
      <span>
        actual{' '}
        {entry.actualHours === null ? (
          <span className="dash" title="not recorded">—</span>
        ) : (
          `${entry.actualHours}h`
        )}
      </span>
      {entry.ratio !== null && (
        <span className={`hours__ratio hours__ratio--${entry.ratio > 1 ? 'over' : 'under'}`}>
          {entry.ratio.toFixed(1)}×
        </span>
      )}
    </p>
  );
}
