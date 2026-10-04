import { TTS_SAMPLE_RATE } from './public/speech-protocol.js';

const networkHints = {
  ENOTFOUND: '域名解析失败', EAI_AGAIN: '域名解析暂时失败',
  ECONNREFUSED: '连接被拒绝', ECONNRESET: '连接被重置', ENETUNREACH: '网络不可达', EHOSTUNREACH: '主机不可达',
  ETIMEDOUT: '连接超时', UND_ERR_CONNECT_TIMEOUT: '连接超时', UND_ERR_HEADERS_TIMEOUT: '等待响应超时',
  UND_ERR_BODY_TIMEOUT: '音频流接收超时', UND_ERR_SOCKET: '音频连接中断',
  CERT_HAS_EXPIRED: 'TLS 证书已过期', DEPTH_ZERO_SELF_SIGNED_CERT: 'TLS 证书校验失败',
  SELF_SIGNED_CERT_IN_CHAIN: 'TLS 证书校验失败', UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'TLS 证书校验失败',
  UNABLE_TO_GET_ISSUER_CERT_LOCALLY: 'TLS 证书校验失败', ERR_TLS_CERT_ALTNAME_INVALID: 'TLS 证书域名不匹配'
};
function networkCode(error, depth = 0) {
  if (!error || depth > 3) return undefined;
  if (Object.hasOwn(networkHints, error.code)) return error.code;
  return networkCode(error.cause, depth + 1) || (Array.isArray(error.errors)
    ? error.errors.slice(0, 4).map(e => networkCode(e, depth + 1)).find(Boolean) : undefined);
}
// Only locally authored messages and allowlisted codes cross the transport boundary.
// Never attach fetch causes, request headers, upstream response bodies or synthesis text.
export class FishTtsError extends Error {
  constructor(code, message, details = {}) {
    super(message); this.name = 'FishTtsError'; this.diagnostics = { code, ...details };
  }
}

// Each scheduler unit is already final text. HTTP streams raw PCM as it is generated;
// Node's fetch reuses connections, while the shared scheduler bounds audio lookahead.
export class FishTts {
  constructor(config, { endpoint = process.env.FISH_TTS_ENDPOINT || 'https://api.fish.audio/v1/tts',
    fetchImpl = fetch, connectTimeoutMs = 15000, timeoutMs = 45000 } = {}) {
    this.config = config; this.endpoint = endpoint; this.fetch = fetchImpl;
    this.connectTimeoutMs = connectTimeoutMs; this.timeoutMs = timeoutMs;
    this.closed = false; this.busy = false; this.abort = null;
  }
  async synthesize(text, onAudio, context) {
    if (this.closed) throw new Error('播报已关闭');
    if (this.busy) throw new Error('语音任务仍在进行');
    this.busy = true;
    const startedAt = Date.now();
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        if (this.closed) throw new Error('播报已关闭');
        const abort = this.abort = new AbortController();
        let audio = false, retryable = true, timedOut = '', stage = 'response';
        const timeout = phase => { timedOut ||= phase; abort.abort(); };
        // fetch resolves at response headers; this includes upstream queue/generation time.
        const connectTimer = setTimeout(() => timeout('response'), this.connectTimeoutMs);
        const timer = setTimeout(() => timeout('generation'), this.timeoutMs);
        try {
          const request = async child => {
            const c = this.config;
            const response = await this.fetch(this.endpoint, {
              method: 'POST', redirect: 'error', signal: abort.signal,
              headers: { Authorization: `Bearer ${c.key}`, 'Content-Type': 'application/json', model: c.model },
              body: JSON.stringify({ text: c.style ? `[${c.style}] ${text}` : text, reference_id: c.referenceId,
                format: 'pcm', sample_rate: TTS_SAMPLE_RATE, latency: c.latency,
                prosody: { speed: c.rate, volume: 0, normalize_loudness: true }, normalize: true })
            });
            clearTimeout(connectTimer);
            child?.event('response_headers', { http_status: response.status });
            if (!response.ok) {
              retryable = false; // In particular, never retry auth/quota failures or change the selected model.
              const message = { 401: 'API Key 无效', 403: '请检查 Key 和音色访问权限', 402: '额度不足',
                429: '请求过于频繁，请稍后重试', 400: '请检查音色 ID 和播报设置', 404: '音色或模型不存在',
                422: '请检查音色 ID 和播报设置', 503: '服务繁忙，请稍后重试' }[response.status];
              throw new FishTtsError('FISH_HTTP_ERROR', `Fish Audio：${message || '请求失败'}（HTTP ${response.status}）`, { httpStatus: response.status });
            }
            const type = response.headers.get('content-type') || '';
            if (!response.body || /json|text\/|wav|mp3|mpeg|opus/i.test(type)) {
              retryable = false; throw new FishTtsError('FISH_AUDIO_FORMAT', 'Fish Audio 未返回预期的 PCM 音频');
            }
            stage = 'audio';
            let tail = Buffer.alloc(0);
            for await (const chunk of response.body) {
              if (this.closed || abort.signal.aborted) throw new Error('播报已关闭');
              const bytes = Buffer.concat([tail, Buffer.from(chunk)]);
              const size = bytes.length - bytes.length % 2;
              tail = bytes.subarray(size);
              if (size) { audio = true; onAudio(bytes.subarray(0, size)); }
            }
            if (this.closed || abort.signal.aborted) throw new Error('播报已关闭');
            if (!audio || tail.length) { retryable = false; throw new FishTtsError('FISH_AUDIO_INCOMPLETE', 'Fish Audio 返回的音频不完整，请重新开启播报'); }
            child?.event('response_received');
            return { status: 'completed', attempts: attempt + 1 };
          };
          return await (context ? context.step('speech.http', request, { attempt: attempt + 1 }) : request());
        } catch (error) {
          if (this.closed) throw new Error('播报已关闭');
          if (audio || attempt || !retryable || timedOut) {
            if (audio && error.message?.startsWith('播放速度')) throw error;
            let failure = error;
            if (timedOut) failure = new FishTtsError(timedOut === 'response' ? 'FISH_RESPONSE_TIMEOUT' : 'FISH_GENERATION_TIMEOUT',
              timedOut === 'response' ? '等待 Fish Audio 响应超时，可能仍在排队或网络不通，请稍后重试'
                : 'Fish Audio 语音生成超时，请稍后重试');
            else if (!(error instanceof FishTtsError)) {
              const code = networkCode(error);
              failure = new FishTtsError('FISH_NETWORK_ERROR', code
                ? `Fish Audio ${networkHints[code]}（${code}），请检查运行 Hearwise 的电脑的网络、代理或证书配置`
                : audio ? 'Fish Audio 音频连接中断，请重新开启播报' : '无法连接 Fish Audio，请检查运行 Hearwise 的电脑的网络及代理配置',
              code ? { networkCode: code } : {});
            }
            Object.assign(failure.diagnostics, { stage, attempts: attempt + 1, audioReceived: audio, elapsedMs: Date.now() - startedAt });
            throw failure;
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
