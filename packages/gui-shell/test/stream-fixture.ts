/** Successful Writable test double that also settles supplied completion callbacks. */
export function completeWrite(
  _chunk: unknown,
  encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
  callback?: (error?: Error | null) => void,
): boolean {
  const complete = typeof encodingOrCallback === 'function' ? encodingOrCallback : callback;
  complete?.();
  return true;
}
