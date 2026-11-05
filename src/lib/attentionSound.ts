/**
 * The attention tone (issue #496): a short built-in beep made with the Web
 * Audio API, so no sound file ships with the app. Played when a parked
 * terminal comes back by itself or a terminal needs input, and only when the
 * Settings switch is on (the caller checks it — this module only makes noise).
 *
 * Best effort by design: no Web Audio (an old webview, the test runner) or a
 * failure to start it is logged and swallowed — the coloured chrome and the
 * blinking tabs are the guaranteed signal, the sound is reach.
 */

/** Pitch of the tone: A5, high enough to cut through but not shrill. */
export const ATTENTION_TONE_HZ = 880;
/** How long the tone lasts, in seconds. */
export const ATTENTION_TONE_SECONDS = 0.18;
/** Peak loudness (0-1): a nudge, not an alarm. */
const ATTENTION_TONE_PEAK_GAIN = 0.15;
/** Quietest level the fade-out reaches (exponential ramps cannot reach 0). */
const ATTENTION_TONE_FLOOR_GAIN = 0.0001;
/** Fade-in time, in seconds; a hard start would click. */
const ATTENTION_TONE_ATTACK_SECONDS = 0.01;

/** One context for the app's lifetime: browsers cap how many may exist. */
let audioContext: AudioContext | null = null;

function getAudioContext(): AudioContext | null {
  if (audioContext) return audioContext;
  const AudioContextClass = globalThis.AudioContext;
  if (typeof AudioContextClass !== "function") return null;
  audioContext = new AudioContextClass();
  return audioContext;
}

/** Plays the attention tone once. Never throws. */
export function playAttentionTone(): void {
  try {
    const context = getAudioContext();
    if (!context) return;
    // A context created before any user gesture starts suspended.
    if (context.state === "suspended") void context.resume();

    const start = context.currentTime;
    const end = start + ATTENTION_TONE_SECONDS;
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = "sine";
    oscillator.frequency.setValueAtTime(ATTENTION_TONE_HZ, start);
    gain.gain.setValueAtTime(ATTENTION_TONE_FLOOR_GAIN, start);
    gain.gain.exponentialRampToValueAtTime(
      ATTENTION_TONE_PEAK_GAIN,
      start + ATTENTION_TONE_ATTACK_SECONDS,
    );
    gain.gain.exponentialRampToValueAtTime(ATTENTION_TONE_FLOOR_GAIN, end);
    oscillator.connect(gain);
    gain.connect(context.destination);
    oscillator.start(start);
    oscillator.stop(end);
  } catch (err) {
    console.error("Attention sound failed:", err);
  }
}
