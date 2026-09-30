import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { ListeningStore } from '../storage.mjs';
import { createSpeechService } from '../speech-service.mjs';
import { speechUnits, transcriptSpeechUnits } from '../speech-scheduler.mjs';
import { SpeechBuffer } from '../public/speech-buffer.js';
import { createSpeechController } from '../public/speech-controller.js';
import { createTranslationScheduler } from '../translation-queue.mjs';
import { speechConfig, TTS_PROMPT_MAX_LENGTH } from '../public/speech-protocol.js';

const config = { key: 'fake-key', region: 'beijing', voice: 'Cherry', rate: 1 };
test('语音 Prompt 兼容旧配置，去除首尾空白，拒绝错误类型和超长指令', () => {
  assert.equal(speechConfig(config).prompt, '');
  assert.equal(speechConfig({ ...config, prompt: ' \n温和、清晰地朗读。\n ' }).prompt, '温和、清晰地朗读。');
  assert.equal(speechConfig({ ...config, prompt: ' \n ' }).prompt, '');
  assert.equal(speechConfig({ ...config, prompt: '字'.repeat(TTS_PROMPT_MAX_LENGTH) }).prompt.length, 500);
  assert.throws(() => speechConfig({ ...config, prompt: '字'.repeat(TTS_PROMPT_MAX_LENGTH + 1) }), /最多 500/);
  for (const prompt of [null, 42, {}, []]) assert.throws(() => speechConfig({ ...config, prompt }), /必须是文本/);
});
const flush = async () => { for (let i = 0; i < 15; i++) await Promise.resolve(); };
class Client extends EventEmitter {
  readyState = 1; bufferedAmount = 0; events = []; packets = [];
  send(data) { if (Buffer.isBuffer(data)) this.packets.push(data); else this.events.push(JSON.parse(data)); }
  message(data) { this.emit('message', Buffer.from(JSON.stringify(data)), false); }
  close() { this.readyState = 3; this.emit('close'); }
}
function fixture(t, options = {}) {
  const store = new ListeningStore(':memory:');
  const run = store.createRun(null, { source: 'en', targetLang: 'Chinese', audioSource: 'tab' }, 'test');
  const spoken = [], heads = new Map(); let closed = 0;
  const service = createSpeechService({ store, setHead: (owner, id) => id ? heads.set(owner, id) : heads.delete(owner),
    createTts: () => ({ async synthesize(text, audio) { spoken.push(text); audio(Buffer.alloc(480)); }, close() { closed++; } }), ...options });
  const client = new Client(); service.accept(client);
  t.after(() => { client.close(); store.db.close(); });
  let sentence = 0;
  const add = (text, original) => {
    const row = store.addSegment(run.listeningId, run.runId, { id: ++sentence, text: original ?? `Source ${sentence}` }).segment;
    if (text) store.setTranslation(row.id, text, false);
    service.notify(run.listeningId); return row;
  };
  const start = () => client.message({ type: 'speech.start', epoch: 7, ...run, config });
  const ack = () => client.message({ type: 'speech.progress', epoch: 7,
    consumedSamples: client.packets.reduce((n, p) => n + p.readUInt32LE(12), 0),
    playedUnit: client.events.filter(e => e.type === 'speech.unit-end').at(-1)?.unit || 0 });
  return { store, run, client, service, add, start, ack, spoken, heads, closed: () => closed };
}

test('final-only watermark excludes historical pending text; reversed translations wait, then speak once in source order', async t => {
  const f = fixture(t); const old = f.add(); f.start();
  f.store.setTranslation(old.id, '旧句不应播报。', false);
  const first = f.add(); f.add('第二句。'); await flush();
  assert.deepEqual(f.spoken, []); assert.equal([...f.heads.values()][0], first.id);
  f.store.setTranslation(first.id, '第一句。', false); f.service.notify(f.run.listeningId); await flush();
  assert.deepEqual(f.spoken, ['第一句。', '第二句。']);
  f.service.notify(f.run.listeningId); await flush(); assert.equal(f.spoken.length, 2);
  assert.equal(f.heads.size, 0);
  assert.equal(f.client.packets[0].readUInt32LE(0), 7);
});

