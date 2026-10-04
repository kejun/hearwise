// Display-only preferences: never filter stored segments, exports, or speech input.
export function initTranscriptVisibility(document) {
  const key = 'hearwise:transcript-visibility';
  const panel = document.getElementById('transcript-panel');
  const original = document.getElementById('hide-transcript-original');
  const translation = document.getElementById('hide-transcript-translation');
  const note = document.getElementById('transcript-hidden-note');
  let saved;
  try { saved = JSON.parse(document.defaultView.localStorage.getItem(key)); } catch { /* Optional preference. */ }
  original.checked = saved?.hideOriginal === true;
  translation.checked = saved?.hideTranslation === true;
  function apply(persist = false) {
    panel.classList.toggle('hide-original', original.checked);
    panel.classList.toggle('hide-translation', translation.checked);
    note.hidden = !(original.checked && translation.checked);
    if (persist) {
      try {
        document.defaultView.localStorage.setItem(key, JSON.stringify({
          hideOriginal: original.checked, hideTranslation: translation.checked
        }));
      } catch { /* Storage restrictions must not block reading. */ }
    }
  }
  for (const input of [original, translation]) input.addEventListener('change', () => apply(true));
  document.getElementById('show-transcript-all').addEventListener('click', () => {
    original.checked = translation.checked = false;
    apply(true);
    original.focus();
  });
  apply();
}
