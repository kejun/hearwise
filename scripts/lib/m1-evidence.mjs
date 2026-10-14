import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { sourceVersion } from './verification-evidence.mjs';
import { digest } from './verification-evidence.mjs';
import { validateFormalReleaseEvidence } from './formal-release-evidence.mjs';
import { validateProcessReleaseEvidence } from './process-release-evidence.mjs';
import { validateGenerationEvidence } from './generation-protocol-report.mjs';
import { properties as relation } from '../../verification/relation-protocol/properties.mjs';
import { properties as knowledge } from '../../verification/knowledge-protocol/properties.mjs';
import { properties as recovery } from '../../verification/process-crash/properties.mjs';
import { properties as generation } from '../../verification/generation-protocol/properties.mjs';

const definitions = [
  { id: 'relation', issue: 'KEJ-63', properties: relation, validate: (directory, options) => validateFormalReleaseEvidence('relation-protocol', directory, options) },
  { id: 'knowledge', issue: 'KEJ-64', properties: knowledge, validate: (directory, options) => validateFormalReleaseEvidence('knowledge-protocol', directory, options) },
  { id: 'process', issue: 'KEJ-65', properties: recovery, validate: validateProcessReleaseEvidence },
  { id: 'generation', issue: 'KEJ-66', properties: generation, validate: validateGenerationEvidence }
];
export const m1Coverage = Object.freeze(Array.from({ length: 12 }, (_, i) => {
  const acceptance = `AC-P${String(i + 1).padStart(2, '0')}`;
  return { acceptance, requirements: definitions.flatMap(domain => domain.properties.filter(property => property.acceptance.some(value => value.endsWith(` ${acceptance}`)))
    .map(property => ({ domain: domain.id, issue: domain.issue, property: property.id }))) };
}));
// Pure status aggregation never validates a report. The public reader below
// invokes all four domain gates against this checkout before using these rows.
export function summarizeM1(domains) {
  const rows = m1Coverage.map(row => ({ ...row, status: row.requirements.length && row.requirements.every(requirement => domains.find(domain => domain.id === requirement.domain)?.status === 'passed') ? 'passed' : 'incomplete' }));
  return { ok: definitions.every(definition => domains.filter(row => row.id === definition.id && row.status === 'passed').length === 1) && rows.every(row => row.status === 'passed'), rows };
}
export async function validateM1Evidence(directories, options = {}) {
  const startedAt = new Date().toISOString(), source = sourceVersion(), domains = [];
  for (const definition of definitions) {
    const directory = directories[definition.id];
    if (!directory) { domains.push({ id: definition.id, issue: definition.issue, status: 'not_run', reasons: ['missing_directory'] }); continue; }
    try {
      const bytes = await readFile(path.join(directory, 'report.json')), report = JSON.parse(bytes);
      const validation = await definition.validate(directory, options);
      const sameSource = report.source?.sha === source.sha && report.source?.dirty === source.dirty;
      domains.push({ id: definition.id, issue: definition.issue, directory: path.resolve(directory), reportSha256: digest(bytes),
        source: report.source, profile: report.profile, status: sameSource && validation.ok ? 'passed' : !sameSource || validation.reasons.some(reason => reason.includes('stale')) ? 'stale' : 'incomplete',
        reasons: [...(!sameSource ? ['different_target_source'] : []), ...validation.reasons], validation });
    } catch (error) { domains.push({ id: definition.id, issue: definition.issue, status: error.code === 'ENOENT' ? 'not_run' : 'incomplete', reasons: [error.message] }); }
  }
  const summary = summarizeM1(domains);
  return { schemaVersion: 1, specificationVersion: '1.0', source, startedAt, finishedAt: new Date().toISOString(), ...summary, domains,
    boundary: 'AC-P01–P12 in the four declared current-target finite profiles; not unbounded verification, arbitrary supplier behavior, or a deep-profile pass.' };
}
