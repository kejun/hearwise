import { SpeechBuffer } from './speech-buffer.js';

class SpeechOutputProcessor extends AudioWorkletProcessor {
  constructor() {
    super(); this.buffer = new SpeechBuffer(sampleRate); this.ticks = 0; this.failed = false;
    this.port.onmessage = ({ data }) => {
      if (this.failed) return;
      try {
        if (data.type === 'begin') this.buffer.begin(data.unit);
        if (data.type === 'pcm') this.buffer.push(new Int16Array(data.pcm));
        if (data.type === 'end') this.buffer.end(data.unit);
      } catch { this.failed = true; this.port.postMessage({ type: 'error' }); }
    };
  }
  process(_inputs, outputs) {
    const channel = outputs[0][0];
    if (!channel || this.failed) return true;
    this.buffer.render(channel, event => this.port.postMessage(event));
    this.ticks += channel.length;
    if (this.ticks >= sampleRate / 4) {
      this.ticks = 0;
      this.port.postMessage({ type: 'progress', consumedSamples: this.buffer.consumedSamples, playedUnit: this.buffer.playedUnit, underruns: this.buffer.underruns });
    }
    return true;
  }
}
registerProcessor('speech-output', SpeechOutputProcessor);
