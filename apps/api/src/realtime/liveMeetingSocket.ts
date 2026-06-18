import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { uuidSchema, type TranscriptionWord } from "@scribeflow/shared";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import { logger } from "../config/logger.js";
import type { ApiDependencies } from "../dependencies.js";
import { createApiDependencies } from "../dependencies.js";
import { ApiError } from "../errors/apiError.js";
import { buildLiveNormalizedTranscription } from "../services/deepgramLiveTranscriptionService.js";

const LIVE_SOCKET_PATH = "/api/meetings/live/socket";
// Safety cap: if Deepgram never closes the upstream stream after we ask it to
// finish, persist whatever final transcripts we have after this long.
const FINALIZE_MAX_WAIT_MS = 15_000;

const sendJson = (ws: WebSocket, payload: Record<string, unknown>) => {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }
};

const toAudioView = (data: RawData): Uint8Array | null => {
  if (Buffer.isBuffer(data)) {
    return data.length > 0 ? new Uint8Array(data) : null;
  }
  if (Array.isArray(data)) {
    const joined = Buffer.concat(data);
    return joined.length > 0 ? new Uint8Array(joined) : null;
  }
  if (data instanceof ArrayBuffer) {
    return data.byteLength > 0 ? new Uint8Array(data) : null;
  }
  return null;
};

async function handleLiveConnection(
  ws: WebSocket,
  meetingId: string,
  dependencies: ApiDependencies,
) {
  const repository = dependencies.getMeetingRepository();
  const liveService = dependencies.getLiveTranscriptionService();

  const detail = await repository.getMeetingDetail(meetingId);
  if (!detail) {
    sendJson(ws, { type: "error", message: "Meeting not found." });
    ws.close();
    return;
  }
  if (detail.meeting.sourceType !== "live") {
    sendJson(ws, { type: "error", message: "This meeting is not a live meeting." });
    ws.close();
    return;
  }
  if (!["created", "failed"].includes(detail.meeting.status)) {
    sendJson(ws, {
      type: "error",
      message: "This live meeting is not ready to record.",
    });
    ws.close();
    return;
  }

  const finalUtterances: TranscriptionWord[][] = [];
  let finishRequested = false;
  let persisted = false;
  let fallbackTimer: ReturnType<typeof setTimeout> | null = null;
  const stats = { audioFrames: 0, audioBytes: 0, transcriptEvents: 0 };

  const persistAndComplete = async () => {
    if (persisted) {
      return;
    }
    logger.info(
      {
        meetingId,
        audioFrames: stats.audioFrames,
        audioBytes: stats.audioBytes,
        transcriptEvents: stats.transcriptEvents,
        finalUtterances: finalUtterances.length,
      },
      "live finalisation summary",
    );
    persisted = true;
    if (fallbackTimer) {
      clearTimeout(fallbackTimer);
      fallbackTimer = null;
    }

    try {
      if (finalUtterances.length === 0) {
        await repository.markMeetingFailed({
          meetingId,
          errorCode: "NO_SPEECH_DETECTED",
          errorMessage: "No speech was captured during the live session.",
        });
        sendJson(ws, { type: "error", message: "No speech was captured." });
        return;
      }

      const transcription = buildLiveNormalizedTranscription(finalUtterances, {
        language: detail.meeting.language,
      });
      await repository.replaceMeetingTranscription({
        meetingId,
        transcription,
        processingStartedAt:
          detail.meeting.processingStartedAt ?? new Date().toISOString(),
        processingTimeMs: 0,
      });

      // Reuse the uploaded-audio analysis + indexing pipeline. Best-effort:
      // a transient analysis failure leaves the meeting failed-with-transcript
      // and the user can retry analysis from the meeting page.
      await runAnalysisAndIndexing(meetingId, dependencies);

      sendJson(ws, { type: "completed", meetingId, status: "transcribed" });
    } catch (error) {
      logger.warn({ err: error, meetingId }, "live meeting finalisation failed");
      sendJson(ws, {
        type: "error",
        message:
          error instanceof ApiError
            ? error.message
            : "Live meeting could not be saved.",
      });
    } finally {
      ws.close();
    }
  };

  // Ask Deepgram to flush remaining finals, then persist once the upstream
  // stream closes (or after a safety timeout). Streaming faster than real time
  // means trailing finals can arrive seconds after the client stops, so we must
  // wait for the upstream close rather than a fixed grace period.
  const requestFinish = () => {
    if (finishRequested) {
      return;
    }
    finishRequested = true;
    try {
      session.finish();
    } catch {
      // upstream may already be closing.
    }
    sendJson(ws, { type: "status", status: "processing" });
    fallbackTimer = setTimeout(() => void persistAndComplete(), FINALIZE_MAX_WAIT_MS);
  };

  await repository.markTranscriptionStarted(meetingId).catch((error) => {
    logger.warn({ err: error, meetingId }, "could not mark live transcription started");
  });

  const session = await liveService.openSession(
    {
      language: detail.meeting.language,
      knownParticipants: detail.meeting.knownParticipants,
      technicalTerms: detail.meeting.technicalTerms,
    },
    {
      onTranscript: (event) => {
        stats.transcriptEvents += 1;
        if (event.isFinal && event.words.length > 0) {
          finalUtterances.push(event.words);
        }
        sendJson(ws, {
          type: "transcript",
          isFinal: event.isFinal,
          transcript: event.transcript,
          startMs: event.startMs,
          endMs: event.endMs,
        });
      },
      onError: (error) => {
        logger.warn({ err: error, meetingId }, "deepgram live stream error");
        sendJson(ws, { type: "error", message: "Transcription stream error." });
      },
      onClose: () => {
        // Deepgram has flushed all finals and closed — safe to persist now.
        void persistAndComplete();
      },
    },
  );

  sendJson(ws, { type: "ready" });

  ws.on("message", (data, isBinary) => {
    if (isBinary) {
      const audio = toAudioView(data);
      if (audio) {
        stats.audioFrames += 1;
        stats.audioBytes += audio.length;
        try {
          session.sendAudio(audio);
        } catch (error) {
          logger.warn({ err: error, meetingId }, "failed to forward live audio");
        }
      }
      return;
    }

    // Text control message.
    try {
      const message = JSON.parse(data.toString()) as { type?: unknown };
      if (message.type === "stop") {
        requestFinish();
      }
    } catch {
      // ignore malformed control frames.
    }
  });

  ws.on("close", () => {
    // Client disconnected — ask Deepgram to flush and persist what we have
    // (graceful finish, not an immediate close, so trailing finals are kept).
    requestFinish();
  });

  ws.on("error", (error) => {
    logger.warn({ err: error, meetingId }, "live meeting client socket error");
  });
}

