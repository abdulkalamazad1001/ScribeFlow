import type { NormalizedTranscription, TranscriptionWord } from "@scribeflow/shared";
import WebSocket from "ws";
import { env } from "../config/env.js";
import { buildDeepgramKeyterms } from "./deepgramTranscriptionService.js";

const DEEPGRAM_LIVE_URL = "wss://api.deepgram.com/v1/listen";
const LIVE_OPEN_TIMEOUT_MS = 10_000;
// Deepgram closes an idle live stream after ~10-12s; keep it alive across brief
// silences so a recording is not dropped mid-meeting.
const KEEPALIVE_INTERVAL_MS = 5_000;

type NormalizedSegment = NormalizedTranscription["segments"][number];

const secondsToMs = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.round(value * 1000))
    : null;

const asConfidence = (value: unknown) => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  return Math.min(Math.max(value, 0), 1);
};

const asSpeakerIndex = (value: unknown) =>
  typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;

const compactWhitespace = (value: string) => value.replace(/\s+/g, " ").trim();

const joinWordText = (words: TranscriptionWord[]) =>
  compactWhitespace(
    words
      .map((word) => word.punctuatedText ?? word.text)
      .join(" ")
      .replace(/\s+([.,!?;:])/g, "$1"),
  );

const averageConfidence = (values: Array<number | null | undefined>) => {
  const finite = values.filter(
    (value): value is number => typeof value === "number" && Number.isFinite(value),
  );
  return finite.length === 0
    ? null
    : finite.reduce((sum, value) => sum + value, 0) / finite.length;
};

const getDominantSpeaker = (words: TranscriptionWord[]) => {
  const counts = new Map<number, number>();
  for (const word of words) {
    if (word.rawSpeakerIndex == null) {
      continue;
    }
    counts.set(word.rawSpeakerIndex, (counts.get(word.rawSpeakerIndex) ?? 0) + 1);
  }
  return [...counts.entries()].sort((left, right) => right[1] - left[1])[0]?.[0] ?? null;
};

type DeepgramLiveWord = {
  word?: unknown;
  punctuated_word?: unknown;
  start?: unknown;
  end?: unknown;
  confidence?: unknown;
  speaker?: unknown;
};

const normalizeLiveWord = (word: DeepgramLiveWord): TranscriptionWord | null => {
  const text =
    typeof word.word === "string" && word.word.trim()
      ? compactWhitespace(word.word)
      : typeof word.punctuated_word === "string" && word.punctuated_word.trim()
        ? compactWhitespace(word.punctuated_word)
        : null;
  const startMs = secondsToMs(word.start);
  const endMs = secondsToMs(word.end);

  if (!text || startMs == null || endMs == null || endMs < startMs) {
    return null;
  }

  return {
    text,
    punctuatedText:
      typeof word.punctuated_word === "string" && word.punctuated_word.trim()
        ? compactWhitespace(word.punctuated_word)
        : null,
    startMs,
    endMs,
    confidence: asConfidence(word.confidence),
    rawSpeakerIndex: asSpeakerIndex(word.speaker),
    speakerConfidence: null,
  };
};

export type ParsedLiveTranscript = {
  isFinal: boolean;
  transcript: string;
  words: TranscriptionWord[];
  startMs: number;
  endMs: number;
};

/**
 * Parse a Deepgram streaming "Results" message into a transport-safe shape.
 * Returns null for non-transcript messages (Metadata, SpeechStarted, etc.) or
 * empty transcripts so callers can ignore them.
 */
export function parseLiveResultsMessage(message: unknown): ParsedLiveTranscript | null {
  if (typeof message !== "object" || message === null) {
    return null;
  }

  const record = message as {
    type?: unknown;
    is_final?: unknown;
    start?: unknown;
    duration?: unknown;
    channel?: { alternatives?: unknown };
  };

  if (record.type !== "Results") {
    return null;
  }

  const alternatives = record.channel?.alternatives;
  const alternative = Array.isArray(alternatives)
    ? (alternatives[0] as { transcript?: unknown; words?: unknown } | undefined)
    : undefined;

  const transcript =
    typeof alternative?.transcript === "string"
      ? compactWhitespace(alternative.transcript)
      : "";

  if (!transcript) {
    return null;
  }

  const words = Array.isArray(alternative?.words)
    ? alternative.words
        .map((word) => normalizeLiveWord(word as DeepgramLiveWord))
        .filter((word): word is TranscriptionWord => word !== null)
    : [];

  const startSeconds = typeof record.start === "number" ? record.start : 0;
  const durationSeconds = typeof record.duration === "number" ? record.duration : 0;
  const startMs = words[0]?.startMs ?? secondsToMs(startSeconds) ?? 0;
  const endMs =
    words.at(-1)?.endMs ?? secondsToMs(startSeconds + durationSeconds) ?? startMs;

  return {
    isFinal: record.is_final === true,
    transcript,
    words,
    startMs,
    endMs,
  };
}

