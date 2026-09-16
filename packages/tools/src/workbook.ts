/**
 * workbook.ts — thin, strict accessors over the master workbook.
 *
 * Everything here exists to make the importer FAIL LOUDLY. A balance importer
 * that silently defaults is worse than no importer at all: the resulting bug is
 * a wrong number in a formula nobody thinks to question.
 *
 * SPEC: spec/07_balance_constants.md §1
 */

import ExcelJS from 'exceljs';

export type Cell = string | number | null;

export class Sheet {
  constructor(
    readonly name: string,
    /** rows[r][c], 0-indexed, with trailing blanks trimmed off each row */
    readonly rows: Cell[][],
  ) {}

  /** Raw cell by 0-indexed row/col. Out of range is `null`, never a throw. */
  at(r: number, c: number): Cell {
    return this.rows[r]?.[c] ?? null;
  }

  /** A cell that MUST be a finite number. Anything else fails the build. */
  num(r: number, c: number, what: string): number {
    const v = this.at(r, c);
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      throw new ImportError(
        `${this.name}!R${r + 1}C${c + 1} (${what}) is ${JSON.stringify(v)}; expected a finite number`,
      );
    }
    return v;
  }

  /** A cell that MUST be a non-empty string. */
  str(r: number, c: number, what: string): string {
    const v = this.at(r, c);
    if (typeof v === 'number') return String(v);
    if (typeof v !== 'string' || v.trim() === '') {
      throw new ImportError(
        `${this.name}!R${r + 1}C${c + 1} (${what}) is ${JSON.stringify(v)}; expected text`,
      );
    }
    return v.trim();
  }

  /**
   * Find the row whose column `c` equals `label`, and return the number in
   * column `valueCol`. Used for the workbook's many label/value pairs, so that
   * inserting a row above them does not silently shift the import.
   */
  labelled(label: string, labelCol: number, valueCol: number): { value: number; ref: string } {
    for (let r = 0; r < this.rows.length; r++) {
      const v = this.at(r, labelCol);
      if (typeof v === 'string' && v.trim() === label) {
        return {
          value: this.num(r, valueCol, label),
          ref: `${this.name}!R${r + 1}C${valueCol + 1}`,
        };
      }
    }
    throw new ImportError(`${this.name}: no row labelled ${JSON.stringify(label)} in column ${labelCol + 1}`);
  }

  /**
   * Find the row whose column `col` equals `label`, and return the number in
   * the SAME column one row below. The workbook uses this vertical layout for
   * its calibration constants (`Time constant K (h)` and its value beneath it).
   */
  labelledBelow(label: string, col: number): { value: number; ref: string } {
    for (let r = 0; r < this.rows.length; r++) {
      const v = this.at(r, col);
      if (typeof v === 'string' && v.trim() === label) {
        return { value: this.num(r + 1, col, label), ref: `${this.name}!R${r + 2}C${col + 1}` };
      }
    }
    throw new ImportError(`${this.name}: no row labelled ${JSON.stringify(label)} in column ${col + 1}`);
  }

  /** Header-indexed access: returns a column index by exact header text. */
  headerIndex(headerRow: number, header: string): number {
    const row = this.rows[headerRow] ?? [];
    for (let c = 0; c < row.length; c++) {
      if (typeof row[c] === 'string' && (row[c] as string).trim() === header) return c;
    }
    throw new ImportError(
      `${this.name}: header ${JSON.stringify(header)} not found in row ${headerRow + 1}. ` +
        `Found: ${row.map((x) => JSON.stringify(x)).join(', ')}`,
    );
  }

  /** Every data row below `headerRow` that has something in column 0. */
  /**
   * Rows below the header, stopping where the first column runs out.
   *
   * A blank first column ends the table in most of this workbook, so this is
   * the right default — but NOT for a sheet whose first column is merged or
   * carried forward down a block, where it would silently drop every row but
   * the first of each group. Those sheets want `dataRowsSpanning`.
   */
  dataRows(headerRow: number): Cell[][] {
    return this.rows.slice(headerRow + 1).filter((r) => r[0] !== null && r[0] !== '');
  }

  /**
   * Rows below the header, keeping ones whose first column is blank.
   *
   * For tables written the way a person writes them: the group is named once
   * and the remaining rows leave that cell empty. Stops at the first entirely
   * blank row, which is what actually ends such a table.
   *
   * This exists because `dataRows` quietly discarded eleven of every twelve
   * rows of `ArtBrief_Exemplars` — the failure was invisible until a reader
   * counted what it got and refused the short result.
   */
  dataRowsSpanning(headerRow: number): Cell[][] {
    const out: Cell[][] = [];
    for (const r of this.rows.slice(headerRow + 1)) {
      if (r.every((c) => c === null || c === '')) break;
      out.push(r);
    }
    return out;
  }
}