async function runAnalysisAndIndexing(
  meetingId: string,
  dependencies: ApiDependencies,
) {
  const repository = dependencies.getMeetingRepository();
  const analysisService = dependencies.getMeetingAnalysisService();
  const indexingService = dependencies.getMeetingIndexingService();

  if (!analysisService.isConfigured()) {
    return;
  }

  const detail = await repository.getMeetingDetail(meetingId);
  if (!detail || detail.transcriptSegments.length === 0) {
    return;
  }

  try {
    await repository.markAnalysisStarted(meetingId);
    const analysisResult = await analysisService.analyseMeeting({
      meeting: detail.meeting,
      speakers: detail.speakers,
      segments: detail.transcriptSegments,
    });
    await repository.persistMeetingAnalysis({ meetingId, result: analysisResult });
  } catch (error) {
    logger.warn({ err: error, meetingId }, "live meeting analysis failed");
    await repository
      .markMeetingFailed({
        meetingId,
        errorCode: error instanceof ApiError ? error.code : "GEMINI_REQUEST_FAILED",
        errorMessage:
          error instanceof ApiError ? error.message : "Gemini meeting analysis failed.",
      })
      .catch(() => undefined);
    return;
  }

  try {
    const indexed = await repository.getMeetingDetail(meetingId);
    if (indexed) {
      await indexingService.indexMeeting(indexed);
    }
  } catch (error) {
    logger.warn({ err: error, meetingId }, "live meeting indexing failed");
  }
}

export function attachLiveMeetingSocket(
  server: Server,
  dependencies: ApiDependencies = createApiDependencies(),
) {
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (url.pathname !== LIVE_SOCKET_PATH) {
      return;
    }

    const meetingId = url.searchParams.get("meetingId") ?? "";
    if (!uuidSchema.safeParse(meetingId).success) {
      socket.write("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }

    if (!dependencies.getLiveTranscriptionService().isConfigured()) {
      socket.write("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit("connection", ws, request);
      handleLiveConnection(ws, meetingId, dependencies).catch((error) => {
        logger.error({ err: error, meetingId }, "live meeting connection failed");
        sendJson(ws, { type: "error", message: "Live session failed to start." });
        ws.close();
      });
    });
  });

  return wss;
}
