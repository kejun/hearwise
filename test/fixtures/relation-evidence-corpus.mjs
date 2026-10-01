// Hand-authored semantic outputs for transport/persistence regression. Empty
// outputs are intentional model decisions. These stubs do not measure live-model
// precision, recall, pronoun resolution or qualifier recognition.
export const relationEvidenceCorpus = [
  { name: 'exact direct relationship', text: 'Atlas developed Nova.', predicate: 'developed', accepted: 1, status: 'active' },
  { name: 'node canonical case differs from original surface', text: 'atlas developed Nova.', subjectSurface: 'atlas', predicate: 'developed', accepted: 1, status: 'active' },
  { name: 'multiword canonical spacing differs from original surface', text: 'Atlas  Labs developed Nova.', subject: 'Atlas Labs', subjectSurface: 'Atlas  Labs', predicate: 'developed', accepted: 1, status: 'active' },
  { name: 'canonical apostrophe differs from exact original surface', text: 'Atlas’s Lab developed Nova.', subject: "Atlas's Lab", subjectSurface: 'Atlas’s Lab', predicate: 'developed', accepted: 1, status: 'active' },
  { name: 'development expressed as built', text: 'Atlas built Nova.', predicate: 'developed', accepted: 1, status: 'active' },
  { name: 'release expressed as shipped', text: 'Atlas shipped Nova.', predicate: 'released', accepted: 1, status: 'active' },
  { name: 'Chinese explicit development', text: 'Atlas 研发了 Nova。', predicate: 'developed', accepted: 1 },
  { name: 'Japanese grounded proposal', text: 'Atlas が Nova を作った。', translation: 'Atlas 研发了 Nova。', predicate: 'developed', accepted: 1, status: 'active' },
  { name: 'same ASR segment subject coreference', text: 'Atlas is a company. It launched Nova.', quote: 'It launched Nova.', subjectReference: 'Atlas', predicate: 'released', accepted: 1, status: 'active' },
  { name: 'same ASR segment two named endpoints then subject coreference', text: 'Atlas is a company. Nova is a product. It launched Nova.', quote: 'It launched Nova.', subjectReference: 'Atlas', predicate: 'released', accepted: 1, status: 'active' },
  { name: 'negative fact retains polarity', text: 'Atlas did not develop Nova.', predicate: 'developed', statement: 'Atlas 没有开发 Nova', fields: { polarity: 'negative' }, accepted: 1 },
  { name: 'planned conditional fact retains both qualifications', text: 'If approved, Atlas will develop Nova.', predicate: 'developed', statement: '若获批准，Atlas 将开发 Nova', fields: { modality: 'planned', conditions: 'If approved' }, accepted: 1 },
  { name: 'attribution remains attached to claimed fact', text: 'According to Mira, Atlas developed Nova.', predicate: 'developed', statement: '据 Mira 称，Atlas 开发了 Nova', fields: { attribution: 'According to Mira' }, accepted: 1 },
  { name: 'uncertain fact retains uncertainty', text: 'Atlas may develop Nova.', predicate: 'developed', statement: 'Atlas 可能开发 Nova', fields: { modality: 'uncertain' }, accepted: 1 },
  { name: 'historical fact retains time scope', text: 'In 2020, Atlas developed Nova.', predicate: 'developed', statement: '2020 年 Atlas 开发了 Nova', fields: { time_scope: 'In 2020' }, accepted: 1 },
  { name: 'passive fact retains direction', text: 'Nova was developed by Atlas.', predicate: 'developed', accepted: 1 },
  { name: 'unrelated negation in same ASR segment is isolated', text: 'Atlas developed Nova. Delta did not acquire Echo.', quote: 'Atlas developed Nova.', predicate: 'developed', accepted: 1 },
  { name: 'conflicting translation never makes source affirmative', text: 'Atlas did not develop Nova.', translation: 'Atlas 研发了 Nova。', predicate: 'developed', fields: { polarity: 'negative' }, accepted: 1, status: 'needs_review' },
  { name: 'co-occurrence needs no edge', text: 'Atlas and Nova were mentioned.', accepted: 0 },
  { name: 'liking is not a supported relationship', text: 'Atlas likes Nova.', accepted: 0 },
  { name: 'translation cannot supply a fact absent from source', text: 'Atlas and Nova were mentioned.', translation: 'Atlas 研发了 Nova。', accepted: 0 },
  { name: 'ambiguous reference is omitted', text: 'Atlas and Delta are companies. It launched Nova.',
    extraCandidates: [{ name: 'Delta', label: 'organization' }], accepted: 0 },
  { name: 'unrelated independent facts need no edge', text: 'Atlas is a company. Nova is a product.', accepted: 0 },
];