test('lookahead is bounded by played acknowledgement; stop releases resources and does not synthesize queued text', async t => {
  const f = fixture(t); f.start(); f.add('一。二。三。四。五。'); await flush();
  assert.deepEqual(f.spoken, ['一。', '二。']);
  f.ack(); await flush(); assert.deepEqual(f.spoken, ['一。', '二。', '三。', '四。']);
  f.client.message({ type: 'speech.stop' }); f.service.notify(f.run.listeningId); await flush();
  assert.equal(f.spoken.length, 4); assert.equal(f.closed(), 1); assert.equal(f.heads.size, 0);
});

test('drain includes ASR tail and late final translation, finishes only after playback', async t => {
  const f = fixture(t); f.start(); f.client.message({ type: 'speech.drain', epoch: 7 });
  const tail = f.add(); f.store.finishRun(f.run.runId); f.service.notify(f.run.listeningId); await flush();
  assert.equal(f.client.readyState, 1);
  f.store.setTranslation(tail.id, '最后一句。', false); f.service.notify(f.run.listeningId); await flush();
  assert.equal(f.client.readyState, 1); f.ack(); await flush();
  assert.equal(f.client.events.at(-1).type, 'speech.finished'); assert.equal(f.client.readyState, 3);
});

test('explicit replay reads only the selected final segment and then stops', async t => {
  const f = fixture(t); const row = f.add('重播这一句。'); f.add('不要顺带读这句。');
  f.store.finishRun(f.run.runId);
  f.client.message({ type: 'speech.replay', epoch: 7, ...f.run, segmentId: row.id, config }); await flush();
  assert.deepEqual(f.spoken, ['重播这一句。']); f.ack(); await flush();
  assert.equal(f.client.events.at(-1).type, 'speech.finished');
});

for (const mode of ['preview', 'replay']) test(`${mode} 等待首包和播放超过 20 秒不触发实时收尾，仍等待播放回执`, async t => {
  let time = 0, release, calls = 0, closed = 0;
  const firstAudio = new Promise(resolve => { release = resolve; });
  const f = fixture(t, { now: () => time, createTts: () => ({
    async synthesize(_text, audio) { if (++calls === 1) await firstAudio; audio(Buffer.alloc(480)); },
    close() { closed++; }
  }) });
  const row = f.add('需要重新播报的句子。'); f.store.finishRun(f.run.runId);
  f.client.message({ type: `speech.${mode}`, epoch: 7, ...f.run, segmentId: row.id, config }); await flush();
  // Worklet heartbeats keep the player alive while the provider is preparing audio.
  for (time = 5000; time <= 25000; time += 5000) { f.ack(); await flush(); }
  assert.equal(f.client.readyState, 1, 'non-live synthesis must not inherit the 20s drain deadline');
  assert.equal(f.client.packets.length, 0); assert.equal(closed, 0);
  // A late drain message must also be ignored outside live playback.
  f.client.message({ type: 'speech.drain', epoch: 7 });
  for (time = 30000; time <= 60000; time += 5000) { f.ack(); await flush(); }
  assert.equal(f.client.readyState, 1);
  release(); await flush();
  assert.ok(f.client.packets.length > 0); assert.equal(f.client.readyState, 1);
  const generated = f.client.events.filter(e => e.type === 'speech.unit-end').length;
  assert.ok(generated > 0);
  // Audio has been generated, but cannot finish until the player consumes it.
  for (time = 65000; time <= 90000; time += 5000) {
    f.client.message({ type: 'speech.progress', epoch: 7, consumedSamples: 0, playedUnit: 0 }); await flush();
  }
  assert.equal(f.client.readyState, 1); assert.ok(!f.client.events.some(e => e.type === 'speech.error'));
  f.ack(); await flush();
  assert.equal(f.client.events.at(-1).type, 'speech.finished'); assert.equal(closed, 1);
});

