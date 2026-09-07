const { setTimeout } = require('node:timers');

process.stdout.write('hello output\n');
setTimeout(() => process.exit(9), 500);
