import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { traceReportFixture } from '../test-support/trace-report-fixture.mjs';
import { createTraceReport } from './trace-report.mjs';

// A local, labelled fixture demonstration; no API key or paid model call.
await mkdir('data/diagnostics', { recursive: true });
const directory = await mkdtemp(path.resolve('data/diagnostics/example-'));
const input = path.join(directory, 'current.json'), baseline = path.join(directory, 'baseline.json');
await writeFile(input, JSON.stringify(await traceReportFixture()), { mode: 0o600 });
await writeFile(baseline, JSON.stringify(await traceReportFixture({ recovered: false })), { mode: 0o600 });
const output = path.join(directory, 'report.html');
const result = await createTraceReport(input, output, baseline);
console.log(JSON.stringify({ fixture: true, output, ...result }));
