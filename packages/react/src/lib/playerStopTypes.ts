/**
 * Diagnostic ownership metadata for a deprecated standalone-player stop.
 *
 * @deprecated Use {@link VoiceProvider} and {@link useVoice}.
 */
export interface UseSoundPlayerStopOptions {
  /** Identifies cleanup performed because the owning React tree unmounted. */
  trigger?: 'unmount';
}