const buildSpeakers = (
  segments: NormalizedSegment[],
): NormalizedTranscription["speakers"] => {
  const durations = new Map<number, number>();

  for (const segment of segments) {
    if (segment.words.length === 0) {
      if (segment.rawSpeakerIndex != null) {
        durations.set(
          segment.rawSpeakerIndex,
          (durations.get(segment.rawSpeakerIndex) ?? 0) +
            Math.max(segment.endMs - segment.startMs, 0),
        );
      }
      continue;
    }

    for (const word of segment.words) {
      const rawSpeakerIndex = word.rawSpeakerIndex ?? segment.rawSpeakerIndex;
      if (rawSpeakerIndex == null) {
        continue;
      }
      durations.set(
        rawSpeakerIndex,
        (durations.get(rawSpeakerIndex) ?? 0) + Math.max(word.endMs - word.startMs, 0),
      );
    }
  }

  const totalMs = [...durations.values()].reduce((sum, value) => sum + value, 0);

  return [...durations.entries()]
    .sort(([left], [right]) => left - right)
    .map(([rawSpeakerIndex, durationMs]) => ({
      rawSpeakerIndex,
      displayName: `Speaker ${rawSpeakerIndex + 1}`,
      totalSpeakingSeconds: Number((durationMs / 1000).toFixed(3)),
      speakingPercentage:
        totalMs > 0 ? Number(((durationMs / totalMs) * 100).toFixed(2)) : 0,
    }));
};

const makeSegment = (words: TranscriptionWord[], index: number): NormalizedSegment => ({
  segmentIndex: index,
  rawSpeakerIndex: getDominantSpeaker(words) ?? 0,
  startMs: words[0]?.startMs ?? 0,
  endMs: words.at(-1)?.endMs ?? words[0]?.startMs ?? 0,
  text: joinWordText(words),
  confidence: averageConfidence(words.map((word) => word.confidence)),
  words,
});

/**
 * Build a NormalizedTranscription from the final utterances of a streaming
 * session, preserving Deepgram's natural utterance boundaries (one final
 * "Results" message per utterance) and splitting further on speaker changes.
 * The output matches the uploaded-audio shape so live meetings reuse the
 * existing persistence and analysis pipeline.
 */
export function buildLiveNormalizedTranscription(
  utterances: TranscriptionWord[][],
  options: {
    language: string | null;
    providerRequestId?: string | null;
    modelName?: string | null;
  },
): NormalizedTranscription {
  const segments: NormalizedSegment[] = [];

  for (const utterance of utterances) {
    let current: TranscriptionWord[] = [];
    let currentSpeaker: number | null = null;

    const flush = () => {
      if (current.length > 0) {
        segments.push(makeSegment(current, segments.length));
        current = [];
        currentSpeaker = null;
      }
    };

    for (const word of utterance) {
      const speakerChanged =
        current.length > 0 &&
        word.rawSpeakerIndex != null &&
        word.rawSpeakerIndex !== currentSpeaker;
      if (speakerChanged) {
        flush();
      }
      if (current.length === 0) {
        currentSpeaker = word.rawSpeakerIndex ?? null;
      }
      current.push(word);
    }
    flush();
  }

  const finalSegments = segments.filter((segment) => segment.text.length > 0);
  const durationMs = finalSegments.at(-1)?.endMs ?? 0;
  const wordCount = utterances.reduce((count, utterance) => count + utterance.length, 0);

  return {
    providerRequestId: options.providerRequestId ?? null,
    language: options.language,
    durationSeconds: Number((durationMs / 1000).toFixed(3)),
    modelName: options.modelName ?? env.DEEPGRAM_MODEL,
    diarizeModel: env.DEEPGRAM_DIARIZE_MODEL,
    confidence: averageConfidence(finalSegments.map((segment) => segment.confidence)),
    wordCount,
    speakers: buildSpeakers(finalSegments),
    segments: finalSegments.map((segment, index) => ({ ...segment, segmentIndex: index })),
  };
}

// Minimal surface of the Deepgram V1 live socket we depend on, so the service
// can be unit-tested with a fake socket.
export interface LiveTranscriptionSocket {
  on(event: "open", callback: () => void): void;
  on(event: "message", callback: (message: unknown) => void): void;
  on(event: "close", callback: () => void): void;
  on(event: "error", callback: (error: Error) => void): void;
  sendMedia(payload: ArrayBuffer | ArrayBufferView): void;
  sendCloseStream(message?: unknown): void;
  sendKeepAlive(): void;
  close(): void;
}

