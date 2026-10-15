// One absolute deadline is passed through stage -> file -> replay -> operation.
// Cleanup is part of that deadline, not a fresh budget after it expires.
export const nameBudgetEnvironment = 'HEARWISE_NAME_DEADLINE_AT';
export function nameDeadlineAt(timeoutMs, parent = process.env[nameBudgetEnvironment]) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error('Invalid name timeout');
  const own = Date.now() + timeoutMs;
  if (parent === undefined || parent === null) return own;
  const parsed = Number(parent);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error('Invalid name parent deadline');
  return Math.min(own, parsed);
}
export function nameRemainingMs(deadlineAt, limitMs, reserveMs = 0) {
  const remaining = Math.min(limitMs, deadlineAt - Date.now() - reserveMs);
  if (!Number.isSafeInteger(remaining) || remaining <= 0) throw new Error('Name absolute deadline exhausted');
  return remaining;
}
