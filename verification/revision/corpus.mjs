// Independent, versioned wire contract. Do not import production field lists.
export const fields = Object.freeze({
  item: ['id', 'listening_id', 'type', 'canonical_name', 'normalized_name', 'dialogue_summary',
    'background_note', 'certainty', 'display_label', 'short_description', 'policy_version', 'content_version',
    'name_override', 'name_override_identity'],
  segments: ['id', 'listening_id', 'run_id', 'sequence_no', 'asr_sentence_id', 'original_text',
    'translation_text', 'translation_state', 'begin_ms', 'end_ms'],
  mentions: ['item_id', 'segment_id', 'surface_text'],
  revisions: ['id', 'item_id', 'action', 'old_value', 'new_value', 'merged_from_id', 'reason'],
  facts: ['id', 'item_id', 'segment_id', 'surface_text', 'content', 'certainty']
});
export const seed = 0x4b454a68;
export const samples = 256;
export const units = text => Array.from({ length: text.length }, (_, i) => text.charCodeAt(i));
export const fromUnits = values => {
  let result = '';
  for (let i = 0; i < values.length; i += 4096) result += String.fromCharCode(...values.slice(i, i + 4096));
  return result;
};
export function transportScalar(value) {
  if (value == null) return { tag: 'null' };
  if (typeof value === 'string') return { tag: 'text', units: units(value) };
  if (typeof value === 'boolean') return { tag: 'boolean', value };
  if (Number.isSafeInteger(value)) return { tag: 'integer', value: Object.is(value, -0) ? 0 : value };
  throw new TypeError('Outside Lean domain: expected nullish, boolean, UTF-16 string, or safe integer');
}
export function transport(snapshot) {
  // Nested collections are separate fields in the tagged AST. Missing/undefined
  // scalar properties remain absent; null has its own explicit tag.
  const row = (value, omitted = []) => Object.entries(value).filter(([key, v]) =>
    !omitted.includes(key) && v !== undefined).map(([key, value]) => [key, transportScalar(value)]);
  return { item: row(snapshot.item, ['aliases', 'mentions', 'revisions', 'facts']),
    aliases: (snapshot.item.aliases || []).map(value => {
      if (typeof value !== 'string') throw new TypeError('Outside Lean domain: aliases must be strings');
      return transportScalar(value);
    }),
    ...Object.fromEntries(['mentions', 'revisions', 'facts'].map(key => [key, (snapshot.item[key] || []).map(value => row(value))])),
    segments: snapshot.segments.map(value => row(value)) };
}
export function referenceJSON(snapshot) {
  const row = (value, names) => Object.fromEntries(names.map(key => [key, value[key] ?? null]));
  const ordered = values => values.map(value => JSON.stringify(value)).sort().map(value => JSON.parse(value));
  return JSON.stringify({ version: 1, item: { ...row(snapshot.item, fields.item),
    aliases: ordered(snapshot.item.aliases || []),
    ...Object.fromEntries(['mentions', 'revisions', 'facts'].map(key => [key,
      ordered((snapshot.item[key] || []).map(value => row(value, fields[key])))])) },
    segments: ordered(snapshot.segments.map(value => row(value, fields.segments))) });
}
export function baseline() {
  const row = names => Object.fromEntries(names.map((name, i) => [name, `${name}-${i}`]));
  return { item: { ...row(fields.item), policy_version: 2, content_version: 1,
    name_override: null, name_override_identity: null, aliases: ['\ue000', '😀', 'same', 'same', 'a', ''],
    mentions: [row(fields.mentions), { ...row(fields.mentions), surface_text: 'second' }],
    revisions: [row(fields.revisions), { ...row(fields.revisions), id: 'second' }],
    facts: [row(fields.facts), { ...row(fields.facts), id: 'second' }] },
    segments: [{ ...row(fields.segments), sequence_no: 1, begin_ms: 0, end_ms: 100 },
      { ...row(fields.segments), id: 'second', sequence_no: 2, begin_ms: -1, end_ms: 200 }] };
}
export function equivalent(snapshot) {
  const out = structuredClone(snapshot);
  const reverse = value => Object.fromEntries(Object.entries({ ...value, future_column: 'ignored', created_at: '2040' }).reverse());
  out.item = reverse({ ...out.item, display_name: 'derived', updated_at: '2040' });
  out.item.aliases = [...(out.item.aliases || [])].reverse();
  for (const key of ['mentions', 'revisions', 'facts']) out.item[key] = [...(out.item[key] || [])].reverse().map(reverse);
  out.segments = out.segments.reverse().map(reverse);
  return out;
}
export function corpus() {
  const cases = [], pairs = [];
  const add = (id, snapshot, group) => { cases.push({ id, group, snapshot }); return cases.length - 1; };
  const base = baseline();
  const empty = { item: { aliases: [], mentions: [], revisions: [], facts: [] }, segments: [] };
  const absent = { item: {}, segments: [] };
  const nullable = { item: { aliases: null, mentions: null, revisions: null, facts: null }, segments: [] };
  add('all-business-fields', base, 'boundary');
  const emptyIndex = add('empty-collections', empty, 'boundary');
  pairs.push([emptyIndex, add('missing-collections', absent, 'boundary')]);
  pairs.push([emptyIndex, add('null-collections', nullable, 'boundary')]);
  for (const [index, value] of [null, undefined, '', false, true, 0, -0, -1, 9007199254740991, -9007199254740991,
    '\u0000\b\t\n\f\r\u001f"\\/', '中文é e\u0301\u2028\u2029', '\ud800', '\udfff', '\ud800x\udc00',
    '\ud800\udc00', '\udbff\udfff', '\ud800\ud800\udc00\udc00', '\uffff', '😀\ue000'].entries()) {
    const snapshot = baseline();
    snapshot.item.background_note = value;
    add(`scalar-${index}`, snapshot, 'boundary');
  }
  // Exercise every UTF-16 code unit, including each unpaired surrogate and
  // controls, in chunks. Separators prevent accidental surrogate pairing.
  const everyUnit = baseline();
  everyUnit.item.aliases = Array.from({ length: 256 }, (_, page) =>
    Array.from({ length: 256 }, (_, i) => String.fromCharCode(page * 256 + i) + 'x').join(''));
  add('every-utf16-unit', everyUnit, 'boundary');
  for (const [group, names] of Object.entries(fields)) for (const name of names) {
    const snapshot = baseline(), row = group === 'item' ? snapshot.item : group === 'segments' ? snapshot.segments[0] : snapshot.item[group][0];
    row[name] = 'business-field-mutation';
    add(`field-${group}-${name}`, snapshot, 'field');
    const omitted = structuredClone(snapshot), nullValue = structuredClone(snapshot);
    const getRow = s => group === 'item' ? s.item : group === 'segments' ? s.segments[0] : s.item[group][0];
    delete getRow(omitted)[name]; getRow(nullValue)[name] = null;
    pairs.push([add(`missing-${group}-${name}`, omitted, 'nullish'), add(`null-${group}-${name}`, nullValue, 'nullish')]);
  }
  let state = seed;
  const random = n => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return (state >>> 0) % n; };
  const values = [null, undefined, '', false, true, 0, -0, -1, 1, 10, 2, 9007199254740991,
    -9007199254740991, '中文', '😀', '\ue000', '\ud800', '\udfff', '\u0000', '"\\\n', 'é', 'e\u0301'];
  const value = () => values[random(values.length)];
  const row = names => Object.fromEntries(names.map(name => [name, value()]));
  for (let i = 0; i < samples; i++) {
    const snapshot = { item: { ...row(fields.item), aliases: Array.from({ length: random(7) }, () => String(value() ?? '')) },
      segments: Array.from({ length: random(5) }, () => row(fields.segments)) };
    for (const key of ['mentions', 'revisions', 'facts']) snapshot.item[key] = Array.from({ length: random(5) }, () => row(fields[key]));
    pairs.push([add(`seeded-${i}`, snapshot, 'seeded'), add(`seeded-${i}-equivalent`, equivalent(snapshot), 'equivalent')]);
  }
  return { cases, pairs };
}
