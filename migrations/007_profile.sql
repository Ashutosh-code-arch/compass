-- What you want to work on, so the ranking stops being the same for everybody.
--
-- Single row, enforced by the check constraint. The handoff calls for multi-user later; when that
-- happens, drop the constraint and add an owner column rather than inventing a second mechanism now.
-- A loud failure on a second insert is better than silently ranking against an arbitrary row.
--
-- Every column is nullable or defaults to empty, and an empty profile must reproduce the previous
-- behaviour exactly: the constants in src/rank/weights.ts remain the defaults, and this table only
-- overrides them. That is what lets the profile ship without re-tuning anything.

create table profile (
  id                integer primary key default 1 check (id = 1),

  -- language -> points. Overrides LANGUAGE_POINTS wholesale when non-empty, rather than merging:
  -- a partial merge would mean removing a language from the UI silently reinstates its default.
  language_points   jsonb   not null default '{}'::jsonb,

  -- topic -> points, matched against repos.topics (already indexed with GIN in 001).
  topic_points      jsonb   not null default '{}'::jsonb,

  -- Subject matter to steer away from. Matched against repos.topics and issue labels respectively.
  -- These extend the built-in AVOID_LABELS rather than replacing them.
  avoid_topics      text[]  not null default '{}',
  avoid_labels      text[]  not null default '{}',

  -- Reputation band. Defaults for the shortlist filters, still overridable per request.
  -- Rationale worth preserving from seeds/queries.ts: below ~500 stars abandonment risk dominates,
  -- above ~50k the labelled beginner issues are claimed within hours.
  min_stars         integer check (min_stars is null or min_stars >= 0),
  max_stars         integer check (max_stars is null or max_stars >= 0),

  max_setup_weight  text    check (max_setup_weight in ('light', 'moderate', 'heavy')),

  updated_at        timestamptz not null default now(),

  constraint profile_star_band_ordered
    check (min_stars is null or max_stars is null or min_stars <= max_stars)
);

-- The row exists from the start so reads never have to special-case its absence. An all-defaults row
-- is precisely the "no profile" state, so this changes nothing about how anything scores.
insert into profile (id) values (1);
