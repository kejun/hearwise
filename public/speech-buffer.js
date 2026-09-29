// Bounded PCM ring with one resampling position shared across every network chunk.
// Kept independent from AudioWorklet so 44.1/48 kHz, underflow and tail handling can be tested.
export class SpeechBuffer {
  constructor(outputRate, inputRate = 24000, capacity = inputRate * 32) {
    this.data = new Float32Array(capacity); this.step = inputRate / outputRate;
    this.inputRate = inputRate; this.read = 0; this.write = 0; this.units = [];
    this.playedUnit = 0; this.started = false; this.underruns = 0;
  }
  begin(unit) { this.units.push({ unit, start: this.write, end: null, started: false }); }
  push(pcm) {
    if (!this.units.length || this.units.at(-1).end != null) throw new Error('缺少语音单元');
    if (this.write - Math.floor(this.read) + pcm.length > this.data.length) throw new Error('语音缓冲区已满');
    for (const sample of pcm) this.data[this.write++ % this.data.length] = sample / 32768;
  }
  end(unit) {
    if (this.units.at(-1)?.unit !== unit) throw new Error('语音单元顺序无效');
    this.units.at(-1).end = this.write;
  }
  render(output, emit = () => {}) {
    output.fill(0);
    for (let i = 0; i < output.length; i++) {
      this.complete(emit);
      const unit = this.units[0];
      if (!unit) { this.started = false; break; }
      const available = this.write - this.read;
      if (!this.started && available < this.inputRate * .2 && unit.end == null) break;
      const index = Math.floor(this.read);
      if (index >= this.write || (index + 1 >= this.write && unit.end == null)) {
        if (this.started) this.underruns++;
        this.started = false; break;
      }
      this.started = true;
      if (!unit.started) { unit.started = true; emit({ type: 'started', unit: unit.unit }); }
      const a = this.data[index % this.data.length];
      const b = this.data[Math.min(index + 1, this.write - 1) % this.data.length];
      output[i] = a + (b - a) * (this.read - index);
      this.read = Math.min(this.write, this.read + this.step);
    }
    this.complete(emit);
  }
  complete(emit) {
    while (this.units[0]?.end != null && this.read >= this.units[0].end - 1e-6) {
      const unit = this.units.shift(); this.read = Math.max(this.read, unit.end);
      this.playedUnit = unit.unit; emit({ type: 'played', unit: unit.unit });
    }
  }
  get consumedSamples() { return Math.min(this.write, Math.floor(this.read + 1e-6)); }
}
