/**
 * Nebula dashboard server. Serves the static page plus the run artifacts the
 * agents produce (data/run.json, data/summary.json, deployments/testnet.json).
 *
 *   bun run apps/web/src/index.ts   →  http://localhost:4100
 */
import { join } from 'node:path';

const ROOT = new URL('../../..', import.meta.url).pathname;
const PUBLIC_DIR = new URL('../public', import.meta.url).pathname;

async function jsonFile(path: string): Promise<Response> {
  const file = Bun.file(path);
  if (!(await file.exists())) {
    return Response.json({ missing: true }, { status: 404 });
  }
  return new Response(file, { headers: { 'content-type': 'application/json' } });
}

const server = Bun.serve({
  port: Number(process.env.NEBULA_WEB_PORT ?? '4100'),
  fetch(request) {
    const { pathname } = new URL(request.url);
    switch (pathname) {
      case '/':
        return new Response(Bun.file(join(PUBLIC_DIR, 'index.html')));
      case '/api/run':
        return jsonFile(join(ROOT, 'data', 'run.json'));
      case '/api/summary':
        return jsonFile(join(ROOT, 'data', 'summary.json'));
      case '/api/deployments':
        return jsonFile(join(ROOT, 'deployments', 'testnet.json'));
      default:
        return Response.json({ error: 'Not found' }, { status: 404 });
    }
  },
});

console.log(`Nebula dashboard on http://localhost:${server.port}`);
