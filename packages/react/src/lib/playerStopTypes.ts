/**
 * Diagnostic ownership metadata for an audio player stop.
 *
 * Shared by the standalone player hook and by {@link VoiceProvider} teardown.
 */
export interface UseSoundPlayerStopOptions {
  /** Identifies cleanup performed because the owning React tree unmounted. */
  trigger?: 'unmount';
}
