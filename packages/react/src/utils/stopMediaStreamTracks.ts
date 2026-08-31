/** Stop every track and report the first cleanup failure after all were attempted. */
export const stopMediaStreamTracks = (stream: MediaStream): void => {
  const tracks = stream.getTracks();
  let firstFailure: { error: unknown } | null = null;

  for (const track of tracks) {
    try {
      track.stop();
    } catch (error) {
      firstFailure ??= { error };
    }
  }

  if (firstFailure !== null) throw firstFailure.error;
};
