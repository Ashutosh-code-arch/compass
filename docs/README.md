# Documentation

| Start here | |
|---|---|
| [Getting started](getting-started.md) | A complete walkthrough, empty database to first recorded decision. ~30 minutes |
| [How ranking works](how-ranking-works.md) | Every signal and weight, and which are measured versus assumed |
| [Troubleshooting](troubleshooting.md) | Errors and what they mean |

| Reference | |
|---|---|
| [CLI reference](cli-reference.md) | Every command and flag, with examples |
| [API reference](api-reference.md) | Every endpoint, with real request and response examples |
| [Configuration](configuration.md) | Every environment variable |
| [Database](database.md) | Tables, columns, migrations, and useful queries |

| Working on it | |
|---|---|
| [Architecture](architecture.md) | Module layout and the rules that keep it testable |
| [Development](development.md) | Tests, conventions, and how to add a signal, migration, endpoint or screen |
| [Roadmap](roadmap.md) | What is built, what is not, and what to do next |
| [Design notes](design-notes.md) | The original reasoning, and the corrections real data forced |

The repository root also has [README.md](../README.md) for installation and
[CONTRIBUTING.md](../CONTRIBUTING.md).

`HANDOFF.md` in the root is a working document for picking up mid-project — architecture, schema,
calibration history, and next steps in one place. Not intended as user documentation.

---

## If you read only one thing

[How ranking works](how-ranking-works.md), and specifically the
[measured versus assumed](how-ranking-works.md#measured-versus-assumed) table.

Two of the four inputs to a score are real measurements corrected against a thousand-repository corpus.
The other two are reasoning. The tool is careful about which is which, and it is the difference between
using it well and trusting a number that was never checked.