test('全文原文跨片段和分页顺序读取，忽略翻译状态，播放超过实时收尾期限仍继续', async t => {
  let time = 0;
  const f = fixture(t, { now: () => time });
  const expected = [];
  for (let i = 0; i < 55; i++) { const row = f.add(); expected.push(row.original_text); }
  f.store.finishRun(f.run.runId);
  const second = f.store.createRun(f.run.listeningId, { source: 'ja', targetLang: 'English', audioSource: 'tab' }, 'next');
  const row = f.store.addSegment(f.run.listeningId, second.runId, { id: 1, text: 'Second run.' }).segment;
  expected.push(row.original_text); f.store.finishRun(second.runId);
  f.client.message({ type: 'speech.transcript', epoch: 7, listeningId: f.run.listeningId, kind: 'original', config });
  await flush();
  assert.equal(f.client.events.find(e => e.type === 'speech.ready').total, 56);
  while (f.client.readyState === 1) { time += 1000; f.ack(); await flush(); }
  assert.ok(time > 20000);
  assert.deepEqual(f.spoken, expected);
  assert.equal(f.client.events.at(-1).message, '原文全文播报完成');
});

test('全文译文从第一句开始，等待未完成句子而不漏读，结束后自动关闭', async t => {
  const f = fixture(t); f.add('第一句。'); const pending = f.add(); f.add('第三句。');
  f.store.finishRun(f.run.runId);
  f.client.message({ type: 'speech.transcript', epoch: 7, listeningId: f.run.listeningId, kind: 'translation', config }); await flush();
  assert.deepEqual(f.spoken, ['第一句。']); assert.match(f.client.events.at(-1).message, /等待第 2 \/ 3 句译文/);
  f.store.setTranslation(pending.id, '第二句。', false); f.service.notify(f.run.listeningId); await flush(); f.ack(); await flush();
  assert.deepEqual(f.spoken, ['第一句。', '第二句。', '第三句。']); f.ack(); await flush();
  assert.equal(f.client.events.at(-1).message, '译文全文播报完成');
});

test('全文译文缺失有等待上限，失败不跳过；活动记录和无效类型不会产生语音', async t => {
  let time = 0; const f = fixture(t, { now: () => time, translationWaitMs: 100 });
  f.add(); f.store.finishRun(f.run.runId);
  f.client.message({ type: 'speech.transcript', epoch: 7, listeningId: f.run.listeningId, kind: 'translation', config }); await flush();
  time = 101; f.service.notify(f.run.listeningId); assert.equal(f.client.readyState, 3);
  assert.match(f.client.events.at(-1).message, /第 1 句译文尚未完成/);
  const failed = fixture(t); const row = failed.add(); failed.store.setTranslation(row.id, null, true); failed.store.finishRun(failed.run.runId);
  failed.client.message({ type: 'speech.transcript', epoch: 7, listeningId: failed.run.listeningId, kind: 'translation', config });
  assert.match(failed.client.events.at(-1).message, /翻译失败/); assert.deepEqual(failed.spoken, []);
  const active = fixture(t); active.add('在听。');
  active.client.message({ type: 'speech.transcript', epoch: 7, listeningId: active.run.listeningId, kind: 'original', config });
  assert.match(active.client.events.at(-1).message, /先停止收听/); assert.deepEqual(active.spoken, []);
  const invalid = fixture(t); invalid.store.finishRun(invalid.run.runId);
  invalid.client.message({ type: 'speech.transcript', epoch: 7, listeningId: invalid.run.listeningId, kind: 'other', config });
  assert.match(invalid.client.events.at(-1).message, /请选择/);
});

test('另一个页面继续收听会停止全文播报，防止新旧内容混入', async t => {
  const f = fixture(t); f.add('旧内容'.repeat(300)); f.store.finishRun(f.run.runId);
  f.client.message({ type: 'speech.transcript', epoch: 7, listeningId: f.run.listeningId, kind: 'translation', config }); await flush();
  f.store.createRun(f.run.listeningId, { source: 'en', targetLang: 'Chinese', audioSource: 'tab' }, 'next');
  f.service.notify(f.run.listeningId); await flush();
  assert.equal(f.client.readyState, 3); assert.equal(f.spoken.length, 2);
  assert.match(f.client.events.at(-1).message, /收听已继续/);
});

