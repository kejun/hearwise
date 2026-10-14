import assert from 'node:assert/strict';

// Test-only copies of the actual controller. No production debug API is added.
export function playbackControllerVariant(source, { wireModulus, mutation } = {}) {
  if (wireModulus !== undefined) {
    assert.equal(wireModulus, 2, 'the declared finite-domain accelerator is modulus 2');
    const anchor = 'epoch = epoch % 0xffffffff + 1;';
    assert.equal(source.split(anchor).length, 2); source = source.replace(anchor, 'epoch = epoch % 2 + 1;');
  }
  if (mutation !== undefined) {
    assert.ok(['old-player-callback', 'late-unlock'].includes(mutation));
    const anchor = mutation === 'old-player-callback' ? 'createPlayer(event => {\n      if (owner !== generation) return;' : 'await output.unlock(volume);\n      if (owner !== generation) return;';
    const replacement = mutation === 'old-player-callback' ? 'createPlayer(event => {\n      // Negative control: missing callback owner fence.' : 'await output.unlock(volume);\n      // Negative control: missing post-unlock owner fence.';
    assert.equal(source.split(anchor).length, 2); source = source.replace(anchor, replacement);
  }
  return source;
}
