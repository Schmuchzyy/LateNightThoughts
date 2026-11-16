// Free "demo mode" endpoint for Late Night Thoughts.
//
// The browser sends { mode: 'thought' | 'week', text } and gets the reply back
// as a plain-text stream. The Gemini key lives only in the GEMINI_API_KEY
// environment variable on the server; it is never sent to the browser.
//
// Environment variables
//   GEMINI_API_KEY   required. A Google AI Studio key.
//   DEMO_MODELS      optional. Comma-separated fallback list; when one model is
//                    out of quota or unavailable the next one is tried.
//   ALLOWED_ORIGINS  optional. Comma-separated extra origins allowed to call this.
//   DEMO_MOCK        optional. "1" streams a canned reply (local dev only).

const DEFAULT_MODELS = ['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite', 'gemini-2.5-flash-lite'];

const PROMPTS = {
  thought:
    'You are a calm, grounded late night friend. The user is sharing a thought with you. ' +
    'Respond thoughtfully and honestly in 2-4 sentences. No toxic positivity, no hype. Just real, warm, human.',
  week:
    'You are a calm, grounded late night friend. The user is sharing the notes they saved over the past week, ' +
    'oldest first. Reflect back what you notice in 4-6 sentences: recurring themes, what seems to matter to them, ' +
    'and one gentle question to sit with. No toxic positivity, no hype, no bullet points. Just real, warm, human.',
};

const MAX_CHARS = { thought: 2000, week: 8000 };
const MAX_OUTPUT_TOKENS = 800;

// Best-effort per-IP limits. Memory is per function instance, so this is a
// first line of defence; a Vercel WAF rate-limit rule backs it up at the edge.
const PER_MINUTE = 8;
const PER_DAY = 40;
const hits = new Map(); // ip -> { minute: number[], day: string, dayCount: number }

function rateLimit(ip) {
  const now = Date.now();
  const today = new Date(now).toISOString().slice(0, 10);
  let h = hits.get(ip);
  if (!h || h.day !== today) h = { minute: [], day: today, dayCount: 0 };
  h.minute = h.minute.filter(t => now - t < 60_000);
  if (h.minute.length >= PER_MINUTE) return { ok: false, retryAfter: 60 - Math.floor((now - h.minute[0]) / 1000) };
  if (h.dayCount >= PER_DAY) return { ok: false, retryAfter: 3600, daily: true };
  h.minute.push(now);
  h.dayCount++;
  hits.set(ip, h);
  if (hits.size > 5000) hits.delete(hits.keys().next().value); // keep memory bounded
  return { ok: true };
}

// Lets the test suite start each case with a clean slate.
export function _resetRateLimit() { hits.clear(); }

function json(status, body, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...extraHeaders },
  });
}

function originAllowed(request) {
  const origin = request.headers.get('origin');
  if (!origin) return true; // non-browser clients still hit the rate limit
  const host = request.headers.get('x-forwarded-host') || request.headers.get('host');
  try {
    if (new URL(origin).host === host) return true;
  } catch { return false; }
  const extra = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
  return extra.includes(origin);
}

function models() {
  const list = (process.env.DEMO_MODELS || '').split(',').map(s => s.trim()).filter(Boolean);
  return list.length ? list : DEFAULT_MODELS;
}

// GET tells the page whether demo mode is available, without revealing anything else.
export function GET() {
  const enabled = Boolean(process.env.GEMINI_API_KEY) || process.env.DEMO_MOCK === '1';
  return json(200, { enabled });
}

export async function POST(request) {
  if (!originAllowed(request)) return json(403, { error: 'This endpoint only serves the Late Night Thoughts page.' });

  const ip = (request.headers.get('x-forwarded-for') || '').split(',')[0].trim()
    || request.headers.get('x-real-ip') || 'unknown';
  const limit = rateLimit(ip);
  if (!limit.ok) {
    return json(429, {
      error: limit.daily
        ? "That's a lot of thinking for one day. The free demo is done for you until tomorrow. You can add your own key in Settings to keep going."
        : 'Slow down a little. Try again in a minute.',
    }, { 'Retry-After': String(limit.retryAfter) });
  }

  let body;
  try { body = await request.json(); } catch { return json(400, { error: 'Invalid request.' }); }
  const mode = body?.mode === 'week' ? 'week' : 'thought';
  const text = typeof body?.text === 'string' ? body.text.trim() : '';
  if (!text) return json(400, { error: 'Nothing to reflect on yet.' });
  if (text.length > MAX_CHARS[mode]) {
    return json(413, { error: `That's a bit long for the free demo (max ${MAX_CHARS[mode].toLocaleString('en-US')} characters).` });
  }

  if (process.env.DEMO_MOCK === '1') return mockStream(mode);

  const key = process.env.GEMINI_API_KEY;
  if (!key) return json(503, { error: "The free demo isn't set up on this deployment. Add your own key in Settings." });

  let lastStatus = 0;
  for (const model of models()) {
    let res;
    try {
      res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
          body: JSON.stringify({
            system_instruction: { parts: [{ text: PROMPTS[mode] }] },
            contents: [{ role: 'user', parts: [{ text }] }],
            generationConfig: { maxOutputTokens: MAX_OUTPUT_TOKENS },
          }),
        },
      );
    } catch {
      lastStatus = 502;
      continue;
    }
    if (res.ok && res.body) return streamGemini(res.body, model);
    lastStatus = res.status;
    // Out of quota, unknown model or a temporary outage: try the next model.
    if ([404, 429, 500, 503].includes(res.status)) continue;
    console.error('Gemini error', res.status, await res.text().catch(() => ''));
    return json(502, { error: 'The demo model returned an error. Try again, or add your own key in Settings.' });
  }

  if (lastStatus === 429) {
    return json(429, { error: 'The free demo is resting. It has used its quota for now. Try again later, or add your own key in Settings.' });
  }
  return json(502, { error: "Couldn't reach the demo model right now. Try again in a moment." });
}

// Re-emit Gemini's SSE stream as plain text so the browser can append chunks directly.
function streamGemini(upstream, model) {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = '';
  const stream = new ReadableStream({
    async start(controller) {
      const reader = upstream.getReader();
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop();
          for (const line of lines) {
            if (!line.startsWith('data:')) continue;
            try {
              const parts = JSON.parse(line.slice(5)).candidates?.[0]?.content?.parts || [];
              for (const p of parts) if (p.text && !p.thought) controller.enqueue(encoder.encode(p.text));
            } catch { /* partial or non-JSON line */ }
          }
        }
      } catch (err) {
        console.error('Stream error', err);
      } finally {
        controller.close();
      }
    },
  });
  return new Response(stream, {
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'X-Demo-Model': model },
  });
}

function mockStream(mode) {
  const reply = mode === 'week'
    ? "Looking back at this week, a lot of your notes circle the same quiet worry about not doing enough. There's also a thread of small, good things you noticed and wrote down anyway, which says something about you. You don't have to solve the big question tonight. What would it look like to be a little gentler with yourself next week?"
    : "That sounds like a lot to carry this late at night. It makes sense that it's still turning over in your head; things that matter usually do. You don't need to figure it all out right now. Sometimes just naming it is enough for tonight.";
  const encoder = new TextEncoder();
  const words = reply.split(/(?<= )/);
  const stream = new ReadableStream({
    async start(controller) {
      for (const w of words) {
        controller.enqueue(encoder.encode(w));
        await new Promise(r => setTimeout(r, 25));
      }
      controller.close();
    },
  });
  return new Response(stream, { headers: { 'Content-Type': 'text/plain; charset=utf-8', 'X-Demo-Model': 'mock' } });
}
