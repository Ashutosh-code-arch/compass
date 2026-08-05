/**
 * Ingesting the ROSS Index: which organisations are growing fastest, and who funds them. PURE parsing.
 *
 * Runa Capital publishes the index as datasets in a git repository (`RunaCapital/ROSS-Index`), already
 * joined: organisation, `owner/repo`, stars, growth multiple, founding year, location, and funding
 * including YC. No scraping, no terms-of-service question, no brittle selectors.
 *
 * **What this is and is not.** Everything here is CURATED, not measured — somebody else's numbers, taken
 * on their date, and stored with a review date saying so. Compass measures growth itself from
 * `repo_stars_history`, and that measurement is the one the hype filter uses. This import contributes the
 * two things the corpus genuinely cannot derive: **funding** and **who is on the list at all**, which is
 * a discovery feed rather than a signal.
 *
 * The columns are found by name rather than by position, because a published dataset's column order is
 * not a contract and a positional parser would silently read growth multiples as star counts the first
 * time somebody inserted a column.
 */

/** Header names that have meant each field, lowercased and stripped of punctuation. */
const COLUMN_ALIASES: Record<string, string[]> = {
  repo: ['repo', 'repository', 'reponame', 'githubrepo', 'ownerrepo', 'projectrepo'],
  org: ['org', 'organization', 'organisation', 'company', 'project', 'projectname'],
  funding: ['funding', 'investors', 'investor', 'lastround', 'round', 'fundingstage'],
  founded: ['founded', 'foundingyear', 'yearfounded', 'inception'],
};

function normaliseHeader(header: string): string {
  return header.toLowerCase().replace(/[^a-z0-9]/g, '');
}

export interface RossRow {
  /** The GitHub owner login, derived from the repository or the organisation column. */
  login: string;
  /** `owner/name`, when the dataset gave one. Something to run `add` against. */
  repoFullName: string | null;
  funding: string | null;
  foundedYear: number | null;
}

export interface ParsedRoss {
  rows: RossRow[];
  /** Rows that had no usable owner, with their line numbers. */
  rejected: { line: number; text: string }[];
  /** Which source column each field came from, so a surprising import can be explained. */
  columns: Record<string, string>;
}

export class RossError extends Error {}

/**
 * Splits one CSV line, honouring double-quoted fields.
 *
 * Deliberately small rather than a dependency: these datasets are machine-generated, and the only
 * complication that actually appears is a quoted field containing a comma — "Palo Alto, CA".
 */
export function splitCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = '';
  let quoted = false;

  for (let index = 0; index < line.length; index += 1) {
    const character = line[index]!;
    if (quoted) {
      if (character === '"') {
        // A doubled quote inside a quoted field is an escaped quote.
        if (line[index + 1] === '"') {
          current += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        current += character;
      }
    } else if (character === '"') {
      quoted = true;
    } else if (character === ',') {
      fields.push(current.trim());
      current = '';
    } else {
      current += character;
    }
  }
  fields.push(current.trim());
  return fields;
}

const LOGIN = /^[a-z\d](?:[a-z\d]|-(?=[a-z\d])){0,38}$/i;

/** `owner/name`, a bare owner, or a GitHub URL, reduced to the owner. */
function ownerOf(value: string): string | null {
  const cleaned = value
    .trim()
    // The scheme is optional: published datasets carry "github.com/x/y" as often as a full URL.
    .replace(/^(?:https?:\/\/)?(?:www\.)?github\.com\//i, '')
    .replace(/\.git$/i, '')
    .replace(/\/+$/, '');
  const owner = cleaned.split('/')[0]?.trim() ?? '';
  return owner !== '' && LOGIN.test(owner) ? owner : null;
}

export function parseRossCsv(text: string): ParsedRoss {
  // Blank lines and leading `#` comments are dropped. CSV has no comment convention, but a dataset
  // saved by hand often acquires a note at the top, and refusing the file for that would be pedantry
  // rather than caution — the header is still found by name, so nothing is guessed.
  const lines = text
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '' && !line.trimStart().startsWith('#'));
  if (lines.length < 2) {
    throw new RossError(
      'The dataset has no rows. Refusing to import: an empty source is a failure, not a finding that ' +
        'no organisation is growing.',
    );
  }

  const headers = splitCsvLine(lines[0]!).map(normaliseHeader);
  const index: Record<string, number> = {};
  const columns: Record<string, string> = {};
  const rawHeaders = splitCsvLine(lines[0]!);

  for (const [field, aliases] of Object.entries(COLUMN_ALIASES)) {
    const found = headers.findIndex((header) => aliases.includes(header));
    if (found >= 0) {
      index[field] = found;
      columns[field] = rawHeaders[found]!;
    }
  }

  if (index['repo'] === undefined && index['org'] === undefined) {
    throw new RossError(
      `Could not find a repository or organisation column. Saw: ${rawHeaders.join(', ')}. ` +
        'Columns are matched by name rather than position on purpose — a positional parser would read ' +
        'the wrong column silently the first time the dataset changed shape.',
    );
  }

  const rows: RossRow[] = [];
  const rejected: { line: number; text: string }[] = [];
  const seen = new Set<string>();

  for (const [offset, line] of lines.slice(1).entries()) {
    const fields = splitCsvLine(line);
    const at = (field: string): string =>
      index[field] === undefined ? '' : (fields[index[field]!] ?? '');

    const repoCell = at('repo');
    const login = ownerOf(repoCell) ?? ownerOf(at('org'));
    if (login === null) {
      rejected.push({ line: offset + 2, text: line.slice(0, 120) });
      continue;
    }

    const key = login.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    const founded = Number.parseInt(at('founded'), 10);
    const bareRepo = repoCell
      .trim()
      .replace(/^(?:https?:\/\/)?(?:www\.)?github\.com\//i, '')
      .replace(/\.git$/i, '')
      .replace(/\/+$/, '');
    const fullName = /^[\w.-]+\/[\w.-]+$/.test(bareRepo) ? bareRepo : null;

    rows.push({
      login,
      repoFullName: fullName,
      funding: at('funding') === '' ? null : at('funding'),
      // Null rather than 0 for an unparseable year, and bounded: GitHub did not exist before 2008 and a
      // founding year in the future is a typo, not a finding.
      foundedYear:
        Number.isInteger(founded) && founded >= 1990 && founded <= 2100 ? founded : null,
    });
  }

  if (rows.length === 0) {
    throw new RossError(
      'No usable rows. Refusing to import rather than recording that nothing is growing.',
    );
  }
  if (rejected.length > rows.length) {
    throw new RossError(
      `${rejected.length} row(s) had no usable owner and only ${rows.length} did. Refusing to import a ` +
        'file this far from the expected shape.',
    );
  }

  return { rows, rejected, columns };
}
