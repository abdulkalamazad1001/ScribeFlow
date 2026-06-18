import { afterEach, describe, expect, it, vi } from "vitest";

async function loadModule() {
  vi.resetModules();
  vi.stubEnv("DEEPGRAM_API_KEY", "test-deepgram-key");
  vi.stubEnv("DEEPGRAM_MODEL", "nova-3");
  vi.stubEnv("DEEPGRAM_DIARIZE_MODEL", "latest");
  vi.stubEnv("DEEPGRAM_DEFAULT_LANGUAGE", "en");
  vi.stubEnv("LOG_LEVEL", "silent");
  return import("../src/services/deepgramLiveTranscriptionService.js");
}

const resultsMessage = (overrides: {
  isFinal: boolean;
  transcript: string;
  words: Array<{
    word: string;
    start: number;
    end: number;
    confidence?: number;
    speaker?: number;
    punctuated_word?: string;
  }>;
}) => ({
  type: "Results",
  channel_index: [0],
  start: overrides.words[0]?.start ?? 0,
  duration: 1,
  is_final: overrides.isFinal,
  channel: {
    alternatives: [
      {
        transcript: overrides.transcript,
        confidence: 0.9,
        words: overrides.words,
      },
    ],
  },
});

describe("deepgramLiveTranscriptionService", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("ignores non-transcript and empty messages", async () => {
    const { parseLiveResultsMessage } = await loadModule();
    expect(parseLiveResultsMessage({ type: "Metadata" })).toBeNull();
    expect(parseLiveResultsMessage(null)).toBeNull();
    expect(
      parseLiveResultsMessage(
        resultsMessage({ isFinal: true, transcript: "", words: [] }),
      ),
    ).toBeNull();
  });

  it("parses a final results message into words and timing", async () => {
    const { parseLiveResultsMessage } = await loadModule();
    const parsed = parseLiveResultsMessage(
      resultsMessage({
        isFinal: true,
        transcript: "hello team",
        words: [
          { word: "hello", start: 0, end: 0.5, confidence: 0.9, speaker: 0 },
          { word: "team", start: 0.5, end: 1.0, confidence: 0.8, speaker: 0 },
        ],
      }),
    );

    expect(parsed).not.toBeNull();
    expect(parsed?.isFinal).toBe(true);
    expect(parsed?.transcript).toBe("hello team");
    expect(parsed?.words).toHaveLength(2);
    expect(parsed?.startMs).toBe(0);
    expect(parsed?.endMs).toBe(1000);
  });

  it("builds segments per utterance and splits on speaker change", async () => {
    const { buildLiveNormalizedTranscription } = await loadModule();
    const transcription = buildLiveNormalizedTranscription(
      [
        // First final utterance: two words from speaker 0.
        [
          {
            text: "hello",
            punctuatedText: "Hello",
            startMs: 0,
            endMs: 500,
            confidence: 0.9,
            rawSpeakerIndex: 0,
            speakerConfidence: null,
          },
          {
            text: "there",
            punctuatedText: "there.",
            startMs: 500,
            endMs: 1000,
            confidence: 0.9,
            rawSpeakerIndex: 0,
            speakerConfidence: null,
          },
        ],
        // Second final utterance: speaker 1.
        [
          {
            text: "hi",
            punctuatedText: "Hi",
            startMs: 1100,
            endMs: 1600,
            confidence: 0.8,
            rawSpeakerIndex: 1,
            speakerConfidence: null,
          },
        ],
      ],
      { language: "en" },
    );

    // Distinct utterances and a speaker change produce two segments.
    expect(transcription.segments).toHaveLength(2);
    expect(transcription.segments[0]?.rawSpeakerIndex).toBe(0);
    expect(transcription.segments[1]?.rawSpeakerIndex).toBe(1);
    expect(transcription.wordCount).toBe(3);
    expect(transcription.speakers).toHaveLength(2);
    expect(transcription.modelName).toBe("nova-3");
    expect(transcription.diarizeModel).toBe("latest");
    const totalPct = transcription.speakers.reduce(
      (sum, s) => sum + s.speakingPercentage,
      0,
    );
    expect(Math.round(totalPct)).toBe(100);
  });

  it("wires socket events to callbacks and forwards audio/finish/close", async () => {
    const { DeepgramLiveTranscriptionService } = await loadModule();

    const handlers: Record<string, (arg?: unknown) => void> = {};
    const socket = {
      on: vi.fn((event: string, cb: (arg?: unknown) => void) => {
        handlers[event] = cb;
      }),
      sendMedia: vi.fn(),
      sendCloseStream: vi.fn(),
      sendKeepAlive: vi.fn(),
      close: vi.fn(),
    };

    const onTranscript = vi.fn();
    const onError = vi.fn();
    const onClose = vi.fn();

    const service = new DeepgramLiveTranscriptionService(async () => socket);
    const session = await service.openSession(
      { language: "en" },
      { onTranscript, onError, onClose },
    );

    // A final transcript message reaches onTranscript.
    handlers.message?.(
      resultsMessage({
        isFinal: true,
        transcript: "hello",
        words: [{ word: "hello", start: 0, end: 0.5, confidence: 0.9, speaker: 0 }],
      }),
    );
    expect(onTranscript).toHaveBeenCalledTimes(1);
    expect(onTranscript.mock.calls[0]?.[0]?.transcript).toBe("hello");

    // Non-transcript messages are ignored.
    handlers.message?.({ type: "Metadata" });
    expect(onTranscript).toHaveBeenCalledTimes(1);

    handlers.error?.(new Error("boom"));
    expect(onError).toHaveBeenCalledTimes(1);
    handlers.close?.();
    expect(onClose).toHaveBeenCalledTimes(1);

    const audio = new Uint8Array([1, 2, 3]);
    session.sendAudio(audio);
    expect(socket.sendMedia).toHaveBeenCalledWith(audio);
    session.finish();
    expect(socket.sendCloseStream).toHaveBeenCalledTimes(1);
    session.close();
    expect(socket.close).toHaveBeenCalledTimes(1);
  });
});
