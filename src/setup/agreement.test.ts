import assert from 'node:assert/strict';
import { test } from 'node:test';
import { latestCheckValues } from '../schema_constraints.ts';
import { AGREEMENT_KINDS, detectContributorAgreement } from './agreement.ts';

function detect(contributingText: string | null, treePaths: string[] = [], treeTruncated = false) {
  return detectContributorAgreement({ contributingText, treePaths, treeTruncated });
}

test('AGREEMENT_KINDS matches the setup_facts constraint', () => {
  const allowed = latestCheckValues('setup_facts', 'contributor_agreement');
  assert.ok(allowed, 'no contributor_agreement constraint found in any migration');
  assert.deepEqual([...allowed].sort(), [...AGREEMENT_KINDS].sort());
});

test('a CLA sentence is found, and the phrase is the evidence', () => {
  const found = detect('Before we can merge, please sign our Contributor License Agreement.');
  assert.equal(found.agreement, 'cla');
  assert.deepEqual(found.evidence, ['contributor license agreement']);
});

test('a DCO sign-off requirement is found and is not confused with a CLA', () => {
  const found = detect('All commits must carry a Signed-off-by line. Use `git commit -s`.');
  assert.equal(found.agreement, 'dco');
  assert.ok(found.evidence.includes('Signed-off-by'));
});

test('a project requiring both reports both', () => {
  const found = detect(
    'Sign the CLA via cla-assistant, and sign off each commit per the Developer Certificate of Origin.',
  );
  assert.equal(found.agreement, 'both');
});

/**
 * The false positive that would have mattered most. "A maintainer must sign off on the design" is an
 * ordinary sentence in an ordinary CONTRIBUTING file, and reading it as a DCO requirement would
 * attach paperwork to a project that has none.
 */
test('a maintainer signing off on a design is not a DCO', () => {
  const found = detect('Open an issue first — a maintainer needs to sign off on the design.');
  assert.equal(found.agreement, 'none');
});

/**
 * The other direction of the same care. A lowercase "cla" inside another word must not fire, and
 * neither must a filename that merely contains those three letters.
 */
test('substrings do not trigger a verdict', () => {
  assert.equal(detect('See the declarations in our docs for class naming.').agreement, 'none');
  assert.equal(detect('Read the CONTRIBUTING guide.', ['declarations.yaml']).agreement, 'none');
  assert.equal(detect('Read the CONTRIBUTING guide.', ['mdco.yaml']).agreement, 'none');
});

test('bot configuration counts even with no CONTRIBUTING file', () => {
  const found = detect(null, ['.github/workflows/cla.yml', 'src/index.ts']);
  assert.equal(found.agreement, 'cla');
  assert.deepEqual(found.evidence, ['.github/workflows/cla.yml']);
});

test('a DCO bot config is recognised', () => {
  assert.equal(detect(null, ['.github/dco.yml']).agreement, 'dco');
});

/**
 * Only configuration-shaped files count. A repository that documents somebody else's CLA workflow, or
 * ships an example of one, does not itself require a CLA.
 */
test('a mention buried in docs or examples is not configuration', () => {
  assert.equal(detect(null, ['docs/cla.md', 'examples/cla/setup.yml']).agreement, null);
});

/**
 * The rule the whole module turns on. Nothing found and nothing read means unmeasured, because the
 * usual place a project states this was not there to look at — and a confident "no CLA" that walks
 * someone into a signature wall is the failure this exists to prevent.
 */
test('nothing found and nothing read is unmeasured, not none', () => {
  const found = detect(null, ['README.md', 'src/index.ts']);
  assert.equal(found.agreement, null);
  assert.deepEqual(found.evidence, []);
});

test('nothing found in a file that WAS read is none', () => {
  const found = detect('Run the tests, open a pull request, be kind.', ['README.md']);
  assert.equal(found.agreement, 'none');
});

test('an empty CONTRIBUTING file is not a reading', () => {
  assert.equal(detect('   \n  ').agreement, null);
});

/**
 * Truncation is the same asymmetry as `classifySetupWeight`: seeing a thing is unaffected by not
 * having seen everything, so positives stand and only absence has to be withheld.
 */
test('a truncated tree withholds none but keeps positives', () => {
  assert.equal(detect('Nothing about agreements here.', ['README.md'], true).agreement, null);
  assert.equal(detect('Please sign the CLA.', [], true).agreement, 'cla');
});

test('evidence is deduplicated and capped', () => {
  const found = detect(
    'CLA. Contributor License Agreement. cla-assistant. Sign the licence. Corporate contributor agreement.',
    ['.clabot', 'cla.json'],
  );
  assert.ok(found.evidence.length <= 6);
  assert.equal(new Set(found.evidence).size, found.evidence.length);
});
