let context: AudioContext | null = null;

/* Browsers keep audio muted until the person interacts with the page, so the context is created
and resumed on the first click or key press. */
export function unlockChime(): () => void {
  const unlock = () => {
    try {
      context ??= new AudioContext();
      void context.resume();
    } catch {
      context = null;
    }
  };
  window.addEventListener('pointerdown', unlock, {once: true});
  window.addEventListener('keydown', unlock, {once: true});
  return () => {
    window.removeEventListener('pointerdown', unlock);
    window.removeEventListener('keydown', unlock);
  };
}

/** A short two-note chime for a new visitor message. Silent until the page has been interacted with. */
export function playChime(): void {
  if (!context || context.state !== 'running') {
    return;
  }
  const start = context.currentTime;
  for (const [frequency, offset] of [
    [880, 0],
    [1318.5, 0.12],
  ] as const) {
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = 'sine';
    oscillator.frequency.value = frequency;
    gain.gain.setValueAtTime(0.0001, start + offset);
    gain.gain.exponentialRampToValueAtTime(0.15, start + offset + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + offset + 0.35);
    oscillator.connect(gain).connect(context.destination);
    oscillator.start(start + offset);
    oscillator.stop(start + offset + 0.4);
  }
}
