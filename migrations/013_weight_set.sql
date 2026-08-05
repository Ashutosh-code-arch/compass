-- Phase 3: named weight sets.
--
-- The roadmap asserted that "the profile system already supports alternative weights". It did not. The
-- profile carried preference points — languages, topics, avoid terms, capped at ±25 — layered over a
-- single module constant that the scorer read directly in forty-five places. There was no way to express
-- a different set, and the career-leverage idea needs one, because what it mainly has to do is REMOVE a
-- penalty and preference points can only add.
--
-- `src/rank/weight_sets.ts` holds the sets. This column holds which one is selected.

alter table profile
  -- Null is the default set. Named rather than free-form so that an unrecognised value is a constraint
  -- violation at write time instead of a silent fallback at read time: a profile that quietly scores
  -- against different weights than it claims is the worst version of this feature.
  add column weight_set text
    check (weight_set in ('default', 'career-leverage'));

comment on column profile.weight_set is
  'Which named weight set to score against. Null means the default. Guarded against WEIGHT_SETS in '
  'src/rank/weight_sets.ts by a test, because a union in TypeScript and a CHECK in SQL only meet at '
  'insert time.';
