import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { FishTts, FishTtsError } from '../fish-tts.mjs';
import { speechConfig } from '../public/speech-protocol.js';

const config = { provider: 'fish', key: 'fish-test-key', model: 's2.1-pro-free', referenceId: 'voice-test-123', rate: 1.2, latency: 'balanced', style: 'calm' };
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
async function server(t, handler) {
  const requests = [];
  const s = http.createServer(async (req, res) => {
    const parts = []; for await (const part of req) parts.push(part);
    requests.push({ headers: req.headers, body: JSON.parse(Buffer.concat(parts).toString()) });
    handler(req, res, requests.length);
  });
  s.listen(0, '127.0.0.1'); await once(s, 'listening');
  t.after(async () => { s.closeAllConnections(); await new Promise(resolve => s.close(resolve)); });
  return { endpoint: `http://127.0.0.1:${s.address().port}/v1/tts`, requests };
}
test('Fish 配置独立校验，未知模型不能回落到付费模型，千问字段不进入 Fish 配置', () => {
  const c = speechConfig({ ...config, prompt: 'Qwen only', voice: 'Cherry', region: 'beijing' });
  assert.deepEqual(c, config);
  assert.equal(speechConfig({ ...config, style: ' [whispers softly] ' }).style, 'whispers softly');
  for (const patch of [{ provider: 'unknown' }, { key: '' }, { model: 's2.1-pro-fre' }, { referenceId: 'https://fish.audio/voice' },
    { rate: .4 }, { rate: 2.1 }, { latency: 'fastest' }, { style: '[calm] speak extra words' }, { style: 'x'.repeat(121) }]) {
    assert.throws(() => speechConfig({ ...config, ...patch }));
  }
});
test('Fish HTTP 流式 PCM 在请求结束前输出；正确下发模型、音色、语速并保留奇数字节边界', { timeout: 5000 }, async t => {
  const first = deferred(), finish = deferred();
  const f = await server(t, (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'audio/pcm' }); res.write(Buffer.from([1, 0, 2]));
    finish.promise.then(() => res.end(Buffer.from([0, 3, 0])));
  });
  const q = new FishTts(config, { endpoint: f.endpoint }); t.after(() => q.close());
  const chunks = []; let complete = false;
  const result = q.synthesize('朗读正文。', pcm => { chunks.push(pcm); first.resolve(); }).then(r => { complete = true; return r; });
  await first.promise; assert.equal(complete, false); finish.resolve();
  assert.equal((await result).attempts, 1);
  assert.deepEqual(Buffer.concat(chunks), Buffer.from([1, 0, 2, 0, 3, 0]));
  assert.equal(f.requests[0].headers.authorization, 'Bearer fish-test-key');
  assert.equal(f.requests[0].headers.model, 's2.1-pro-free');
  assert.deepEqual(f.requests[0].body, { text: '[calm] 朗读正文。', reference_id: config.referenceId, format: 'pcm', sample_rate: 24000,
    latency: 'balanced', prosody: { speed: 1.2, volume: 0, normalize_loudness: true }, normalize: true });
});
test('Fish 仅在首包前网络中断时重试一次；已播出的部分不会自动重读', { timeout: 5000 }, async t => {
  let response;
  const f = await server(t, (req, res, n) => {
    if (n === 1) return req.socket.destroy();
    res.writeHead(200, { 'Content-Type': 'audio/pcm' });
    if (n === 2) return res.end(Buffer.alloc(8));
    response = res; res.write(Buffer.alloc(8));
  });
  const q = new FishTts(config, { endpoint: f.endpoint }); t.after(() => q.close());
  assert.equal((await q.synthesize('第一句', () => {})).attempts, 2);
  await assert.rejects(q.synthesize('第二句', () => response.destroy()), /连接中断/);
  assert.equal(f.requests.length, 3);
});
test('Fish 停止与超时会中止在途请求，不再产生后续音频', { timeout: 5000 }, async t => {
  const received = deferred(), disconnected = deferred();
  const f = await server(t, (_req, res) => { res.on('close', disconnected.resolve); received.resolve(); });
  const q = new FishTts(config, { endpoint: f.endpoint });
  let frames = 0;
  const pending = assert.rejects(q.synthesize('取消', () => frames++), /关闭/);
  await received.promise; q.close(); await pending; await disconnected.promise;
  assert.equal(frames, 0);
  await assert.rejects(q.synthesize('不能重启旧实例', () => {}), /关闭/);
  const timed = new FishTts(config, { endpoint: f.endpoint, connectTimeoutMs: 60 });
  t.after(() => timed.close());
  await assert.rejects(timed.synthesize('超时', () => {}), error => {
    assert.match(error.message, /超时/); assert.equal(error.diagnostics.code, 'FISH_RESPONSE_TIMEOUT');
    assert.equal(error.diagnostics.stage, 'response'); assert.equal(error.diagnostics.attempts, 1); return true;
  });
  assert.equal(f.requests.length, 2);
});
test('Fish 认证、额度和限流错误不重试；错误正文不能泄露 Key', { timeout: 5000 }, async t => {
  const statuses = [401, 402, 429, 503];
  const f = await server(t, (_req, res, n) => { res.writeHead(statuses[n - 1], { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ message: config.key })); });
  for (const [index, message] of [/Key 无效/, /额度不足/, /请求过于频繁/, /服务繁忙/].entries()) {
    const q = new FishTts(config, { endpoint: f.endpoint }); t.after(() => q.close());
    await assert.rejects(q.synthesize('正文', () => assert.fail('Must not emit PCM')), error => {
      assert.match(error.message, message); assert.ok(!error.message.includes(config.key));
      assert.equal(error.diagnostics.httpStatus, statuses[index]); assert.equal(error.diagnostics.code, 'FISH_HTTP_ERROR');
      assert.equal(error.diagnostics.audioReceived, false); assert.equal(error.diagnostics.attempts, 1); return true;
    });
  }
  assert.equal(f.requests.length, 4);
});

