import { useState } from 'react';
import { Shortlist } from './Shortlist.tsx';
import { Journal } from './Journal.tsx';
import { Profile } from './Profile.tsx';
import { Sync } from './Sync.tsx';

type Screen = 'shortlist' | 'journal' | 'profile' | 'sync';

const LABELS: Record<Screen, string> = {
  shortlist: 'Shortlist',
  journal: 'What you decided',
  profile: 'What you want',
  sync: 'The corpus',
};

export function App() {
  const [screen, setScreen] = useState<Screen>('shortlist');

  return (
    <div className="shell">
      <header className="rail">
        <span className="rail__mark">COMPASS</span>
        <span className="rail__tagline">should I spend my next five hours on this?</span>
        <nav className="rail__nav">
          {(['shortlist', 'journal', 'profile', 'sync'] as Screen[]).map((name) => (
            <button
              key={name}
              type="button"
              className="rail__tab"
              aria-current={screen === name ? 'page' : undefined}
              onClick={() => setScreen(name)}
            >
              {LABELS[name]}
            </button>
          ))}
        </nav>
      </header>

      {screen === 'shortlist' && <Shortlist />}
      {screen === 'journal' && <Journal />}
      {screen === 'profile' && <Profile />}
      {screen === 'sync' && <Sync />}
    </div>
  );
}
