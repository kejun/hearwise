export const TTS_SAMPLE_RATE = 24000;
export const TTS_MODEL = 'qwen3-tts-flash-realtime';
export const TTS_INSTRUCT_MODEL = 'qwen3-tts-instruct-flash-realtime';
// A compact prompt stays comfortably below the provider's 1600-token limit.
export const TTS_PROMPT_MAX_LENGTH = 500;
export const TTS_REGIONS = {
  beijing: 'wss://dashscope.aliyuncs.com/api-ws/v1/realtime',
  singapore: 'wss://dashscope-intl.aliyuncs.com/api-ws/v1/realtime'
};
export const TTS_VOICES = ['Cherry', 'Serena', 'Ethan', 'Chelsie'];
export const FISH_MODELS = ['s2.1-pro-free', 's2.1-pro'];
export function speechConfig(input) {
  const provider = input?.provider === undefined ? 'qwen' : input.provider;
  if (!['qwen', 'fish'].includes(provider)) throw new Error('请选择有效的语音服务商');
  if (provider === 'fish') {
    if (typeof input.key !== 'string' || !input.key.trim() || input.key.length > 2048 || /[\r\n]/.test(input.key)) throw new Error('请填写 Fish Audio API Key');
    if (!FISH_MODELS.includes(input.model)) throw new Error('请选择有效的 Fish Audio 模型');
    if (typeof input.referenceId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(input.referenceId.trim())) throw new Error('请填写 Fish Audio 音色 ID，不是音色页面链接');
    if (!Number.isFinite(input.rate) || input.rate < .5 || input.rate > 2 || !['balanced', 'normal', 'low'].includes(input.latency)) throw new Error('请检查 Fish Audio 语速和延迟模式');
    if (input.style !== undefined && typeof input.style !== 'string') throw new Error('Fish Audio 表达风格必须是文本');
    let style = (input.style || '').trim();
    if (style.startsWith('[') && style.endsWith(']')) style = style.slice(1, -1).trim();
    if (style.length > 120 || /[\[\]<>\r\n]/.test(style)) throw new Error('Fish Audio 表达风格限 120 字符，请填写一条简短描述');
    return { provider, key: input.key.trim(), model: input.model, referenceId: input.referenceId.trim(), rate: input.rate, latency: input.latency, style };
  }
  if (!input || typeof input.key !== 'string' || !input.key.trim() || input.key.length > 2048 ||
      !Object.hasOwn(TTS_REGIONS, input.region) || !TTS_VOICES.includes(input.voice) ||
      ![1, 1.1, 1.2].includes(input.rate)) throw new Error('请检查连接设置中的 API Key，以及播报地域、音色和语速');
  if (input.prompt !== undefined && typeof input.prompt !== 'string') throw new Error('语音 Prompt 必须是文本');
  const prompt = (input.prompt || '').trim();
  if (prompt.length > TTS_PROMPT_MAX_LENGTH) throw new Error(`语音 Prompt 最多 ${TTS_PROMPT_MAX_LENGTH} 个字符，请缩短后重试`);
  return { provider, key: input.key.trim(), region: input.region, voice: input.voice, rate: input.rate, prompt };
}
// Binary frames: little-endian uint32 epoch, unit, frame, PCM sample count; then signed PCM16 LE.
export const AUDIO_HEADER_BYTES = 16;
export const PREVIEW_TEXT = '你好，这是译文语音播报。开启后，我会按顺序读出新的中文译文。';
