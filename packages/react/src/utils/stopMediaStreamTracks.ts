/** Stop every track and report every cleanup failure after all were attempted. */
export const stopMediaStreamTracks = (stream: MediaStream): void => {
  const tracks = stream.getTracks();
  const failures: unknown[] = [];

  for (const track of tracks) {
    try {
      track.stop();
    } catch (error) {
      failures.push(error);
    }
  }

  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    throw new AggregateError(
      failures,
      `${failures.length} media tracks failed to stop.`,
      { cause: failures[0] },
    );
  }
};
