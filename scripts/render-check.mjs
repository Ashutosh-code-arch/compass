/**
 * Verifies the UI by RENDERING it: the built bundle, loaded into jsdom, against a live server.
 *
 * A frontend that compiles is not a frontend that works. `tsc` proves the types line up and says
 * nothing about whether the app mounts, whether a fetch succeeds, or whether clicking a tab shows
 * anything — every one of which has been broken at some point by a change that typechecked.
 *
 *   npm start                # build the bundle and serve on :8787
 *   npm run render:check     # in another shell
 */

import { JSDOM } from 'jsdom';

const base = process.env.COMPASS_URL ?? 'http://127.0.0.1:8787';

let html;
try {
  html = await (await fetch(`${base}/`)).text();
} catch (error) {
  console.error(
    `Could not reach ${base}. Start the app first:\n  npm start\n\n${String(error)}`,
  );
  process.exitCode = 1;
  // Not process.exit(): it truncates buffered stdout, which is a rule this project learned the hard
  // way and which applies to scripts as much as to the CLI.
  html = null;
}

if (html !== null) await check(html);

async function check(html) {

  /**
   * jsdom does not execute `<script type="module">`, which is what Vite emits. The bundle is
   * self-contained (no top-level import/export — asserted below), so it is fetched and evaluated
   * inside the window instead. The stylesheet and the Google Fonts link are irrelevant to whether the
   * app WORKS, so they are dropped rather than left to fail noisily.
   */
  const scriptSrc = /<script[^>]+src="([^"]+\.js)"/.exec(html)?.[1];
  if (!scriptSrc) throw new Error('no bundle script tag in index.html');

  const bundle = await (await fetch(new URL(scriptSrc, base))).text();
  if (/^\s*(import|export)\b/m.test(bundle)) {
    throw new Error('bundle uses module syntax; it can no longer be evaluated this way');
  }

  const dom = new JSDOM(html.replace(/<link[^>]*>/g, '').replace(/<script[^>]*><\/script>/g, ''), {
    url: `${base}/`,
    runScripts: 'dangerously',
    pretendToBeVisual: true,
  });
  dom.window.fetch = (input, init) =>
    fetch(new URL(typeof input === 'string' ? input : input.url, base), init);

  dom.window.eval(bundle);

  const text = () => dom.window.document.body.textContent ?? '';
  const click = (label) => {
    const buttons = [...dom.window.document.querySelectorAll('button')];
    const target = buttons.find((b) => (b.textContent ?? '').includes(label));
    if (!target) throw new Error(`no button matching ${JSON.stringify(label)}`);
    target.click();
  };
  const settle = (ms = 1200) => new Promise((r) => setTimeout(r, ms));

  await settle(3000);
  if (!text().includes('COMPASS')) throw new Error('app did not mount');
  console.log('mounted; shortlist rendered:', text().includes('Monopoly candidate'));

  click('Who to work with');
  await settle(1500);
  let body = text();
  for (const expect of ['organisations', 'GSoC', 'merge rate', 'open candidate']) {
    if (!body.toLowerCase().includes(expect.toLowerCase())) {
      throw new Error(`orgs screen missing ${JSON.stringify(expect)}`);
    }
  }
  console.log('orgs screen: hog shown =', body.includes('hog'),
              '| uncovered shown =', body.includes('Not in your corpus'),
              '| pooled denominator =', /% of \d+/.test(body),
              '| calendar =', /GSoC 2026/.test(body));

  click('open candidate');
  await settle(1500);
  body = text();
  console.log('drill-in reached shortlist:', body.includes('Monopoly candidate'));
  console.log('org filter carried (acme absent):', !body.includes('acme/widgets'));

  /**
   * Phase 2: the decaying facts must render, and a claim verdict must never appear without its age.
   *
   * Asserted against the element rather than the page's textContent. textContent concatenates across
   * element boundaries — "DCO sign-off" immediately followed by "contested" reads as
   * "sign-offcontested" — so a word-boundary regex over the whole blob fails on markup that is
   * perfectly correct. The first version of this check did exactly that and blamed the app.
   */
  const chips = [...dom.window.document.querySelectorAll('.chip')].map((el) => el.textContent ?? '');
  const claimChip = chips.find((chipText) =>
    /^(free|claimed|contested|in-progress|stale-claim)\b/.test(chipText.trim()),
  );
  if (claimChip !== undefined && !/checked/.test(claimChip)) {
    throw new Error(`claim verdict rendered without its age: ${JSON.stringify(claimChip)}`);
  }
  console.log(
    'claim verdict chip:', claimChip === undefined ? 'none on this page' : JSON.stringify(claimChip.trim()),
    '| queue depth:', /open PRs/.test(body),
  );
  const hasCheckButton = [...dom.window.document.querySelectorAll('button')].some((b) =>
    (b.textContent ?? '').includes('actually free'),
  );
  console.log('claim check button present:', hasCheckButton);

  /**
   * Phase 3: a momentum verdict must never render without the numbers that produced it, for the same
   * reason a claim verdict must never render without its age.
   */
  const momentumChip = chips.find((chipText) =>
    /^(hype|rising|steady|cooling)\b/.test(chipText.trim()),
  );
  if (momentumChip !== undefined && !/[+-]?\d/.test(momentumChip)) {
    throw new Error(`momentum verdict rendered without its numbers: ${JSON.stringify(momentumChip)}`);
  }
  console.log(
    'momentum chip:',
    momentumChip === undefined ? 'none on this page' : JSON.stringify(momentumChip.trim()),
  );

  dom.window.close();
  console.log('RENDER OK');
}
