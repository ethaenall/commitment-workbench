// Timing ceilings for the unwired Node backend candidate. Not production.
// Trusted policy may only LOWER these values. commandSliceMs ceiling is 100, not 2000.
export const TIMING_CEILINGS = Object.freeze({
  taskLifetimeMs: 300000,
  startupDeadlineMs: 2000,
  commandSliceMs: 100,
  cumulativeCommandMs: 8000,
});

export function lowerTiming(v = {}) {
  const result = { ...TIMING_CEILINGS };
  for (const [k, n] of Object.entries(v)) {
    if (!Object.hasOwn(result, k)) {
      const err = new Error("INVALID_LIMIT");
      err.code = "INVALID_LIMIT";
      throw err;
    }
    if (!Number.isSafeInteger(n) || n < 1 || n > result[k]) {
      const err = new Error("INVALID_LIMIT");
      err.code = "INVALID_LIMIT";
      throw err;
    }
    result[k] = n;
  }
  return Object.freeze(result);
}
