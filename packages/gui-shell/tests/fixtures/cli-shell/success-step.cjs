const expectedEndpoint = 'https://example.test:8443/a:b';

if (process.argv[2] !== expectedEndpoint || process.argv[3] !== 'following-argument') {
  process.exitCode = 1;
}
