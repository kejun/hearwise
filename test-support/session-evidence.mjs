import { summarizeChecks } from '../scripts/lib/verification-checks.mjs';
export { tapSummary as sessionTapSummary, runChecks as runSessionChecks } from '../scripts/lib/verification-checks.mjs';

const requiredChecks = {
  'HW-01-02': ['identity-and-source'],
  'HW-01-03': ['browser'],
  'HW-02-02': ['identity-and-source', 'browser'],
  'HW-02-03': ['caption-frontier', 'browser'],
  'HW-11-02': ['browser']
};
export function sessionRequiredChecks(id, nodeOnly = false) {
  if (!requiredChecks[id]) throw new Error(`Unknown session property: ${id}`);
  return requiredChecks[id].filter(name => !nodeOnly || name !== 'browser');
}
export function summarizeSessionResults(options) {
  const { nodeOnly = false } = options;
  return summarizeChecks({ ...options,
    expectedChecks: ['identity-and-source', 'caption-frontier', ...(nodeOnly ? [] : ['browser'])],
    checksForProperty: id => sessionRequiredChecks(id, nodeOnly) });
}