for (const kind of ['original', 'translation']) for (const provider of ['qwen', 'fish']) {
  test(`${provider} 全文${kind}长记录按段完整播放，暂停停止前不无限预生成`, async t => {
    const f = fixture(t), original = 'English words without any sentence punctuation '.repeat(35).trim();
    const translation = '“' + '长引号中的全部译文必须被读出来而不是因长度限制被跳过。'.repeat(40) + '”';
    const first = f.add(translation, original), second = f.add('下一条记录。', 'Next record.');
    f.store.finishRun(f.run.runId);
    const input = provider === 'qwen' ? config : { provider: 'fish', key: 'fake-fish-key', referenceId: 'voice', model: 's2.1-pro-free', rate: .5, latency: 'balanced' };
    f.client.message({ type: 'speech.transcript', epoch: 7, listeningId: f.run.listeningId, kind, config: input }); await flush();
    assert.equal(f.spoken.length, 2); assert.equal(f.client.readyState, 1);
    f.client.message({ type: 'speech.pause', epoch: 7 }); f.ack(); await flush();
    assert.equal(f.spoken.length, 2);
    f.client.message({ type: 'speech.resume', epoch: 7 }); await flush();
    let loops = 0;
    while (f.client.readyState === 1 && loops++ < 200) { f.ack(); await flush(); }
    assert.equal(f.client.events.at(-1).type, 'speech.finished');
    const units = f.client.events.filter(e => e.type === 'speech.unit');
    assert.equal(units.filter(e => e.segmentId === first.id).map(e => e.text).join(''), kind === 'original' ? original : translation);
    assert.equal(units.filter(e => e.segmentId === second.id).map(e => e.text).join(''), kind === 'original' ? 'Next record.' : '下一条记录。');
    assert.deepEqual(f.spoken, units.map(e => e.text));
    const firstUnits = units.filter(e => e.segmentId === first.id);
    assert.deepEqual(firstUnits.map(e => e.part), Array.from({ length: firstUnits.length }, (_, i) => i + 1));
    assert.ok(firstUnits.every(e => e.parts === firstUnits.length && e.position === 1 && e.total === 2));
    assert.equal(units.at(-1).position, 2);
  });
}

test('全文分段受 PCM 水位限制，手动停止不会继续生成剩余长文', async t => {
  const spoken = [];
  const f = fixture(t, { createTts: () => ({ async synthesize(text, audio) { spoken.push(text); audio(Buffer.alloc(24000 * 2 * 10)); }, close() {} }) });
  f.add('字'.repeat(3000)); f.store.finishRun(f.run.runId);
  f.client.message({ type: 'speech.transcript', epoch: 7, listeningId: f.run.listeningId, kind: 'translation', config }); await flush();
  assert.equal(spoken.length, 1, '10 seconds of PCM must stop prefetch until the player consumes it');
  f.ack(); await flush(); assert.equal(spoken.length, 2);
  f.client.message({ type: 'speech.stop', epoch: 7 }); f.service.notify(f.run.listeningId); await flush();
  assert.equal(spoken.length, 2); assert.equal(f.client.readyState, 3);
});

test('后一句翻译失败会先播完前一句，不会因预取而截断正在听的内容', async t => {
  const f = fixture(t); f.add('先读完这一句。'); const failed = f.add();
  f.store.setTranslation(failed.id, null, true); f.store.finishRun(f.run.runId);
  f.client.message({ type: 'speech.transcript', epoch: 7, listeningId: f.run.listeningId, kind: 'translation', config }); await flush();
  assert.equal(f.client.readyState, 1); assert.deepEqual(f.spoken, ['先读完这一句。']);
  f.ack(); await flush(); assert.equal(f.client.readyState, 3);
  assert.match(f.client.events.at(-1).message, /第 2 句翻译失败/);
});

