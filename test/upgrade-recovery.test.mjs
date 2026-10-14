import test from 'node:test';
import { faultCases, faultId, migrationFault, historicalRestore } from '../test-support/upgrade-scenarios.mjs';
for (const config of faultCases) test(`migration SQLite fault ${faultId(config)}`, { timeout: 15000 }, () => migrationFault(config));
for (const version of [1, 6, 10, 11, 12]) test(`historical backup HTTP restore v${version}`, { timeout: 15000 }, () => historicalRestore(version));
