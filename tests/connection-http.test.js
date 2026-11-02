import test from 'node:test';
import assert from 'node:assert/strict';
const base = process.env.NUBE_TEST_URL;
test('local connection server protects operations', {skip: !base}, async () => {
  const page = await fetch(base);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  const html = await page.text();
  assert.match(html, /Aplicación de terceros no oficial/);
  assert.equal((await fetch(base+'/state')).status,403);
  assert.equal((await fetch(base+'/roundtrip',{method:'POST'})).status,403);
  const token = html.match(/const token="([a-f0-9]{64})"/)[1];
  const state=await fetch(base+'/state',{headers:{'X-Nube-Token':token}});assert.equal(state.status,200);const json=await state.json();assert.equal(json.version,'0.16.2');assert.equal(typeof json.progress.phase,'string');assert.ok(Array.isArray(json.history));assert.ok(Array.isArray(json.conflicts));assert.equal((await fetch(base+'/resolve',{method:'POST',headers:{'X-Nube-Token':token,'Content-Type':'application/json'},body:JSON.stringify({id:'invalid',choice:'remote'})})).status,400);
  assert.equal((await fetch(base+'/state',{headers:{'X-Nube-Token':token,Origin:'https://example.com'}})).status,403);
});