test('run completion freezes the tail bound; late callbacks cannot extend drain', async t => {
  const f = fixture(t); f.start(); f.add('边界内。'); await flush();
  f.store.finishRun(f.run.runId); f.service.notify(f.run.listeningId);
  f.add('边界外的迟到事件。'); f.ack(); await flush();
  assert.deepEqual(f.spoken, ['边界内。']);
  assert.equal(f.client.events.at(-1).type, 'speech.finished');
});

test('a forged playback acknowledgement cannot bypass the PCM budget', async t => {
  const f = fixture(t); f.start(); f.add('测试。'); await flush();
  f.client.message({ type: 'speech.progress', epoch: 7, consumedSamples: 0, playedUnit: 1 });
  assert.equal(f.client.readyState, 3); assert.match(f.client.events.at(-1).message, /进度无效/);
});

test('drain timeout stops even during a hung synthesis; failed translations are not skipped silently', async t => {
  let time = 0, rejectTask;
  const f = fixture(t, { now: () => time, drainMs: 20, createTts: () => ({
    synthesize: () => new Promise((_r, reject) => { rejectTask = reject; }), close: () => rejectTask?.(new Error('closed'))
  }) });
  f.start(); const row = f.add(); f.store.setTranslation(row.id, null, true); f.service.notify(f.run.listeningId); await flush();
  assert.match(f.client.events.at(-1).message, /翻译失败/);
  f.store.setTranslation(row.id, '恢复。', false); f.service.notify(f.run.listeningId); await flush();
  f.client.message({ type: 'speech.drain', epoch: 7 }); time = 21; f.service.notify(f.run.listeningId); await flush();
  assert.match(f.client.events.at(-1).message, /收尾等待已结束/); assert.equal(f.client.readyState, 3);
});

test('wrong run, unsupported language/config, stale progress and deletion cannot keep a consumer alive', async t => {
  const f = fixture(t);
  f.client.message({ type: 'speech.start', epoch: 1, ...f.run, runId: 'missing', config });
  assert.equal(f.client.readyState, 3); assert.deepEqual(f.spoken, []);
  let time = 0; const g = fixture(t, { now: () => time, progressTimeoutMs: 10 });
  g.start(); time = 11; g.service.notify(g.run.listeningId); assert.equal(g.client.readyState, 3);
  const h = fixture(t); h.start(); h.service.remove(h.run.listeningId); assert.equal(h.client.readyState, 3);
});

test('暂停保留队列，超过心跳期限仍可继续；在途一句完成后不再生成新句', async t => {
  let time = 0, release;
  const spoken = [];
  const f = fixture(t, { now: () => time, createTts: () => ({
    async synthesize(text, audio) { spoken.push(text); if (spoken.length === 1) await new Promise(resolve => { release = resolve; }); audio(Buffer.alloc(480)); }, close() {}
  }) });
  f.start(); f.add('第一句。第二句。第三句。'); await flush();
  f.client.message({ type: 'speech.pause', epoch: 7 }); release(); await flush();
  assert.deepEqual(spoken, ['第一句。']); assert.equal(f.client.packets.length, 1);
  time = 120000; f.service.notify(f.run.listeningId); await flush();
  assert.equal(f.client.readyState, 1); assert.equal(spoken.length, 1);
  f.client.message({ type: 'speech.resume', epoch: 6 }); await flush(); assert.equal(spoken.length, 1);
  f.client.message({ type: 'speech.resume', epoch: 7 }); await flush();
  assert.deepEqual(spoken, ['第一句。', '第二句。']);
  f.ack(); await flush(); assert.deepEqual(spoken, ['第一句。', '第二句。', '第三句。']);
  assert.ok(!f.client.events.some(e => e.type === 'speech.error'));
});

