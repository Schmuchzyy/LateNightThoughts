// Tests for the free-demo function. Run with `npm test` (Node's built-in test runner, no dependencies).
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { GET, POST, _resetRateLimit } from '../api/reflect.js';

const realFetch = globalThis.fetch;
const ENV_KEYS = ['GEMINI_API_KEY', 'DEMO_MODELS', 'DEMO_MOCK', 'ALLOWED_ORIGINS'];
let savedEnv;

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.GEMINI_API_KEY = 'test-key';
  _resetRateLimit();
});

afterEach(() => {
  globalThis.fetch = realFetch;
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k];
  }
});

let ipCounter = 0;
function post(body, { ip = `10.0.0.${++ipCounter}`, origin = 'https://lnt.example', host = 'lnt.example' } = {}) {
  const headers = { 'Content-Type': 'application/json', host, 'x-forwarded-for': ip };
  if (origin) headers.origin = origin;
  return POST(new Request('https://lnt.example/api/reflect', {
    method: 'POST',
    headers,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  }));
}

// A Gemini-style server-sent-events response.
function sse(...chunks) {
  const enc = new TextEncoder();
  const body = new ReadableStream({
    start(c) {
      for (const ch of chunks) c.enqueue(enc.encode(ch));
      c.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}
const part = (text, extra = {}) => `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text, ...extra }] } }] })}\n\n`;

test('GET reports whether the demo is configured', async () => {
  assert.deepEqual(await (await GET()).json(), { enabled: true });
  delete process.env.GEMINI_API_KEY;
  assert.deepEqual(await (await GET()).json(), { enabled: false });
});

test('streams Gemini text as plain text, skipping thought parts', async () => {
  let called;
  globalThis.fetch = async (url, init) => {
    called = { url, init };
    return sse(part('hidden reasoning', { thought: true }), part('That sounds '), part('heavy.'));
  };
  const res = await post({ mode: 'thought', text: 'cannot sleep' });
  assert.equal(res.status, 200);
  assert.equal(await res.text(), 'That sounds heavy.');
  assert.equal(res.headers.get('X-Demo-Model'), 'gemini-3.5-flash-lite');
  // Key goes in a header, never in the URL.
  assert.equal(called.init.headers['x-goog-api-key'], 'test-key');
  assert.ok(!called.url.includes('test-key'));
  const sent = JSON.parse(called.init.body);
  assert.match(sent.system_instruction.parts[0].text, /calm, grounded late night friend/);
});

test('uses the week prompt for mode "week"', async () => {
  let sent;
  globalThis.fetch = async (_url, init) => { sent = JSON.parse(init.body); return sse(part('ok')); };
  await (await post({ mode: 'week', text: 'notes' })).text();
  assert.match(sent.system_instruction.parts[0].text, /past week/);
});

test('falls back to the next model when one is out of quota', async () => {
  process.env.DEMO_MODELS = 'model-a, model-b';
  const tried = [];
  globalThis.fetch = async url => {
    tried.push(url.match(/models\/([^:]+)/)[1]);
    return tried.length === 1 ? new Response('{}', { status: 429 }) : sse(part('fallback reply'));
  };
  const res = await post({ text: 'hello' });
  assert.equal(await res.text(), 'fallback reply');
  assert.deepEqual(tried, ['model-a', 'model-b']);
  assert.equal(res.headers.get('X-Demo-Model'), 'model-b');
});

test('says the demo is resting when every model is out of quota', async () => {
  globalThis.fetch = async () => new Response('{}', { status: 429 });
  const res = await post({ text: 'hello' });
  assert.equal(res.status, 429);
  assert.match((await res.json()).error, /resting/);
});

test('does not retry on a non-retryable upstream error', async () => {
  let calls = 0;
  globalThis.fetch = async () => { calls++; return new Response('bad request', { status: 400 }); };
  const res = await post({ text: 'hello' });
  assert.equal(res.status, 502);
  assert.equal(calls, 1);
});

test('rejects empty, oversized and malformed input', async () => {
  globalThis.fetch = async () => assert.fail('should not call Gemini');
  assert.equal((await post({ text: '   ' })).status, 400);
  assert.equal((await post('{not json')).status, 400);
  assert.equal((await post({ text: 'a'.repeat(2001) })).status, 413);
  assert.equal((await post({ mode: 'week', text: 'a'.repeat(8001) })).status, 413);
});

test('blocks requests from other sites', async () => {
  globalThis.fetch = async () => assert.fail('should not call Gemini');
  const res = await post({ text: 'hi' }, { origin: 'https://evil.example' });
  assert.equal(res.status, 403);
});

test('allows extra origins listed in ALLOWED_ORIGINS', async () => {
  process.env.ALLOWED_ORIGINS = 'https://friend.example';
  globalThis.fetch = async () => sse(part('ok'));
  const res = await post({ text: 'hi' }, { origin: 'https://friend.example' });
  assert.equal(res.status, 200);
});

test('rate limits each IP to 8 requests a minute', async () => {
  globalThis.fetch = async () => sse(part('ok'));
  const ip = '192.0.2.50';
  for (let i = 0; i < 8; i++) assert.equal((await post({ text: 'hi' }, { ip })).status, 200);
  const limited = await post({ text: 'hi' }, { ip });
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get('Retry-After')) > 0);
  // A different visitor is unaffected.
  assert.equal((await post({ text: 'hi' }, { ip: '192.0.2.51' })).status, 200);
});

test('returns 503 when no key is configured', async () => {
  delete process.env.GEMINI_API_KEY;
  globalThis.fetch = async () => assert.fail('should not call Gemini');
  assert.equal((await post({ text: 'hi' })).status, 503);
});

test('mock mode streams a canned reply without a key', async () => {
  delete process.env.GEMINI_API_KEY;
  process.env.DEMO_MOCK = '1';
  const res = await post({ text: 'hi' });
  assert.equal(res.status, 200);
  assert.ok((await res.text()).length > 50);
});
