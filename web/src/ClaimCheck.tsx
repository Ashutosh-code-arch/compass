import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, type ClaimCheck } from './api.ts';

const LABELS: Record<ClaimCheck['verdict'], string> = {
  free: 'Nobody has asked for this',
  claimed: 'One person has asked, and nobody was assigned',
  contested: 'Several people have asked, and nobody was assigned',
  'in-progress': 'Somebody is already doing the work',
  'stale-claim': 'Asked for a while ago, then nothing',
};

const ADVICE: Record<ClaimCheck['verdict'], string> = {
  free: 'Nothing in the thread suggests anyone else is on it.',
  claimed:
    'Comment before you start. The maintainers are not assigning, so arriving second is a real risk.',
  contested:
    'This is the pattern that wastes evenings — a queue of volunteers and no assignment. Unless you want to race, spend the time elsewhere.',
  'in-progress': 'Skip it. Somebody has work in flight, and a second pull request helps nobody.',
  'stale-claim':
    'Probably yours. Say so in the thread — the earlier request is old enough that nobody will mind.',
};

/**
 * An explicit action, not something that happens on render.
 *
 * Reading a comment thread costs a GitHub request, and the corpus has three hundred thousand issues.
 * Checking on expand would drain the rate limit answering questions about rows the person scrolled
 * past — so this is a button, and the result is cached so pressing it once is enough.
 */
export function ClaimCheckButton({
  repoFullName,
  number,
}: {
  repoFullName: string;
  number: number;
}) {
  const [result, setResult] = useState<ClaimCheck | null>(null);
  const queryClient = useQueryClient();

  const check = useMutation({
    mutationFn: () => api.checkClaims(repoFullName, number),
    onSuccess: (data) => {
      setResult(data);
      // The shortlist reads the same cache, so the row picks up the verdict on its next fetch.
      void queryClient.invalidateQueries({ queryKey: ['shortlist'] });
    },
  });

  return (
    <div>
      <button
        type="button"
        className="btn"
        disabled={check.isPending}
        onClick={() => check.mutate()}
      >
        {check.isPending ? 'Reading the thread…' : result ? 'Check again' : 'Is it actually free?'}
      </button>

      {check.isError && (
        <p className="row__held">
          {(check.error as Error).message}
          {/* Reading comments needs a token; the rest of the app does not, and saying so avoids
              sending someone to look for a bug in the corpus. */}
        </p>
      )}

      {result && (
        <div className="notice" style={{ marginTop: 10 }}>
          <p className="notice__title">
            {LABELS[result.verdict]}
            {result.verdict === 'contested' ? ` — ${result.claimants} people` : ''}
          </p>
          <p className="notice__body">{ADVICE[result.verdict]}</p>

          <p className="row__held">
            {result.commentsTotal > result.commentsRead
              ? `Read ${result.commentsRead} of ${result.commentsTotal} comments — the rest were not seen.`
              : `Read all ${result.commentsRead} comment${result.commentsRead === 1 ? '' : 's'}.`}{' '}
            True as of the moment of the check, not of now.
          </p>

          {result.progress.length > 0 && (
            <ul className="notice__body">
              {result.progress.slice(0, 3).map((event) => (
                <li key={`${event.author}-${event.at}`}>
                  <strong>{event.author}</strong> {event.why}
                  {event.excerpt && <> — “{event.excerpt}”</>}
                </li>
              ))}
            </ul>
          )}

          {result.claims.length > 0 && (
            <ul className="notice__body">
              {result.claims.slice(0, 5).map((event) => (
                <li key={`${event.author}-${event.at}`}>
                  <strong>{event.author}</strong> {event.why}
                  {event.excerpt && <> — “{event.excerpt}”</>}
                </li>
              ))}
            </ul>
          )}

          {result.linkedPrs.length > 0 && (
            <p className="notice__body">
              {result.linkedPrs.slice(0, 3).map((url) => (
                <a key={url} href={url} target="_blank" rel="noreferrer" style={{ marginRight: 8 }}>
                  {url.replace('https://github.com/', '')}
                </a>
              ))}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
