/**
 * Parses an integer environment variable, throwing on malformed values instead
 * of silently falling back — a typo'd setting should fail the boot loudly.
 */
export function toInt(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) {
    throw new Error(`Expected an integer but got "${value}"`);
  }
  return parsed;
}
