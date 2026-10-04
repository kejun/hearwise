import WebSocket from 'ws';
import { randomUUID } from 'node:crypto';
import { TTS_MODEL, TTS_INSTRUCT_MODEL, TTS_REGIONS, TTS_SAMPLE_RATE } from './public/speech-protocol.js';

// One response at a time per persistent Qwen session. Cancellation closes the transport;
// Qwen does not document response.cancel for this model.
export class QwenTts {
  constructor(config, { endpoint = process.env.TTS_ENDPOINT, timeoutMs = 15000 } = {}) {
    this.config = config; this.endpoint = endpoint; this.timeoutMs = timeoutMs;
    this.ws = null; this.pending = null; this.connecting = null; this.closed = false;
  }
  send(type, data = {}) {
    if (this.ws?.readyState !== WebSocket.OPEN) throw new Error('语音连接已断开');
    this.ws.send(JSON.stringify({ event_id: randomUUID(), type, ...data }));
  }
  async connect() {
    if (this.closed) throw new Error('播报已关闭');
    if (this.ready && this.ws?.readyState === WebSocket.OPEN) return;
    if (this.connecting) return this.connecting;
    this.connecting = new Promise((resolve, reject) => {
      const url = new URL(this.endpoint || TTS_REGIONS[this.config.region]);
      url.searchParams.set('model', this.config.prompt ? TTS_INSTRUCT_MODEL : TTS_MODEL);
      const ws = this.ws = new WebSocket(url, {
        headers: { Authorization: `Bearer ${this.config.key}` }, handshakeTimeout: this.timeoutMs,
        maxPayload: 4 * 1024 * 1024
      });
      let settled = false;
      const timer = setTimeout(() => fail(new Error('语音连接超时，请检查网络与地域')), this.timeoutMs);
      const fail = error => {
        if (ws !== this.ws) return;
        this.ready = false;
        if (!settled) { settled = true; clearTimeout(timer); reject(error); }
        this.pending?.reject(error);
        if (ws.readyState !== WebSocket.CLOSED) ws.terminate();
      };
      ws.on('error', () => fail(new Error('无法连接语音服务，请检查网络、Key 和地域')));
      ws.on('unexpected-response', (_req, res) => fail(new Error(`语音服务 HTTP ${res.statusCode}，请检查 Key、地域和额度`)));
      ws.on('close', () => fail(new Error('语音连接已断开')));
      ws.on('message', raw => {
        if (ws !== this.ws || this.closed) return;
        let event; try { event = JSON.parse(raw.toString()); } catch { return fail(new Error('语音服务响应无效')); }
        if (event.type === 'session.created') this.send('session.update', { session: {
          mode: 'commit', voice: this.config.voice, language_type: this.config.language || 'Chinese',
          response_format: 'pcm', sample_rate: TTS_SAMPLE_RATE, speech_rate: this.config.rate,
          ...(this.config.prompt ? { instructions: this.config.prompt, optimize_instructions: false } : {})
        } });
        if (event.type === 'session.updated' && !settled) {
          settled = true; clearTimeout(timer); this.ready = true; resolve();
        }
        if (event.type === 'error') return fail(new Error('语音服务拒绝请求，请检查 Key、地域、额度及模型权限'));
        const task = this.pending;
        if (!task) return;
        if (event.type === 'response.created') task.responseId = event.response?.id;
        if (event.type === 'response.audio.delta' && task.responseId && event.response_id === task.responseId) {
          const bytes = Buffer.concat([task.tail, Buffer.from(event.delta || '', 'base64')]);
          task.tail = bytes.subarray(bytes.length - bytes.length % 2);
          const pcm = bytes.subarray(0, bytes.length - bytes.length % 2);
          if (pcm.length) { task.audio = true; try { task.onAudio(pcm); } catch (error) { fail(error); } }
        }
        if (event.type === 'response.done' && event.response?.id === task.responseId) {
          if (event.response.status !== 'completed' || !task.audio || task.tail.length) {
            fail(new Error('本句语音生成不完整，请重新开启或跳到最新内容'));
          } else task.resolve({ id: event.response.id, status: event.response.status, usage: event.response.usage });
        }
      });
    });
    try { await this.connecting; } finally { this.connecting = null; }
  }
  async synthesize(text, onAudio, context) {
    if (this.pending) throw new Error('语音任务仍在进行');
    // Retry once only if no PCM has escaped. Never replay a partly heard sentence.
    for (let attempt = 0; attempt < 2; attempt++) {
      let audio = false;
      try {
        const request = async child => {
          if (this.ready && this.ws?.readyState === WebSocket.OPEN) child?.event('connection_reused');
          await (child ? child.step('speech.connect', () => this.connect()) : this.connect());
          const stream = () => new Promise((resolve, reject) => {
            const finish = (error, value) => {
              clearTimeout(timer); this.pending = null;
              error ? reject(error) : resolve(value);
            };
            const timer = setTimeout(() => { finish(new Error('本句语音生成超时')); this.ws?.terminate(); }, 45000);
            this.pending = { tail: Buffer.alloc(0), audio: false,
              onAudio: pcm => { audio = true; onAudio(pcm); }, resolve: value => finish(null, value), reject: finish };
            this.send('input_text_buffer.append', { text });
            this.send('input_text_buffer.commit');
          });
          const result = await (child ? child.step('speech.stream', stream) : stream());
          return { ...result, attempts: attempt + 1 };
        };
        return await (context ? context.step('speech.attempt', request, { attempt: attempt + 1 }) : request());
      } catch (error) {
        if (this.closed || audio || attempt) throw error;
        this.ready = false; this.ws?.terminate();
      }
    }
  }
  close(graceful = false) {
    if (this.closed) return;
    this.closed = true; this.ready = false;
    this.pending?.reject(new Error('播报已关闭'));
    this.config = null;
    if (graceful && this.ws?.readyState === WebSocket.OPEN) {
      const ws = this.ws;
      ws.send(JSON.stringify({ event_id: randomUUID(), type: 'session.finish' }));
      const timer = setTimeout(() => ws.terminate(), 1000); timer.unref();
      ws.once('close', () => clearTimeout(timer));
    } else this.ws?.terminate();
  }
}
