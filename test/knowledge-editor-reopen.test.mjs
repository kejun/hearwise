import test from 'node:test';
import assert from 'node:assert/strict';
import { createKnowledgeEditor } from '../public/knowledge-editor.js';
import { createNameProtocolFixture } from '../test-support/name-protocol-fixture.mjs';
import { deadline } from '../test-support/lifecycle.mjs';

// Minimal DOM port for the actual editor. Network requests and persisted state
// use the real HTTP server/SQLite fixture; this is not browser layout evidence.
function editorDocument() {
  const controls = new Map(), handlers = new Map();
  const control = id => {
    if (!controls.has(id)) controls.set(id, { value: '', textContent: '', disabled: false, hidden: false, focused: 0,
      focus() { this.focused++; }, select() {}, replaceChildren() {}, append() {}, addEventListener(name, fn) { handlers.set(id + ':' + name, fn); } });
    return controls.get(id);
  };
  const dialog = { open: false, innerHTML: '', setAttribute() {}, addEventListener() {},
    querySelector(selector) { return control(selector); }, querySelectorAll() { return [...controls.values()]; },
    showModal() { this.open = true; }, close() { this.open = false; } };
  return { document: { body: { append() {} }, createElement(tag) { return tag === 'dialog' ? dialog : control(tag); } },
    control, dialog, submit() { handlers.get('form:submit')({ preventDefault() {} }); } };
}
const until = (predicate, label) => deadline(async () => {
  while (!predicate()) await new Promise(resolve => setTimeout(resolve, 5));
}, 5000, label);

test('reopening an uncertain committed name refreshes surrounding views without another write', { timeout: 15000 }, async t => {
  const fixture = await createNameProtocolFixture(), dom = editorDocument(), originalDocument = globalThis.document, originalFetch = globalThis.fetch;
  const initial = fixture.snapshot().item, requests = []; let viewName = initial.canonical_name, refreshed = 0;
  t.after(async () => { globalThis.document = originalDocument; globalThis.fetch = originalFetch; await fixture.close(); });
  globalThis.document = dom.document;
  globalThis.fetch = async (url, options = {}) => {
    const target = new URL(url, fixture.base).href; requests.push({ url: target, method: options.method || 'GET' });
    if (target.endsWith('/name-replacements')) {
      const response = await originalFetch(target, options); assert.equal(response.status, 200);
      assert.equal(fixture.snapshot().item.canonical_name, 'Tibo');
      return new Response('Proxy lost the committed response', { status: 502 });
    }
    if (target.includes('/edits/')) return new Response('Receipt unavailable', { status: 502 });
    return originalFetch(target, options);
  };
  const editor = createKnowledgeEditor({ getId: () => fixture.listeningId, getKey: () => '', onSaved: async id => {
    assert.equal(id, fixture.listeningId); refreshed++; viewName = fixture.snapshot().item.canonical_name;
  } });
  await editor.open(initial); assert.equal(refreshed, 0);
  dom.control('#knowledge-edit-name').value = 'Tibo'; dom.submit();
  await until(() => dom.control('#knowledge-edit-status').textContent.includes('保存结果尚未确认'), 'actual committed response becomes uncertain');
  assert.equal(dom.control('#knowledge-edit-name').value, 'Tibo'); assert.equal(dom.control('#knowledge-edit-save').disabled, true);
  assert.equal(viewName, 'Deebo'); const committedTables = fixture.tables();
  editor.close(); await editor.open(initial);
  assert.equal(dom.control('#knowledge-edit-source').value, 'Tibo'); assert.equal(dom.control('#knowledge-edit-name').value, 'Tibo');
  assert.equal(refreshed, 1); assert.equal(viewName, 'Tibo');
  assert.equal(requests.filter(row => row.method === 'POST').length, 1);
  assert.equal(requests.filter(row => row.url.includes('/edits/')).length, 1);
  assert.deepEqual(fixture.tables(), committedTables);
  editor.close(); await editor.open(fixture.snapshot().item); assert.equal(refreshed, 1);
});

test('a stale open response cannot refresh another listening', async t => {
  const dom = editorDocument(), originalDocument = globalThis.document, originalFetch = globalThis.fetch;
  t.after(() => { globalThis.document = originalDocument; globalThis.fetch = originalFetch; });
  globalThis.document = dom.document;
  let release; const pending = new Promise(resolve => { release = resolve; }); let listening = 'first', refreshed = 0;
  globalThis.fetch = async () => { await pending; return Response.json({ revision: 'a'.repeat(64), item: { id: 'item', canonical_name: 'Tibo' }, segments: [] }); };
  const editor = createKnowledgeEditor({ getId: () => listening, getKey: () => '', onSaved: async () => { refreshed++; } });
  const opening = editor.open({ id: 'item', canonical_name: 'Deebo' }); listening = 'second'; release(); await opening;
  assert.equal(refreshed, 0); assert.equal(dom.control('#knowledge-edit-source').value, 'Deebo');
});

test('view refresh failure retains the successfully read name and permits an explicit save', async t => {
  const dom = editorDocument(), originalDocument = globalThis.document, originalFetch = globalThis.fetch;
  t.after(() => { globalThis.document = originalDocument; globalThis.fetch = originalFetch; });
  globalThis.document = dom.document;
  globalThis.fetch = async () => Response.json({ revision: 'a'.repeat(64), item: { id: 'item', canonical_name: 'Tibo' }, segments: [] });
  let refreshed = 0;
  const editor = createKnowledgeEditor({ getId: () => 'first', getKey: () => '', onSaved: async () => { refreshed++; throw new Error('View unavailable'); } });
  await editor.open({ id: 'item', canonical_name: 'Deebo' });
  assert.equal(refreshed, 1); assert.equal(dom.control('#knowledge-edit-source').value, 'Tibo');
  assert.equal(dom.control('#knowledge-edit-name').value, 'Tibo'); assert.equal(dom.control('#knowledge-edit-save').disabled, false);
  assert.match(dom.control('#knowledge-edit-status').textContent, /已读取最新名称.*页面刷新失败/);
});

test('view refresh settling after a listening switch cannot apply the old editor focus', async t => {
  const dom = editorDocument(), originalDocument = globalThis.document, originalFetch = globalThis.fetch;
  t.after(() => { globalThis.document = originalDocument; globalThis.fetch = originalFetch; });
  globalThis.document = dom.document;
  globalThis.fetch = async () => Response.json({ revision: 'a'.repeat(64), item: { id: 'item', canonical_name: 'Tibo' }, segments: [] });
  let release, entered; const pending = new Promise(resolve => { release = resolve; }), started = new Promise(resolve => { entered = resolve; });
  let listening = 'first';
  const editor = createKnowledgeEditor({ getId: () => listening, getKey: () => '', onSaved: async () => { entered(); await pending; } });
  const opening = editor.open({ id: 'item', canonical_name: 'Deebo' }); await started; listening = 'second'; release(); await opening;
  assert.equal(dom.control('#knowledge-edit-name').focused, 0);
});
