import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const [action, outputDirectory] = process.argv.slice(2);
if (!outputDirectory || (action !== 'configure' && action !== 'notes')) {
  throw new Error('Usage: node scripts/setup.mjs configure|notes OUTPUT_DIRECTORY');
}

const directory = resolve(outputDirectory);
await mkdir(directory, { recursive: true });

if (action === 'configure') {
  const profile = process.env.RUNE_EXAMPLE_PROFILE;
  if (profile !== 'development' && profile !== 'production') {
    throw new Error('RUNE_EXAMPLE_PROFILE must be development or production');
  }
  await writeFile(
    join(directory, 'configuration.json'),
    `${JSON.stringify({ profile }, null, 2)}\n`,
  );
  process.stdout.write('Wrote configuration.json.\n');
} else {
  const note = process.env.RUNE_EXAMPLE_NOTE;
  if (!note) {
    throw new Error('RUNE_EXAMPLE_NOTE must be set');
  }
  await writeFile(join(directory, 'NOTES.txt'), `${note}\n`);
  process.stdout.write('Wrote NOTES.txt.\n');
}
