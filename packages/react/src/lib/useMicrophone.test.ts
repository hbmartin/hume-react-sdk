import { act, renderHook } from '@testing-library/react';
import { MimeType } from 'hume';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useMicrophone } from './useMicrophone';

type RecorderInstance = {
  stream: MediaStream;
  options?: MediaRecorderOptions;
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  addEventListener: ReturnType<typeof vi.fn>;
  removeEventListener: ReturnType<typeof vi.fn>;
};

/**
 * Installs a fake `MediaRecorder`. Omitting `isTypeSupported` models an
 * environment that only partially implements the API — a polyfill, an embedded
 * WebView — which is the case that makes `getBrowserSupportedMimeType` throw
 * rather than return a result.
 */
const stubMediaRecorder = (isTypeSupported?: (type: string) => boolean) => {
  const instances: RecorderInstance[] = [];

  class MediaRecorderStub {
    start = vi.fn();

    stop = vi.fn();

    addEventListener = vi.fn();

    removeEventListener = vi.fn();

    constructor(
      public stream: MediaStream,
      public options?: MediaRecorderOptions,
    ) {
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
  const context = {
    ...createAudioContext(),
    close: contextClose,
  } as AudioContext;
  vi.stubGlobal(
    'AudioContext',
    vi.fn(() => context),
  );

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

    expect(recorders[0]?.removeEventListener).toHaveBeenCalledOnce();
    expect(recorders[0]?.stop).toHaveBeenCalledOnce();
    expect(firstTrackStop).toHaveBeenCalledOnce();
    expect(secondTrackStop).not.toHaveBeenCalled();
  });

  it('starts unmuted after mute was requested before a stream existed', () => {
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

    expect(result.current.isMuted).toBe(false);
    expect(track.enabled).toBe(true);
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
    expect(consoleError).toHaveBeenCalledWith(
      'Failed to detect supported microphone MIME types.',
      expect.any(TypeError),
    );
    expect(() =>
      result.current.start(createStream(), createAudioContext()),
    ).toThrow('No MimeType specified');
    consoleError.mockRestore();
  });

  it('rolls back claimed resources when recorder construction fails', () => {
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
    expect(sourceDisconnect).toHaveBeenCalledOnce();
    expect(cancelAnimationFrame).toHaveBeenCalledWith(1);
    expect(trackStop).toHaveBeenCalledOnce();
    expect(contextClose).toHaveBeenCalledOnce();
  });

  it('releases the stream and owned audio context when recorder cleanup throws', () => {
    const { contextClose, recorderStop, stream, trackStop } =
      installInactiveRecorderScenario();
    const { result, unmount } = renderMicrophone();
    result.current.start(stream);

    expect(() => unmount()).not.toThrow();
    expect(recorderStop).toHaveBeenCalledOnce();
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
    const firstTrackStop = vi.fn(() => {
      throw new Error('first track failed');
    });
    const secondTrackStop = vi.fn();
    const contextClose = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal(
      'AudioContext',
      vi.fn(() => ({
        ...createAudioContext(),
        close: contextClose,
      })),
    );
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

  it('continues unmount cleanup when stopping a track throws', async () => {
    stubMediaRecorder(supports(MimeType.WEBM));
    const firstTrackStop = vi.fn(() => {
      throw new Error('first track failed');
    });
    const secondTrackStop = vi.fn();
    const contextClose = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal(
      'AudioContext',
      vi.fn(() => ({
        ...createAudioContext(),
        close: contextClose,
      })),
    );
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
    expect(consoleError).toHaveBeenCalledWith(
      'Failed to fully dispose microphone resources during unmount.',
      expect.any(Error),
    );
    consoleError.mockRestore();
  });

  it('bounds an owned audio context that never closes', async () => {
    vi.useFakeTimers();
    stubMediaRecorder(supports(MimeType.WEBM));
    const contextClose = vi.fn(() => new Promise<void>(() => {}));
    vi.stubGlobal(
      'AudioContext',
      vi.fn(() => ({
        ...createAudioContext(),
        close: contextClose,
      })),
    );
    const { result } = renderMicrophone();
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
  });
});