test('Fish 保留 fetch cause / AggregateError 中的安全网络错误码，不输出原始错误或 Key', async t => {
  for (const code of ['ENOTFOUND', 'UND_ERR_CONNECT_TIMEOUT', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'ECONNREFUSED', 'UNRECOGNIZED']) {
    let attempts = 0;
    const q = new FishTts(config, { fetchImpl: async () => {
      attempts++;
      const cause = new AggregateError([Object.assign(new Error(`${config.key}: private text`), { code })]);
      throw new TypeError(`fetch failed ${config.key}`, { cause });
    } });
    t.after(() => q.close());
    await assert.rejects(q.synthesize('private synthesis text', () => {}), error => {
      assert.ok(error instanceof FishTtsError); assert.equal(error.diagnostics.code, 'FISH_NETWORK_ERROR');
      assert.equal(error.diagnostics.networkCode, code === 'UNRECOGNIZED' ? undefined : code);
      assert.equal(error.diagnostics.stage, 'response'); assert.equal(error.diagnostics.attempts, 2);
      assert.equal(error.diagnostics.audioReceived, false); assert.ok(error.diagnostics.elapsedMs >= 0);
      assert.equal(error.cause, undefined); assert.doesNotMatch(error.message + JSON.stringify(error), /fish-test-key|private|UNRECOGNIZED/);
      return true;
    });
    assert.equal(attempts, 2);
  }
});

test('Fish 响应已到但音频流挂起，区分生成超时与等待响应超时', { timeout: 5000 }, async t => {
  const f = await server(t, (_req, res) => { res.writeHead(200, { 'Content-Type': 'audio/pcm' }); res.flushHeaders(); });
  const q = new FishTts(config, { endpoint: f.endpoint, timeoutMs: 100, connectTimeoutMs: 1000 }); t.after(() => q.close());
  await assert.rejects(q.synthesize('正文', () => {}), error => {
    assert.equal(error.diagnostics.code, 'FISH_GENERATION_TIMEOUT'); assert.equal(error.diagnostics.stage, 'audio');
    assert.equal(error.diagnostics.audioReceived, false); assert.equal(error.diagnostics.attempts, 1); return true;
  });
});
test('Fish 拒绝错误格式、空音频与残缺样本；停止输出后不重试', { timeout: 5000 }, async t => {
  const f = await server(t, (_req, res, n) => {
    res.writeHead(200, { 'Content-Type': n === 1 ? 'application/json' : 'audio/pcm' });
    res.end(n === 1 ? '{}' : n === 2 ? Buffer.alloc(0) : Buffer.alloc(3));
  });
  for (let n = 0; n < 3; n++) {
    const q = new FishTts(config, { endpoint: f.endpoint }); t.after(() => q.close());
    await assert.rejects(q.synthesize('正文', () => {}), /PCM 音频|音频不完整/);
  }
  assert.equal(f.requests.length, 3);
});