test('初始化前暂停不生成试听；重复暂停不延长 5 分钟期限，过期继续会释放资源', async t => {
  let time = 0; const f = fixture(t, { now: () => time });
  f.client.message({ type: 'speech.preview', epoch: 7, config, paused: true }); await flush();
  assert.deepEqual(f.spoken, []);
  time = 299000; f.client.message({ type: 'speech.pause', epoch: 7 });
  time = 300001; f.client.message({ type: 'speech.resume', epoch: 7 });
  assert.equal(f.client.readyState, 3); assert.equal(f.closed(), 1); assert.match(f.client.events.at(-1).message, /暂停已超过 5 分钟/);
});

test('暂停时间不消耗收尾或等待翻译预算，删除记录仍立即停止', async t => {
  let time = 0; const f = fixture(t, { now: () => time });
  f.start(); f.add('最后一句。'); await flush();
  f.client.message({ type: 'speech.drain', epoch: 7 });
  f.client.message({ type: 'speech.pause', epoch: 7 });
  time = 60000; f.store.finishRun(f.run.runId); f.service.notify(f.run.listeningId);
  f.client.message({ type: 'speech.resume', epoch: 7 }); f.ack(); await flush();
  assert.equal(f.client.events.at(-1).type, 'speech.finished');
  const g = fixture(t, { now: () => time }); g.add(); g.store.finishRun(g.run.runId);
  g.client.message({ type: 'speech.transcript', epoch: 7, listeningId: g.run.listeningId, kind: 'translation', config });
  g.client.message({ type: 'speech.pause', epoch: 7 });
  time += 60000; g.client.message({ type: 'speech.resume', epoch: 7 }); await flush();
  assert.equal(g.client.readyState, 1);
  g.client.message({ type: 'speech.pause', epoch: 7 }); g.service.remove(g.run.listeningId);
  assert.equal(g.client.readyState, 3); assert.match(g.client.events.at(-1).message, /已删除/);
});

test('speech head gets a bounded priority boost without starving realtime/background work', () => {
  const q = createTranslationScheduler();
  const add = (id, kind) => q.enqueue({ segment: { id }, listeningId: 'l', kind });
  add('old', 'background'); add('new1', 'realtime'); add('new2', 'realtime');
  q.setSpeechHead('reader', 'old'); assert.equal(q.next().segment.id, 'old');
  add('old2', 'background'); q.setSpeechHead('reader', 'old2');
  assert.equal(q.next().segment.id, 'new1'); assert.equal(q.next().segment.id, 'old2');
  q.setSpeechHead('reader', null); assert.equal(q.next().segment.id, 'new2');
});

test('speech units retain numbers, quoted clauses and meaningful text', () => {
  assert.deepEqual(speechUnits('**值是 3.14**，不是 3.1。“不要。拆开！”然后继续。'), ['值是 3.14，不是 3.1。', '“不要。拆开！”然后继续。']);
  assert.deepEqual(speechUnits('你好。再见！'), ['你好。', '再见！']);
  assert.throws(() => speechUnits('字'.repeat(601)), /过长/);
  assert.deepEqual(speechUnits('Dr. Smith works in the U.S. today. It costs 3.14 dollars. Next sentence.'),
    ['Dr. Smith works in the U.S. today.', 'It costs 3.14 dollars.', 'Next sentence.']);
});

test('全文分段不因缺少标点、长引号或未配对括号报错，所有正文保持原序', () => {
  for (const text of ['字'.repeat(5000), 'word '.repeat(700).trim(), '“' + '一段完整的引用。'.repeat(100) + '”', '(' + '没有右括号'.repeat(200), 'x'.repeat(1000)]) {
    const units = transcriptSpeechUnits(text);
    assert.ok(units.length > 1); assert.equal(units.join(''), text);
    assert.ok(units.every(unit => unit.trim() && [...unit].length <= 180));
  }
});

