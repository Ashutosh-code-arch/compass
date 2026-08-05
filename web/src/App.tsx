import { useState } from 'react';
import { Shortlist } from './Shortlist.tsx';
import { Organisations } from './Organisations.tsx';
import { Journal } from './Journal.tsx';
import { Profile } from './Profile.tsx';
import { Sync } from './Sync.tsx';

type Screen = 'orgs' | 'shortlist' | 'journal' | 'profile' | 'sync';

const LABELS: Record<Screen, string> = {
  orgs: 'Who to work with',
  shortlist: 'Shortlist',
  journal: 'What you decided',
  profile: 'What you want',
  sync: 'The corpus',
};

export function App() {
  const [screen, setScreen] = useState<Screen>('shortlist');
  /**
   * The organisation drilled into, if any.
   *
   * Kept here rather than in the shortlist so that arriving from the organisations table brings the
   * filter with it. Cleared on any other tab change, because a filter you cannot see is a filter that
   * will confuse you later.
   */
  const [drilledOrg, setDrilledOrg] = useState<string | null>(null);

  return (
    <div className="shell">
      <header className="rail">
        <span className="rail__mark">COMPASS</span>
        <span className="rail__tagline">should I spend my next five hours on this?</span>
        <nav className="rail__nav">
          {(['orgs', 'shortlist', 'journal', 'profile', 'sync'] as Screen[]).map((name) => (
            <button
              key={name}
              type="button"
              className="rail__tab"
              aria-current={screen === name ? 'page' : undefined}
              onClick={() => {
                setDrilledOrg(null);
                setScreen(name);
              }}
            >
              {LABELS[name]}
            </button>
          ))}
        </nav>
      </header>

      {screen === 'orgs' && (
        <Organisations
          onDrillIn={(login) => {
            setDrilledOrg(login);
            setScreen('shortlist');
          }}
        />
      )}
      {/* Keyed on the organisation so arriving from a different one remounts with the new filter. */}
      {screen === 'shortlist' && (
        <Shortlist
          key={drilledOrg ?? 'all'}
          {...(drilledOrg === null ? {} : { initialOrg: drilledOrg })}
        />
      )}
      {screen === 'journal' && <Journal />}
      {screen === 'profile' && <Profile />}
      {screen === 'sync' && <Sync />}
    </div>
  );
}
