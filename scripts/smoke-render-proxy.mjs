// End-to-end smoke test of Next.js -> Fastify private-network forwarding.
// Uses a temporary local HTTP upstream; no database or Google credentials.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const upstream = createServer(async (req, res) => {
  if (req.url === '/api/health') {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok: true, service: 'vincent-api' }));
  } else if (req.url === '/api/auth/login' && req.method === 'POST') {
    const parts = [];
    for await (const part of req) parts.push(part);
    res.setHeader('Set-Cookie', 'vincent_session=test; HttpOnly; SameSite=Strict; Path=/');
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ received: JSON.parse(Buffer.concat(parts).toString('utf8')) }));
  } else if (req.url === '/api/reports/transfers?format=pdf') {
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="transfers.pdf"');
    res.end(Buffer.from('%PDF-1.4\nTEST\n'));
  } else {
    res.statusCode = 404;
    res.end();
  }
});

await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
const upstreamPort = upstream.address().port;
const probe = createServer();
await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
const webPort = probe.address().port;
await new Promise(resolve => probe.close(resolve));
const web = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', 'apps/web', '-H', '127.0.0.1', '-p', String(webPort)], {
  cwd: root,
  env: { ...process.env, NODE_ENV: 'production', API_INTERNAL_URL: '', API_INTERNAL_HOSTPORT: `127.0.0.1:${upstreamPort}` },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let logs = '';
web.stdout.on('data', chunk => { logs += chunk.toString(); });
web.stderr.on('data', chunk => { logs += chunk.toString(); });

try {
  let healthy = false;
  for (let i = 0; i < 60; i++) {
    if (web.exitCode !== null) throw new Error(`Next.js exited (${web.exitCode}): ${logs}`);
    try {
      const res = await fetch(`http://127.0.0.1:${webPort}/api/health`);
      if (res.ok && (await res.json()).service === 'vincent-api') { healthy = true; break; }
    } catch { /* Next.js still starting */ }
    await delay(300);
  }
  assert.ok(healthy, `Health route failed: ${logs}`);
  const login = await fetch(`http://127.0.0.1:${webPort}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ login: '0912345678', password: 'example-password' }),
  });
  assert.equal(login.status, 200);
  assert.match(login.headers.get('set-cookie') ?? '', /vincent_session=test/);
  assert.equal((await login.json()).received.login, '0912345678');
  const pdf = await fetch(`http://127.0.0.1:${webPort}/api/reports/transfers?format=pdf`);
  assert.equal(pdf.status, 200);
  assert.match(pdf.headers.get('content-disposition') ?? '', /transfers\.pdf/);
  assert.equal(Buffer.from(await pdf.arrayBuffer()).toString(), '%PDF-1.4\nTEST\n');
  console.info('OK: /api/health, POST body, Set-Cookie, query string and PDF binary forwarding');
} finally {
  web.kill();
  upstream.close();
  if (web.exitCode === null) await Promise.race([once(web, 'exit'), delay(2500)]);
}
