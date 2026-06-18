# Live Recording — Implementation Plan

## Purpose

This document plans **true real-time live transcription**: a user speaks into
their microphone and sees partial/final transcript text appear *while the
meeting is happening*, then the meeting is finalised and analysed like an
uploaded recording.

It is a planning document. No live-streaming code is implemented yet beyond the
scaffolding described below.

## Current state (accurate as of this plan)

What already exists:

- **Browser recording → upload (batch).** `apps/web/src/pages/NewMeetingPage.tsx`
  uses `MediaRecorder` to capture microphone audio into chunks, and on stop
  builds a `File` that is uploaded through the **normal upload pipeline**
  (TUS → `/transcribe` → `/analyze`). This works today. It is *record-then-process*,
  **not** real-time.
- **Live meeting scaffolding.** `meetingSourceType` includes `"live"`,
  `startLiveMeetingInputSchema` exists, and `POST /api/meetings/live`
  (`meetingRoutes.ts`) creates a `live` meeting row via
  `repository.createLiveMeeting(...)`.
- **WebSocket stub.** `apps/api/src/realtime/liveMeetingSocket.ts` accepts the
  upgrade path `/api/meetings/live/socket` but responds `501 Not Implemented`
  and closes.

> Correction to an earlier claim in chat: the browser "record" button is **not**
> a no-op — it records and uploads. The part that is genuinely missing is
> **real-time streaming transcription** (live partial transcripts via the
> WebSocket + Deepgram streaming API). That is what this plan covers.

## Goal

```text
Browser mic ──audio frames──▶ API WebSocket ──stream──▶ Deepgram streaming STT
                                   │                          │
                                   ◀──── partial/final transcript events ─────┘
   live transcript UI ◀──pushed updates── API
                                   │
                                   ▼ on stop
                       persist final segments + speakers
                                   ▼
                       run existing Gemini analysis + RAG indexing
```

The Deepgram API key stays server-side; the browser only talks to the ScribeFlow
WebSocket. This preserves the security boundary documented in
`docs/ARCHITECTURE.md`.

## Architecture

### Backend

1. **WebSocket server** (`liveMeetingSocket.ts`, replace the stub):
   - On upgrade to `/api/meetings/live/socket?meetingId=...`, validate the
     meeting exists and is in a `live`/`recording` state.
   - For each client connection, open a **Deepgram live streaming** connection
     (`@deepgram/sdk` live client — distinct from the batch `listen` API we use
     for uploads).
   - Pipe inbound binary audio frames from the browser straight to Deepgram.
   - Forward Deepgram `transcript` events (interim + final) back to the browser
     as JSON messages.
   - Buffer **final** results server-side for persistence.
2. **Deepgram live client wrapper** (new, e.g. `deepgramLiveTranscriptionService.ts`):
   - Wraps `deepgram.listen.live({ model, diarize, interim_results, ... })`.
   - Handles open/close/error, keepalive, and reconnection.
   - Normalises Deepgram live words/utterances into the same internal shape used
     by `transcriptionResponse.ts` so persistence is shared.
3. **Finalisation** (on stop / socket close):
   - Persist accumulated final segments + speakers (reuse
     `replace_meeting_transcription` RPC), mark meeting `transcribed`.
   - Trigger the existing `/analyze` + indexing path (or call the services
     directly) so the live meeting gets the same summary/topics/action-items/RAG
     treatment as uploads.

### Frontend

1. **Live session UI** (extend `NewMeetingPage` or a new `LiveMeetingPage`):
   - `getUserMedia({ audio: true })` → capture stream.
   - Stream audio to the WebSocket. Two options:
     - **(A) `MediaRecorder` timeslice** (e.g. `recorder.start(250)`), send each
       `ondataavailable` blob over the socket. Simplest; sends WebM/Opus chunks.
     - **(B) `AudioWorklet`/`ScriptProcessor`** → raw PCM frames. More control,
       lower latency, but more code. Recommend starting with (A).
   - Render incoming partial transcript (greyed/italic) and final lines as they
     arrive; show elapsed time and a stop button.
2. **On stop:** close the socket, navigate to the processing/detail page while
   finalisation + analysis complete.

### Data model

- Likely no new tables. Reuse `transcript_segments`, `meeting_speakers`, and the
  `replace_meeting_transcription` RPC.
- Add live meeting statuses if needed: `recording` (in progress) →
  `transcribed` → `completed`. Confirm against the existing status enum and
  migrations before adding.

## Security & robustness considerations

- **Key stays server-side** — audio flows browser → API → Deepgram; the browser
  never sees the Deepgram key. ✅ matches existing boundary.
- **Audio does pass through Express** for live (unlike uploads, which go direct
  to Supabase). That is unavoidable for server-mediated streaming; keep frames
  small and do not buffer the whole meeting in memory — persist finals
  incrementally.
- **Connection drops:** handle browser disconnect, Deepgram disconnect, and
  partial-meeting persistence (don't lose a 30-minute meeting because the socket
  blipped at minute 29). Persist finals as they arrive, not only at the end.
- **Auth:** there is currently no auth; a live socket is a new unauthenticated
  ingress. Acceptable for local/demo, but note it if this is ever deployed.
- **Backpressure / limits:** cap session duration and frame rate; Deepgram
  streaming has its own timeouts and keepalive requirements.

## Work breakdown (suggested order)

1. **Deepgram live wrapper + unit tests** — open a streaming session against a
   mocked client, normalise events. (No UI yet.)
2. **WebSocket server** — replace the 501 stub; relay audio ↔ transcript; log
   safely (no audio, no keys). Integration test with a fake WS client.
3. **Persistence on stop** — accumulate finals, write via the existing RPC, mark
   `transcribed`.
4. **Wire analysis** — reuse `/analyze` + indexing so live meetings get summary/
   RAG. (Benefits from the retry work already done.)
5. **Frontend streaming + live UI** — option (A) first; partial/final rendering.
6. **End-to-end test** — speak → see live text → stop → see summary + search.
7. **Hardening** — reconnection, duration caps, error surfaces, mid-session
   persistence.

## Risks / open decisions

- **Streaming transport:** `MediaRecorder` chunks (simple) vs raw PCM
  (low-latency). Recommend chunks first.
- **Diarisation in streaming mode** is less mature than batch; speaker labels
  may be lower quality live than for uploads. Set expectations.
- **Cost/latency:** live streaming holds an open Deepgram connection for the
  whole meeting.
- **Scope creep:** this is the most complex feature in the app. A realistic
  estimate is **several focused days**, dominated by the WebSocket relay,
  robustness, and the live UI.

## Definition of done

- Speaking into the mic shows partial then final transcript live.
- Stopping persists the transcript and produces summary, topics, action items,
  and RAG search results — identical to the uploaded-audio path.
- Reconnection / disconnection does not lose already-transcribed content.
- Tests cover the live wrapper, the socket relay, and finalisation.
- `docs/ARCHITECTURE.md` "Planned Live Meeting Data Flow" updated to "current".
