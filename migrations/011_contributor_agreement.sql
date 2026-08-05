-- Phase 0: is there paperwork in the way?
--
-- A Contributor License Agreement is a hard blocker for some people, an employer question for
-- others, and a detour for everybody -- and it is far better known before the code is written than
-- after. A Developer Certificate of Origin is a much cheaper thing: a sign-off line on each commit,
-- no signature, no third party. Folding both into one "agreement required" boolean would throw away
-- the only distinction that changes what you do next, so they are recorded separately.
--
-- Nearly free: CONTRIBUTING is located by the full tree walk that migration 008 already pays for,
-- and its text arrives in a blob slot alongside files that were already being fetched.

alter table setup_facts
  -- Null means unmeasured, as everywhere else in this schema. 'none' is written only when a
  -- CONTRIBUTING file was actually read and mentioned neither -- having looked nowhere is not
  -- evidence of absence, and a confident "no CLA" that sends you into a signature wall is exactly
  -- the failure this column exists to prevent.
  add column contributor_agreement text
    check (contributor_agreement in ('cla', 'dco', 'both', 'none')),

  -- The phrases and paths that produced the verdict, so a surprising one can be argued with instead
  -- of trusted. Empty with a non-null verdict is possible only for 'none'.
  add column agreement_evidence text[] not null default '{}',

  -- Where CONTRIBUTING was found, which may be the root, .github/ or docs/.
  --
  -- Deliberately separate from has_contributing, which stays a root-only fact. Widening that column
  -- would change existing verdicts for reasons unrelated to this change, and a fix that quietly
  -- re-scores the corpus is not a fix.
  add column contributing_path text;

create index setup_facts_agreement_idx on setup_facts (contributor_agreement);

comment on column setup_facts.contributor_agreement is
  'cla | dco | both | none, or null for unmeasured. Derived from CONTRIBUTING text plus CLA/DCO bot '
  'configuration found in the tree. Null when no CONTRIBUTING file was readable and no bot '
  'configuration was present, because the usual place to state it was not there to read.';

comment on column setup_facts.agreement_evidence is
  'Verbatim matched phrases and paths. A verdict of cla with evidence [".github/workflows/cla.yml"] '
  'is a different quality of claim from one backed by a sentence in CONTRIBUTING, and the reader '
  'should be able to tell which they have.';
