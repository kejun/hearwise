import { runProcess } from './process.mjs';

// Node regressions read repository-relative fixtures and config. Formal tools
// keep their generated output isolated in this run's evidence directory.
export function runEditProtocolCommand(command, args, { kind, repositoryRoot, evidenceDirectory, ...options }) {
  const cwd = kind === 'implementation-regression' ? repositoryRoot : evidenceDirectory;
  return runProcess(command, args, { ...options, cwd });
}
