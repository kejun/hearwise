// Optional platform integration. Unsupported actions must never prevent audio playback.
export function createSpeechMediaSession({ navigator = globalThis.navigator, Metadata = globalThis.MediaMetadata } = {}) {
  const session = navigator?.mediaSession, audioSession = navigator?.audioSession;
  let active = false, previousAudioType, assignedAudioType;
  const actions = new Set();
  const attempt = operation => { try { operation(); } catch { /* Browser/platform does not support this capability. */ } };
  function setContext(context) {
    if (!active || !audioSession) return;
    // Playback is exclusive on some platforms. Do not interrupt the source tab or microphone capture.
    const type = context.phase === 'idle' ? 'playback' : context.audioSource === 'microphone' ? 'play-and-record' : 'auto';
    attempt(() => {
      if (previousAudioType === undefined) previousAudioType = audioSession.type;
      audioSession.type = type; assignedAudioType = type;
    });
  }
  return {
    activate({ mode, kind, context, play, pause, stop }) {
      active = true; setContext(context);
      if (!session) return;
      const title = mode === 'preview' ? '语音试听' : mode === 'transcript' ? `${kind === 'original' ? '原文' : '译文'}全文播报` : '实时译文播报';
      // Keep transcript contents and credentials off the device lock screen.
      if (Metadata) attempt(() => { session.metadata = new Metadata({ title, artist: 'HearWise' }); });
      for (const [action, handler] of Object.entries({ play, pause, stop })) attempt(() => {
        session.setActionHandler(action, handler); actions.add(action);
      });
      attempt(() => { session.playbackState = 'playing'; });
    },
    setContext,
    setPaused(paused) { if (active && session) attempt(() => { session.playbackState = paused ? 'paused' : 'playing'; }); },
    close() {
      if (!active) return;
      active = false;
      if (session) {
        for (const action of actions) attempt(() => session.setActionHandler(action, null));
        attempt(() => { session.playbackState = 'none'; });
        attempt(() => { session.metadata = null; });
      }
      actions.clear();
      if (audioSession && previousAudioType !== undefined) attempt(() => {
        if (audioSession.type === assignedAudioType) audioSession.type = previousAudioType;
      });
      previousAudioType = assignedAudioType = undefined;
    }
  };
}
