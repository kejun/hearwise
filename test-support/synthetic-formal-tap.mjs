import { formalRegressionTree } from '../scripts/lib/formal-regression-contract.mjs';
// TEST ONLY: complete synthetic TAP for report-parser unit fixtures. Never
// represents an actual implementation execution or a releasable report.
export async function syntheticFormalTap(kind) {
  const lines = ['TAP version 13', '# TEST ONLY: synthetic parser fixture'], nodes = await formalRegressionTree(kind); let count = 0;
  const group = (rows, nesting = 0) => {
    for (const [i, value] of rows.entries()) {
      const node = typeof value === 'string' ? { name: value } : value, pad = '    '.repeat(nesting);
      lines.push(`${pad}# Subtest: ${node.name}`);
      if (node.children?.length) group(node.children, nesting + 1);
      lines.push(`${pad}ok ${i + 1} - ${node.name.replaceAll('\\', '\\\\').replaceAll('#', '\\#')}`); count++;
    }
    lines.push(`${'    '.repeat(nesting)}1..${rows.length}`);
  };
  group(nodes);
  return [...lines, `# tests ${count}`, '# suites 0', `# pass ${count}`, '# fail 0', '# cancelled 0', '# skipped 0', '# todo 0', '# duration_ms 1.0', ''].join('\n');
}
