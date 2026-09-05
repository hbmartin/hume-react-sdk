import { act, renderHook, waitFor } from '@testing-library/react';
import { MimeType } from 'hume';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createVoiceDiagnosticsReporter,
  type VoiceDiagnosticEvent,
} from './diagnostics';
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
      onStart?.(instances.indexOf(this));
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
    vi.fn(function AudioContextMock() {
      return context;
    }),
  );
  return { context, contextClose };
};

const createStream = (
  tracks: MediaStreamTrack[] = [],
  audioTracks: MediaStreamTrack[] = tracks,
) =>
  ({
    getTracks: () => tracks,
    getAudioTracks: () => audioTracks,
  }) as unknown as MediaStream;

const renderMicrophone = (
  callbacks: Pick<
    Parameters<typeof useMicrophone>[0],
    'diagnostics' | 'onStartRecording' | 'onStopRecording'
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

  it('mutes only audio tracks and restores their previous enabled state', () => {
    stubMediaRecorder(supports(MimeType.WEBM));
    const enabledAudioTrack = {
      enabled: true,
      stop: vi.fn(),
    } as unknown as MediaStreamTrack;
    const disabledAudioTrack = {
      enabled: false,
      stop: vi.fn(),
    } as unknown as MediaStreamTrack;
    const videoTrack = {
      enabled: true,
      stop: vi.fn(),
    } as unknown as MediaStreamTrack;
    const stream = createStream(
      [enabledAudioTrack, disabledAudioTrack, videoTrack],
      [enabledAudioTrack, disabledAudioTrack],
    );
    const { result } = renderMicrophone();
    result.current.start(stream, createAudioContext());

    act(() => result.current.mute());

    expect(enabledAudioTrack.enabled).toBe(false);
    expect(disabledAudioTrack.enabled).toBe(false);
    expect(videoTrack.enabled).toBe(true);

    act(() => result.current.unmute());

    expect(enabledAudioTrack.enabled).toBe(true);
    expect(disabledAudioTrack.enabled).toBe(false);
    expect(videoTrack.enabled).toBe(true);
  });

  it('keeps successfully muted tracks disabled when another track rejects mute', () => {
    stubMediaRecorder(supports(MimeType.WEBM));
    const events: VoiceDiagnosticEvent[] = [];
    const diagnostics = createVoiceDiagnosticsReporter(() => ({
      logger: false,
      onEvent: (event) => events.push(event),
    }));
    const mutedTrack = {
      enabled: true,
      stop: vi.fn(),
    } as unknown as MediaStreamTrack;
    let stubbornEnabled = true;
    const stubbornTrack = { stop: vi.fn() } as unknown as MediaStreamTrack;
    Object.defineProperty(stubbornTrack, 'enabled', {
      configurable: true,
      get: () => stubbornEnabled,
      set(value: boolean) {
        if (!value) throw new Error('track refused mute');
        stubbornEnabled = value;
      },
    });
    const { result } = renderMicrophone({ diagnostics });
    result.current.start(
      createStream([mutedTrack, stubbornTrack]),
      createAudioContext(),
    );

    act(() => result.current.mute());

    expect(mutedTrack.enabled).toBe(false);
    expect(stubbornTrack.enabled).toBe(true);
    expect(result.current.isMuted).toBe(false);
    expect(events.at(-1)).toMatchObject({
      name: 'control.change_failed',
      details: {
        value: true,
        error: { message: 'track refused mute' },
      },
    });

    act(() => result.current.unmute());
    expect(mutedTrack.enabled).toBe(true);
  });

  it('leaves a track muted when its setter throws after applying the value', () => {
    stubMediaRecorder(supports(MimeType.WEBM));
    let enabled = true;
    const track = { stop: vi.fn() } as unknown as MediaStreamTrack;
    Object.defineProperty(track, 'enabled', {
      configurable: true,
      get: () => enabled,
      set(value: boolean) {
        enabled = value;
        if (!value) throw new Error('mute failed after applying');
      },
    });
    const { result } = renderMicrophone();
    result.current.start(createStream([track]), createAudioContext());

    act(() => result.current.mute());

    expect(track.enabled).toBe(false);
    expect(result.current.isMuted).toBe(false);

    act(() => result.current.unmute());
    expect(track.enabled).toBe(true);
  });

  it('clears a stale FFT snapshot when muted without an analyzer', () => {
    let flushFft: FrameRequestCallback | undefined;
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn((callback: FrameRequestCallback) => {
        flushFft = callback;
        return 1;
      }),
    );
    const { result } = renderMicrophone();
    result.current.fftStore.write(Array.from({ length: 24 }, () => 1));
    act(() => flushFft?.(0));
    expect(
      result.current.fftStore.getSnapshot().some((value) => value > 0),
    ).toBe(true);
    const onFftChange = vi.fn();
    const unsubscribe = result.current.fftStore.subscribe(onFftChange);

    act(() => result.current.mute());

    expect(
      result.current.fftStore.getSnapshot().every((value) => value === 0),
    ).toBe(true);
    expect(onFftChange).toHaveBeenCalledOnce();
    const mutedSnapshot = result.current.fftStore.getSnapshot();

    act(() => result.current.mute());

    expect(onFftChange).toHaveBeenCalledOnce();
    expect(result.current.fftStore.getSnapshot()).toBe(mutedSnapshot);
    unsubscribe();
  });

  it('does not let the analyzer republish FFT data while muted', () => {
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
    const getByteFrequencyData = vi.fn((data: Uint8Array) => data.fill(255));
    const context = {
      ...createAudioContext(),
      createAnalyser: vi.fn(() => ({
        fftSize: 0,
        frequencyBinCount: 1024,
        getByteFrequencyData,
      })),
    } as unknown as AudioContext;
    const { result } = renderMicrophone();

    result.current.start(createStream(), context);
    act(() => {
      // The first RAF publishes the sample already read synchronously by
      // startFftAnalyzer; the analyzer's next draw is RAF 2.
      const flush = rafCallbacks.get(1);
      rafCallbacks.delete(1);
      flush?.(0);
    });
    expect(
      result.current.fftStore.getSnapshot().some((value) => value > 0),
    ).toBe(true);

    act(() => result.current.mute());

    expect(cancelAnimationFrame).toHaveBeenCalledWith(2);
    expect(requestAnimationFrame).toHaveBeenCalledTimes(2);
    expect(rafCallbacks.size).toBe(0);
    expect(getByteFrequencyData).toHaveBeenCalledOnce();
    expect(
      result.current.fftStore.getSnapshot().every((value) => value === 0),
    ).toBe(true);

    act(() => result.current.unmute());

    expect(getByteFrequencyData).toHaveBeenCalledTimes(2);
    expect(requestAnimationFrame).toHaveBeenCalledTimes(4);
    expect(rafCallbacks.has(3)).toBe(true);
    expect(rafCallbacks.has(4)).toBe(true);
  });

  it('keeps mute state unchanged and reports when track enumeration fails', () => {
    stubMediaRecorder(supports(MimeType.WEBM));
    const events: VoiceDiagnosticEvent[] = [];
    const diagnostics = createVoiceDiagnosticsReporter(() => ({
      logger: false,
      onEvent: (event) => events.push(event),
    }));
    const track = {
      enabled: true,
      stop: vi.fn(),
    } as unknown as MediaStreamTrack;
    const stream = {
      getTracks: () => [track],
      getAudioTracks: () => {
        throw new Error('audio track enumeration failed');
      },
    } as unknown as MediaStream;
    const { result } = renderMicrophone({ diagnostics });
    result.current.start(stream, createAudioContext());

    act(() => result.current.mute());

    expect(result.current.isMuted).toBe(false);
    expect(track.enabled).toBe(true);
    expect(events.at(-1)).toMatchObject({
      level: 'warn',
      category: 'microphone',
      name: 'control.change_failed',
      details: {
        control: 'microphone_mute',
        value: true,
        error: { message: 'audio track enumeration failed' },
      },
    });
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

  it('finishes cleanup and isolates onStopRecording from resource failures', async () => {
    stubMediaRecorder(supports(MimeType.WEBM));
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const callbackFailure = new Error('consumer stop callback failed');
    const onStopRecording = vi.fn(() => {
      throw callbackFailure;
    });
    const trackStop = vi.fn().mockImplementationOnce(() => {
      throw new Error('track cleanup failed');
    });
    const contextClose = vi.fn().mockResolvedValue(undefined);
    stubOwnedAudioContext(contextClose);
    const { result, onError } = renderMicrophone({ onStopRecording });
    result.current.start(
      createStream([
        { enabled: true, stop: trackStop } as unknown as MediaStreamTrack,
      ]),
    );

    await act(() => result.current.stop());

    expect(onStopRecording).toHaveBeenCalledOnce();
    expect(contextClose).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledWith(
      expect.stringContaining('Media track 1 cleanup failed'),
      'mic_closure_failure',
    );
    expect(onError.mock.calls[0]?.[0]).not.toContain(
      'onStopRecording callback failed',
    );
    expect(consoleWarn.mock.calls[0]?.[0]).toBe(
      '[Hume Voice][consumer] consumer.callback_failed',
    );
    const callbackEvent = consoleWarn.mock.calls[0]?.[1] as unknown as
      | VoiceDiagnosticEvent
      | undefined;
    expect(callbackEvent?.details['callback']).toBe('onStopRecording');
    consoleWarn.mockRestore();
  });

  it('does not misclassify an isolated onStopRecording failure as cleanup', async () => {
    stubMediaRecorder(supports(MimeType.WEBM));
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const onStopRecording = vi.fn(() => {
      throw new Error('consumer stop callback failed');
    });
    const contextClose = vi.fn().mockResolvedValue(undefined);
    stubOwnedAudioContext(contextClose);
    const { result, onError } = renderMicrophone({ onStopRecording });
    result.current.start(createStream());

    await act(() => result.current.stop());

    expect(contextClose).toHaveBeenCalledOnce();
    expect(onError).not.toHaveBeenCalled();
    expect(consoleWarn.mock.calls[0]?.[0]).toBe(
      '[Hume Voice][consumer] consumer.callback_failed',
    );
    const callbackEvent = consoleWarn.mock.calls[0]?.[1] as unknown as
      | VoiceDiagnosticEvent
      | undefined;
    expect(callbackEvent?.details['callback']).toBe('onStopRecording');
    consoleWarn.mockRestore();
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
      message:
        'Failed to retire previous microphone resources after retry. [1] Media track 1 cleanup failed: old track cleanup failed; [2] Retired media stream cleanup failed: old track cleanup retry failed',
      errors: [
        {
          name: 'Error',
          message: 'Media track 1 cleanup failed: old track cleanup failed',
          cause: { name: 'Error', message: 'old track cleanup failed' },
        },
        {
          name: 'Error',
          message:
            'Retired media stream cleanup failed: old track cleanup retry failed',
          cause: {
            name: 'AbortError',
            message: 'old track cleanup retry failed',
          },
        },
      ],
      cause: {
        name: 'Error',
        message: 'Media track 1 cleanup failed: old track cleanup failed',
        cause: { name: 'Error', message: 'old track cleanup failed' },
      },
    });

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

  it('applies mute state to a retained stream whose cleanup failed', async () => {
    const oldTrackStop = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error('old track cleanup failed');
      })
      .mockImplementationOnce(() => {
        throw new Error('old track cleanup retry failed');
      })
      .mockImplementationOnce(() => undefined);
    const oldTrack = {
      enabled: true,
      stop: oldTrackStop,
    } as unknown as MediaStreamTrack;
    const candidateTrackStop = vi.fn();
    const candidateTrack = {
      enabled: true,
      stop: candidateTrackStop,
    } as unknown as MediaStreamTrack;
    stubMediaRecorder(supports(MimeType.WEBM));
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { result } = renderMicrophone();
    const context = createAudioContext();
    result.current.start(createStream([oldTrack]), context);

    await act(() =>
      result.current.replace(createStream([candidateTrack]), context),
    );
    act(() => result.current.mute());

    expect(oldTrack.enabled).toBe(false);
    expect(candidateTrack.enabled).toBe(false);
    expect(result.current.isMuted).toBe(true);

    act(() => result.current.unmute());

    expect(oldTrack.enabled).toBe(false);
    expect(candidateTrack.enabled).toBe(true);
    expect(result.current.isMuted).toBe(false);

    await act(() => result.current.stop());
    expect(oldTrackStop).toHaveBeenCalledTimes(3);
    expect(candidateTrackStop).toHaveBeenCalledOnce();
    consoleWarn.mockRestore();
  });

  it('keeps the active stream muted when a retained stream cannot be muted', async () => {
    const oldTrackStop = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error('old track cleanup failed');
      })
      .mockImplementationOnce(() => {
        throw new Error('old track cleanup retry failed');
      })
      .mockImplementationOnce(() => undefined);
    const oldTrack = {
      enabled: true,
      stop: oldTrackStop,
    } as unknown as MediaStreamTrack;
    const oldStream = {
      getTracks: () => [oldTrack],
      getAudioTracks: () => {
        throw new Error('retained track enumeration failed');
      },
    } as unknown as MediaStream;
    const candidateTrack = {
      enabled: true,
      stop: vi.fn(),
    } as unknown as MediaStreamTrack;
    const events: VoiceDiagnosticEvent[] = [];
    const diagnostics = createVoiceDiagnosticsReporter(() => ({
      logger: false,
      onEvent: (event) => events.push(event),
    }));
    stubMediaRecorder(supports(MimeType.WEBM));
    const { result } = renderMicrophone({ diagnostics });
    const context = createAudioContext();
    result.current.start(oldStream, context);

    await act(() =>
      result.current.replace(createStream([candidateTrack]), context),
    );
    act(() => result.current.mute());

    expect(candidateTrack.enabled).toBe(false);
    expect(result.current.isMuted).toBe(true);
    expect(events.at(-1)).toMatchObject({
      level: 'warn',
      category: 'microphone',
      name: 'resource.cleanup_failed',
      details: {
        resource: 'microphone',
        message:
          'Failed to mute a retained microphone stream after cleanup failed.',
        error: { message: 'retained track enumeration failed' },
      },
    });

    await act(() => result.current.stop());
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

  it('applies a mute requested while a replacement is in progress', async () => {
    const recorders = stubMediaRecorder(supports(MimeType.WEBM));
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
    const oldRecorder = recorders[0];
    if (!oldRecorder) throw new Error('Expected the original MediaRecorder.');
    oldRecorder.stop.mockImplementationOnce(() => {});

    let replacement = Promise.resolve();
    act(() => {
      replacement = result.current.replace(
        createStream([candidateTrack]),
        context,
      );
    });
    await waitFor(() => expect(oldRecorder.stop).toHaveBeenCalledOnce());

    act(() => result.current.mute());
    expect(candidateTrack.enabled).toBe(false);
    await act(async () => {
      oldRecorder.emit('stop', new Event('stop'));
      await replacement;
    });

    expect(result.current.isMuted).toBe(true);
    expect(candidateTrack.enabled).toBe(false);
  });

  it('rejects a replacement when pending track enumeration prevents mute reconciliation', async () => {
    const recorders = stubMediaRecorder(supports(MimeType.WEBM));
    const events: VoiceDiagnosticEvent[] = [];
    const diagnostics = createVoiceDiagnosticsReporter(() => ({
      logger: false,
      onEvent: (event) => events.push(event),
    }));
    const oldTrack = {
      enabled: true,
      stop: vi.fn(),
    } as unknown as MediaStreamTrack;
    const candidateTrackStop = vi.fn();
    const candidateTrack = {
      enabled: true,
      stop: candidateTrackStop,
    } as unknown as MediaStreamTrack;
    const candidateStream = {
      getTracks: () => [candidateTrack],
      getAudioTracks: () => {
        throw new Error('pending track enumeration failed');
      },
    } as unknown as MediaStream;
    const { result } = renderMicrophone({ diagnostics });
    const context = createAudioContext();
    result.current.start(createStream([oldTrack]), context);
    const oldRecorder = recorders[0];
    if (!oldRecorder) throw new Error('Expected the original MediaRecorder.');
    oldRecorder.stop.mockImplementationOnce(() => {});

    let replacement = Promise.resolve();
    act(() => {
      replacement = result.current.replace(candidateStream, context);
    });
    await waitFor(() => expect(oldRecorder.stop).toHaveBeenCalledOnce());

    act(() => result.current.mute());

    expect(oldTrack.enabled).toBe(false);
    expect(result.current.isMuted).toBe(false);
    expect(events.at(-1)).toMatchObject({
      name: 'control.change_failed',
      details: {
        value: true,
        error: { message: 'pending track enumeration failed' },
      },
    });

    await act(async () => {
      oldRecorder.emit('stop', new Event('stop'));
      await expect(replacement).rejects.toThrow(
        'pending track enumeration failed',
      );
    });

    expect(candidateTrack.enabled).toBe(true);
    expect(candidateTrackStop).toHaveBeenCalledOnce();
    await act(() => result.current.stop());
    expect(candidateTrackStop).toHaveBeenCalledOnce();
  });

  it('applies an unmute requested while a replacement is in progress', async () => {
    const recorders = stubMediaRecorder(supports(MimeType.WEBM));
    const oldTrack = {
      enabled: true,
      stop: vi.fn(),
    } as unknown as MediaStreamTrack;
    const candidateTrack = {
      enabled: true,
      stop: vi.fn(),
    } as unknown as MediaStreamTrack;
    const oldAudioTracks = [oldTrack];
    const candidateAudioTracks = [candidateTrack];
    const { result } = renderMicrophone();
    const context = createAudioContext();
    result.current.start(createStream([oldTrack], oldAudioTracks), context);
    act(() => result.current.mute());
    const oldRecorder = recorders[0];
    if (!oldRecorder) throw new Error('Expected the original MediaRecorder.');
    oldRecorder.stop.mockImplementationOnce(() => {});

    let replacement = Promise.resolve();
    act(() => {
      replacement = result.current.replace(
        createStream([candidateTrack], candidateAudioTracks),
        context,
      );
    });
    await waitFor(() => expect(oldRecorder.stop).toHaveBeenCalledOnce());

    act(() => result.current.unmute());
    expect(candidateTrack.enabled).toBe(true);
    expect(oldAudioTracks).toEqual([oldTrack]);
    expect(candidateAudioTracks).toEqual([candidateTrack]);
    await act(async () => {
      oldRecorder.emit('stop', new Event('stop'));
      await replacement;
    });

    expect(result.current.isMuted).toBe(false);
    expect(candidateTrack.enabled).toBe(true);
  });

  it('does not re-reconcile a pending stream after only the outgoing unmute fails', async () => {
    const recorders = stubMediaRecorder(supports(MimeType.WEBM));
    const oldTrack = {
      enabled: true,
      stop: vi.fn(),
    } as unknown as MediaStreamTrack;
    const getOldAudioTracks = vi
      .fn<() => MediaStreamTrack[]>()
      .mockReturnValueOnce([oldTrack])
      .mockImplementationOnce(() => {
        throw new Error('outgoing track enumeration failed');
      });
    const oldStream = {
      getTracks: () => [oldTrack],
      getAudioTracks: getOldAudioTracks,
    } as unknown as MediaStream;
    const candidateTrackStop = vi.fn();
    const candidateTrack = {
      enabled: true,
      stop: candidateTrackStop,
    } as unknown as MediaStreamTrack;
    const getCandidateAudioTracks = vi
      .fn<() => MediaStreamTrack[]>()
      .mockReturnValueOnce([candidateTrack])
      .mockImplementationOnce(() => {
        throw new Error('redundant candidate reconciliation');
      });
    const candidateStream = {
      getTracks: () => [candidateTrack],
      getAudioTracks: getCandidateAudioTracks,
    } as unknown as MediaStream;
    const { result } = renderMicrophone();
    const context = createAudioContext();
    result.current.start(oldStream, context);
    act(() => result.current.mute());
    const oldRecorder = recorders[0];
    if (!oldRecorder) throw new Error('Expected the original MediaRecorder.');
    oldRecorder.stop.mockImplementationOnce(() => {});

    let replacement = Promise.resolve();
    act(() => {
      replacement = result.current.replace(candidateStream, context);
    });
    await waitFor(() => expect(oldRecorder.stop).toHaveBeenCalledOnce());

    act(() => result.current.unmute());
    expect(result.current.isMuted).toBe(true);

    await act(async () => {
      oldRecorder.emit('stop', new Event('stop'));
      await replacement;
    });

    expect(getOldAudioTracks).toHaveBeenCalledTimes(2);
    expect(getCandidateAudioTracks).toHaveBeenCalledOnce();
    expect(candidateTrack.enabled).toBe(false);
    expect(candidateTrackStop).not.toHaveBeenCalled();

    await act(() => result.current.stop());
    expect(candidateTrackStop).toHaveBeenCalledOnce();
  });

  it('releases an owned audio context when required mute reconciliation fails', async () => {
    const recorders = stubMediaRecorder(supports(MimeType.WEBM));
    const contextClose = vi.fn().mockResolvedValue(undefined);
    stubOwnedAudioContext(contextClose);
    let oldTrackEnabled = true;
    const oldTrack = { stop: vi.fn() } as unknown as MediaStreamTrack;
    Object.defineProperty(oldTrack, 'enabled', {
      configurable: true,
      get: () => oldTrackEnabled,
      set(value: boolean) {
        if (!value) throw new Error('outgoing track refused mute');
        oldTrackEnabled = value;
      },
    });
    const candidateTrackStop = vi.fn();
    const candidateTrack = {
      enabled: true,
      stop: candidateTrackStop,
    } as unknown as MediaStreamTrack;
    const candidateStream = {
      getTracks: () => [candidateTrack],
      getAudioTracks: vi
        .fn<() => MediaStreamTrack[]>()
        .mockReturnValueOnce([candidateTrack])
        .mockImplementationOnce(() => {
          throw new Error('final mute reconciliation failed');
        }),
    } as unknown as MediaStream;
    const events: VoiceDiagnosticEvent[] = [];
    const diagnostics = createVoiceDiagnosticsReporter(() => ({
      level: 'debug',
      logger: false,
      onEvent: (event) => events.push(event),
    }));
    const onStopRecording = vi.fn();
    const { result } = renderMicrophone({ diagnostics, onStopRecording });
    result.current.start(createStream([oldTrack]));
    const oldRecorder = recorders[0];
    if (!oldRecorder) throw new Error('Expected the original MediaRecorder.');
    oldRecorder.stop.mockImplementationOnce(() => {});

    let replacement = Promise.resolve();
    act(() => {
      replacement = result.current.replace(candidateStream);
    });
    await waitFor(() => expect(oldRecorder.stop).toHaveBeenCalledOnce());
    act(() => result.current.mute());

    let replacementError: unknown;
    await act(async () => {
      oldRecorder.emit('stop', new Event('stop'));
      try {
        await replacement;
      } catch (error) {
        replacementError = error;
      }
    });

    expect(replacementError).toMatchObject({
      message: 'final mute reconciliation failed',
    });
    expect(candidateTrackStop).toHaveBeenCalledOnce();
    expect(contextClose).toHaveBeenCalledOnce();
    expect(result.current.isMuted).toBe(false);
    expect(onStopRecording).toHaveBeenCalledOnce();
    expect(
      events.filter((event) => event.name === 'microphone.recording_stopped'),
    ).toHaveLength(1);
    expect(
      events.filter(
        (event) =>
          event.name === 'control.changed' &&
          event.details['control'] === 'microphone_mute' &&
          event.details['value'] === false,
      ),
    ).toHaveLength(0);

    const nextTrack = {
      enabled: true,
      stop: vi.fn(),
    } as unknown as MediaStreamTrack;
    expect(() => result.current.start(createStream([nextTrack]))).not.toThrow();
    expect(nextTrack.enabled).toBe(true);
    await act(() => result.current.stop());
  });

  it('does not repeat mute reconciliation after a successful transition', async () => {
    const recorders = stubMediaRecorder(supports(MimeType.WEBM));
    const contextClose = vi.fn().mockResolvedValue(undefined);
    const context = {
      ...createAudioContext(),
      close: contextClose,
    } as AudioContext;
    const oldTrack = {
      enabled: true,
      stop: vi.fn(),
    } as unknown as MediaStreamTrack;
    const candidateTrackStop = vi.fn();
    const candidateTrack = {
      enabled: true,
      stop: candidateTrackStop,
    } as unknown as MediaStreamTrack;
    const getCandidateAudioTracks = vi
      .fn<() => MediaStreamTrack[]>()
      .mockReturnValueOnce([candidateTrack])
      .mockImplementationOnce(() => {
        throw new Error('final mute reconciliation failed');
      });
    const candidateStream = {
      getTracks: () => [candidateTrack],
      getAudioTracks: getCandidateAudioTracks,
    } as unknown as MediaStream;
    const diagnostics = createVoiceDiagnosticsReporter(() => ({
      logger: false,
    }));
    const { result } = renderMicrophone({ diagnostics });
    result.current.start(createStream([oldTrack]), context);
    const oldRecorder = recorders[0];
    if (!oldRecorder) throw new Error('Expected the original MediaRecorder.');
    oldRecorder.stop.mockImplementationOnce(() => {});

    let replacement = Promise.resolve();
    act(() => {
      replacement = result.current.replace(candidateStream, context);
    });
    await waitFor(() => expect(oldRecorder.stop).toHaveBeenCalledOnce());
    act(() => result.current.mute());

    await act(async () => {
      oldRecorder.emit('stop', new Event('stop'));
      await replacement;
    });

    expect(getCandidateAudioTracks).toHaveBeenCalledOnce();
    expect(candidateTrackStop).not.toHaveBeenCalled();
    expect(contextClose).not.toHaveBeenCalled();
    expect(result.current.isMuted).toBe(true);

    await act(() => result.current.stop());
    expect(candidateTrackStop).toHaveBeenCalledOnce();
  });

  it('preserves a shared context and can restart after mute reconciliation fails', async () => {
    const recorders = stubMediaRecorder(supports(MimeType.WEBM));
    const contextClose = vi.fn().mockResolvedValue(undefined);
    const context = {
      ...createAudioContext(),
      close: contextClose,
    } as AudioContext;
    let oldTrackEnabled = true;
    const oldTrack = { stop: vi.fn() } as unknown as MediaStreamTrack;
    Object.defineProperty(oldTrack, 'enabled', {
      configurable: true,
      get: () => oldTrackEnabled,
      set(value: boolean) {
        if (!value) throw new Error('outgoing track refused mute');
        oldTrackEnabled = value;
      },
    });
    const candidateTrackStop = vi.fn();
    const candidateTrack = {
      enabled: true,
      stop: candidateTrackStop,
    } as unknown as MediaStreamTrack;
    const candidateStream = {
      getTracks: () => [candidateTrack],
      getAudioTracks: vi
        .fn<() => MediaStreamTrack[]>()
        .mockReturnValueOnce([candidateTrack])
        .mockImplementationOnce(() => {
          throw new Error('final mute reconciliation failed');
        }),
    } as unknown as MediaStream;
    const { result } = renderMicrophone();
    result.current.start(createStream([oldTrack]), context);
    const oldRecorder = recorders[0];
    if (!oldRecorder) throw new Error('Expected the original MediaRecorder.');
    oldRecorder.stop.mockImplementationOnce(() => {});

    let replacement = Promise.resolve();
    act(() => {
      replacement = result.current.replace(candidateStream, context);
    });
    await waitFor(() => expect(oldRecorder.stop).toHaveBeenCalledOnce());
    act(() => result.current.mute());

    await act(async () => {
      oldRecorder.emit('stop', new Event('stop'));
      await expect(replacement).rejects.toThrow(
        'final mute reconciliation failed',
      );
    });

    expect(candidateTrackStop).toHaveBeenCalledOnce();
    expect(contextClose).not.toHaveBeenCalled();
    expect(result.current.isMuted).toBe(false);

    const nextContextClose = vi.fn().mockResolvedValue(undefined);
    const nextContext = {
      ...createAudioContext(),
      close: nextContextClose,
    } as AudioContext;
    expect(() =>
      result.current.start(createStream(), nextContext),
    ).not.toThrow();
    await act(() => result.current.stop());
    expect(nextContextClose).not.toHaveBeenCalled();
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

  it('releases a replacement candidate when no MIME type is available', async () => {
    vi.stubGlobal('MediaRecorder', undefined);
    const candidateTrackStop = vi.fn();
    const { result } = renderMicrophone();

    await act(async () => {
      await expect(
        result.current.replace(
          createStream([
            {
              enabled: true,
              stop: candidateTrackStop,
            } as unknown as MediaStreamTrack,
          ]),
        ),
      ).rejects.toThrow('No MimeType specified');
    });

    expect(candidateTrackStop).toHaveBeenCalledOnce();
  });

  it('does not retain a caller-owned candidate whose cleanup fails', async () => {
    vi.stubGlobal('MediaRecorder', undefined);
    const firstTrackStop = vi.fn().mockImplementationOnce(() => {
      throw new Error('candidate track cleanup failed');
    });
    const secondTrackStop = vi.fn();
    const candidateStream = createStream([
      {
        enabled: true,
        stop: firstTrackStop,
      } as unknown as MediaStreamTrack,
      {
        enabled: true,
        stop: secondTrackStop,
      } as unknown as MediaStreamTrack,
    ]);
    const events: VoiceDiagnosticEvent[] = [];
    const diagnostics = createVoiceDiagnosticsReporter(() => ({
      logger: false,
      onEvent: (event) => events.push(event),
    }));
    const { result } = renderMicrophone({ diagnostics });

    await expect(result.current.replace(candidateStream)).rejects.toThrow(
      'No MimeType specified',
    );

    expect(firstTrackStop).toHaveBeenCalledOnce();
    expect(secondTrackStop).toHaveBeenCalledOnce();
    expect(events.at(-1)).toMatchObject({
      level: 'warn',
      category: 'microphone',
      name: 'resource.cleanup_failed',
      details: {
        resource: 'microphone',
        message:
          'Failed to release an uncommitted replacement microphone stream.',
        error: { message: 'candidate track cleanup failed' },
      },
    });

    await act(() => result.current.stop());
    expect(firstTrackStop).toHaveBeenCalledOnce();
    expect(secondTrackStop).toHaveBeenCalledOnce();
  });

  it('releases a replacement candidate when the microphone is not recording', async () => {
    stubMediaRecorder(supports(MimeType.WEBM));
    const candidateTrackStop = vi.fn();
    const { result } = renderMicrophone();

    await act(async () => {
      await expect(
        result.current.replace(
          createStream([
            {
              enabled: true,
              stop: candidateTrackStop,
            } as unknown as MediaStreamTrack,
          ]),
        ),
      ).rejects.toThrow('The microphone is not recording.');
    });

    expect(candidateTrackStop).toHaveBeenCalledOnce();
  });

  it('releases a replacement candidate when the audio context changes', async () => {
    stubMediaRecorder(supports(MimeType.WEBM));
    const oldTrackStop = vi.fn();
    const candidateTrackStop = vi.fn();
    const { result } = renderMicrophone();
    const context = createAudioContext();
    result.current.start(
      createStream([
        {
          enabled: true,
          stop: oldTrackStop,
        } as unknown as MediaStreamTrack,
      ]),
      context,
    );

    await act(async () => {
      await expect(
        result.current.replace(
          createStream([
            {
              enabled: true,
              stop: candidateTrackStop,
            } as unknown as MediaStreamTrack,
          ]),
          createAudioContext(),
        ),
      ).rejects.toThrow('The microphone audio context changed.');
    });

    expect(candidateTrackStop).toHaveBeenCalledOnce();
    expect(oldTrackStop).not.toHaveBeenCalled();
    await act(() => result.current.stop());
  });

  it('treats an active stream replacement as a no-op', async () => {
    stubMediaRecorder(supports(MimeType.WEBM));
    const activeTrackStop = vi.fn();
    const activeStream = createStream([
      {
        enabled: true,
        stop: activeTrackStop,
      } as unknown as MediaStreamTrack,
    ]);
    const { result } = renderMicrophone();
    const context = createAudioContext();
    result.current.start(activeStream, context);

    await expect(
      result.current.replace(activeStream, context),
    ).resolves.toBeUndefined();

    expect(activeTrackStop).not.toHaveBeenCalled();
    await act(() => result.current.stop());
    expect(activeTrackStop).toHaveBeenCalledOnce();
  });

  it('keeps an active stream replacement a no-op when the context argument changes', async () => {
    stubMediaRecorder(supports(MimeType.WEBM));
    const activeTrackStop = vi.fn();
    const activeStream = createStream([
      {
        enabled: true,
        stop: activeTrackStop,
      } as unknown as MediaStreamTrack,
    ]);
    const { result } = renderMicrophone();
    result.current.start(activeStream, createAudioContext());

    await expect(
      result.current.replace(activeStream, createAudioContext()),
    ).resolves.toBeUndefined();

    expect(activeTrackStop).not.toHaveBeenCalled();
    await act(() => result.current.stop());
    expect(activeTrackStop).toHaveBeenCalledOnce();
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
      vi.fn(function AudioContextMock() {
        return context;
      }),
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
