import { act, renderHook, waitFor } from '@testing-library/react';
import { MimeType } from 'hume';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { VoiceDiagnosticEvent } from './diagnostics';
import { useMicrophone } from './useMicrophone';

type RecorderInstance = {
  stream: MediaStream;
  options: MediaRecorderOptions | undefined;
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  addEventListener: ReturnType<typeof vi.fn>;
  removeEventListener: ReturnType<typeof vi.fn>;
  emit: (type: string, event: Event) => void;
};

/**
 * Installs a fake `MediaRecorder`. Omitting `isTypeSupported` models an
 * environment that only partially implements the API — a polyfill, an embedded
 * WebView — which is the case that makes `getBrowserSupportedMimeType` throw
 * rather than return a result.
 */
const stubMediaRecorder = (
  isTypeSupported?: (type: string) => boolean,
  onStart?: (index: number) => void,
) => {
  const instances: RecorderInstance[] = [];

  class MediaRecorderStub {
    public options: MediaRecorderOptions | undefined;

    private listeners = new Map<
      string,
      Set<EventListenerOrEventListenerObject>
    >();

    start = vi.fn(() => {
      onStart?.(instances.indexOf(this as unknown as RecorderInstance));
    });

    stop = vi.fn(() => {
      this.emit('stop', new Event('stop'));
    });

    emit = (type: string, event: Event) => {
      this.listeners.get(type)?.forEach((listener) => {
        if (typeof listener === 'function') {
          listener.call(this as unknown as EventTarget, event);
        } else {
          listener.handleEvent(event);
        }
      });
    };

    addEventListener = vi.fn(
      (type: string, listener: EventListenerOrEventListenerObject) => {
        const listeners = this.listeners.get(type) ?? new Set();
        listeners.add(listener);
        this.listeners.set(type, listeners);
      },
    );

    removeEventListener = vi.fn(
      (type: string, listener: EventListenerOrEventListenerObject) => {
        this.listeners.get(type)?.delete(listener);
      },
    );

    constructor(
      public stream: MediaStream,
      options?: MediaRecorderOptions,
    ) {
      this.options = options;
      instances.push(this);
    }
  }

  if (isTypeSupported) {
    Object.assign(MediaRecorderStub, {
      isTypeSupported: vi.fn(isTypeSupported),
    });
  }

  vi.stubGlobal('MediaRecorder', MediaRecorderStub);

  return instances;
};

/** Builds an `isTypeSupported` that reports exactly `supported` as available. */
const supports =
  (...supported: MimeType[]) =>
  (type: string) =>
    (supported as string[]).includes(type);

const createAudioContext = () =>
  ({
    sampleRate: 48000,
    createMediaStreamSource: vi.fn(() => ({
      connect: vi.fn(),
      disconnect: vi.fn(),
    })),
    createAnalyser: vi.fn(() => ({
      fftSize: 0,
      frequencyBinCount: 1024,
      getByteFrequencyData: vi.fn(),
    })),
    close: vi.fn(() => Promise.resolve()),
  }) as unknown as AudioContext;

const stubOwnedAudioContext = (
  contextClose: () => Promise<void> = vi.fn().mockResolvedValue(undefined),
) => {
  const context = {
    ...createAudioContext(),
    close: contextClose,
  } as AudioContext;
  vi.stubGlobal(
    'AudioContext',
    vi.fn(() => context),
  );
  return { context, contextClose };
};

const createStream = (tracks: MediaStreamTrack[] = []) =>
  ({ getTracks: () => tracks }) as unknown as MediaStream;

const renderMicrophone = (
  callbacks: Pick<
    Parameters<typeof useMicrophone>[0],
    'onStartRecording' | 'onStopRecording'
  > = {},
) => {
  const onError = vi.fn();
  const onAudioCaptured = vi.fn();
  const { result, unmount } = renderHook(() =>
    useMicrophone({ onAudioCaptured, onError, ...callbacks }),
  );

  return { result, unmount, onError, onAudioCaptured };
};

const installInactiveRecorderScenario = () => {
  const recorderStop = vi.fn(() => {
    throw new DOMException('The recorder is inactive', 'InvalidStateError');
  });
  class InactiveMediaRecorder {
    static isTypeSupported = vi.fn(() => true);

    start = vi.fn();

    stop = recorderStop;

    addEventListener = vi.fn();

    removeEventListener = vi.fn();
  }
  vi.stubGlobal('MediaRecorder', InactiveMediaRecorder);

  const contextClose = vi.fn().mockResolvedValue(undefined);
  stubOwnedAudioContext(contextClose);

  const trackStop = vi.fn();
  const stream = createStream([
    { enabled: true, stop: trackStop } as unknown as MediaStreamTrack,
  ]);

  return { contextClose, recorderStop, stream, trackStop };
};

