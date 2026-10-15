import test from 'node:test';
import { dataCases, dataScenario } from '../test-support/import-atomicity-data.mjs';
for (const kind of dataCases) test(`import full business projection: ${kind}`, { timeout: 15000 }, () => dataScenario(kind));
