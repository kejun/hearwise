import { TTS_SAMPLE_RATE } from './public/speech-protocol.js';

// Each scheduler unit is already final text. HTTP streams raw PCM as it is generated;
// Node's fetch reuses connections, while the shared scheduler bounds audio lookahead.
export class FishTts {
  constructor(config, { endpoint = process.env.FISH_TTS_ENDPOINT || 'https://api.fish.audio/v1/tts',
    fetchImpl = fetch, connectTimeoutMs = 15000, timeoutMs = 45000 } = {}) {
    this.config = config; this.endpoint = endpoint; this.fetch = fetchImpl;
    this.connectTimeoutMs = connectTimeoutMs; this.timeoutMs = timeoutMs;
    this.closed = false; this.busy = false; this.abort = null;
  }
  async synthesize(text, onAudio) {
    if (this.closed) throw new Error('播报已关闭');
    if (this.busy) throw new Error('语音任务仍在进行');
    this.busy = true;
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        if (this.closed) throw new Error('播报已关闭');
        const abort = this.abort = new AbortController();
        let audio = false, retryable = true, timedOut = false;
        const timeout = () => { timedOut = true; abort.abort(); };
        const connectTimer = setTimeout(timeout, this.connectTimeoutMs);
        const timer = setTimeout(timeout, this.timeoutMs);
        try {
          const c = this.config;
          const response = await this.fetch(this.endpoint, {
            method: 'POST', redirect: 'error', signal: abort.signal,
            headers: { Authorization: `Bearer ${c.key}`, 'Content-Type': 'application/json', model: c.model },
            body: JSON.stringify({ text: c.style ? `[${c.style}] ${text}` : text, reference_id: c.referenceId,
              format: 'pcm', sample_rate: TTS_SAMPLE_RATE, latency: c.latency,
              prosody: { speed: c.rate, volume: 0, normalize_loudness: true }, normalize: true })
          });
          clearTimeout(connectTimer);
          if (!response.ok) {
            retryable = false; // In particular, never retry auth/quota failures or change the selected model.
            const message = { 401: 'API Key 无效', 403: '请检查 Key 和音色访问权限', 402: '额度不足',
              429: '请求过于频繁，请稍后重试', 400: '请检查音色 ID 和播报设置', 404: '音色或模型不存在',
              422: '请检查音色 ID 和播报设置', 503: '服务繁忙，请稍后重试' }[response.status];
            throw new Error(`Fish Audio：${message || `请求失败（HTTP ${response.status}）`}`);
          }
          const type = response.headers.get('content-type') || '';
          if (!response.body || /json|text\/|wav|mp3|mpeg|opus/i.test(type)) {
            retryable = false; throw new Error('Fish Audio 未返回预期的 PCM 音频');
          }
          let tail = Buffer.alloc(0);
          for await (const chunk of response.body) {
            if (this.closed || abort.signal.aborted) throw new Error('播报已关闭');
            const bytes = Buffer.concat([tail, Buffer.from(chunk)]);
            const size = bytes.length - bytes.length % 2;
            tail = bytes.subarray(size);
            if (size) { audio = true; onAudio(bytes.subarray(0, size)); }
          }
          if (this.closed || abort.signal.aborted) throw new Error('播报已关闭');
          if (!audio || tail.length) { retryable = false; throw new Error('Fish Audio 返回的音频不完整，请重新开启播报'); }
          return { status: 'completed', attempts: attempt + 1 };
        } catch (error) {
          if (this.closed) throw new Error('播报已关闭');
          if (audio || attempt || !retryable || timedOut) {
            if (timedOut) throw new Error('Fish Audio 语音生成超时，请稍后重试');
            if (!retryable || audio && error.message?.startsWith('播放速度')) throw error;
            throw new Error('Fish Audio 音频连接中断，请重新开启播报');
          }
        } finally {
          clearTimeout(connectTimer); clearTimeout(timer); abort.abort();
          if (this.abort === abort) this.abort = null;
        }
      }
    } finally { this.busy = false; }
  }
  close() {
    this.closed = true; this.abort?.abort(); this.config = null;
  }
}
