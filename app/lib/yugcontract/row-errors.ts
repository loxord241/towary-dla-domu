/**
 * Diagnostic collector for per-row import failures.
 *
 * Row-level failures must not fail a batch (checkpointed import), so the
 * ONLY persistent trace is the batch row's last_error column. This collector
 * keeps the FIRST 5 failures (row id + message) and caps the final string so
 * last_error stays bounded. It never decides batch status — status logic
 * lives at the finishBatch/finishContentBatch call sites (unchanged).
 */
const MAX_RECORDED = 5;
const MAX_LAST_ERROR_LENGTH = 2000;

export class RowErrorCollector {
  private readonly items: string[] = [];

  /** Record one row failure; entries beyond the cap are silently dropped. */
  add(rowId: string, message: string): void {
    if (this.items.length >= MAX_RECORDED) return;
    this.items.push(`${rowId}: ${message}`);
  }

  /** null when nothing failed — preserves the errors=0 → last_error=null contract. */
  toLastError(): string | null {
    if (this.items.length === 0) return null;
    const joined = this.items.join('; ');
    if (joined.length <= MAX_LAST_ERROR_LENGTH) return joined;
    return `${joined.slice(0, MAX_LAST_ERROR_LENGTH - 3)}...`;
  }
}
