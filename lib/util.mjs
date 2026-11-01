/** Small async helpers shared by the server and the poller. */

export class TimeoutError extends Error {
  constructor(ms, label = 'operation') {
    super(`${label} timed out after ${Math.round(ms / 1000)}s`);
    this.name = 'TimeoutError';
  }
}

/**
 * Reject if `promise` doesn't settle in time. Prevents a single unreachable
 * listing (or a browser that won't launch) from stalling a whole poll cycle.
 */
export function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError(ms, label)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Random integer between min and max, inclusive. */
export const randInt = (min, max) => Math.floor(min + Math.random() * (max - min + 1));
