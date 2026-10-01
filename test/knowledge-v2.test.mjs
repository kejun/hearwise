import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ListeningStore } from '../storage.mjs';
import { parseKnowledgeV2 } from '../knowledge.mjs';

const settings = { source: 'zh', targetLang: 'Chinese', audioSource: 'microphone' };
const item = (name, label, action, quote, segmentId, extra = {}) => ({
  action, type: { person: 'person', organization: 'other', product: 'other', work: 'other',
    method: 'term', event: 'event', place: 'other' }[label], display_label: label,
  canonical_name: name, role: '核心案例', reason: '对理解本段案例有用',
  existing_item_id: null, observed_candidate_id: null, correction_reason: null, aliases: [],
  short_description: `${name}是本段讨论的对象。`, new_information: `讲者介绍了${name}。`,
  certainty: 'clear', evidence: [{ segment_id: segmentId, quote }], ...extra
});

test('阶段 1：柯达只收录两个对象，泛词及不在原文的标题不能新建', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'knowledge-v2-'));
  const store = new ListeningStore(path.join(dir, 'data.sqlite'));
  try {
    const run = store.createRun(null, settings, '柯达');
    const first = store.addSegment(run.listeningId, run.runId, {
      id: 's1', text: '1900 年，伊士曼柯达公司推出了 Brownie 相机。' }).segment;
    const second = store.addSegment(run.listeningId, run.runId, {
      id: 's2', text: '我记得，用它拍一张照片大约只要一美元。' }).segment;
    const job = store.createExtractionJob(run.listeningId, store.extractionRange(run.listeningId));
    assert.equal(job.prompt_version, 2);
    const input = store.jobInput(job);
    const output = { items: [
      item('伊士曼柯达公司', 'organization', 'create', '伊士曼柯达公司推出了 Brownie 相机', first.id,
        { short_description: '1900 年推出 Brownie 相机的公司。', new_information: '讲者称该公司推出了 Brownie 相机。' }),
      item('Brownie 相机', 'product', 'create', '伊士曼柯达公司推出了 Brownie 相机', first.id,
        { short_description: '讲者用它说明摄影产品面向大众。',
          new_information: '讲者称 Brownie 相机于 1900 年推出。' }),
      item('AI', 'method', 'create', '一美元', second.id),
      item('摄影大众化', 'method', 'create', 'Brownie 相机', first.id)
    ] };
    const parsed = parseKnowledgeV2(JSON.stringify(output), input);
    assert.equal(parsed.items.length, 2);
    assert.equal(parsed.rejected.length, 2);
    store.applyKnowledgeV2(run.listeningId, parsed.items);
    const knowledge = store.knowledge(run.listeningId);
    assert.deepEqual(knowledge.map(k => k.canonical_name), ['伊士曼柯达公司', 'Brownie 相机']);
    assert.deepEqual(knowledge.map(k => k.display_label), ['organization', 'product']);
    assert.equal(knowledge[1].facts.length, 1);
    assert.equal(knowledge[1].facts[0].segment_id, first.id);
    store.applyKnowledgeV2(run.listeningId, parsed.items);
    assert.equal(store.knowledge(run.listeningId).length, 2);
    assert.equal(store.knowledge(run.listeningId)[1].facts.length, 1);
    assert.equal(store.knowledge(run.listeningId)[1].content_version, 1);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('待观察可提升且保留早期依据；重复提及不重写正文；同名冲突暂缓', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'knowledge-v2-candidate-'));
  const store = new ListeningStore(path.join(dir, 'data.sqlite'));
  try {
    const run = store.createRun(null, settings, '候选');
    const s1 = store.addSegment(run.listeningId, run.runId, { id: 's1', text: '名单里有 AlphaFold。' }).segment;
    const j1 = store.createExtractionJob(run.listeningId, [s1]);
    store.applyKnowledgeV2(run.listeningId, parseKnowledgeV2(JSON.stringify({ items: [
      item('AlphaFold', 'product', 'observe', 'AlphaFold', s1.id,
        { role: '名单成员', short_description: null, new_information: null })
    ] }), store.jobInput(j1)).items);
    assert.equal(store.knowledge(run.listeningId).length, 0);
    const s2 = store.addSegment(run.listeningId, run.runId, { id: 's2', text: 'AlphaFold 是今天分析的核心系统。' }).segment;
    const j2 = store.createExtractionJob(run.listeningId, [s2]);
    const input = store.jobInput(j2);
    assert.equal(input.observed_candidates[0].canonical_name, 'AlphaFold');
    const promoted = item('AlphaFold', 'product', 'create', 'AlphaFold 是今天分析的核心系统', s2.id,
      { observed_candidate_id: input.observed_candidates[0].id });
    store.applyKnowledgeV2(run.listeningId, parseKnowledgeV2(JSON.stringify({ items: [promoted] }), input).items);
    let [stored] = store.knowledge(run.listeningId);
    assert.deepEqual(stored.mentions.map(m => m.segment_id).sort(), [s1.id, s2.id].sort());
    const s3 = store.addSegment(run.listeningId, run.runId, { id: 's3', text: 'AlphaFold 再次被提及。' }).segment;
    const j3 = store.createExtractionJob(run.listeningId, [s3]);
    const repeat = item('AlphaFold', 'product', 'repeat', 'AlphaFold', s3.id,
      { existing_item_id: stored.id, short_description: null, new_information: null });
    store.applyKnowledgeV2(run.listeningId, parseKnowledgeV2(JSON.stringify({ items: [repeat] }), store.jobInput(j3)).items);
    stored = store.knowledge(run.listeningId)[0];
    assert.equal(stored.content_version, 1);
    assert.equal(stored.facts.length, 1);
    assert.equal(stored.mentions.length, 3);
    const collision = item('AlphaFold', 'product', 'create', 'AlphaFold', s3.id,
      { new_information: '另一同名对象。' });
    store.applyKnowledgeV2(run.listeningId, parseKnowledgeV2(JSON.stringify({ items: [collision] }), store.jobInput(j3)).items);
    assert.equal(store.knowledge(run.listeningId).length, 1);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('旧记录固定 v1，新记录固定 v2，重启后继续收听版本不变', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'knowledge-v2-version-'));
  const filename = path.join(dir, 'data.sqlite');
  try {
    let store = new ListeningStore(filename);
    const old = store.createRun(null, settings, '旧记录');
    store.db.prepare('UPDATE listenings SET knowledge_policy_version=1 WHERE id=?').run(old.listeningId);
    const oldSegment = store.addSegment(old.listeningId, old.runId, { id: 's1', text: 'Maya speaks.' }).segment;
    assert.equal(store.createExtractionJob(old.listeningId, [oldSegment]).prompt_version, 1);
    store.finishRun(old.runId);
    store.close();
    store = new ListeningStore(filename);
    const resumed = store.createRun(old.listeningId, settings, 'ignored');
    const s2 = store.addSegment(old.listeningId, resumed.runId, { id: 's2', text: 'Maya returns.' }).segment;
    assert.equal(store.createExtractionJob(old.listeningId, [s2]).prompt_version, 1);
    const fresh = store.createRun(null, settings, '新记录');
    const s3 = store.addSegment(fresh.listeningId, fresh.runId, { id: 's3', text: 'OpenAI is discussed.' }).segment;
    assert.equal(store.createExtractionJob(fresh.listeningId, [s3]).prompt_version, 2);
    assert.equal(parseKnowledgeV2(JSON.stringify({ items: [
      item('OpenAI', 'organization', 'create', 'OpenAI', s3.id)
    ] }), store.jobInput(store.nextJob(fresh.listeningId))).items.length, 1);
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('新事实递增版本并保留旧事实；无效关联与跨类别关联不能写入', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'knowledge-v2-update-'));
  const store = new ListeningStore(path.join(dir, 'data.sqlite'));
  try {
    const run = store.createRun(null, settings, '增量');
    const s1 = store.addSegment(run.listeningId, run.runId, { id: 's1', text: 'Brownie 相机于 1900 年推出。' }).segment;
    const j1 = store.createExtractionJob(run.listeningId, [s1]);
    store.applyKnowledgeV2(run.listeningId, parseKnowledgeV2(JSON.stringify({ items: [
      item('Brownie 相机', 'product', 'create', s1.original_text, s1.id,
        { new_information: '讲者称 Brownie 相机于 1900 年推出。' })
    ] }), store.jobInput(j1)).items);
    const first = store.knowledge(run.listeningId)[0];
    const s2 = store.addSegment(run.listeningId, run.runId, { id: 's2', text: 'Brownie 相机价格下降了，我记得一张照片约一美元。' }).segment;
    const j2 = store.createExtractionJob(run.listeningId, [s2]);
    const input = store.jobInput(j2);
    const update = item('Brownie 相机', 'product', 'update', s2.original_text, s2.id,
      { existing_item_id: first.id, short_description: '讲者借它讨论摄影价格下降。',
        new_information: '讲者回忆用 Brownie 相机拍一张照片约一美元，待确认。' });
    const parsed = parseKnowledgeV2(JSON.stringify({ items: [update] }), input);
    assert.equal(parsed.rejected.length, 0);
    store.applyKnowledgeV2(run.listeningId, parsed.items);
    store.applyKnowledgeV2(run.listeningId, parsed.items);
    const next = store.knowledge(run.listeningId)[0];
    assert.equal(next.content_version, 2);
    assert.equal(next.facts.length, 2);
    assert.equal(next.facts[0].content, '讲者称 Brownie 相机于 1900 年推出。');
    assert.equal(next.facts[1].certainty, 'clear'); // 原文明确说出，不代表价格已核实
    assert.equal(next.short_description, '讲者借它讨论摄影价格下降。');
    const invalid = parseKnowledgeV2(JSON.stringify({ items: [
      { ...update, existing_item_id: 'missing' },
      { ...update, display_label: 'organization' }
    ] }), input);
    assert.equal(invalid.items.length, 0);
    assert.equal(invalid.rejected.length, 2);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('真实 v1 数据库迁移：旧记录策略为 v1，新记录为 v2', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'knowledge-v1-migration-'));
  const filename = path.join(dir, 'data.sqlite');
  try {
    const legacy = new DatabaseSync(filename);
    legacy.exec(`CREATE TABLE listenings (id TEXT PRIMARY KEY,title TEXT,created_at TEXT,updated_at TEXT);
      CREATE TABLE listening_runs (id TEXT PRIMARY KEY,listening_id TEXT,run_no INTEGER,audio_source TEXT,source_lang TEXT,target_lang TEXT,
        started_at TEXT,ended_at TEXT,state TEXT);
      CREATE TABLE extraction_jobs (id TEXT PRIMARY KEY,listening_id TEXT,from_sequence INTEGER,to_sequence INTEGER,prompt_version INTEGER,
        state TEXT,attempts INTEGER,last_error TEXT,created_at TEXT,updated_at TEXT);
      CREATE TABLE knowledge_items (id TEXT PRIMARY KEY,listening_id TEXT,type TEXT,canonical_name TEXT,normalized_name TEXT,
        dialogue_summary TEXT,background_note TEXT,certainty TEXT,created_at TEXT,updated_at TEXT);
      CREATE TABLE segments (id TEXT PRIMARY KEY,listening_id TEXT,run_id TEXT,sequence_no INTEGER,asr_sentence_id TEXT,original_text TEXT,translation_text TEXT,translation_state TEXT,begin_ms INTEGER,end_ms INTEGER,created_at TEXT);
      CREATE TABLE knowledge_mentions (item_id TEXT,segment_id TEXT,surface_text TEXT,PRIMARY KEY(item_id,segment_id,surface_text));
      CREATE TABLE knowledge_aliases (item_id TEXT,alias TEXT,normalized_alias TEXT,PRIMARY KEY(item_id,normalized_alias));
      CREATE TABLE knowledge_revisions (id TEXT PRIMARY KEY,item_id TEXT,action TEXT,old_value TEXT,new_value TEXT,merged_from_id TEXT,reason TEXT,created_at TEXT);
      INSERT INTO listenings VALUES ('legacy','旧记录','2026-01-01','2026-01-01');
      INSERT INTO knowledge_items VALUES ('k1','legacy','other','旧对象','旧对象','旧摘要',NULL,'clear','2026-01-01','2026-01-01');
      PRAGMA user_version=1;`);
    legacy.close();
    const store = new ListeningStore(filename);
    assert.equal(store.db.prepare('PRAGMA user_version').get().user_version, 9);
    assert.equal(store.db.prepare("SELECT knowledge_policy_version FROM listenings WHERE id='legacy'").get().knowledge_policy_version, 1);
    assert.equal(store.db.prepare("SELECT short_description FROM knowledge_items WHERE id='k1'").get().short_description, '旧摘要');
    const fresh = store.createRun(null, settings, '新记录');
    assert.equal(store.db.prepare('SELECT knowledge_policy_version FROM listenings WHERE id=?').get(fresh.listeningId).knowledge_policy_version, 2);
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
