#!/usr/bin/env node
/**
 * Track A harness — result-set comparator (gate A3).
 * Tool-agnostic: no Langfuse imports. Takes two result sets, returns a
 * structured diff. Import this from whatever runner fetches the actual rows.
 *
 * Usage:
 *   import { compareResultSets } from './result-set-diff.mjs'
 *   const result = compareResultSets(expected, actual, { tolerance: 0.5 })
 */

/**
 * Compare two result sets order-insensitively.
 * Rows are matched by their non-numeric key values (dimensions).
 * Numeric measure values are compared within tolerance.
 *
 * @param {object[]} expected  - reference rows from golden set
 * @param {object[]} actual    - rows returned by the agent's cube_query
 * @param {object}   opts
 * @param {number}   opts.tolerance  - max allowed float delta (default 0.5)
 * @returns {{ pass: boolean, matched: number, total: number, mismatches: object[], missing: object[], extra: object[] }}
 */
export function compareResultSets(expected, actual, { tolerance = 0.5 } = {}) {
  const mismatches = [];
  const missing = [];
  const extra = [];

  // Index actual rows by their dimension key for O(n) lookup
  const actualIndex = indexRows(actual);

  for (const expRow of expected) {
    const key = dimensionKey(expRow);
    const actRow = actualIndex.get(key);

    if (!actRow) {
      missing.push({ key, expected: expRow });
      continue;
    }

    const rowMismatches = compareMeasures(expRow, actRow, tolerance);
    if (rowMismatches.length > 0) {
      mismatches.push({ key, expected: expRow, actual: actRow, fields: rowMismatches });
    }

    actualIndex.delete(key);
  }

  // Anything left in actualIndex was not in expected
  for (const [key, row] of actualIndex) {
    extra.push({ key, actual: row });
  }

  const total = expected.length;
  const matched = total - missing.length - mismatches.length;

  return {
    pass: missing.length === 0 && mismatches.length === 0,
    matched,
    total,
    mismatches,
    missing,
    extra,
  };
}

function indexRows(rows) {
  const idx = new Map();
  for (const row of rows) {
    idx.set(dimensionKey(row), row);
  }
  return idx;
}

function dimensionKey(row) {
  // Build a stable key from all non-numeric fields (dimensions)
  return Object.entries(row)
    .filter(([, v]) => typeof v !== 'number')
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join('|');
}

function compareMeasures(exp, act, tolerance) {
  const diffs = [];
  for (const [key, expVal] of Object.entries(exp)) {
    if (typeof expVal !== 'number') continue;
    const actVal = act[key];
    if (actVal === undefined) {
      diffs.push({ field: key, expected: expVal, actual: undefined, delta: null });
    } else if (Math.abs(expVal - actVal) > tolerance) {
      diffs.push({ field: key, expected: expVal, actual: actVal, delta: Math.abs(expVal - actVal) });
    }
  }
  return diffs;
}

/**
 * Format a compareResultSets result for terminal output.
 */
export function formatDiff(caseId, diff) {
  const lines = [];
  const status = diff.pass ? 'PASS' : 'FAIL';
  lines.push(`${status}  ${caseId}  (${diff.matched}/${diff.total} rows matched)`);

  for (const m of diff.mismatches) {
    for (const f of m.fields) {
      lines.push(`  MISMATCH  key=${m.key}  field=${f.field}  expected=${f.expected}  actual=${f.actual}  delta=${f.delta?.toFixed(3) ?? 'n/a'}`);
    }
  }
  for (const m of diff.missing) {
    lines.push(`  MISSING   key=${m.key}`);
  }
  for (const e of diff.extra) {
    lines.push(`  EXTRA     key=${e.key}`);
  }

  return lines.join('\n');
}