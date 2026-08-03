# Contributing

Start with [Development](docs/development.md) — setup, tests, conventions, and how to add a signal, a
migration, an endpoint or a screen.

## The short version

```bash
npm install && npm run web:install
npm test
npm run typecheck
npm run docs:check
```

All three must pass. Then run it against real data and look at the output — the two worst bugs found in this
project so far passed every test.

## Three conventions that matter more than the rest

**`null` means unmeasured. Never zero.** This runs from the SQL through the pure modules to the dash in the
interface. Reporting absence as zero is the easiest way to make this tool lie.

**Comments explain why, not what.** `src/rank/weights.ts` is the model: every number carries the observation
that produced it. A weight changed without a reason attached is a mystery in three months.

**Judgement belongs in a pure module.** Anything with a decision in it goes somewhere with no database, no
network, no clock and no console, so it can be tested against a fixture. See
[Architecture](docs/architecture.md#the-rule-that-matters).

## Before opening a pull request

- `npm test` and `npm run typecheck` pass
- `npm run docs:check` passes — it verifies the docs against the source, and it fails when you add a
  flag or endpoint without documenting it
- `(cd web && npm run build)` if you touched the frontend
- New judgement is covered by a test that says *why* it would matter if it broke
- If you changed a weight or a metric, say what evidence prompted it

If you are changing behaviour rather than adding to it, diff the output before and against a fixture corpus
rather than asserting it is equivalent. The recipe is in
[Development](docs/development.md#verifying-a-refactor).
