// ============================================================
// fusfun — runtime configuration
// ============================================================
// Edit this file to swap icons or other paths without touching code.
// Paths are relative to index.html. Any image format <img> accepts
// works: .svg, .png, .jpg, .webp, .gif, .avif. Transparent backgrounds
// recommended so the wave field shows through.
//
// Each icon entry is either:
//   - a plain string path, e.g. 'assets/speaker.svg'
//   - an object { src, rotate } where rotate is degrees clockwise.
// ============================================================
window.FUSFUN_CONFIG = {
  icons: {
    speaker:     { src: 'assets/speaker.png', rotate: 45 },   // array elements
    freqSpeaker: { src: 'assets/speaker.png', rotate: 0 },   // preview by the freq slider
    microphone:  { src: 'assets/microphone.png', rotate: -135 },
    bubble:      { src: 'assets/bubble.png', rotate: 0 },
    play:        { src: 'assets/play.svg' },
  },
};
