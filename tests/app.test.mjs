// Static checks on the front end and the repo.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';

const root = join(import.meta.dirname, '..');
const html = readFileSync(join(root, 'index.html'), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];

test('the inline app script is valid JavaScript', () => {
  assert.doesNotThrow(() => new vm.Script(script, { filename: 'index.html' }));
});

test('every provider has a default model and no duplicate suggestions', () => {
  // Evaluate just the provider table in isolation.
  const table = script.slice(script.indexOf('const m = (id, label)'), script.indexOf("const CUSTOM = '__custom__';"));
  const PROVIDERS = new vm.Script(`${table}; PROVIDERS`).runInNewContext({});
  for (const [id, p] of Object.entries(PROVIDERS)) {
    if (id === 'demo' || id === 'custom') continue;
    assert.ok(p.defaultModel, `${id} needs a default model`);
    const ids = p.models.map(x => x.id);
    assert.equal(new Set(ids).size, ids.length, `${id} has duplicate model IDs`);
    assert.ok(p.format === 'anthropic' || p.format === 'gemini' || p.endpoint, `${id} needs an endpoint`);
  }
});

test('every form control has a label', () => {
  const ids = [...html.matchAll(/<(?:input|select|textarea)\b[^>]*\bid="([^"]+)"/g)]
    .map(x => x[1])
    .filter(id => id !== 'importFile');
  for (const id of ids) {
    assert.match(html, new RegExp(`<label[^>]*for="${id}"`), `#${id} has no <label for>`);
  }
});

test('no API keys are committed', () => {
  const patterns = [/AIza[0-9A-Za-z_-]{35}/, /sk-ant-[0-9A-Za-z_-]{20,}/, /sk-(proj-)?[0-9A-Za-z]{32,}/, /gsk_[0-9A-Za-z]{30,}/, /xai-[0-9A-Za-z]{30,}/];
  const skip = new Set(['.git', 'node_modules', '.vercel', 'docs', '.env', '.env.local']);
  const walk = dir => readdirSync(dir).flatMap(name => {
    if (skip.has(name)) return [];
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
  for (const file of walk(root)) {
    const text = readFileSync(file, 'utf8');
    for (const re of patterns) assert.doesNotMatch(text, re, `possible secret in ${file}`);
  }
});
