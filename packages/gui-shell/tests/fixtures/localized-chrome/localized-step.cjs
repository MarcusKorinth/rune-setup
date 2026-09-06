const { setTimeout } = require('node:timers');

process.stdout.write('localized child output\n');

setTimeout(() => undefined, 500);
