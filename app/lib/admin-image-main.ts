/**
 * F13: decision logic for the admin «make image main» flow.
 *
 * The database enforces ≤1 main per product via a PARTIAL UNIQUE index
 * on (product_id) WHERE is_main = TRUE, so the executor must apply a
 * demote of the previous main BEFORE the promote of the new one —
 * otherwise the promote fails with 23505.
 *
 * Pure + dependency-free so node:test can exercise every scenario.
 */

export type MainPromotionStep =
  /** Clear the flag on the previous main row (guarded by its own id+product_id). */
  | { op: 'demote-current-main'; id: string }
  /** Apply the whitelisted field patch to the target; includeIsMain adds
   * is_main:true only when the target was not already main. */
  | { op: 'patch-target'; includeIsMain: boolean };

export function planMainPromotion(args: {
  targetIsAlreadyMain: boolean;
  otherMainId: string | null;
}): MainPromotionStep[] {
  // Already main: never churn the main flag (no demote, no redundant
  // is_main write); only requested side-fields may be patched.
  if (args.targetIsAlreadyMain) {
    return [{ op: 'patch-target', includeIsMain: false }];
  }
  const steps: MainPromotionStep[] = [];
  if (args.otherMainId !== null) {
    steps.push({ op: 'demote-current-main', id: args.otherMainId });
  }
  steps.push({ op: 'patch-target', includeIsMain: true });
  return steps;
}
