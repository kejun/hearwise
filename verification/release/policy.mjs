// Versioned release obligations, not evidence or user-selectable exclusions.
export const policyVersion = 1;
export const specificationVersion = 'hearwise-enhanced-verification-v1.0';
export const groups = Array.from({ length: 15 }, (_, index) => `HW-${String(index + 1).padStart(2, '0')}`);
export const technicalSuites = ['node', 'pilot', 'browser', 'relation-protocol', 'knowledge-protocol', 'revision', 'name-interval', 'import-protocol', 'edit-protocol', 'process-crash', 'quality-offline', 'playback-protocol', 'scheduler', 'semantic-offline', 'import-atomicity', 'name-protocol', 'install-upgrade'];
export const purposes = Object.freeze({
  'foundation-demo': ['relation-protocol', 'revision'],
  pr: technicalSuites,
  release: technicalSuites
});
// All fifteen umbrella requirements remain mandatory. Existing focused reports
// establish their stated sub-properties; none closes an entire umbrella card.
export const fullRequirements = groups.map(group => ({ id: `${group}:complete`, group,
  status: 'adapter_not_registered', reason: 'Full business acceptance requires the remaining child-issue evidence and explicit domain validation.' }));
export const externalRequirements = [
  ['quality-asr', ['HW-01'], 'quality'], ['quality-translation', ['HW-02'], 'quality'],
  ['quality-knowledge', ['HW-04', 'HW-05'], 'quality'], ['quality-relations', ['HW-04', 'HW-05'], 'quality'],
  ['quality-tts', ['HW-08'], 'quality'], ['performance', ['HW-01', 'HW-02', 'HW-03', 'HW-08', 'HW-11', 'HW-13'], 'performance'],
  ['physical-devices', ['HW-01', 'HW-08', 'HW-11', 'HW-14'], 'device'], ['upgrade-recovery', ['HW-09', 'HW-10', 'HW-14'], 'upgrade']
].map(([id, domains, method]) => ({ id, domains, method, validator: null, frozenConfiguration: null,
  automaticPrExecution: false, reason: 'No accepted real measurement and frozen threshold/support configuration is registered on this main baseline.' }));
