// Offline maintainer-only generation from pinned original Git objects.
// CI only reads the frozen JSON; Date/UUID/fetch overrides live in this process.
import crypto from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { pathToFileURL, fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
const repo = fileURLToPath(new URL("..", import.meta.url));
const refs = [
  "6f77c186ff370a1500ab4af7197b44b1b83e3495",
  "0399d2dc3d6e16bf3beb9915231867e2a655b9a5",
  "3ca171a77847cdd0367a2511a3726feba5ed1719",
  "e4d240ef8bc12331ac41fdd1c880c1f97023eb44",
  "e9594026db1142179ca36b0704033079dd7ad28a",
  "0537ae4b93ab1ca30ae399ca78e762bd511260d4",
  "9cfb37985f177b99720499e84b9be6443f677dd4",
  "5f04e008df71d87c0d5860a2f1d14b3890cf5717",
  "e09b8ba8ff2a290a677018b983581a2a9798c140",
  "5bf45e68341c159ceb118cd174a128ccaef93401",
  "fa61faf4b7145af650d78012775d06aa09893de2",
  "b4c10ae1f824c95b62215772a963bcb155bd3179"
];
const git = (args) => execFileSync("git", args, { cwd: repo, encoding: "utf8", timeout: 5e3 });
const hash = (value) => crypto.createHash("sha256").update(value).digest("hex");
const root = await mkdtemp(path.join(tmpdir(), "hearwise-historical-fixtures-"));
const realDate = globalThis.Date, realUuid = crypto.randomUUID, realFetch = globalThis.fetch;
const fixedTime = Date.parse("2026-10-01T12:00:00.000Z");
let counter = 0, version = 0, providerCalls = 0;
crypto.randomUUID = () => `${String(version).padStart(8, "0")}-0000-4000-8000-${String(++counter).padStart(12, "0")}`;
syncBuiltinESMExports();
globalThis.Date = class extends realDate {
  constructor(...args) {
    super(...args.length ? args : [fixedTime]);
  }
  static now() {
    return fixedTime;
  }
};
globalThis.fetch = () => {
  providerCalls++;
  throw new Error("NO_PROVIDER_ALLOWED");
};
const snapshot = (store) => Object.fromEntries(store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(({ name }) => [name, store.db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()]));
const fixtures = [];
try {
  for (const ref of refs) {
    version++;
    counter = 0;
    const commit = git(["rev-parse", ref]).trim();
    const sourceFiles = {}, dir = path.join(root, commit), pending = ["storage.mjs"];
    while (pending.length) {
      const file = pending.pop();
      if (sourceFiles[file]) continue;
      const text = git(["show", `${commit}:${file}`]);
      sourceFiles[file] = hash(text);
      const destination = path.join(dir, file);
      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, text);
      if (/\.(mjs|js)$/.test(file)) for (const match of text.matchAll(/(?:from\s*|new URL\(\s*)['"](\.[^'"]+)['"]/g)) {
        const next = path.posix.normalize(path.posix.join(path.posix.dirname(file), match[1]));
        assert.ok(!next.startsWith("../") && !path.isAbsolute(next));
        pending.push(next);
      }
    }
    const { ListeningStore } = await import(pathToFileURL(path.join(dir, "storage.mjs")));
    const store = new ListeningStore(path.join(dir, "fixture.sqlite"));
    try {
      assert.equal(store.db.prepare("PRAGMA user_version").get().user_version, version);
      const settings = { source: "en", targetLang: "Chinese", audioSource: "microphone" };
      const seed = (label) => {
        const run = store.createRun(null, settings, `v${version} ${label}`);
        const segment = store.addSegment(run.listeningId, run.runId, { id: "source-1", text: "Atlas released Camera, with 17 units.", beginMs: 150, endMs: 2400 }).segment;
        store.setTranslation(segment.id, "Atlas 发布了相机，共17台。", false);
        const items = store.applyKnowledge(run.listeningId, ["Atlas", "Camera"].map((name) => ({ type: name === "Atlas" ? "person" : "term", canonical_name: name, aliases: [name + " alias"], dialogue_summary: `${name} appears in the launch.`, background_note: null, certainty: "clear", decision: "create", existing_item_id: null, correction_reason: null, evidence: [{ segment_id: segment.id, quote: segment.original_text }] })));
        const job = store.createExtractionJob(run.listeningId, [segment]);
        store.markJob(job.id, "running");
        return { ...run, segment, items, job };
      };
      const complete = seed("complete");
      store.markJob(complete.job.id, "complete");
      if (version >= 6) {
        store.enableRelations(complete.listeningId);
        const job = store.beginRelationRequest(store.nextRelationJob(complete.listeningId, { quietMs: 0 }).id), s = job.input.focus_segments[0];
        const result2 = store.commitRelationJob(job.id, { relations: [{ subject_item_id: complete.items[0].id, object_item_id: complete.items[1].id, predicate: "released", statement: s.text, polarity: "positive", modality: "asserted", conditions: null, time_scope: null, attribution: null, status: "active", correction_of: null, supports: [{ segment_id: s.id, source_revision: s.source_revision, start: 0, end: s.text.length, quote: s.text, role: "relation" }] }] });
        assert.equal(result2.accepted, 1);
      }
      store.finishRun(complete.runId);
      const unfinished = seed("unfinished");
      if (version >= 4) {
        const partInput = { focus_refs: [{ segment_id: unfinished.segment.id, start: 0, end: unfinished.segment.original_text.length }] };
        store.initializeKnowledgeParts(unfinished.job.id, [partInput]);
        let part = store.knowledgeCheckpoint(unfinished.job.id).parts[0];
        part = { ...part, phase: "extract_inflight", initial_requests: 1, stats: { requests: 1 }, input_snapshot: store.jobInput(unfinished.job) };
        store.writeKnowledgePart(unfinished.job.id, part);
      }
      const pending2 = store.addSegment(unfinished.listeningId, unfinished.runId, { id: "source-2", text: "Translation remains pending.", beginMs: 2500, endMs: 3e3 }).segment;
      const failed = store.addSegment(unfinished.listeningId, unfinished.runId, { id: "source-3", text: "Translation failed safely.", beginMs: 3100, endMs: 4e3 }).segment;
      store.setTranslation(failed.id, null, true);
      let manual = null;
      if (version >= 10) {
        manual = seed("manual");
        store.markJob(manual.job.id, "complete");
        store.finishRun(manual.runId);
        const item = manual.items[0], snapshot2 = store.knowledgeEditSnapshot(manual.listeningId, item.id), input = { name: "Atlas Prime", source: "Atlas", revision: snapshot2.revision };
        const prepared = store.prepareKnowledgeEdit(manual.listeningId, item.id, input);
        const card = { short_description: "Manually corrected identity", dialogue_summary: "Atlas Prime released Camera.", evidence: [{ segment_id: manual.segment.id, quote: "Atlas Prime released Camera, with 17 units." }], facts: [{ segment_id: manual.segment.id, quote: "Atlas Prime released Camera, with 17 units.", content: "Atlas Prime released 17 units." }] };
        const jobId = version >= 11 ? crypto.randomUUID() : null;
        if (jobId) store.createKnowledgeEditJob(manual.listeningId, item.id, jobId, input);
        store.saveKnowledgeEdit(manual.listeningId, item.id, prepared, card, jobId);
        store.setTranslation(manual.segment.id, "Atlas Prime 发布了相机，共17台。", false);
        if (version >= 11) {
          const waiting = store.knowledgeEditSnapshot(manual.listeningId, item.id);
          store.createKnowledgeEditJob(manual.listeningId, item.id, crypto.randomUUID(), { name: "Atlas Second", source: "Atlas Prime", revision: waiting.revision });
        }
      }
      assert.equal(store.db.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
      assert.deepEqual(store.db.prepare("PRAGMA foreign_key_check").all(), []);
      const schema = store.db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all(), rows = snapshot(store);
      const columns = Object.fromEntries(Object.keys(rows).map((table) => [table, store.db.prepare(`PRAGMA table_info("${table}")`).all()]));
      fixtures.push({ version, commit, sourceFiles, columns, schemaSha256: hash(JSON.stringify(schema)), schema, rows, identities: { complete: { listening: complete.listeningId, run: complete.runId, segment: complete.segment.id, job: complete.job.id }, unfinished: { listening: unfinished.listeningId, run: unfinished.runId, segment: unfinished.segment.id, job: unfinished.job.id, pending: pending2.id, failed: failed.id }, manual: manual ? { listening: manual.listeningId, item: manual.items[0].id, segment: manual.segment.id } : null } });
    } finally {
      store.close();
    }
  }
  const result = { formatVersion: 2, description: "Actual historical schemas and synthetic records generated with each pinned original implementation; no provider calls.", fixedTime: new realDate(fixedTime).toISOString(), node: process.version, sqlite: process.versions.sqlite, providerCalls, fixtures };
  const directory = path.join(repo, "test/fixtures/upgrade"), { fixtures: records, ...metadata } = result;
  const manifest = { manifestVersion: 1, metadata, fixtures: [] };
  for (const fixture of records) {
    const { rows, ...schema } = fixture, entry = { version: fixture.version };
    for (const [kind, value] of Object.entries({ schema, rows })) {
      const filename = `v${fixture.version}.${kind}.json`, bytes = JSON.stringify(value) + "\n";
      await writeFile(path.join(directory, filename), bytes);
      entry[kind] = { path: filename, sha256: hash(bytes) };
    }
    manifest.fixtures.push(entry);
  }
  const output = path.join(directory, "manifest.json");
  await writeFile(output, JSON.stringify(manifest, null, 2) + "\n");
  console.log(JSON.stringify({ output, providerCalls, scope: fixtures.map((x) => ({ version: x.version, tables: Object.keys(x.rows).length, rows: Object.values(x.rows).reduce((n, r) => n + r.length, 0) })) }));
} finally {
  globalThis.Date = realDate;
  crypto.randomUUID = realUuid;
  syncBuiltinESMExports();
  globalThis.fetch = realFetch;
  await rm(root, { recursive: true, force: true });
}
