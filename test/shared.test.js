import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { extractOutputText, priceValue, problemFrom, publicTool, readJson, recommend, sanitizeDiagnosis } from '../functions/api/_shared.js';

const tools = JSON.parse(await readFile(new URL('../data/tools.json', import.meta.url), 'utf8'));

test('problemFrom maps starter prompts to the expected bottleneck', () => {
  assert.equal(problemFrom('I am losing leads because I cannot follow up fast enough.'), 'lead-follow-up');
  assert.equal(problemFrom('My estimates and proposals take too long.'), 'slow-estimates');
  assert.equal(problemFrom('We miss calls and customers cannot reach us.'), 'missed-calls');
  assert.equal(problemFrom('We spend too much time on repetitive admin work.'), 'repetitive-work');
});

test('problemFrom only matches keywords at word starts', () => {
  assert.equal(problemFrom('Access is forbidden and the report is misleading'), 'general');
  assert.equal(problemFrom('Our invoices pile up'), 'bookkeeping');
});

test('priceValue parses prices and treats unknown prices as unaffordable', () => {
  assert.equal(priceValue('$19/mo'), 19);
  assert.equal(priceValue('$1,200/yr'), 1200);
  assert.equal(priceValue('Contact sales'), Infinity);
});

test('recommend returns a diagnosis and top verified matches', () => {
  const result = recommend(tools, { problem: 'We miss calls', industry: 'general', budget: 100 });
  assert.equal(result.problem, 'missed-calls');
  assert.match(result.diagnosis, /missed calls/);
  assert.equal(result.results[0].id, 'tool-reception');
  assert.ok(result.results.length <= 3);
});

test('publicTool strips internal fields', () => {
  const safe = publicTool({ id: 'x', affiliate: true, licenseStatus: 'a', sourceType: 'b', score: 9 });
  assert.deepEqual(safe, { id: 'x' });
  assert.equal(publicTool(undefined), null);
});

test('extractOutputText reads raw Responses API output items', () => {
  const data = { output: [
    { type: 'reasoning', summary: [] },
    { type: 'message', content: [{ type: 'output_text', text: '{"a":' }, { type: 'output_text', text: '1}' }] }
  ] };
  assert.equal(extractOutputText(data), '{"a":1}');
  assert.equal(extractOutputText({ output_text: 'x' }), 'x');
  assert.equal(extractOutputText({}), '');
});

test('sanitizeDiagnosis drops unknown tools and coerces types', () => {
  const out = sanitizeDiagnosis({
    diagnosis: 'Slow follow-up',
    bottlenecks: 'not an array',
    recommendations: [{ toolId: 'tool-crm-lite', why: 'fits', caveats: ['setup time'] }, { toolId: 'made-up' }, null]
  }, tools);
  assert.deepEqual(out.bottlenecks, []);
  assert.equal(out.recommendations.length, 1);
  assert.deepEqual(out.recommendations[0], { toolId: 'tool-crm-lite', why: 'fits', caveats: ['setup time'] });
  assert.throws(() => sanitizeDiagnosis([], tools));
});

test('readJson rejects oversized, malformed and non-object bodies', async () => {
  const req = body => new Request('https://x.test', { method: 'POST', body });
  assert.deepEqual(await readJson(req('{"a":1}')), { a: 1 });
  assert.deepEqual(await readJson(req('')), {});
  await assert.rejects(readJson(req('nope')), /BAD_JSON/);
  await assert.rejects(readJson(req('null')), /BAD_JSON/);
  await assert.rejects(readJson(req('x'.repeat(70 * 1024))), /BODY_TOO_LARGE/);
});