export type OpenLiveSocket = (args: {
  language: string;
  keyterms: string[];
}) => Promise<LiveTranscriptionSocket>;

export type LiveSessionCallbacks = {
  onTranscript: (event: ParsedLiveTranscript) => void;
  onError: (error: Error) => void;
  onClose: () => void;
};

export type LiveSession = {
  sendAudio: (payload: ArrayBuffer | ArrayBufferView) => void;
  finish: () => void;
  close: () => void;
};

const buildLiveUrl = (input: { language: string; keyterms: string[] }) => {
  const params = new URLSearchParams({
    model: env.DEEPGRAM_MODEL,
    diarize: "true",
    interim_results: "true",
    punctuate: "true",
    smart_format: "true",
    // Emit finalized utterances after ~1s of silence so finals arrive promptly.
    utterance_end_ms: "1000",
    language: input.language,
  });
  // Containerised WebM/Opus from the browser MediaRecorder is streamed as a
  // continuous byte stream; encoding/sample_rate are intentionally omitted so
  // Deepgram auto-detects the container.
  for (const term of input.keyterms.slice(0, 100)) {
    params.append("keyterm", term);
  }
  return `${DEEPGRAM_LIVE_URL}?${params.toString()}`;
};

// Connect with a raw WebSocket. The bundled @deepgram/sdk live client does not
// open reliably in this Node environment, so we drive the documented streaming
// endpoint directly — auth is the standard `Token <key>` header.
const defaultOpenLiveSocket: OpenLiveSocket = async ({ language, keyterms }) => {
  const ws = new WebSocket(buildLiveUrl({ language, keyterms }), {
    headers: { Authorization: `Token ${env.DEEPGRAM_API_KEY ?? ""}` },
  });

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out opening the Deepgram live connection."));
    }, LIVE_OPEN_TIMEOUT_MS);
    const onOpen = () => {
      cleanup();
      resolve();
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      clearTimeout(timer);
      ws.off("open", onOpen);
      ws.off("error", onError);
    };
    ws.on("open", onOpen);
    ws.on("error", onError);
  });

  return {
    on(event, callback) {
      if (event === "message") {
        ws.on("message", (data) => {
          try {
            (callback as (message: unknown) => void)(JSON.parse(data.toString()));
          } catch {
            // ignore non-JSON frames.
          }
        });
      } else if (event === "open") {
        ws.on("open", callback as () => void);
      } else if (event === "close") {
        ws.on("close", () => (callback as () => void)());
      } else if (event === "error") {
        ws.on("error", (error) => (callback as (error: Error) => void)(error));
      }
    },
    sendMedia(payload) {
      ws.send(payload as Uint8Array);
    },
    sendCloseStream() {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "CloseStream" }));
      }
    },
    sendKeepAlive() {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "KeepAlive" }));
      }
    },
    close() {
      ws.close();
    },
  };
};

export class DeepgramLiveTranscriptionService {
  constructor(private readonly openSocket: OpenLiveSocket = defaultOpenLiveSocket) {}

  isConfigured() {
    return Boolean(env.DEEPGRAM_API_KEY);
  }

  async openSession(
    input: {
      language?: string | null;
      knownParticipants?: string[];
      technicalTerms?: string[];
    },
    callbacks: LiveSessionCallbacks,
  ): Promise<LiveSession> {
    const language = input.language?.trim() || env.DEEPGRAM_DEFAULT_LANGUAGE;
    const keyterms = buildDeepgramKeyterms({
      knownParticipants: input.knownParticipants ?? [],
      technicalTerms: input.technicalTerms ?? [],
    });

    const socket = await this.openSocket({ language, keyterms });

    const keepAlive = setInterval(() => {
      try {
        socket.sendKeepAlive();
      } catch {
        // ignore — the socket may be mid-close.
      }
    }, KEEPALIVE_INTERVAL_MS);
    const stopKeepAlive = () => clearInterval(keepAlive);

    socket.on("message", (message) => {
      const parsed = parseLiveResultsMessage(message);
      if (parsed) {
        callbacks.onTranscript(parsed);
      }
    });
    socket.on("error", (error) => callbacks.onError(error));
    socket.on("close", () => {
      stopKeepAlive();
      callbacks.onClose();
    });

    return {
      sendAudio: (payload) => socket.sendMedia(payload),
      finish: () => {
        stopKeepAlive();
        socket.sendCloseStream();
      },
      close: () => {
        stopKeepAlive();
        socket.close();
      },
    };
  }
}
