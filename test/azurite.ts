import { type ChildProcess, spawn } from 'node:child_process';
import { connect, createServer } from 'node:net';
import { fileURLToPath } from 'node:url';

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
}

function portOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect(port, '127.0.0.1');
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => { socket.destroy(); resolve(false); });
  });
}

/** Starts the Azurite storage emulator in memory and returns a connection string for it. */
export async function startAzurite(): Promise<{ connectionString: string; stop: () => void }> {
  const [blobPort, queuePort, tablePort] = [await freePort(), await freePort(), await freePort()];
  // Run Azurite's JavaScript entry with Node directly. The node_modules/.bin shim is a shell
  // script on Linux and a .cmd file on Windows, and spawn() cannot start a .cmd without a shell.
  const entry = fileURLToPath(new URL('../node_modules/azurite/dist/src/azurite.js', import.meta.url));
  const child: ChildProcess = spawn(
    process.execPath,
    [entry, '--inMemoryPersistence', '--silent', '--skipApiVersionCheck', '--loose', '--blobPort', String(blobPort), '--queuePort', String(queuePort), '--tablePort', String(tablePort)],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  // Wait until the table port accepts connections. Recent Azurite versions print nothing at all
  // with --silent, so waiting for a "listening" line on stdout never finishes.
  let seen = '';
  let exited: number | null | undefined;
  const collect = (chunk: Buffer) => { seen += chunk.toString(); };
  child.stdout?.on('data', collect);
  child.stderr?.on('data', collect);
  child.on('exit', (code) => { exited = code; });
  const deadline = Date.now() + 110_000;
  for (;;) {
    if (exited !== undefined) throw new Error(`Azurite exited early with code ${exited}: ${seen}`);
    if (await portOpen(tablePort) && await portOpen(blobPort)) break;
    if (Date.now() > deadline) { child.kill(); throw new Error(`Azurite did not start in time: ${seen}`); }
    await new Promise((r) => setTimeout(r, 250));
  }
  // The account name and key below are the published defaults of the emulator, not secrets.
  const key = 'Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==';
  const connectionString = `DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;AccountKey=${key};BlobEndpoint=http://127.0.0.1:${blobPort}/devstoreaccount1;TableEndpoint=http://127.0.0.1:${tablePort}/devstoreaccount1;`;
  return { connectionString, stop: () => child.kill() };
}
