// Public UI + real application HTTP/SQLite; only the model provider is stubbed.
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { relationResultFixture, settledResult, readResult, assertResult } from './relation-result-fixture.mjs';

const directory = process.argv[2];
const observations = { widths: [], complete: false };
const expectedText = { shortage: '未发现有充分依据的关系', empty: '未发现有充分依据的关系',
  filtered: '未发现有充分依据的关系', qualified: '关系整理完成', partial: '关系部分完成', error: '关系整理失败' };
let browser;
try {
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_EXECUTABLE || undefined,
    args: ['--no-sandbox', '--no-zygote', '--disable-gpu'] });
  observations.chromium = browser.version();
  for (const width of [1280, 390]) {
    const fixture = await relationResultFixture();
    const page = await browser.newPage({ viewport: { width, height: 950 }, reducedMotion: 'reduce' });
    page.setDefaultTimeout(12000);
    const errors = [], results = [];
    page.on('pageerror', error => errors.push(error.message));
    try {
      await page.addInitScript(() => localStorage.setItem('tongsheng:qianwen-key', 'fixture-only'));
      await page.goto(fixture.base);
      for (const record of fixture.seeded) {
        await page.locator('#history-listening').click();
        await page.getByRole('button', { name: `查看“${record.title}”`, exact: true }).click();
        await page.locator('#record-title').filter({ hasText: record.title }).waitFor();
        await page.locator('#knowledge-view-graph').click();
        await page.locator('#graph-count').filter({ hasText: `${record.nodes} / ${record.nodes}` }).waitFor();
        await page.locator('#graph-viewport canvas').first().waitFor({ state: 'visible' });
        // Start from real input, without calling page business functions or intercepting graph APIs.
        await page.locator('#graph-generate').focus(); await page.keyboard.press('Enter');
        const graph = await settledResult(fixture, record); assertResult(fixture, record, graph);
        await page.locator('#graph-status').filter({ hasText: expectedText[record.name] }).waitFor();
        await page.locator('#graph-count').filter({ hasText: `${record.edges} 条关系` }).waitFor();
        if (!await page.locator('.graph-results').evaluate(el => el.open)) await page.locator('.graph-results > summary').click();
        assert.equal(await page.locator('[data-result-node-id]').count(), record.nodes);
        const independent = graph.nodes.find(node => node.canonical_name === 'Independent') || graph.nodes[0];
        await page.locator(`[data-result-node-id="${independent.id}"]`).click();
        await page.locator('#graph-details').filter({ hasText: '该知识仍作为独立节点保留' }).waitFor();
        await page.keyboard.press('Escape');
        if (record.edges) {
          if (!await page.locator('.graph-relations').evaluate(el => el.open)) await page.locator('.graph-relations > summary').click();
          assert.equal(await page.locator('[data-relation-id]').count(), 1);
          await page.locator('[data-relation-id]').click();
          const details = page.locator('#graph-details');
          await details.filter({ hasText: 'If approved' }).waitFor();
          assert.match(await details.textContent(), /否定/); assert.match(await details.textContent(), /计划/);
          assert.ok((await details.textContent()).includes(record.segment.original_text), 'Page evidence must show the exact persisted source');
          assert.ok((await details.textContent()).includes('Atlas’s Lab'));
          await page.keyboard.press('Escape');
        }
        if (!await page.locator('#graph-diagnostics').evaluate(el => el.open)) await page.locator('#graph-diagnostics > summary').click();
        const d = graph.status.diagnostics, diagnostics = await page.locator('#graph-diagnostics').textContent();
        assert.ok(diagnostics.includes(`当前可见 ${record.edges} 条 · 已保存 ${record.edges} 条`));
        if (['empty', 'filtered', 'qualified', 'partial'].includes(record.name)) {
          assert.ok(diagnostics.includes(`模型返回 ${d.returnedCount} 项 · 通过校验 ${d.validatorAcceptedCount} 项 · 最终接收 ${d.acceptedCount} 项 · 已忽略候选 ${d.rejectedCount} 项`));
        }
        if (record.name === 'filtered') assert.match(diagnostics, /未保存候选详情/);
        if (record.name === 'error') assert.match(diagnostics, /请求失败原因/);
        if (['shortage', 'empty', 'filtered'].includes(record.name)) {
          assert.equal(await page.locator('#graph-retry').isHidden(), true);
          assert.doesNotMatch(await page.locator('#graph-status').textContent(), /失败|部分完成/);
        }
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        await page.locator('#graph-status').scrollIntoViewIfNeeded();
        await page.screenshot({ path: path.join(directory, `relations-${width}-${record.name}.png`) });
        results.push({ scenario: record.name, state: graph.status.state, nodes: graph.nodes.length, edges: graph.relations.length,
          providerRequests: fixture.calls.filter(c => c.name === record.name).length, diagnostics: d, supports: graph.supports });
      }
      const calls = fixture.calls.length;
      await page.waitForTimeout(3300);
      assert.equal(fixture.calls.length, calls, 'Terminal empty/success/error results do not restart automatically');
      for (const record of fixture.seeded) assertResult(fixture, record, await readResult(fixture, record));
      assert.deepEqual(errors, []); observations.widths.push({ width, results, errors });
    } finally { await page.close(); await fixture.close(); }
  }
  observations.complete = true;
} finally {
  if (browser) await browser.close();
  await writeFile(path.join(directory, 'browser.json'), JSON.stringify(observations, null, 2));
}
console.log(JSON.stringify(observations, null, 2));