export const budgets = Object.freeze({
  node: { defaultFileMs: 90000, nestedProfileFileMs: 190000, testMs: 30000, concurrency: 4, plan: 'scripts/lib/test-schedule.mjs#testExecutionPlan' }, browser: { profileMs: 180000 },
  'relation-protocol': { fastMs: 480000, deepMs: 1200000, processMs: 60000, boundedMs: 240000 },
  'knowledge-protocol': { fastMs: 480000, deepMs: 1200000, processMs: 60000, boundedMs: 240000 },
  'import-protocol': { fastMs: 720000, deepMs: 1200000, processMs: 60000, tlcMs: { single: 60000, two_tokens: 240000 }, boundedMs: 240000 },
  'edit-protocol': { overallMs: 480000, tlcMs: 60000, boundedMs: 120000, simulationMs: 30000, witnessMs: 30000, mutationMs: 120000 },
  'process-crash': { fastMs: 480000, deepMs: 1200000, processMs: 60000, boundedMs: 240000 },
  'playback-protocol': { fastMs: 480000, deepMs: 1200000, processMs: 60000, boundedMs: 240000, deepPairAbaMs: 900000 },
  scheduler: { fastMs: 900000, deepMs: 1200000, processMs: 60000, regressionMs: 90000, diagnosticMs: 90000, tlcMs: 'verification/scheduler-protocol/config.json#checks' },
  'install-upgrade': { overallMs: 300000, dataMs: 60000, installMs: 240000 },
  'import-atomicity': { sharedMs: 150000, parentMs: 180000, childMs: 55000 },
  'name-protocol': { overallMs: 480000, tlcMs: 60000, boundedMs: 120000, witnessMs: 30000, simulationMs: 30000, mutationMs: 120000, regressionMs: 90000, stageCleanupMs: 1500, replayMs: 60000, startupMs: 15000, actionMs: 15000, cleanupMs: 5000 },
  'semantic-offline': { paidCalls: 0, syntheticCases: 11, overallMs: 150000 },
  'quality-offline': { paidCalls: 0, syntheticTrials: 4 },
  revision: { overallMs: 360000 }, 'name-interval': { overallMs: 360000 }, pilot: { processMs: 15000 }
});
export const domainSuites = {
  'HW-01': ['browser'], 'HW-02': ['browser'], 'HW-03': ['knowledge-protocol', 'relation-protocol', 'scheduler'],
  'HW-04': ['pilot', 'knowledge-protocol', 'relation-protocol', 'semantic-offline'], 'HW-05': ['browser', 'knowledge-protocol', 'relation-protocol', 'semantic-offline'],
  'HW-06': ['revision', 'edit-protocol', 'browser'], 'HW-07': ['name-interval', 'revision', 'name-protocol', 'browser'],
  'HW-08': ['playback-protocol', 'browser'], 'HW-09': ['import-protocol', 'import-atomicity', 'install-upgrade', 'browser'], 'HW-10': ['knowledge-protocol', 'relation-protocol', 'process-crash', 'install-upgrade', 'browser'],
  'HW-11': ['edit-protocol', 'scheduler', 'name-protocol', 'browser'], 'HW-12': ['browser'], 'HW-13': ['scheduler', 'browser'], 'HW-14': technicalSuites, 'HW-15': technicalSuites
};
// First-match is deliberately not used. A shared file may affect several domains.
export const impactRules = [
  { id: 'dependency-environment', category: 'dependencies-support', match: /^(?:package(?:-lock)?\.json|\.github\/|\.agents\/|\.nvmrc$|\.node-version$|Dockerfile|.*(?:docker|runtime|platform|support-matrix|toolchain|setup-|preflight).*)/, domains: groups },
  { id: 'verification-infrastructure', category: 'evidence-rules', match: /^(?:scripts\/(?:lib\/(?:process|verification|formal-|tap-|release|impact|runner-|node-test|.*(?:release|evidence))|run-|verify(?:-report)?\.)|verification\/(?:properties|release)|AGENTS\.md$)/, domains: groups },
  { id: 'server-storage', category: 'identity-persistence', match: /^(?:server\.mjs|storage\.mjs|src\/server\/)/, domains: groups },
  { id: 'runtime-security-performance', category: 'security-performance', match: /^(?:public\/.*\.(?:js|html)|[^/]+\.(?:mjs|js)|src\/)/, domains: ['HW-12', 'HW-13'] },
  { id: 'relation', category: 'rules-budget-protocol', match: /(?:^|\/)(?:relation[-.]|relations\.|identity-grounding)/, domains: ['HW-03', 'HW-04', 'HW-05', 'HW-10'] },
  { id: 'knowledge', category: 'rules-budget-identity', match: /(?:^|\/)(?:knowledge[-.]|knowledge\/)/, domains: ['HW-03', 'HW-04', 'HW-05', 'HW-06', 'HW-07', 'HW-10'] },
  { id: 'revision-proof', category: 'identity-text-coordinates', match: /(?:revision|NameInterval|name-interval|name-replacement|knowledge-edit|knowledge-name|AxiomAudit|verification\/lean)/, domains: ['HW-06', 'HW-07'] },
  { id: 'audio-session', category: 'protocol-identity-provider', match: /(?:asr|listening|session|interim-translation|caption|translation|translation-queue)/, domains: ['HW-01', 'HW-02', 'HW-03', 'HW-08'] },
  { id: 'speech', category: 'protocol-text-provider', match: /(?:speech|playback|qwen|fish|tts)/, domains: ['HW-03', 'HW-08', 'HW-11'] },
  { id: 'edit-protocol', category: 'identity-transaction-interaction', match: /(?:edit-protocol|edit-consistency|edit-commit-notification|knowledge-editor)/, domains: ['HW-06', 'HW-11'] },
  { id: 'transfer', category: 'persistence-protocol', match: /(?:data-transfer|migration|migrate|backup|restore|append-import|import-protocol|upgrade)/, domains: ['HW-09', 'HW-10', 'HW-14'] },
  { id: 'provider-admission', category: 'budget-provider-protocol', match: /(?:provider|retry|cooldown|queue|scheduler)/, domains: ['HW-01', 'HW-02', 'HW-03', 'HW-04', 'HW-05', 'HW-08'] },
  { id: 'prompts-models', category: 'prompt-model', match: /(?:prompt|model-config|model-selection)/, domains: ['HW-01', 'HW-02', 'HW-04', 'HW-05', 'HW-08'] },
  { id: 'ui-graph', category: 'interaction', match: /^(?:public\/app\.js|public\/index\.html)$|(?:knowledge-graph|cytoscape|transcript|pinned-caption)/, domains: ['HW-01', 'HW-02', 'HW-05', 'HW-06', 'HW-07', 'HW-08', 'HW-09', 'HW-11'] },
  { id: 'security', category: 'security-boundary', match: /(?:security|privacy|credential|saniti|escape|auth)/, domains: ['HW-12'] },
  { id: 'diagnostics', category: 'diagnostics-evidence', match: /(?:trace|diagnostic|business)/, domains: ['HW-15'] },
  { id: 'performance', category: 'load-environment', match: /(?:performance|throughput|benchmark)/, domains: ['HW-13'] }
];
export const safeDocumentation = /^(?:docs\/|README(?:\.[^/]+)?$|LICENSE$|\.editorconfig$|\.gitattributes$)/;
export const styleFile = /^public\/.*\.css$/;