describe('useMicrophone', () => {
  beforeEach(() => {
    // The fft analyzer reschedules itself through rAF; a no-op keeps it to a
    // single pass so the loop does not outlive the test.
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn(() => 1),
    );
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('records with the mime type the browser reports as supported', () => {
    // Safari and iOS support mp4 but not webm.
    const recorders = stubMediaRecorder(supports(MimeType.MP4));
    const { result, onError } = renderMicrophone();

    result.current.start(createStream(), createAudioContext());

    expect(onError).not.toHaveBeenCalled();
    expect(recorders).toHaveLength(1);
    expect(recorders[0]?.options?.mimeType).toBe(MimeType.MP4);
  });

  it('prefers webm when the browser supports more than one type', () => {
    const recorders = stubMediaRecorder(supports(MimeType.WEBM, MimeType.MP4));
    const { result } = renderMicrophone();

    result.current.start(createStream(), createAudioContext());

    expect(recorders[0]?.options?.mimeType).toBe(MimeType.WEBM);
  });

  it('rejects a second start without abandoning the active recording', async () => {
    const recorders = stubMediaRecorder(supports(MimeType.WEBM));
    const firstTrackStop = vi.fn();
    const secondTrackStop = vi.fn();
    const firstStream = createStream([
      { enabled: true, stop: firstTrackStop } as unknown as MediaStreamTrack,
    ]);
    const secondStream = createStream([
      { enabled: true, stop: secondTrackStop } as unknown as MediaStreamTrack,
    ]);
    const { result } = renderMicrophone();

    result.current.start(firstStream, createAudioContext());

    expect(() =>
      result.current.start(secondStream, createAudioContext()),
    ).toThrow(
      'The microphone is already recording. Stop it before starting again.',
    );
    expect(recorders).toHaveLength(1);
    expect(firstTrackStop).not.toHaveBeenCalled();
    expect(secondTrackStop).not.toHaveBeenCalled();

    await act(() => result.current.stop());

    expect(recorders[0]?.removeEventListener).toHaveBeenCalledWith(
      'dataavailable',
      expect.any(Function),
    );
    expect(recorders[0]?.stop).toHaveBeenCalledOnce();
    expect(firstTrackStop).toHaveBeenCalledOnce();
    expect(secondTrackStop).not.toHaveBeenCalled();
  });

  it('captures the final dataavailable blob before removing its listener', async () => {
    const finalBuffer = new Uint8Array([1, 2, 3]).buffer;
    const finalBlob = {
      arrayBuffer: vi.fn().mockResolvedValue(finalBuffer),
    } as unknown as Blob;
    const recorders = stubMediaRecorder(supports(MimeType.WEBM));
    const { result, onAudioCaptured } = renderMicrophone();
    result.current.start(createStream(), createAudioContext());
    const recorder = recorders[0];
    if (!recorder) {
      throw new Error('Expected a MediaRecorder instance.');
    }
    recorder.stop.mockImplementationOnce(() => {
      queueMicrotask(() => {
        recorder.emit('dataavailable', {
          data: finalBlob,
        } as unknown as BlobEvent);
        recorder.emit('stop', new Event('stop'));
      });
    });

    await act(() => result.current.stop());
    await waitFor(() =>
      expect(onAudioCaptured).toHaveBeenCalledWith(finalBuffer),
    );
    expect(recorder.removeEventListener).toHaveBeenCalledWith(
      'dataavailable',
      expect.any(Function),
    );
  });

  it('preserves a mute requested before a stream existed', () => {
    stubMediaRecorder(supports(MimeType.WEBM));
    const track = {
      enabled: true,
      stop: vi.fn(),
    } as unknown as MediaStreamTrack;
    const { result } = renderMicrophone();

    act(() => result.current.mute());
    expect(result.current.isMuted).toBe(true);

    act(() =>
      result.current.start(createStream([track]), createAudioContext()),
    );

    expect(result.current.isMuted).toBe(true);
    expect(track.enabled).toBe(false);
  });

  it('invokes the public recording lifecycle callbacks', async () => {
    stubMediaRecorder(supports(MimeType.WEBM));
    const onStartRecording = vi.fn();
    const onStopRecording = vi.fn();
    const { result } = renderMicrophone({
      onStartRecording,
      onStopRecording,
    });

    result.current.start(createStream(), createAudioContext());

    expect(onStartRecording).toHaveBeenCalledOnce();
    expect(onStopRecording).not.toHaveBeenCalled();

    await act(() => result.current.stop());
    await act(() => result.current.stop());

    expect(onStopRecording).toHaveBeenCalledOnce();
  });

  it('flushes old final audio before buffered replacement audio', async () => {
    const oldFinalBuffer = new Uint8Array([1]).buffer;
    const candidateBuffer = new Uint8Array([2]).buffer;
    const oldTrackStop = vi.fn();
    const candidateTrackStop = vi.fn();
    const recorders = stubMediaRecorder(supports(MimeType.WEBM));
    const onStartRecording = vi.fn();
    const onStopRecording = vi.fn();
    const { result, onAudioCaptured } = renderMicrophone({
      onStartRecording,
      onStopRecording,
    });
    const context = createAudioContext();
    result.current.start(
      createStream([
        { enabled: true, stop: oldTrackStop } as unknown as MediaStreamTrack,
      ]),
      context,
    );
    const oldRecorder = recorders[0];
    if (!oldRecorder) {
      throw new Error('Expected the original MediaRecorder.');
    }
    oldRecorder.stop.mockImplementationOnce(() => {
      const candidateRecorder = recorders[1];
      if (!candidateRecorder) {
        throw new Error('Expected the candidate MediaRecorder.');
      }
      candidateRecorder.emit('dataavailable', {
        data: {
          arrayBuffer: vi.fn().mockResolvedValue(candidateBuffer),
        } as unknown as Blob,
      } as BlobEvent);
      oldRecorder.emit('dataavailable', {
        data: {
          arrayBuffer: vi.fn().mockResolvedValue(oldFinalBuffer),
        } as unknown as Blob,
      } as BlobEvent);
      oldRecorder.emit('stop', new Event('stop'));
    });

    await act(() =>
      result.current.replace(
        createStream([
          {
            enabled: true,
            stop: candidateTrackStop,
          } as unknown as MediaStreamTrack,
        ]),
        context,
      ),
    );

    expect(onAudioCaptured).toHaveBeenNthCalledWith(1, oldFinalBuffer);
    expect(onAudioCaptured).toHaveBeenNthCalledWith(2, candidateBuffer);
    expect(oldTrackStop).toHaveBeenCalledOnce();
    expect(candidateTrackStop).not.toHaveBeenCalled();
    expect(onStartRecording).toHaveBeenCalledOnce();
    expect(onStopRecording).not.toHaveBeenCalled();

    await act(() => result.current.stop());
    expect(onStopRecording).toHaveBeenCalledOnce();
  });

  it('retries a failed previous-stream cleanup before committing a replacement', async () => {
    const firstFailure = new Error('old track was temporarily busy');
    const oldTrackStop = vi
      .fn()
      .mockImplementationOnce(() => {
        throw firstFailure;
      })
      .mockImplementationOnce(() => undefined);
    const candidateTrackStop = vi.fn();
    stubMediaRecorder(supports(MimeType.WEBM));
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { result } = renderMicrophone();
    const context = createAudioContext();
    result.current.start(
      createStream([
        { enabled: true, stop: oldTrackStop } as unknown as MediaStreamTrack,
      ]),
      context,
    );

    await act(() =>
      result.current.replace(
        createStream([
          {
            enabled: true,
            stop: candidateTrackStop,
          } as unknown as MediaStreamTrack,
        ]),
        context,
      ),
    );

    expect(oldTrackStop).toHaveBeenCalledTimes(2);
    expect(candidateTrackStop).not.toHaveBeenCalled();

    await act(() => result.current.stop());
    expect(oldTrackStop).toHaveBeenCalledTimes(2);
    expect(candidateTrackStop).toHaveBeenCalledOnce();
    consoleWarn.mockRestore();
  });

  it('retries a retained stream during the next replacement', async () => {
    const firstFailure = new Error('old track cleanup failed');
    const retryFailure = new DOMException(
      'old track cleanup retry failed',
      'AbortError',
    );
    const oldTrackStop = vi
      .fn()
      .mockImplementationOnce(() => {
        throw firstFailure;
      })
      .mockImplementationOnce(() => {
        throw retryFailure;
      })
      .mockImplementationOnce(() => undefined);
    const candidateTrackStop = vi.fn();
    const nextCandidateTrackStop = vi.fn();
    stubMediaRecorder(supports(MimeType.WEBM));
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { result } = renderMicrophone();
    const context = createAudioContext();
    result.current.start(
      createStream([
        { enabled: true, stop: oldTrackStop } as unknown as MediaStreamTrack,
      ]),
      context,
    );

    await act(() =>
      result.current.replace(
        createStream([
          {
            enabled: true,
            stop: candidateTrackStop,
          } as unknown as MediaStreamTrack,
        ]),
        context,
      ),
    );

    expect(oldTrackStop).toHaveBeenCalledTimes(2);
    expect(candidateTrackStop).not.toHaveBeenCalled();
    const cleanupEvent = consoleWarn.mock.calls[0]?.[1] as unknown as
      | VoiceDiagnosticEvent
      | undefined;
    const cleanupError = cleanupEvent?.details['error'];
    expect(cleanupError).toMatchObject({
      name: 'AggregateError',
    });
    const serializedCleanupError = JSON.stringify(cleanupError);
    expect(serializedCleanupError).toContain(
      'Failed to retire previous microphone resources after retry.',
    );
    expect(serializedCleanupError).toContain('old track cleanup failed');
    expect(serializedCleanupError).toContain('old track cleanup retry failed');

    await act(() =>
      result.current.replace(
        createStream([
          {
            enabled: true,
            stop: nextCandidateTrackStop,
          } as unknown as MediaStreamTrack,
        ]),
        context,
      ),
    );
    expect(oldTrackStop).toHaveBeenCalledTimes(3);
    expect(candidateTrackStop).toHaveBeenCalledOnce();
    expect(nextCandidateTrackStop).not.toHaveBeenCalled();

    await act(() => result.current.stop());
    expect(nextCandidateTrackStop).toHaveBeenCalledOnce();
    consoleWarn.mockRestore();
  });

  it('does not retry an older retained stream twice when the current stream also fails', async () => {
    const retainedTrackStop = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error('retained stream still busy');
      })
      .mockImplementationOnce(() => {
        throw new Error('retained stream still busy');
      })
      .mockImplementationOnce(() => {
        throw new Error('retained stream still busy');
      })
      .mockImplementationOnce(() => undefined);
    const currentTrackStop = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error('current stream temporarily busy');
      })
      .mockImplementationOnce(() => undefined);
    const candidateTrackStop = vi.fn();
    stubMediaRecorder(supports(MimeType.WEBM));
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { result } = renderMicrophone();
    const context = createAudioContext();
    result.current.start(
      createStream([
        {
          enabled: true,
          stop: retainedTrackStop,
        } as unknown as MediaStreamTrack,
      ]),
      context,
    );

    await act(() =>
      result.current.replace(
        createStream([
          {
            enabled: true,
            stop: currentTrackStop,
          } as unknown as MediaStreamTrack,
        ]),
        context,
      ),
    );
    expect(retainedTrackStop).toHaveBeenCalledTimes(2);

    await act(() =>
      result.current.replace(
        createStream([
          {
            enabled: true,
            stop: candidateTrackStop,
          } as unknown as MediaStreamTrack,
        ]),
        context,
      ),
    );

    expect(retainedTrackStop).toHaveBeenCalledTimes(3);
    expect(currentTrackStop).toHaveBeenCalledTimes(2);
    expect(candidateTrackStop).not.toHaveBeenCalled();

    await act(() => result.current.stop());
    expect(retainedTrackStop).toHaveBeenCalledTimes(4);
    expect(candidateTrackStop).toHaveBeenCalledOnce();
    consoleWarn.mockRestore();
  });

  it('preserves mute state across a replacement', async () => {
    stubMediaRecorder(supports(MimeType.WEBM));
    const oldTrack = {
      enabled: true,
      stop: vi.fn(),
    } as unknown as MediaStreamTrack;
    const candidateTrack = {
      enabled: true,
      stop: vi.fn(),
    } as unknown as MediaStreamTrack;
    const { result } = renderMicrophone();
    const context = createAudioContext();
    result.current.start(createStream([oldTrack]), context);
    act(() => result.current.mute());

    await act(() =>
      result.current.replace(createStream([candidateTrack]), context),
    );

    expect(result.current.isMuted).toBe(true);
    expect(candidateTrack.enabled).toBe(false);
  });

  it('queues stop behind an in-progress replacement', async () => {
    const oldTrackStop = vi.fn();
    const candidateTrackStop = vi.fn();
    const recorders = stubMediaRecorder(supports(MimeType.WEBM));
    const { result } = renderMicrophone();
    const context = createAudioContext();
    result.current.start(
      createStream([
        { enabled: true, stop: oldTrackStop } as unknown as MediaStreamTrack,
      ]),
      context,
    );
    const oldRecorder = recorders[0];
    if (!oldRecorder) {
      throw new Error('Expected the original MediaRecorder.');
    }
    oldRecorder.stop.mockImplementationOnce(() => {});

    let replacement = Promise.resolve();
    let stopping = Promise.resolve();
    let stopSettled = false;
    act(() => {
      replacement = result.current.replace(
        createStream([
          {
            enabled: true,
            stop: candidateTrackStop,
          } as unknown as MediaStreamTrack,
        ]),
        context,
      );
    });
    await waitFor(() => expect(oldRecorder.stop).toHaveBeenCalledOnce());

    act(() => {
      stopping = result.current.stop().then(() => {
        stopSettled = true;
      });
    });
    await act(() => Promise.resolve());

    expect(stopSettled).toBe(false);
    expect(candidateTrackStop).not.toHaveBeenCalled();

    await act(async () => {
      oldRecorder.emit('stop', new Event('stop'));
      await Promise.all([replacement, stopping]);
    });

    expect(oldTrackStop).toHaveBeenCalledOnce();
    expect(recorders[1]?.stop).toHaveBeenCalledOnce();
    expect(candidateTrackStop).toHaveBeenCalledOnce();
    expect(stopSettled).toBe(true);
  });

  it('blocks start while a queued stop can still observe microphone resources', async () => {
    const recorders = stubMediaRecorder(supports(MimeType.WEBM));
    const oldTrackStop = vi.fn();
    const newTrackStop = vi.fn();
    const { result } = renderMicrophone();
    const context = createAudioContext();
    result.current.start(
      createStream([
        { enabled: true, stop: oldTrackStop } as unknown as MediaStreamTrack,
      ]),
      context,
    );
    const oldRecorder = recorders[0];
    if (!oldRecorder) {
      throw new Error('Expected the original MediaRecorder.');
    }
    oldRecorder.stop.mockImplementationOnce(() => {});

    let firstStop = Promise.resolve();
    let secondStop = Promise.resolve();
    act(() => {
      firstStop = result.current.stop();
      secondStop = result.current.stop();
    });
    await waitFor(() => expect(oldRecorder.stop).toHaveBeenCalledOnce());

    expect(() =>
      result.current.start(
        createStream([
          { enabled: true, stop: newTrackStop } as unknown as MediaStreamTrack,
        ]),
        context,
      ),
    ).toThrow(
      'A microphone operation is still in progress. Wait for it before starting again.',
    );
    expect(recorders).toHaveLength(1);
    expect(newTrackStop).not.toHaveBeenCalled();

    await act(async () => {
      oldRecorder.emit('stop', new Event('stop'));
      await Promise.all([firstStop, secondStop]);
    });

    result.current.start(
      createStream([
        { enabled: true, stop: newTrackStop } as unknown as MediaStreamTrack,
      ]),
      context,
    );
    expect(recorders).toHaveLength(2);
  });

  it('cancels a queued replacement when the hook unmounts', async () => {
    const recorders = stubMediaRecorder(supports(MimeType.WEBM));
    const oldTrackStop = vi.fn();
    const candidateTrackStop = vi.fn();
    const { result, unmount, onAudioCaptured } = renderMicrophone();
    const context = createAudioContext();
    result.current.start(
      createStream([
        { enabled: true, stop: oldTrackStop } as unknown as MediaStreamTrack,
      ]),
      context,
    );
    const oldRecorder = recorders[0];
    if (!oldRecorder) {
      throw new Error('Expected the original MediaRecorder.');
    }
    oldRecorder.stop.mockImplementationOnce(() => {});

    const stopping = result.current.stop();
    await waitFor(() => expect(oldRecorder.stop).toHaveBeenCalledOnce());
    const replacementOutcome = result.current
      .replace(
        createStream([
          {
            enabled: true,
            stop: candidateTrackStop,
          } as unknown as MediaStreamTrack,
        ]),
        context,
      )
      .catch((error: unknown) => error);

    unmount();
    await act(async () => {
      oldRecorder.emit('stop', new Event('stop'));
      await stopping;
    });

    await expect(replacementOutcome).resolves.toMatchObject({
      name: 'AbortError',
    });
    expect(recorders).toHaveLength(1);
    expect(candidateTrackStop).toHaveBeenCalledOnce();
    expect(onAudioCaptured).not.toHaveBeenCalled();
  });

  it('disposes an in-progress replacement without forwarding audio after unmount', async () => {
    const recorders = stubMediaRecorder(supports(MimeType.WEBM));
    const oldTrackStop = vi.fn();
    const candidateTrackStop = vi.fn();
    const { result, unmount, onAudioCaptured } = renderMicrophone();
    const context = createAudioContext();
    result.current.start(
      createStream([
        { enabled: true, stop: oldTrackStop } as unknown as MediaStreamTrack,
      ]),
      context,
    );
    const oldRecorder = recorders[0];
    if (!oldRecorder) {
      throw new Error('Expected the original MediaRecorder.');
    }
    oldRecorder.stop.mockImplementationOnce(() => {});

    const replacementOutcome = result.current
      .replace(
        createStream([
          {
            enabled: true,
            stop: candidateTrackStop,
          } as unknown as MediaStreamTrack,
        ]),
        context,
      )
      .catch((error: unknown) => error);
    await waitFor(() => expect(recorders).toHaveLength(2));
    const candidateRecorder = recorders[1];
    if (!candidateRecorder) {
      throw new Error('Expected the candidate MediaRecorder.');
    }
    candidateRecorder.emit('dataavailable', {
      data: {
        arrayBuffer: vi.fn().mockResolvedValue(new Uint8Array([9]).buffer),
      } as unknown as Blob,
    } as BlobEvent);

    unmount();
    await act(async () => {
      oldRecorder.emit('stop', new Event('stop'));
      await Promise.resolve();
    });

    await expect(replacementOutcome).resolves.toMatchObject({
      name: 'AbortError',
    });
    expect(candidateRecorder.stop).toHaveBeenCalledOnce();
    expect(candidateTrackStop).toHaveBeenCalledOnce();
    expect(onAudioCaptured).not.toHaveBeenCalled();
  });

  it('keeps the original capture when candidate recorder startup fails', async () => {
    const recorders = stubMediaRecorder(supports(MimeType.WEBM), (index) => {
      if (index === 1) {
        throw new Error('candidate start failed');
      }
    });
    const oldTrackStop = vi.fn();
    const candidateTrackStop = vi.fn();
    const oldStream = createStream([
      { enabled: true, stop: oldTrackStop } as unknown as MediaStreamTrack,
    ]);
    const candidateStream = createStream([
      {
        enabled: true,
        stop: candidateTrackStop,
      } as unknown as MediaStreamTrack,
    ]);
    const { result, onAudioCaptured } = renderMicrophone();
    const context = createAudioContext();
    result.current.start(oldStream, context);

    await expect(
      result.current.replace(candidateStream, context),
    ).rejects.toThrow('candidate start failed');

    expect(oldTrackStop).not.toHaveBeenCalled();
    expect(candidateTrackStop).toHaveBeenCalledOnce();
    expect(recorders[0]?.stop).not.toHaveBeenCalled();

    const stillActiveBuffer = new Uint8Array([3]).buffer;
    recorders[0]?.emit('dataavailable', {
      data: {
        arrayBuffer: vi.fn().mockResolvedValue(stillActiveBuffer),
      } as unknown as Blob,
    } as BlobEvent);
    await waitFor(() =>
      expect(onAudioCaptured).toHaveBeenCalledWith(stillActiveBuffer),
    );
  });

  it('reports an error and refuses to record when MediaRecorder is absent', () => {
    vi.stubGlobal('MediaRecorder', undefined);
    const { result, onError } = renderMicrophone();
    const context = createAudioContext();
    const createMediaStreamSource = vi.spyOn(
      context,
      'createMediaStreamSource',
    );

    expect(onError).toHaveBeenCalledWith(
      'MediaRecorder is not supported',
      'mime_types_not_supported',
    );
    expect(() => result.current.start(createStream(), context)).toThrow(
      'No MimeType specified',
    );
    expect(createMediaStreamSource).not.toHaveBeenCalled();
    expect(requestAnimationFrame).not.toHaveBeenCalled();
  });

  it('reports an error when no candidate mime type is supported', () => {
    stubMediaRecorder(supports());
    const { result, onError } = renderMicrophone();

    expect(onError).toHaveBeenCalledWith(
      'Browser does not support any compatible mime types',
      'mime_types_not_supported',
    );
    expect(() =>
      result.current.start(createStream(), createAudioContext()),
    ).toThrow('No MimeType specified');
  });

  it('reports an error rather than throwing when MediaRecorder is partially implemented', () => {
    stubMediaRecorder();
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => {});
    const { result, onError } = renderMicrophone();

    expect(onError).toHaveBeenCalledWith(
      'This browser does not fully support microphone recording.',
      'mime_types_not_supported',
    );
    expect(consoleError.mock.calls[0]?.[0]).toBe(
      '[Hume Voice][microphone] resource.cleanup_failed',
    );
    const mimeErrorEvent = consoleError.mock.calls[0]?.[1] as unknown as
      | VoiceDiagnosticEvent
      | undefined;
    expect(mimeErrorEvent?.details['message']).toBe(
      'Failed to detect supported microphone MIME types.',
    );
    expect(mimeErrorEvent?.details['error']).toMatchObject({
      name: 'TypeError',
    });
    expect(() =>
      result.current.start(createStream(), createAudioContext()),
    ).toThrow('No MimeType specified');
    consoleError.mockRestore();
  });

  it('rolls back claimed resources when recorder construction fails', async () => {
    class FailingMediaRecorder {
      static isTypeSupported = vi.fn(() => true);

      constructor() {
        throw new Error('recorder construction failed');
      }
    }
    vi.stubGlobal('MediaRecorder', FailingMediaRecorder);
    const sourceDisconnect = vi.fn();
    const contextClose = vi.fn().mockResolvedValue(undefined);
    const context = {
      sampleRate: 48000,
      createMediaStreamSource: vi.fn(() => ({
        connect: vi.fn(),
        disconnect: sourceDisconnect,
      })),
      createAnalyser: vi.fn(() => ({
        fftSize: 0,
        frequencyBinCount: 1024,
        getByteFrequencyData: vi.fn(),
      })),
      close: contextClose,
    } as unknown as AudioContext;
    vi.stubGlobal(
      'AudioContext',
      vi.fn(() => context),
    );
    const trackStop = vi.fn();
    const stream = {
      getTracks: () => [{ stop: trackStop }],
    } as unknown as MediaStream;
    const { result } = renderMicrophone();

    expect(() => result.current.start(stream)).toThrow(
      'recorder construction failed',
    );
    await waitFor(() => {
      expect(sourceDisconnect).toHaveBeenCalledOnce();
      expect(cancelAnimationFrame).toHaveBeenCalledWith(1);
      expect(trackStop).toHaveBeenCalledOnce();
      expect(contextClose).toHaveBeenCalledOnce();
    });
  });

  it('releases the stream and owned audio context when recorder cleanup throws', async () => {
    const { contextClose, recorderStop, stream, trackStop } =
      installInactiveRecorderScenario();
    const { result, unmount } = renderMicrophone();
    result.current.start(stream);

    expect(() => unmount()).not.toThrow();
    await waitFor(() => expect(recorderStop).toHaveBeenCalledOnce());
    expect(trackStop).toHaveBeenCalledOnce();
    expect(contextClose).toHaveBeenCalledOnce();
  });

  it('releases the stream and owned audio context when stopping an inactive recorder', async () => {
    const { contextClose, recorderStop, stream, trackStop } =
      installInactiveRecorderScenario();
    const { result } = renderMicrophone();
    result.current.start(stream);

    await act(() => result.current.stop());

    expect(recorderStop).toHaveBeenCalledOnce();
    expect(trackStop).toHaveBeenCalledOnce();
    expect(contextClose).toHaveBeenCalledOnce();
  });

  it('attempts every track and reports an explicit-stop cleanup failure', async () => {
    stubMediaRecorder(supports(MimeType.WEBM));
    const firstTrackStop = vi.fn().mockImplementationOnce(() => {
      throw new Error('first track failed');
    });
    const secondTrackStop = vi.fn();
    const contextClose = vi.fn().mockResolvedValue(undefined);
    stubOwnedAudioContext(contextClose);
    const stream = createStream([
      { enabled: true, stop: firstTrackStop } as unknown as MediaStreamTrack,
      { enabled: true, stop: secondTrackStop } as unknown as MediaStreamTrack,
    ]);
    const { result, onError } = renderMicrophone();
    result.current.start(stream);

    await act(() => result.current.stop());

    expect(firstTrackStop).toHaveBeenCalledOnce();
    expect(secondTrackStop).toHaveBeenCalledOnce();
    expect(contextClose).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledWith(
      expect.stringContaining('Media track 1 cleanup failed'),
      'mic_closure_failure',
    );
  });

  it('preserves mute intent while a failed track remains attached', async () => {
    stubMediaRecorder(supports(MimeType.WEBM));
    const trackStop = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error('track still live');
      })
      .mockImplementationOnce(() => undefined);
    const track = {
      enabled: true,
      stop: trackStop,
    } as unknown as MediaStreamTrack;
    const { result, onError } = renderMicrophone();
    result.current.start(createStream([track]), createAudioContext());
    act(() => result.current.mute());

    await act(() => result.current.stop());

    expect(onError).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledWith(
      expect.stringContaining('Media track 1 cleanup failed'),
      'mic_closure_failure',
    );
    expect(result.current.isMuted).toBe(true);
    expect(track.enabled).toBe(false);

    await act(() => result.current.stop());
    expect(result.current.isMuted).toBe(false);
  });

  it('shares one timeout between recorder stop and final data flushing', async () => {
    vi.useFakeTimers();
    const recorders = stubMediaRecorder(supports(MimeType.WEBM));
    const pendingBlob = {
      arrayBuffer: vi.fn(() => new Promise<ArrayBuffer>(() => {})),
    } as unknown as Blob;
    const { result, onError } = renderMicrophone();
    result.current.start(createStream(), createAudioContext());
    const recorder = recorders[0];
    if (!recorder) {
      throw new Error('Expected a MediaRecorder instance.');
    }
    recorder.stop.mockImplementationOnce(() => {
      setTimeout(() => {
        recorder.emit('dataavailable', {
          data: pendingBlob,
        } as unknown as BlobEvent);
        recorder.emit('stop', new Event('stop'));
      }, 750);
    });

    let stopped = false;
    const stopping = result.current.stop().then(() => {
      stopped = true;
    });

    await act(() => vi.advanceTimersByTimeAsync(999));
    expect(stopped).toBe(false);

    await act(() => vi.advanceTimersByTimeAsync(1));
    await stopping;
    expect(stopped).toBe(true);
    expect(onError).toHaveBeenCalledWith(
      expect.stringContaining('final audio data timed out'),
      'mic_closure_failure',
    );
  });

  it('continues unmount cleanup when stopping a track throws', async () => {
    stubMediaRecorder(supports(MimeType.WEBM));
    const firstTrackStop = vi.fn(() => {
      throw new Error('first track failed');
    });
    const secondTrackStop = vi.fn();
    const contextClose = vi.fn().mockResolvedValue(undefined);
    stubOwnedAudioContext(contextClose);
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => {});
    const stream = createStream([
      { enabled: true, stop: firstTrackStop } as unknown as MediaStreamTrack,
      { enabled: true, stop: secondTrackStop } as unknown as MediaStreamTrack,
    ]);
    const { result, unmount } = renderMicrophone();
    result.current.start(stream);

    expect(() => unmount()).not.toThrow();
    await act(() => Promise.resolve());

    expect(firstTrackStop).toHaveBeenCalledOnce();
    expect(secondTrackStop).toHaveBeenCalledOnce();
    expect(contextClose).toHaveBeenCalledOnce();
    expect(consoleError.mock.calls[0]?.[0]).toBe(
      '[Hume Voice][microphone] resource.cleanup_failed',
    );
    const cleanupErrorEvent = consoleError.mock.calls[0]?.[1] as unknown as
      | VoiceDiagnosticEvent
      | undefined;
    expect(cleanupErrorEvent?.details['message']).toBe(
      'Failed to fully dispose microphone resources during unmount.',
    );
    expect(cleanupErrorEvent?.details['error']).toMatchObject({
      name: 'Error',
    });
    consoleError.mockRestore();
  });

  it('retains a stream for a later cleanup attempt when track enumeration fails', async () => {
    stubMediaRecorder(supports(MimeType.WEBM));
    const trackStop = vi.fn();
    const getTracks = vi
      .fn<() => MediaStreamTrack[]>()
      .mockImplementationOnce(() => {
        throw new Error('enumeration failed');
      })
      .mockReturnValue([
        { enabled: true, stop: trackStop } as unknown as MediaStreamTrack,
      ]);
    const stream = { getTracks } as unknown as MediaStream;
    const { result, onError } = renderMicrophone();
    result.current.start(stream, createAudioContext());

    await act(() => result.current.stop());

    expect(onError).toHaveBeenCalledWith(
      expect.stringContaining('Media track enumeration failed'),
      'mic_closure_failure',
    );
    expect(trackStop).not.toHaveBeenCalled();
    expect(() =>
      result.current.start(createStream(), createAudioContext()),
    ).toThrow(
      'The microphone is already recording. Stop it before starting again.',
    );

    await act(() => result.current.stop());
    expect(trackStop).toHaveBeenCalledOnce();
  });

  it('reports recorder stop failures and retains the recorder for retry', async () => {
    const recorders = stubMediaRecorder(supports(MimeType.WEBM));
    const { result, onError } = renderMicrophone();
    result.current.start(createStream(), createAudioContext());
    recorders[0]?.stop.mockImplementationOnce(() => {
      throw new Error('recorder stop failed');
    });

    await act(() => result.current.stop());

    expect(onError).toHaveBeenCalledWith(
      expect.stringContaining('Recorder cleanup failed'),
      'mic_closure_failure',
    );
    expect(() =>
      result.current.start(createStream(), createAudioContext()),
    ).toThrow(
      'The microphone is already recording. Stop it before starting again.',
    );

    await act(() => result.current.stop());
    expect(recorders[0]?.stop).toHaveBeenCalledTimes(2);
  });

  it('clears the published microphone FFT snapshot when stopped', async () => {
    const rafCallbacks = new Map<number, FrameRequestCallback>();
    let nextRafId = 1;
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn((callback: FrameRequestCallback) => {
        const id = nextRafId++;
        rafCallbacks.set(id, callback);
        return id;
      }),
    );
    vi.stubGlobal(
      'cancelAnimationFrame',
      vi.fn((id: number) => rafCallbacks.delete(id)),
    );
    stubMediaRecorder(supports(MimeType.WEBM));
    const context = {
      ...createAudioContext(),
      createAnalyser: vi.fn(() => ({
        fftSize: 0,
        frequencyBinCount: 1024,
        getByteFrequencyData: vi.fn((data: Uint8Array) => data.fill(255)),
      })),
    } as unknown as AudioContext;
    const { result } = renderMicrophone();

    result.current.start(createStream(), context);
    act(() => rafCallbacks.get(1)?.(0));
    expect(
      result.current.fftStore.getSnapshot().some((value) => value > 0),
    ).toBe(true);

    await act(() => result.current.stop());
    expect(
      result.current.fftStore.getSnapshot().every((value) => value === 0),
    ).toBe(true);
  });

  it('reports cleanup failures while rolling back a failed start', async () => {
    class FailingMediaRecorder {
      static isTypeSupported = vi.fn(() => true);

      constructor() {
        throw new Error('recorder construction failed');
      }
    }
    vi.stubGlobal('MediaRecorder', FailingMediaRecorder);
    const trackStop = vi.fn().mockImplementationOnce(() => {
      throw new Error('rollback track failed');
    });
    const stream = createStream([
      { enabled: true, stop: trackStop } as unknown as MediaStreamTrack,
    ]);
    const { result, onError } = renderMicrophone();

    expect(() => result.current.start(stream, createAudioContext())).toThrow(
      'recorder construction failed',
    );
    await act(async () => {
      await Promise.resolve();
    });

    expect(onError).toHaveBeenCalledWith(
      expect.stringContaining('rollback track failed'),
      'mic_closure_failure',
    );
    await act(() => result.current.stop());
    expect(trackStop).toHaveBeenCalledTimes(2);
  });

  it('bounds an owned audio context that never closes', async () => {
    vi.useFakeTimers();
    stubMediaRecorder(supports(MimeType.WEBM));
    const contextClose = vi.fn(() => new Promise<void>(() => {}));
    stubOwnedAudioContext(contextClose);
    const { result, onError } = renderMicrophone();
    result.current.start(createStream());

    let stopped = false;
    const stopping = result.current.stop().then(() => {
      stopped = true;
    });

    await act(() => vi.advanceTimersByTimeAsync(999));
    expect(contextClose).toHaveBeenCalledOnce();
    expect(stopped).toBe(false);

    await act(() => vi.advanceTimersByTimeAsync(1));
    await stopping;
    expect(stopped).toBe(true);
    expect(onError).toHaveBeenCalledWith(
      expect.stringContaining('Audio context close timed out.'),
      'mic_closure_failure',
    );
  });
});
