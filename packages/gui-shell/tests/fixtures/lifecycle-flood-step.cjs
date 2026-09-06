const { clearInterval, setInterval } = require('node:timers');

let batch = 0;

const timer = setInterval(() => {
  let lines = '';
  for (let index = 0; index < 100; index += 1) {
    lines += `lifecycle-flood-${batch}-${index}\n`;
  }
  process.stdout.write(lines);
  batch += 1;
}, 10);

process.on('SIGTERM', () => {
  clearInterval(timer);
  process.exit(0);
});
