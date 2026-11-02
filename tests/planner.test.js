import test from 'node:test';
import assert from 'node:assert/strict';
import { planSync } from '../src/planner.js';
const type = (l,r,b) => planSync(l,r,b).map(x => x.type);
test('first sync merges without deleting', () => {
  assert.deepEqual(type({a:'1'}, {b:'2'}), ['upload','download']);
});
test('same content needs no transfer', () => assert.deepEqual(type({a:'1'},{a:'1'}), []));
test('first sync preserves differing versions', () => assert.deepEqual(type({a:'1'},{a:'2'}), ['conflict']));
test('local change uploads', () => assert.deepEqual(type({a:'2'},{a:'1'},{a:'1'}), ['upload']));
test('remote change downloads', () => assert.deepEqual(type({a:'1'},{a:'2'},{a:'1'}), ['download']));
test('local deletion plans recoverable remote removal', () => {
  const [action] = planSync({}, {a:'1'}, {a:'1'});
  assert.equal(action.type,'delete-remote'); assert.equal(action.recoverable,true);
});
test('remote deletion plans recoverable local removal', () => {
  const [action] = planSync({a:'1'}, {}, {a:'1'});
  assert.equal(action.type,'delete-local'); assert.equal(action.recoverable,true);
});
test('delete against edit is conflict in both directions', () => {
  assert.deepEqual(type({}, {a:'2'}, {a:'1'}), ['conflict']);
  assert.deepEqual(type({a:'2'}, {}, {a:'1'}), ['conflict']);
});
test('concurrent edits conflict', () => assert.deepEqual(type({a:'2'},{a:'3'},{a:'1'}), ['conflict']));
test('both deleted needs no action', () => assert.deepEqual(type({}, {}, {a:'1'}), []));
test('rejects escaping and ambiguous paths', () => {
  for (const p of ['../secret','/secret','a/../b','a//b','a\\b']) assert.throws(() => planSync({[p]:'x'}, {}));
});
