# RUNE engine

The engine loads a YAML workflow, resolves inputs, builds a plan, and executes commands.
The CLI and Electron main process use its `Session` API. The engine does not depend on
either frontend or on Electron.

## Execute a workflow

The current workspace package is `@rune/engine`; public registry delivery and the final
namespace are still being prepared. In a built checkout or an installed local package:

```typescript
import { Session, writeResult } from '@rune/engine';

const resultPath = 'examples/basic/output/result.json';
const session = await Session.open('examples/basic/installer.yaml', {
  mode: 'non-interactive',
  overrides: { profile: 'production' },
  resultDestination: resultPath,
});

const result = await session.execute();
await writeResult(result, resultPath);
process.exitCode = result.exitCode;
```

This example assumes the repository root as the working directory. Hosts handle thrown
errors and delivery failures; use the CLI when you need its complete exit-code and
result-delivery behavior. `resultDestination` checks for a collision with the effective
log path; the host still calls `writeResult` to deliver the returned result.

For a preview, call `session.describe()` instead of `execute()`. Interactive hosts
read `allInputs()` or `pendingInputs()`, submit answers with `setValue()`, and then
plan and execute. An observer passed to `execute()` receives ordered run events;
it must return promptly. `session.cancel()` requests cooperative cancellation.

`manifestJsonSchema()` and `resultJsonSchema()` provide schemas for editor integration
and result consumers. Manifest paths and command paths resolve according to the
[architecture contract](https://github.com/MarcusKorinth/rune-setup/blob/55b7b94a0328deb462672cacf3b0a0b592f98268/docs/architecture.md).

From the repository root, build with `npm run build` and run engine tests with
`npm test -- packages/engine/test`. The [basic workflow](https://github.com/MarcusKorinth/rune-setup/blob/55b7b94a0328deb462672cacf3b0a0b592f98268/examples/basic/README.md)
and [release checks](https://github.com/MarcusKorinth/rune-setup/blob/55b7b94a0328deb462672cacf3b0a0b592f98268/docs/releasing.md) cover practical integration and known
execution limits.

Run observers may return a native Promise. RUNE waits for it before the next event,
so slow consumers apply backpressure to child output. Cancellation still stops the
child, then waits for already accepted output. Throwing or rejecting observers are
contained; other return values are ignored.
