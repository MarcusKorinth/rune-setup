// @ts-expect-error tsc addresses the compiled file as .cjs; vitest resolves the source
import { invokeBridge } from '../src/preload/index.cts';

/** Drive the real preload decoder after the main reply has passed structured cloning. */
export function throughPreload(
  handler: (...args: unknown[]) => unknown,
): (...args: unknown[]) => Promise<unknown> {
  return (...args) =>
    invokeBridge<unknown>(
      {
        invoke: async () => structuredClone(await handler(...args)),
      },
      'rune:test',
    );
}