export class ImportError extends Error {
  override name = 'ImportError';
}

export class Workbook {
  private constructor(private readonly sheets: Map<string, Sheet>) {}

  static async load(path: string): Promise<Workbook> {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(path);
    const sheets = new Map<string, Sheet>();
    for (const ws of wb.worksheets) {
      const rows: Cell[][] = [];
      ws.eachRow({ includeEmpty: true }, (row, rowNumber) => {
        const out: Cell[] = [];
        // ExcelJS rows are 1-indexed and sparse; normalise to a dense 0-indexed array.
        for (let c = 1; c <= (ws.columnCount || 0); c++) {
          out[c - 1] = readCell(row.getCell(c));
        }
        rows[rowNumber - 1] = out;
      });
      for (let i = 0; i < rows.length; i++) rows[i] ??= [];
      sheets.set(ws.name, new Sheet(ws.name, rows));
    }
    return new Workbook(sheets);
  }

  /** Fetch a sheet by name. A missing sheet FAILS THE BUILD (spec/07 §1). */
  sheet(name: string): Sheet {
    const s = this.sheets.get(name);
    if (!s) {
      throw new ImportError(
        `workbook is missing required sheet ${JSON.stringify(name)}. Present: ${[...this.sheets.keys()].join(', ')}`,
      );
    }
    return s;
  }

  names(): string[] {
    return [...this.sheets.keys()];
  }
}

/**
 * Read one cell to a plain value.
 *
 * Formula cells are read from the CACHED RESULT, not re-evaluated. ExcelJS
 * omits `result` from `cell.value` when the cached value is 0, which silently
 * turned every zero in the workbook into a null and took a calibration anchor
 * with it — so formula cells go through `cell.result`, where 0 survives.
 *
 * A formula cell with no cached result at all means the workbook was written by
 * a tool that did not evaluate it. That is unrecoverable here and must fail the
 * build rather than default (spec/07 §1).
 */
function readCell(cell: ExcelJS.Cell): Cell {
  if (cell.type === ExcelJS.ValueType.Formula) {
    const r = (cell as unknown as { result?: unknown }).result;
    if (r === undefined) {
      throw new ImportError(
        `${cell.worksheet.name}!${cell.address} holds an uncached formula ` +
          `(${String((cell as unknown as { formula?: string }).formula)}). ` +
          `Re-save the workbook from Excel or LibreOffice so cached values are present.`,
      );
    }
    return normalise(r);
  }
  return normalise(cell.value);
}

function normalise(v: unknown): Cell {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return v;
  if (typeof v === 'string') return v;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    // Formula cells carry {formula, result}; we want the cached result, which is
    // why the workbook must be saved by Excel/LibreOffice with values present.
    if ('result' in o) return normalise(o['result']);
    if ('richText' in o && Array.isArray(o['richText'])) {
      return (o['richText'] as { text: string }[]).map((t) => t.text).join('');
    }
    if ('text' in o) return normalise(o['text']);
    if ('error' in o) return null;
  }
  return null;
}
