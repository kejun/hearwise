import { AUDIO_HEADER_BYTES } from './speech-protocol.js';

export class SpeechPlayer {
  constructor(onEvent) { this.onEvent = onEvent; this.context = null; this.closed = false; this.unit = 0; this.frame = 0; this.samples = 0; }
  async unlock(volume) {
    if (!globalThis.AudioContext || !globalThis.AudioWorkletNode) throw new Error('请使用支持语音播放的新版 Chrome 或 Edge');
    const context = this.context = new AudioContext(); // Separate from the 16 kHz recording graph.
    const resumed = context.resume(); // Must run synchronously inside the user gesture, before the first await.
    await Promise.all([context.audioWorklet.addModule('/speech-output-processor.js'), resumed]);
    if (this.closed) return;
    this.node = new AudioWorkletNode(context, 'speech-output', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [1] });
    this.gain = context.createGain(); this.gain.gain.value = volume;
    this.node.connect(this.gain); this.gain.connect(context.destination);
    this.node.port.onmessage = ({ data }) => { if (!this.closed) this.onEvent(data); };
    context.onstatechange = () => {
      if (!this.closed && context.state !== 'running') this.onEvent({ type: 'suspended' });
    };
    if (context.state !== 'running') this.onEvent({ type: 'suspended' });
  }
  begin(unit) {
    if (unit !== this.unit + 1) throw new Error('语音单元顺序无效');
    this.unit = unit; this.frame = 0; this.samples = 0; this.node.port.postMessage({ type: 'begin', unit });
  }
  audio(packet, epoch) {
    if (packet.byteLength < AUDIO_HEADER_BYTES) throw new Error('语音数据不完整');
    const header = new DataView(packet);
    if (header.getUint32(0, true) !== epoch) return;
    if (header.getUint32(4, true) !== this.unit || header.getUint32(8, true) !== this.frame++ ||
        header.getUint32(12, true) * 2 !== packet.byteLength - AUDIO_HEADER_BYTES) throw new Error('语音数据顺序无效');
    const pcm = packet.slice(AUDIO_HEADER_BYTES);
    this.samples += pcm.byteLength / 2;
    this.node.port.postMessage({ type: 'pcm', pcm }, [pcm]);
  }
  end(unit, samples) {
    if (unit !== this.unit || samples !== this.samples) throw new Error('本句语音不完整');
    this.node.port.postMessage({ type: 'end', unit });
  }
  volume(value) { if (this.gain) this.gain.gain.setTargetAtTime(value, this.context.currentTime, .02); }
  async settle() {
    // Worklet consumption precedes the hardware output. Let the final device buffer drain.
    const seconds = (this.context?.baseLatency || 0) + (this.context?.outputLatency || 0) + .03;
    await new Promise(resolve => setTimeout(resolve, Math.min(500, Math.max(80, seconds * 1000))));
  }
  close() {
    this.closed = true;
    if (this.gain) { this.gain.gain.cancelScheduledValues(this.context.currentTime); this.gain.gain.value = 0; this.gain.disconnect(); }
    this.node?.disconnect(); this.node?.port.close();
    if (this.context && this.context.state !== 'closed') void this.context.close().catch(() => {});
  }
}
