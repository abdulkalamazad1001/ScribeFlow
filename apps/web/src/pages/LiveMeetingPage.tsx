import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { PageHeader } from "../components/PageHeader";
import { buildLiveSocketUrl, createLiveMeeting } from "../lib/apiClient";

type Phase = "setup" | "connecting" | "recording" | "finishing" | "error";

type ServerMessage =
  | { type: "ready" }
  | { type: "transcript"; isFinal: boolean; transcript: string }
  | { type: "status"; status: string }
  | { type: "completed"; meetingId: string }
  | { type: "error"; message?: string };

const formatElapsed = (seconds: number) => {
  const mm = Math.floor(seconds / 60)
    .toString()
    .padStart(2, "0");
  const ss = (seconds % 60).toString().padStart(2, "0");
  return `${mm}:${ss}`;
};

export function LiveMeetingPage() {
  const navigate = useNavigate();
  const [phase, setPhase] = useState<Phase>("setup");
  const [title, setTitle] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [finalLines, setFinalLines] = useState<string[]>([]);
  const [interim, setInterim] = useState("");
  const [elapsed, setElapsed] = useState(0);

  const wsRef = useRef<WebSocket | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const cleanup = () => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== "inactive") {
      recorder.stop();
    }
    recorderRef.current = null;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    if (wsRef.current && wsRef.current.readyState <= WebSocket.OPEN) {
      wsRef.current.close();
    }
    wsRef.current = null;
  };

  useEffect(() => cleanup, []);

  const startLive = async () => {
    if (!title.trim()) {
      setError("Enter a meeting title before recording.");
      return;
    }
    setError(null);
    setFinalLines([]);
    setInterim("");
    setElapsed(0);
    setPhase("connecting");

    let meetingId: string;
    try {
      const response = await createLiveMeeting({
        title: title.trim(),
        knownParticipants: [],
        technicalTerms: [],
      });
      meetingId = response.meeting.id;
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Could not create the live meeting.",
      );
      setPhase("error");
      return;
    }

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      setError("Microphone access was denied. Allow it and try again.");
      setPhase("error");
      return;
    }
    streamRef.current = stream;

    const ws = new WebSocket(buildLiveSocketUrl(meetingId));
    wsRef.current = ws;
    ws.binaryType = "arraybuffer";

    ws.onopen = () => {
      const preferred = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"];
      const mimeType =
        typeof MediaRecorder !== "undefined"
          ? preferred.find((t) => MediaRecorder.isTypeSupported(t))
          : undefined;
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      recorderRef.current = recorder;
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0 && ws.readyState === WebSocket.OPEN) {
          ws.send(event.data);
        }
      };
      recorder.start(250);
    };

    ws.onmessage = (event) => {
      let message: ServerMessage;
      try {
        message = JSON.parse(String(event.data)) as ServerMessage;
      } catch {
        return;
      }

      if (message.type === "ready") {
        setPhase("recording");
        timerRef.current = setInterval(() => setElapsed((s) => s + 1), 1000);
      } else if (message.type === "transcript") {
        if (message.isFinal) {
          setFinalLines((lines) => [...lines, message.transcript]);
          setInterim("");
        } else {
          setInterim(message.transcript);
        }
      } else if (message.type === "status") {
        setPhase("finishing");
      } else if (message.type === "completed") {
        cleanup();
        navigate(`/meetings/${message.meetingId}`);
      } else if (message.type === "error") {
        setError(message.message ?? "The live session failed.");
        setPhase("error");
        cleanup();
      }
    };

    ws.onerror = () => {
      setError("The live connection failed. Check that the API server is running.");
      setPhase("error");
      cleanup();
    };
  };

  const stopLive = () => {
    setPhase("finishing");
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }

    const ws = wsRef.current;
    const sendStop = () => {
      streamRef.current?.getTracks().forEach((track) => track.stop());
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "stop" }));
      }
    };

    const recorder = recorderRef.current;
    if (recorder && recorder.state !== "inactive") {
      // Send the stop control frame only after the final audio chunk has been
      // flushed via ondataavailable, so trailing speech is not cut off.
      recorder.onstop = sendStop;
      recorder.stop();
    } else {
      sendStop();
    }
  };

  const isLive = phase === "recording";
  const isBusy = phase === "connecting" || phase === "finishing";

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="LIVE"
        title="Record a live meeting"
        description="Stream your microphone for real-time transcription. Audio is sent to the ScribeFlow server, transcribed by Deepgram as you speak, then summarised and indexed when you stop."
      />

      {phase === "setup" || phase === "error" ? (
        <div className="space-y-4 rounded-card border border-border bg-surface p-6">
          <label className="block space-y-2">
            <span className="text-sm font-medium">Meeting title</span>
            <input
              type="text"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="e.g. Weekly product sync"
              className="w-full rounded-control border border-border bg-background px-3 py-2"
            />
          </label>
          {error ? <p className="text-sm text-red-400">{error}</p> : null}
          <button
            type="button"
            onClick={startLive}
            className="rounded-control bg-accent px-4 py-2 font-medium text-accent-foreground"
          >
            Start recording
          </button>
        </div>
      ) : null}

      {phase !== "setup" && phase !== "error" ? (
        <div className="space-y-4 rounded-card border border-border bg-surface p-6">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <span
                className={`inline-block h-3 w-3 rounded-full ${
                  isLive ? "animate-pulse bg-red-500" : "bg-muted"
                }`}
                aria-hidden
              />
              <span className="font-medium">
                {phase === "connecting"
                  ? "Connecting…"
                  : phase === "recording"
                    ? "Recording"
                    : "Processing…"}
              </span>
            </div>
            <span className="tabular-nums text-muted-foreground">
              {formatElapsed(elapsed)}
            </span>
          </div>

          <div className="min-h-[200px] space-y-2 rounded-control border border-border bg-background p-4">
            {finalLines.length === 0 && !interim ? (
              <p className="text-sm text-muted-foreground">
                {isLive
                  ? "Listening… start speaking."
                  : "Waiting for the transcription stream…"}
              </p>
            ) : null}
            {finalLines.map((line, index) => (
              <p key={index} className="text-sm leading-relaxed">
                {line}
              </p>
            ))}
            {interim ? (
              <p className="text-sm italic leading-relaxed text-muted-foreground">
                {interim}
              </p>
            ) : null}
          </div>

          <button
            type="button"
            onClick={stopLive}
            disabled={!isLive}
            className="rounded-control bg-red-500/90 px-4 py-2 font-medium text-white disabled:opacity-50"
          >
            {isBusy && phase === "finishing"
              ? "Finishing…"
              : "Stop & process meeting"}
          </button>
        </div>
      ) : null}
    </div>
  );
}
