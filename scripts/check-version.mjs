import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = file => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
const { version } = JSON.parse(read('package.json'));
const lock = JSON.parse(read('package-lock.json'));
assert.match(version, /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/, '版本必须使用 X.Y.Z 格式');
assert.equal(lock.version, version, 'package-lock.json 顶层版本未同步');
assert.equal(lock.packages?.['']?.version, version, 'package-lock.json 根包版本未同步');
const footer = read('public/index.html').match(/<footer\b[^>]*>([\s\S]*?)<\/footer>/)?.[1];
const labels = [...(footer || '').matchAll(/HearWise v([^<\s]+)/g)];
assert.equal(labels.length, 1, '页脚必须包含且仅包含一个 HearWise 版本号');
assert.equal(labels[0][1], version, '页脚版本与 package.json 不一致');
console.log(`版本一致：v${version}`);
