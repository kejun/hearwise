// Shared by the browser and /api/translate. Length follows JavaScript UTF-16 units.
export const INTERIM_TRANSLATION_MAX_LENGTH = 3000;
export const TRANSLATION_TARGETS = Object.freeze(['Chinese', 'English', 'Japanese', 'Korean']);
export const RECOGNITION_SOURCES = Object.freeze(['auto', 'zh', 'en', 'ja', 'ko']);

export function validateInterimTranslation(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { code: 'INVALID_TRANSLATION_REQUEST', error: '翻译请求格式无效' };
  }
  const { key, text, target = 'Chinese', source = 'auto' } = input;
  if (typeof key !== 'string' || !key.trim()) {
    return { code: 'API_KEY_REQUIRED', field: 'key', error: '请先填写有效的 API Key' };
  }
  if (typeof text !== 'string' || !text.trim()) {
    return { code: 'TRANSLATION_TEXT_REQUIRED', field: 'text', error: '待翻译文本不能为空' };
  }
  if (text.trim().length > INTERIM_TRANSLATION_MAX_LENGTH) {
    return { code: 'INTERIM_TEXT_TOO_LONG', field: 'text', maxLength: INTERIM_TRANSLATION_MAX_LENGTH,
      error: '临时译文文本过长，请等待完整译文' };
  }
  if (!TRANSLATION_TARGETS.includes(target)) {
    return { code: 'UNSUPPORTED_TARGET_LANGUAGE', field: 'target', error: '不支持所选的译文语言' };
  }
  if (!RECOGNITION_SOURCES.includes(source)) {
    return { code: 'UNSUPPORTED_SOURCE_LANGUAGE', field: 'source', error: '不支持所选的识别语言' };
  }
  return null;
}