test('全文分段优先段落、句末和词界，保留小数、缩写和 Unicode 字素', () => {
  const paragraphs = '第一段，保留原文。\n第二段，单独播报。';
  assert.deepEqual(transcriptSpeechUnits(paragraphs), ['第一段，保留原文。\n', '第二段，单独播报。']);
  const text = ('Dr. Smith works in the U.S. today. It costs 3.14 dollars. ' + 'words without punctuation ').repeat(30).trim();
  const units = transcriptSpeechUnits(text);
  assert.equal(units.join(''), text);
  assert.deepEqual(units.flatMap(unit => unit.trim().split(/\s+/)), text.split(/\s+/), 'English words must not be split when a word boundary fits');
  const complex = '👨‍👩‍👧‍👦e\u0301𠮷'.repeat(100), clusters = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  const split = transcriptSpeechUnits(complex);
  assert.equal(split.join(''), complex);
  assert.deepEqual(split.flatMap(unit => [...clusters.segment(unit)].map(c => c.segment)), [...clusters.segment(complex)].map(c => c.segment));
});

test('全文分段随语速缩小或放大，较慢 Fish 音色不使用长文本上限', () => {
  for (const text of ['字'.repeat(1200), '1234567890'.repeat(120)]) for (const rate of [.5, 1, 1.1, 1.2, 2]) {
    const units = transcriptSpeechUnits(text, { rate });
    assert.equal(units.join(''), text); assert.ok(units.every(unit => [...unit].length <= Math.floor(60 * rate)));
  }
});

for (const rate of [44100, 48000]) test(`PCM streams resample at ${rate} Hz without gaps or dropped short tail`, () => {
  const pcm = Int16Array.from({ length: 2401 }, (_, i) => Math.round(Math.sin(i / 20) * 20000));
  const buffer = new SpeechBuffer(rate); buffer.begin(1); buffer.push(pcm); buffer.end(1);
  const output = new Float32Array(Math.ceil(pcm.length * rate / 24000)); const events = [];
  buffer.render(output, e => events.push(e));
  assert.equal(buffer.consumedSamples, pcm.length); assert.equal(buffer.playedUnit, 1);
  assert.deepEqual(events.map(e => e.type), ['started', 'played']);
  for (let i = 0; i < output.length - 1; i++) {
    const p = i * 24000 / rate, a = Math.floor(p), frac = p - a;
    const expected = (pcm[a] + (pcm[Math.min(a + 1, pcm.length - 1)] - pcm[a]) * frac) / 32768;
    assert.ok(Math.abs(output[i] - expected) < 1e-5);
  }
  const tail = new SpeechBuffer(rate); tail.begin(1); tail.push(pcm.subarray(0, 5));
  const silence = new Float32Array(128); tail.render(silence); assert.equal(tail.consumedSamples, 0);
  tail.end(1); tail.render(silence); assert.equal(tail.consumedSamples, 5); assert.equal(tail.playedUnit, 1);
});

test('ring resampling position survives packet boundaries and underrun; overflow is explicit', () => {
  const b = new SpeechBuffer(44100); b.begin(1); b.push(new Int16Array(4800).fill(8192));
  const block = new Float32Array(128);
  for (let i = 0; i < 80; i++) b.render(block);
  const consumed = b.consumedSamples; b.render(block); assert.equal(b.consumedSamples, consumed);
  b.push(new Int16Array(2400).fill(8192)); b.end(1);
  for (let i = 0; i < 40; i++) b.render(block);
  assert.equal(b.consumedSamples, 7200); assert.equal(b.playedUnit, 1);
  const small = new SpeechBuffer(48000, 24000, 10); small.begin(1);
  assert.throws(() => small.push(new Int16Array(11)), /已满/);
});

