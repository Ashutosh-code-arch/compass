#!/usr/bin/env python3
"""
Checks the documentation against the source.

Run after changing a weight, a CLI flag, an endpoint, or a migration:

    python3 docs/docs-check.py

Docs that quietly stop being true are worse than no docs, and proofreading does not catch it. This has
found four real problems so far: a `--fetch-limit` flag documented before it existed, a stale anchor
after a heading was renamed, two migration counts left at 7 after an eighth was added, and a "roughly
forty" vocabulary claim when the code had 34 entries.
"""
import json
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
FILES = [ROOT / 'README.md', ROOT / 'CONTRIBUTING.md'] + sorted((ROOT / 'docs').glob('*.md'))

# Flags belonging to other programs (node, psql, git), not to Compass.
FOREIGN = {'version', 'test', 'no', 'experimental-strip-types', 'env-file-if-exists',
           'noEmit', 'name', 'help', 'dry-run'}

problems: list[str] = []


def bad(message: str) -> None:
    problems.append(message)
    print(f'  BROKEN  {message}')


def read(path: pathlib.Path) -> str:
    return path.read_text()


def anchors(path: pathlib.Path) -> set[str]:
    return {
        re.sub(r'[^\w\s-]', '', line.lstrip('#').strip().lower()).replace(' ', '-')
        for line in read(path).split('\n')
        if line.startswith('#')
    }


def check_links() -> None:
    count = 0
    for f in FILES:
        for m in re.finditer(r'\]\((?!https?:)([^)#]+)(#[^)]*)?\)', read(f)):
            count += 1
            if not (f.parent / m.group(1)).resolve().exists():
                bad(f'{f.name}: link to {m.group(1)}')
    print(f'  {count} internal links resolve')


def check_anchors() -> None:
    count = 0
    for f in FILES:
        for m in re.finditer(r'\]\((?!https?:)([^)#]*)#([^)]+)\)', read(f)):
            target = f if m.group(1) == '' else f.parent / m.group(1)
            if not target.exists():
                continue
            count += 1
            if m.group(2) not in anchors(target):
                bad(f'{f.name}: anchor #{m.group(2)} not in {target.name}')
    print(f'  {count} anchors resolve')


def check_npm_scripts() -> None:
    root = set(json.loads(read(ROOT / 'package.json'))['scripts'])
    web = set(json.loads(read(ROOT / 'web' / 'package.json'))['scripts'])
    for f in FILES:
        for m in re.finditer(r'(\(cd web && )?npm (?:--prefix web )?run ([a-z:]+)', read(f)):
            pool = web if m.group(1) else root
            if m.group(2) not in pool and m.group(2) != 'compass':
                bad(f'{f.name}: npm run {m.group(2)} does not exist')
    print(f'  npm scripts exist ({len(root)} root, {len(web)} web)')


def check_cli() -> None:
    cli = read(ROOT / 'src' / 'cli.ts')
    flags = set(re.findall(r"^  '?([a-z-]+)'?: \{ type:", cli, re.M))
    commands = set(re.findall(r"case '([a-z]+)':", cli))

    for f in FILES:
        for line in read(f).split('\n'):
            is_flag_context = (
                line.strip().startswith('|') or 'compass -- ' in line or line.strip().startswith('`--')
            )
            if is_flag_context:
                for m in re.finditer(r'--([a-z][a-z-]{2,})', line):
                    if m.group(1) not in flags and m.group(1) not in FOREIGN:
                        bad(f'{f.name}: --{m.group(1)} is not a Compass flag')
        for m in re.finditer(r'npm run compass -- ([a-z]+)', read(f)):
            if m.group(1) not in commands:
                bad(f'{f.name}: no dispatch for command "{m.group(1)}"')
    print(f'  {len(flags)} flags and {len(commands)} commands, all references valid')


def check_endpoints() -> None:
    srv = read(ROOT / 'src' / 'http' / 'server.ts')
    actual = {
        f'{m.group(1).upper()} {m.group(2)}'
        for m in re.finditer(r"app\.(get|post|put)[^(]*\(\s*'(/api/[^']*)'", srv)
    }
    doc = read(ROOT / 'docs' / 'api-reference.md')
    documented = {
        f'{verb} {path}'
        for verb, path in re.findall(r'^### `(GET|POST|PUT) (/api/[^`]*)`', doc, re.M)
    }
    for missing in actual - documented:
        bad(f'endpoint not documented: {missing}')
    for invented in documented - actual:
        bad(f'documented endpoint does not exist: {invented}')
    print(f'  {len(actual)} endpoints, all documented, none invented')


def check_constants() -> None:
    weights = read(ROOT / 'src' / 'rank' / 'weights.ts').replace(' ', '')
    for fragment in ['responsive:22', 'dormant:-40', 'invitedLabel:16', 'avoidLabel:-14',
                     'points:-35', 'light:12', 'heavy:-14', 'DEFAULT_MIN_SCORE=20']:
        if fragment not in weights:
            bad(f'weights.ts no longer contains {fragment}, but a doc quotes it')

    cap = re.search(r'MAX_PREFERENCE_POINTS = (\d+)', read(ROOT / 'src' / 'rank' / 'profile.ts'))
    assert cap
    for f in FILES:
        text = read(f)
        if re.search(r'±\d+', text) and f'±{cap.group(1)}' not in text:
            bad(f'{f.name}: cites a preference cap other than {cap.group(1)}')

    verdicts = set(re.findall(
        r"'(shortlisted|rejected|started|abandoned|submitted|merged|closed_unmerged|stalled)'",
        read(ROOT / 'src' / 'rank' / 'view.ts')))
    if len(verdicts) != 8:
        bad(f'expected 8 verdicts in view.ts, found {len(verdicts)}')

    stacks = len(re.findall(r"\{ name: '", read(ROOT / 'src' / 'setup' / 'stack.ts')))
    for f in FILES:
        for m in re.finditer(r'vocabulary(?:,| of| currently)?\D{0,12}(\d+) entries', read(f)):
            if int(m.group(1)) != stacks:
                bad(f'{f.name}: says {m.group(1)} stack entries, code has {stacks}')
        if re.search(r'(roughly|around|about) forty (entries|common)', read(f)):
            bad(f'{f.name}: vague "forty" claim; code has {stacks}')

    migrations = sorted((ROOT / 'migrations').glob('*.sql'))
    for f in FILES:
        for m in re.finditer(r'(\d+) migration\(s\) applied', read(f)):
            if int(m.group(1)) != len(migrations):
                bad(f'{f.name}: says {m.group(1)} migrations, there are {len(migrations)}')
        for m in re.finditer(r'`(\d{3})_(\w+)\.sql`', read(f)):
            if not (ROOT / 'migrations' / f'{m.group(1)}_{m.group(2)}.sql').exists():
                bad(f'{f.name}: references missing migration {m.group(1)}_{m.group(2)}.sql')
    print(f'  weights, verdicts, {stacks} stack entries and {len(migrations)} migrations all agree')


for check in (check_links, check_anchors, check_npm_scripts, check_cli,
              check_endpoints, check_constants):
    check()

if problems:
    print(f'\n{len(problems)} documentation problem(s).')
    sys.exit(1)
print('\nDocumentation matches the source.')
