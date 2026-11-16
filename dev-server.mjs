// Tiny local server: serves index.html and runs api/reflect.js like Vercel would.
//   node dev-server.mjs          uses GEMINI_API_KEY from the environment or .env.local
//   node dev-server.mjs --mock   streams a canned reply, no key needed
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { extname } from 'node:path';

process.chdir(import.meta.dirname);

if (existsSync('.env.local')) {
  for (const line of readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
    if (m && m[2] && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}
if (process.argv.includes('--mock')) process.env.DEMO_MOCK = '1';

const api = await import('./api/reflect.js');
const PORT = Number(process.env.PORT) || 3000;
const PUBLIC = new Set(['index.html', 'sw.js', 'manifest.webmanifest']);
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml', '.png': 'image/png',
};

createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname === '/api/reflect') {
    const handler = api[req.method];
    if (!handler) { res.writeHead(405).end(); return; }
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const request = new Request(url, {
      method: req.method,
      headers: { ...req.headers, 'x-forwarded-for': req.socket.remoteAddress },
      body: req.method === 'POST' ? Buffer.concat(chunks) : undefined,
    });
    const response = await handler(request);
    res.writeHead(response.status, Object.fromEntries(response.headers));
    if (response.body) for await (const c of response.body) res.write(c);
    res.end();
    return;
  }
  const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
  if (PUBLIC.has(file) || /^icons\/[\w.-]+$/.test(file)) {
    try {
      const body = await readFile(file);
      res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
      res.end(body);
      return;
    } catch { /* fall through to 404 */ }
  }
  res.writeHead(404).end('Not found');
}).listen(PORT, () => console.log(`Late Night Thoughts on http://localhost:${PORT}${process.env.DEMO_MOCK === '1' ? ' (mock demo)' : ''}`));
