class PcmProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.inputIndex = 0;
    this.nextOutput = 0;
    this.previous = 0;
    this.samples = new Int16Array(320);
    this.count = 0;
    this.step = sampleRate / 16000;
    this.totalSamples = 0; // 诊断用：已发送样本计数
    this.port.onmessage = event => {
      if (event.data?.type === 'flush') this.flush();
    };
  }

  flush() {
    // stop/flush 确认协议：立即发出未满一包的尾样本，然后回执 flushed（含样本计数）
    if (this.count > 0) {
      const tail = this.samples.slice(0, this.count);
      this.totalSamples += tail.length;
      this.port.postMessage(tail.buffer, [tail.buffer]);
      this.samples = new Int16Array(320);
      this.count = 0;
    }
    this.port.postMessage({ type: 'flushed', totalSamples: this.totalSamples });
  }

  process(inputs) {
    const channel = inputs[0]?.[0];
    if (!channel) return true;
    for (let i = 0; i < channel.length; i++) {
      const current = channel[i];
      while (this.nextOutput <= this.inputIndex) {
        const fraction = Math.max(0, this.nextOutput - (this.inputIndex - 1));
        const value = this.inputIndex === 0 ? current : this.previous + (current - this.previous) * fraction;
        this.samples[this.count++] = Math.round(Math.max(-1, Math.min(1, value)) * (value < 0 ? 32768 : 32767));
        if (this.count === this.samples.length) {
          this.totalSamples += this.count;
          this.port.postMessage(this.samples.buffer, [this.samples.buffer]);
          this.samples = new Int16Array(320);
          this.count = 0;
        }
        this.nextOutput += this.step;
      }
      this.previous = current;
      this.inputIndex++;
    }
    return true;
  }
}
registerProcessor('pcm-processor', PcmProcessor);