test('controller starts off with no audio/network; stop and run changes reject late events, drain retains output', async () => {
  const sockets = [], players = [], states = [];
  let unlock;
  const c = createSpeechController({ onChange: state => states.push(state), createPlayer: () => {
    const p = { closed: false, unlock: () => new Promise(resolve => { unlock = resolve; }), close() { this.closed = true; } };
    players.push(p); return p;
  }, createSocket: () => {
    const s = new EventTarget(); s.readyState = 1; s.sent = []; s.send = text => s.sent.push(JSON.parse(text)); s.close = () => {};
    sockets.push(s); return s;
  } });
  assert.equal(c.enabled, false); assert.equal(players.length + sockets.length, 0);
  c.setContext({ phase: 'listening', target: 'Chinese', runId: 'r', listeningId: 'l' });
  const starting = c.start(config); c.stop(); unlock(); await starting;
  assert.equal(sockets.length, 0); assert.equal(players[0].closed, true);
  const next = c.start(config); unlock(); await next; sockets[0].dispatchEvent(new Event('open'));
  const epoch = sockets[0].sent[0].epoch;
  c.drain(); c.setContext({ phase: 'idle', target: 'Chinese', runId: 'r', listeningId: 'l' });
  assert.equal(c.enabled, true); assert.equal(players[1].closed, false);
  c.setContext({ phase: 'connecting', target: 'Chinese', runId: 'r', listeningId: 'l' });
  assert.equal(c.enabled, false); assert.equal(players[1].closed, true);
  sockets[0].dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ epoch, type: 'speech.state', message: 'stale' }) }));
  assert.notEqual(states.at(-1).message, 'stale');
});

test('首次等待说明不被缓冲统计覆盖；全文原文允许非中文记录，切换模式先停止旧播放器', async () => {
  const states = [], sockets = [], players = [];
  const c = createSpeechController({ onChange: state => states.push(state), createPlayer: callback => {
    const p = { callback, closed: false, async unlock() {}, close() { this.closed = true; }, begin() {} };
    players.push(p); return p;
  }, createSocket: () => {
    const s = new EventTarget(); s.readyState = 1; s.sent = [];
    s.send = data => s.sent.push(JSON.parse(data)); s.close = () => {}; sockets.push(s); return s;
  } });
  c.setContext({ phase: 'listening', target: 'Chinese', runId: 'run', listeningId: 'record' });
  await c.start(config); sockets[0].dispatchEvent(new Event('open'));
  const epoch = sockets[0].sent[0].epoch;
  const event = data => sockets[0].dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ epoch, ...data }) }));
  event({ type: 'speech.state', state: 'waiting', message: '等待新的完整译文' });
  assert.match(states.at(-1).message, /说话人说完一句/);
  event({ type: 'speech.backlog', estimatedSeconds: 0, waiting: 0 }); assert.match(states.at(-1).message, /说话人说完一句/);
  event({ type: 'speech.ready', incremental: true });
  event({ type: 'speech.state', state: 'waiting', message: '等待新的完整译文' });
  event({ type: 'speech.backlog', estimatedSeconds: 0, waiting: 0 });
  assert.match(states.at(-1).message, /实验性短句/);
  event({ type: 'speech.state', state: 'buffering', message: '正在准备语音' }); assert.match(states.at(-1).message, /第一句语音/);
  event({ type: 'speech.unit', unit: 1, text: '完整译文。' }); players[0].callback({ type: 'started', unit: 1 });
  assert.equal(states.at(-1).message, '正在播报');
  c.setContext({ phase: 'idle', target: 'English', runId: 'run', listeningId: 'record' });
  await c.start(config, { transcript: 'original' }); sockets[1].dispatchEvent(new Event('open'));
  assert.equal(players[0].closed, true); assert.equal(sockets[1].sent[0].type, 'speech.transcript');
  assert.equal(sockets[1].sent[0].kind, 'original');
  const transcriptEpoch = sockets[1].sent[0].epoch;
  for (const data of [{ type: 'speech.ready', total: 3 }, { type: 'speech.unit', unit: 1, text: '原文中的第二小段', position: 1, part: 2, parts: 8 }]) {
    sockets[1].dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ epoch: transcriptEpoch, ...data }) }));
  }
  players[1].callback({ type: 'started', unit: 1 });
  assert.equal(states.at(-1).message, '正在播报原文 · 第 1 / 3 句 · 第 2 / 8 段');
  assert.equal(states.at(-1).reading, '原文中的第二小段');
  c.setContext({ phase: 'idle', target: 'English', runId: 'run', listeningId: 'record' }); assert.equal(c.enabled, true);
  c.setContext({ phase: 'idle', target: 'English', runId: 'other', listeningId: 'other' });
  assert.equal(players[1].closed, true); assert.equal(c.enabled, false);
});
