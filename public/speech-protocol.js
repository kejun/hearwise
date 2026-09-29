export const TTS_SAMPLE_RATE = 24000;
export const TTS_MODEL = 'qwen3-tts-flash-realtime';
export const TTS_REGIONS = {
  beijing: 'wss://dashscope.aliyuncs.com/api-ws/v1/realtime',
  singapore: 'wss://dashscope-intl.aliyuncs.com/api-ws/v1/realtime'
};
export const TTS_VOICES = ['Cherry', 'Serena', 'Ethan', 'Chelsie'];
export function speechConfig(input) {
  if (!input || typeof input.key !== 'string' || !input.key.trim() || input.key.length > 2048 ||
      !Object.hasOwn(TTS_REGIONS, input.region) || !TTS_VOICES.includes(input.voice) ||
      ![1, 1.1, 1.2].includes(input.rate)) throw new Error('请检查语音 Key、地域、音色和语速');
  return { key: input.key.trim(), region: input.region, voice: input.voice, rate: input.rate };
}
// Binary frames: little-endian uint32 epoch, unit, frame, PCM sample count; then signed PCM16 LE.
export const AUDIO_HEADER_BYTES = 16;
export const PREVIEW_TEXT = '你好，这是译文语音播报。开启后，我会按顺序读出新的中文译文。';
