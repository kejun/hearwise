import { test } from 'node:test';
import { workflowScenarioNames, runWorkflowScenario } from '../test-support/trace-business-scenarios.mjs';

for (const name of workflowScenarioNames) test(`actual workflow and durable task query agree with Trace: ${name}`,
  { timeout: 10000 }, () => runWorkflowScenario(name));
