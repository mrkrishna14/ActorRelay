// Runs on either side of the WSL boundary and reports which addresses reach a service.
// Usage: node probe-network.mjs <port> [<path>] [extra-host ...]
const port = process.argv[2] ?? '8787';
const path = process.argv[3] ?? '/health';
const hosts = ['127.0.0.1', 'localhost', '[::1]', ...process.argv.slice(4)];

console.log(`from ${process.platform} ${process.versions.bun ? `bun ${process.versions.bun}` : `node ${process.version}`}`);
for (const host of hosts) {
  const url = `http://${host}:${port}${path}`;
  const started = performance.now();
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(2500) });
    console.log(`${url} -> ${response.status} in ${Math.round(performance.now() - started)}ms`);
  } catch (error) {
    console.log(`${url} -> FAILED ${error.cause?.code ?? error.name} in ${Math.round(performance.now() - started)}ms`);
  }
}
