/**
 * "Did you mean …?" — the nudge that turns a rejection into a fix.
 *
 * Used wherever RUNE refuses a name an author wrote: an unknown manifest key, a `${...}`
 * reference that resolves to nothing, later an unknown `--set` key.
 */

/** Closest candidate within a small edit distance, or nothing if none is close enough. */
export function suggest(name: string, candidates: Iterable<string>): string | undefined {
  const written = name.toLowerCase();
  // Short names need a closer match: at two edits, "cwd" is as far from "env" as from anything.
  const limit = name.length <= 4 ? 1 : 2;

  let best: string | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (const candidate of candidates) {
    // Never suggest the name the author already wrote — it is valid *somewhere else*, and
    // "did you mean windows?" about `windows:` reads like a broken tool. Compared exactly:
    // a name that differs only in case is a real mistake and deserves the hint.
    if (candidate === name) {
      return undefined;
    }
    const lowered = candidate.toLowerCase();
    // The difference in length is a lower bound on the edit distance, so a candidate this
    // far off can never be close enough and never needs the matrix.
    if (Math.abs(lowered.length - written.length) > limit) {
      continue;
    }
    const distance = editDistance(written, lowered);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = candidate;
    }
  }

  return bestDistance <= limit ? best : undefined;
}

/** Levenshtein distance, one row at a time. */
function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_unused, index) => index);

  for (let i = 1; i <= a.length; i++) {
    const current = [i, ...Array.from<number>({ length: b.length }).fill(0)];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(
        (current[j - 1] ?? 0) + 1,
        (previous[j] ?? 0) + 1,
        (previous[j - 1] ?? 0) + cost,
      );
    }
    previous = current;
  }

  return previous[b.length] ?? Math.max(a.length, b.length);
}
