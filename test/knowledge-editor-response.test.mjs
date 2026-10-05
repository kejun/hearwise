import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readKnowledgeEditorResponse } from '../public/knowledge-editor.js';

test('HTML proxy errors and missing endpoints expose stage/status instead of browser JSON syntax errors', async () => {
  for (const status of [404, 405, 502, 503, 504]) {
    const response = new Response('<html>private token and proxy error</html>', { status, headers: { 'Content-Type': 'text/html' } });
    await assert.rejects(readKnowledgeEditorResponse(response, 'PATCH'), error => {
      assert.match(error.message, new RegExp(`保存知识修改失败（HTTP ${status}）`));
      assert.doesNotMatch(error.message, /private|token|pattern|SyntaxError|<html>/);
      assert.equal(error.outcomeUnknown, true);
      return true;
    });
  }
  await assert.rejects(readKnowledgeEditorResponse(new Response('Not Found', { status: 404 })), error => {
    assert.match(error.message, /读取知识条目失败.*404.*重启/);
    assert.equal(error.outcomeUnknown, false);
    return true;
  });
});
test('empty, truncated or wrong-shaped successful responses are not mistaken for saved changes', async () => {
  for (const body of ['', '{"item":', '<html>Login required</html>', '{}', 'null', '[]', '{"item":{}}']) {
    await assert.rejects(readKnowledgeEditorResponse(new Response(body), 'PATCH'), error => {
      assert.match(error.message, /HTTP 200/);
      assert.equal(error.outcomeUnknown, true);
      return true;
    });
  }
  await assert.rejects(readKnowledgeEditorResponse(new Response(null, { status: 204 }), 'DELETE'), /HTTP 204/);
});
test('grounding/business failures remain distinct and confirmed rollbacks allow safe retry', async () => {
  const message = '条目引用的原文中找不到这个错误词，请填写原文中的实际写法';
  await assert.rejects(readKnowledgeEditorResponse(Response.json({ error: message }, { status: 400 }), 'PATCH'), error => {
    assert.ok(error.message.includes(message)); assert.equal(error.outcomeUnknown, false); return true;
  });
  await assert.rejects(readKnowledgeEditorResponse(Response.json({ code: 'KNOWLEDGE_EDIT_FAILED', saved: false,
    error: '知识修改失败，原内容未更改，请稍后重试' }, { status: 502 }), 'PATCH'), error => {
    assert.equal(error.outcomeUnknown, false); return true;
  });
  await assert.rejects(readKnowledgeEditorResponse(Response.json({ error: 'gateway failure' }, { status: 502 }), 'PATCH'), error => {
    assert.equal(error.outcomeUnknown, true); return true;
  });
});
test('valid editor contracts and transport failures retain their meaning', async () => {
  const item = { id: 'item', canonical_name: 'OpenAI' };
  const snapshot = { item, revision: 'snapshot', segments: [] };
  assert.deepEqual(await readKnowledgeEditorResponse(Response.json(snapshot)), snapshot);
  assert.deepEqual(await readKnowledgeEditorResponse(Response.json({ item }), 'PATCH'), { item });
  assert.deepEqual(await readKnowledgeEditorResponse(Response.json({ ok: true }), 'DELETE'), { ok: true });
  const error = new DOMException('timeout', 'TimeoutError');
  await assert.rejects(readKnowledgeEditorResponse({ status: 200, text: async () => { throw error; } }), caught => caught === error);
});
