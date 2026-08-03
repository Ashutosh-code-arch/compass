import { useEffect, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, VERDICTS, type Verdict } from './api.ts';

/**
 * Verdicts that start a piece of work, and verdicts that end it.
 *
 * The distinction drives which hours field is offered. A prediction recorded at the end is not a
 * prediction, and an outcome recorded at the start is not an outcome — the journal pairs them per
 * issue over time, so asking for the right one at the right moment is what eventually produces a
 * usable calibration figure.
 */
const OPENS: Verdict[] = ['shortlisted', 'started'];
const CLOSES: Verdict[] = ['submitted', 'merged', 'closed_unmerged', 'abandoned', 'stalled'];

const BLURB: Record<Verdict, string> = {
  shortlisted: 'Worth doing, not started yet.',
  started: 'Working on it now.',
  submitted: 'Pull request opened, waiting on review.',
  merged: 'Merged.',
  stalled: 'Open but going nowhere.',
  abandoned: 'Started and dropped.',
  closed_unmerged: 'Closed without merging.',
  rejected: 'Not worth doing. Removes it from the shortlist.',
};

export function DecideDialog({
  repoFullName,
  number,
  title,
  onClose,
}: {
  repoFullName: string;
  number: number;
  title: string;
  onClose: () => void;
}) {
  const [verdict, setVerdict] = useState<Verdict | null>(null);
  const [predictedHours, setPredictedHours] = useState('');
  const [actualHours, setActualHours] = useState('');
  const [reason, setReason] = useState('');
  const queryClient = useQueryClient();
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    dialogRef.current?.focus();
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const save = useMutation({
    mutationFn: () => {
      const hours = (value: string): number | undefined => {
        const parsed = Number.parseFloat(value);
        return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
      };
      return api.decide({
        ref: `${repoFullName}#${number}`,
        verdict: verdict!,
        ...(hours(predictedHours) !== undefined ? { predictedHours: hours(predictedHours)! } : {}),
        ...(hours(actualHours) !== undefined ? { actualHours: hours(actualHours)! } : {}),
        ...(reason.trim() ? { reason: reason.trim() } : {}),
      });
    },
    onSuccess: async () => {
      // A decision removes the issue from the shortlist and adds it to the journal; both are stale.
      await queryClient.invalidateQueries({ queryKey: ['shortlist'] });
      await queryClient.invalidateQueries({ queryKey: ['journal'] });
      onClose();
    },
  });

  return (
    <div className="scrim" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-label={`Record a decision on ${repoFullName} number ${number}`}
        ref={dialogRef}
        tabIndex={-1}
      >
        <h2 className="dialog__title">Record a decision</h2>
        <p className="dialog__sub">
          {repoFullName}#{number} — {title.slice(0, 64)}
        </p>

        <div className="verdicts">
          {VERDICTS.map((option) => (
            <button
              key={option}
              type="button"
              className="verdict"
              aria-pressed={verdict === option}
              onClick={() => setVerdict(option)}
            >
              {option.replace(/_/g, ' ')}
            </button>
          ))}
        </div>

        {verdict && <p className="notice__body">{BLURB[verdict]}</p>}

        {verdict && OPENS.includes(verdict) && (
          <label className="field" style={{ marginTop: 12 }}>
            <span className="field__label">How many hours do you think it will take?</span>
            <input
              type="number"
              min="0"
              step="0.5"
              value={predictedHours}
              onChange={(event) => setPredictedHours(event.target.value)}
              placeholder="e.g. 4"
            />
          </label>
        )}

        {verdict && CLOSES.includes(verdict) && (
          <label className="field" style={{ marginTop: 12 }}>
            <span className="field__label">How many hours did it actually take?</span>
            <input
              type="number"
              min="0"
              step="0.5"
              value={actualHours}
              onChange={(event) => setActualHours(event.target.value)}
              placeholder="e.g. 9"
            />
          </label>
        )}

        <label className="field">
          <span className="field__label">Why? (optional, but this is what you will reread)</span>
          <input
            type="text"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder="e.g. needs a design discussion first"
          />
        </label>

        {save.isError && (
          <p className="dialog__error">{(save.error as Error).message}</p>
        )}

        <div className="dialog__actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn--primary"
            disabled={!verdict || save.isPending}
            onClick={() => save.mutate()}
          >
            {save.isPending ? 'Recording…' : 'Record decision'}
          </button>
        </div>
      </div>
    </div>
  );
}
