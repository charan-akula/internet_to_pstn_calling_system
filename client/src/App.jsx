import { useEffect, useMemo, useRef, useState } from "react";
import { Room, RoomEvent } from "livekit-client";
import "./App.css";

const API_BASE = "http://localhost:8000";
// You should store your Deepgram API Key in your .env file in the client directory
// e.g. VITE_DEEPGRAM_API_KEY=your_deepgram_api_key
const DEEPGRAM_API_KEY = import.meta.env.DEEPGRAM_API_KEY;

function normalizeE164(prefix, phone) {
  const p = `${prefix || ""}${phone || ""}`.replace(/\s+/g, "");
  // very light normalization; you can strengthen later
  if (p.startsWith("+")) return p;
  return `+${p}`;
}

export default function App() {
  const [room, setRoom] = useState(null);
  const [roomName, setRoomName] = useState("");
  const [connected, setConnected] = useState(false);

  const [joining, setJoining] = useState(false);
  const [dialing, setDialing] = useState(false);

  // people you add in UI
  const [people, setPeople] = useState(() => [
    // sample row
    { id: crypto.randomUUID(), name: "Caller 1", prefix: "+91", phone: "7075497632", status: "idle" },
  ]);

  // speaking indicators (identities)
  const [activeSpeakerIds, setActiveSpeakerIds] = useState(new Set());

  // maps for SIP identities -> your person id
  const sipIdentityToPersonId = useRef(new Map());

  // local/agent speaking
  const [agentSpeaking, setAgentSpeaking] = useState(false);

  // Deepgram and Audio Recording States
  const [isRecording, setIsRecording] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const isRecordingRef = useRef(isRecording);
  const isTranscribingRef = useRef(isTranscribing);
  const transcriptEndRef = useRef(null);

  // Sync refs safely across renders
  if (isRecording !== isRecordingRef.current) isRecordingRef.current = isRecording;
  if (isTranscribing !== isTranscribingRef.current) isTranscribingRef.current = isTranscribing;

  const [audioUrl, setAudioUrl] = useState(null);
  const [transcripts, setTranscripts] = useState([]);
  const [activeMembersCount, setActiveMembersCount] = useState(0);

  // Refs for tracking audio node and websocket
  const deepgramSocketRef = useRef(null);
  const mediaRecorderRef = useRef(null);
  const audioChunksRef = useRef([]);
  const audioContextRef = useRef(null);
  const mediaStreamDestinationRef = useRef(null);
  const activeSourcesRef = useRef(new Map()); // track.sid -> mediaStreamSource
  const recentMuteToggles = useRef(new Map()); // personId -> timestamp

  const canCall = useMemo(() => connected && !dialing && people.some(p =>
    p.phone &&
    p.prefix &&
    p.phone.trim().length === 10 &&
    !["calling", "answered", "active"].includes(p.status)
  ), [connected, dialing, people]);

  // Handle mixing LiveKit Audio Tracks
  const handleTrackMix = (track) => {
    if (!audioContextRef.current) return;
    if (track.kind !== "audio") return;

    if (!activeSourcesRef.current.has(track.sid)) {
      const ms = new MediaStream([track.mediaStreamTrack]);
      const source = audioContextRef.current.createMediaStreamSource(ms);
      source.connect(mediaStreamDestinationRef.current);
      activeSourcesRef.current.set(track.sid, source);
    }
  };

  const removeTrackMix = (track) => {
    if (track.kind !== "audio") return;
    const source = activeSourcesRef.current.get(track.sid);
    if (source) {
      source.disconnect();
      activeSourcesRef.current.delete(track.sid);
    }
  };

  async function joinRoom() {
    setJoining(true);
    try {
      const res = await fetch(`${API_BASE}/token`);
      const data = await res.json();

      const lkRoom = new Room({
        adaptiveStream: true,
        dynacast: true,
      });

      // who is speaking (remote + local)
      lkRoom.on(RoomEvent.ActiveSpeakersChanged, (speakers) => {
        const ids = new Set(speakers.map(s => s.identity));
        setActiveSpeakerIds(ids);

        // local participant is included when they speak
        const localId = lkRoom.localParticipant?.identity;
        setAgentSpeaking(localId ? ids.has(localId) : false);
      });

      // Setup audio mixing context and destination
      audioContextRef.current = new (window.AudioContext || window.webkitAudioContext)();
      mediaStreamDestinationRef.current = audioContextRef.current.createMediaStreamDestination();

      lkRoom.on(RoomEvent.TrackSubscribed, (track, publication, participant) => {
        if (track.kind === "audio") {
          track.attach();
          // Mix remote audio
          handleTrackMix(track);
        }
      });

      lkRoom.on(RoomEvent.TrackUnsubscribed, (track) => {
        removeTrackMix(track);
      });

      // Handle local mic track mix
      lkRoom.on(RoomEvent.LocalTrackPublished, (pub) => {
        if (pub.track?.kind === "audio") {
          handleTrackMix(pub.track);
        }
      });
      lkRoom.on(RoomEvent.LocalTrackUnpublished, (pub) => {
        if (pub.track?.kind === "audio") {
          removeTrackMix(pub.track);
        }
      });

      await lkRoom.connect(data.url, data.token);
      await lkRoom.localParticipant.setMicrophoneEnabled(true);

      const localAudioTrack = Array.from(lkRoom.localParticipant.audioTrackPublications.values())[0]?.track;
      if (localAudioTrack) {
        handleTrackMix(localAudioTrack);
      }

      setRoom(lkRoom);
      setRoomName(data.room);
      setConnected(true);

      // Auto-start recording/transcription disabled by default

    } catch (e) {
      console.error(e);
      alert("Failed to join room. Check backend / LiveKit config.");
    } finally {
      setJoining(false);
    }
  }

  const startTranscription = async () => {
    if (!DEEPGRAM_API_KEY) {
      alert("Deepgram API key is missing. Please set VITE_DEEPGRAM_API_KEY in your .env");
      return;
    }

    if (!mediaStreamDestinationRef.current || isTranscribing) return;

    // We clear transcripts on fresh start
    setTranscripts([]);

    const stream = mediaStreamDestinationRef.current.stream;

    const deepgramUrl = 'wss://api.deepgram.com/v1/listen?diarize=true&punctuate=true&model=nova-2';
    deepgramSocketRef.current = new WebSocket(deepgramUrl, ['token', DEEPGRAM_API_KEY]);

    deepgramSocketRef.current.onopen = () => {
      console.log('Deepgram WebSocket connected');
      setIsTranscribing(true);

      // We need a media recorder strictly to feed the websocket chunks and/or save locally
      if (!mediaRecorderRef.current || mediaRecorderRef.current.state === "inactive") {
        mediaRecorderRef.current = new MediaRecorder(stream, { mimeType: 'audio/webm' });

        mediaRecorderRef.current.addEventListener('dataavailable', (e) => {
          if (e.data.size > 0) {
            // Save local recording chunk if recording
            if (isRecordingRef.current) {
              audioChunksRef.current.push(e.data);
            }
            // Send chunk to deepgram if transcribing
            if (isTranscribingRef.current && deepgramSocketRef.current && deepgramSocketRef.current.readyState === WebSocket.OPEN) {
              deepgramSocketRef.current.send(e.data);
            }
          }
        });

        mediaRecorderRef.current.addEventListener('stop', () => {
          if (isRecordingRef.current) {
            const audioBlob = new Blob(audioChunksRef.current, { type: 'audio/webm' });
            setAudioUrl(URL.createObjectURL(audioBlob));
          }
        });

        mediaRecorderRef.current.start(250);
      }
    };

    deepgramSocketRef.current.onmessage = (message) => {
      const data = JSON.parse(message.data);
      if (data.type === 'Results' && data.channel && data.channel.alternatives && data.channel.alternatives[0]) {
        const transcript = data.channel.alternatives[0].transcript;
        if (transcript && data.is_final) {
          // Deepgram gives words array with speaker assigned to each word
          const words = data.channel.alternatives[0].words;
          // Simplified chunking by speaker
          if (words && words.length > 0) {
            const startSpeaker = words[0].speaker;
            setTranscripts(prev => [...prev, {
              id: crypto.randomUUID(),
              speaker: `Speaker ${startSpeaker}`,
              text: transcript,
              time: new Date().toLocaleTimeString()
            }]);
          } else {
            setTranscripts(prev => [...prev, {
              id: crypto.randomUUID(),
              speaker: `Speaker Unknown`,
              text: transcript,
              time: new Date().toLocaleTimeString()
            }]);
          }
        }
      }
    };

    deepgramSocketRef.current.onclose = () => {
      console.log('Deepgram WebSocket closed');
    };

    deepgramSocketRef.current.onerror = (e) => {
      console.error("Deepgram WS Error", e);
    }
  };

  const stopTranscription = () => {
    if (deepgramSocketRef.current) {
      if (deepgramSocketRef.current.readyState === WebSocket.OPEN) {
        deepgramSocketRef.current.send(JSON.stringify({ type: "CloseStream" }));
      }
      deepgramSocketRef.current.close();
      deepgramSocketRef.current = null;
    }
    setIsTranscribing(false);

    // Stop the transcriber-only mediaRecorder if we aren't currently "Recording" audio for download
    if (mediaRecorderRef.current && mediaRecorderRef.current.state === "recording" && !isRecordingRef.current) {
      mediaRecorderRef.current.stop();
      mediaRecorderRef.current = null;
    }
  };

  const startRecording = async () => {
    if (!mediaStreamDestinationRef.current || isRecording) return;
    setAudioUrl(null);
    audioChunksRef.current = [];
    setIsRecording(true);

    const stream = mediaStreamDestinationRef.current.stream;

    // If a media recorder isn't running for transcription already, start one
    if (!mediaRecorderRef.current || mediaRecorderRef.current.state === "inactive") {
      mediaRecorderRef.current = new MediaRecorder(stream, { mimeType: 'audio/webm' });

      mediaRecorderRef.current.addEventListener('dataavailable', (e) => {
        if (e.data.size > 0) {
          if (isRecordingRef.current) audioChunksRef.current.push(e.data);
          if (isTranscribingRef.current && deepgramSocketRef.current && deepgramSocketRef.current.readyState === WebSocket.OPEN) {
            deepgramSocketRef.current.send(e.data);
          }
        }
      });

      mediaRecorderRef.current.addEventListener('stop', () => {
        if (isRecordingRef.current && audioChunksRef.current.length > 0) {
          const audioBlob = new Blob(audioChunksRef.current, { type: 'audio/webm' });
          setAudioUrl(URL.createObjectURL(audioBlob));
        }
      });

      mediaRecorderRef.current.start(250);
    }
  };



  const stopRecording = () => {
    setIsRecording(false);

    // Provide the blob immediately since we are dropping record mode
    if (audioChunksRef.current.length > 0) {
      const audioBlob = new Blob(audioChunksRef.current, { type: 'audio/webm' });
      setAudioUrl(URL.createObjectURL(audioBlob));
    }

    if (mediaRecorderRef.current && mediaRecorderRef.current.state === "recording" && !isTranscribingRef.current) {
      mediaRecorderRef.current.stop();
      mediaRecorderRef.current = null;
    }
  };


  function addPerson() {
    setPeople(prev => [
      ...prev,
      { id: crypto.randomUUID(), name: "", prefix: "+91", phone: "", status: "idle" },
    ]);
  }

  function updatePerson(id, patch) {
    setPeople(prev => prev.map(p => (p.id === id ? { ...p, ...patch } : p)));
  }

  function removePerson(id) {
    setPeople(prev => prev.filter(p => p.id !== id));
  }

  async function hangUpPerson(personId) {
    if (!roomName) return removePerson(personId); // if no room, just delete row

    const person = people.find(p => p.id === personId);
    if (!person) return;

    // find identity map
    let targetIdentity = null;
    for (const [sipIdentity, pid] of sipIdentityToPersonId.current.entries()) {
      if (pid === personId) {
        targetIdentity = sipIdentity;
        break;
      }
    }

    if (targetIdentity && ["calling", "answered", "active"].includes(person.status)) {
      try {
        await fetch(`${API_BASE}/participant/remove`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ room: roomName, identity: targetIdentity })
        });
        // We don't remove the row, we just mark it ended so we can call again
        updatePerson(personId, { status: "ended" });
      } catch (e) {
        console.error("Failed to hang up", e);
      }
    } else {
      // just delete the row if not active
      removePerson(personId);
    }
  }

  async function toggleMute(personId, currentMuted) {
    if (!roomName) return;

    let targetIdentity = null;
    for (const [sipIdentity, pid] of sipIdentityToPersonId.current.entries()) {
      if (pid === personId) {
        targetIdentity = sipIdentity;
        break;
      }
    }

    if (!targetIdentity) return;

    try {
      // Optimistic update
      recentMuteToggles.current.set(personId, Date.now());
      updatePerson(personId, { isMuted: !currentMuted });

      const res = await fetch(`${API_BASE}/participant/mute`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ room: roomName, identity: targetIdentity, muted: !currentMuted })
      });
      const data = await res.json();
      if (!data.ok) {
        throw new Error("Failed");
      }
    } catch (e) {
      console.error("Failed to toggle mute", e);
      // Revert on failure
      updatePerson(personId, { isMuted: currentMuted });
    }
  }

  async function dialSelected(personIds) {
    if (!roomName) return;

    const targets = people
      .filter(p => personIds.includes(p.id))
      .map(p => ({
        person_id: p.id,
        name: p.name?.trim() || "Unknown",
        phone: normalizeE164(p.prefix, p.phone),
      }));

    if (targets.length === 0) return;

    setDialing(true);
    try {
      // set UI state first
      setPeople(prev =>
        prev.map(p =>
          personIds.includes(p.id) ? { ...p, status: "calling" } : p
        )
      );

      const res = await fetch(`${API_BASE}/dial`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ room: roomName, targets }),
      });

      const data = await res.json();
      if (!data.ok) throw new Error(data.error || "Dial failed");

      // store sip identities mapping to people
      // backend returns: [{ person_id, phone, identity }]
      (data.dialed || []).forEach((d) => {
        if (d.identity && d.person_id) {
          sipIdentityToPersonId.current.set(d.identity, d.person_id);
        }
      });

      // Start polling participant list to mark ANSWERED/ENDED accurately
      startParticipantsPolling();
    } catch (e) {
      console.error(e);
      // mark selected as failed
      setPeople(prev =>
        prev.map(p =>
          personIds.includes(p.id) ? { ...p, status: "failed" } : p
        )
      );
      alert("Dial failed. Check SIP trunk / number formatting.");
    } finally {
      setDialing(false);
    }
  }

  async function dialAll() {
    const ids = people.filter(p =>
      p.phone &&
      p.prefix &&
      p.phone.trim().length === 10 &&
      !["calling", "answered", "active"].includes(p.status)
    ).map(p => p.id);
    await dialSelected(ids);
  }

  const pollTimer = useRef(null);

  function startParticipantsPolling() {
    // avoid multiple timers
    if (pollTimer.current) return;

    pollTimer.current = setInterval(async () => {
      try {
        if (!roomName) return;

        const res = await fetch(`${API_BASE}/participants?room=${encodeURIComponent(roomName)}`);
        const data = await res.json();
        if (!data.ok) return;

        const serverParticipants = data.participants || [];
        setActiveMembersCount(serverParticipants.length + 1); // include local agent

        setPeople(prev =>
          prev.map(person => {
            let presentParticipant = null;
            for (const [sipIdentity, personId] of sipIdentityToPersonId.current.entries()) {
              if (personId === person.id) {
                presentParticipant = serverParticipants.find(p => p.identity === sipIdentity);
                if (presentParticipant) break;
              }
            }

            if (presentParticipant) {
              const cs = presentParticipant.call_status;

              // Only sync muted state if we haven't manually toggled it in the last 3000ms
              const lastToggleForPerson = recentMuteToggles.current.get(person.id) || 0;
              const isRecentlyToggled = Date.now() - lastToggleForPerson < 3000;

              // default to local optimistic state if recently toggled to avoid jitter
              const isMuted = isRecentlyToggled ? person.isMuted : (presentParticipant.muted || false);

              if (cs === "active") return { ...person, status: "answered", isMuted: isMuted };
              if (cs) return { ...person, status: cs, isMuted: isMuted }; // use raw sip status if available
              return { ...person, status: "answered", isMuted: isMuted }; // fallback
            }

            if (["calling", "answered", "active"].includes(person.status)) {
              return { ...person, status: "ended" };
            }
            return person;
          })
        );
      } catch (e) {
        // ignore polling errors
      }
    }, 1000);
  }

  async function endCall() {
    try {
      if (pollTimer.current) {
        clearInterval(pollTimer.current);
        pollTimer.current = null;
      }
      if (isRecording) stopRecording();
      if (isTranscribing) stopTranscription();
      if (room) room.disconnect();
    } finally {
      await fetch(`${API_BASE}/end`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ room: roomName }),
      });

      setConnected(false);
      setRoom(null);
      setRoomName("");
      setActiveSpeakerIds(new Set());
      setAgentSpeaking(false);
      setActiveMembersCount(0);
      setTranscripts([]);
      sipIdentityToPersonId.current.clear();
      activeSourcesRef.current.clear();

      if (audioContextRef.current && audioContextRef.current.state !== "closed") {
        audioContextRef.current.close()
      }

      // reset statuses
      setPeople(prev => prev.map(p => ({ ...p, status: "idle" })));
    }
  }

  // speaking indicator for each person:
  // We don’t know the SIP identity purely from UI row, so:
  // - backend returns identity we map to person_id
  // - when identity is in active speakers, mark that person speaking
  const speakingByPersonId = useMemo(() => {
    const map = new Map(); // person_id -> boolean
    for (const [sipIdentity, personId] of sipIdentityToPersonId.current.entries()) {
      if (activeSpeakerIds.has(sipIdentity)) map.set(personId, true);
    }
    return map;
  }, [activeSpeakerIds]);

  useEffect(() => {
    // Scroll to bottom every time transcripts change
    if (transcriptEndRef.current) {
      transcriptEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [transcripts]);

  useEffect(() => {
    return () => {
      if (pollTimer.current) clearInterval(pollTimer.current);
      if (audioContextRef.current && audioContextRef.current.state !== "closed") {
        audioContextRef.current.close()
      }
    };
  }, []);

  return (
    <div className="appShell">
      <header className="topBar">
        <div className="brand">
          <div className="logoDot" />
          <div>
            <div className="brandTitle">Live Voice Console</div>
            <div className="brandSub">Professional calling workspace</div>
          </div>
        </div>

        <div className="topRight">
          {connected ? (
            <>
              <span className="pill ok">Connected</span>
              <span className="pill">Room: {roomName}</span>
              {isRecording ? (
                <button className="btn outline" style={{ color: "var(--danger)", borderColor: "var(--danger)" }} onClick={stopRecording}>Stop Recording</button>
              ) : (
                <button className="btn outline" style={{ color: "#10b981", borderColor: "#10b981" }} onClick={startRecording}>Start Record</button>
              )}
              <button className="btn danger" onClick={endCall}>End Session</button>
            </>
          ) : (
            <span className="pill">Not connected</span>
          )}
        </div>
      </header>

      {!connected && (
        <main className="centerStage">
          <div className="joinCard">
            <div className="joinTitle">Join your calling room</div>
            <div className="joinText">
              Start a secure SIP call session where you can make local and international PSTN calls to any phone number.
            </div>

            <button className="btn primary big" onClick={joinRoom} disabled={joining}>
              {joining ? "Joining..." : "Join Room"}
            </button>

            <div className="hint">
              Note : make pstn calls even without having sim card..
            </div>
          </div>
        </main>
      )}

      {connected && (
        <main className="consoleGrid">
          {/* LEFT: Agent panel */}
          <section className="panel agentPanel">
            <div className="panelHeader">
              <div className="panelTitle">Room</div>
              <div className="panelMeta">Microphone + speaking indicator</div>
            </div>

            <div className="agentOrbWrap">
              <div className={`orb ${agentSpeaking ? "speaking" : ""}`}>
                <div className="orbInner" />
              </div>
              <div className="orbLabel">
                <div className="orbName">You</div>
                <div className={`orbState ${agentSpeaking ? "live" : ""}`}>
                  {agentSpeaking ? "Speaking" : "Idle"}
                </div>
              </div>
            </div>

            <div className="controlsRow">
              <button className="btn secondary" onClick={() => addPerson()}>
                + Add Person
              </button>
              <button className="btn primary" onClick={dialAll} disabled={!canCall}>
                {dialing ? "Calling..." : "Call All"}
              </button>
            </div>
          </section>

          {/* MIDDLE: Participants */}
          <section className="panel participantsPanel">
            <div className="panelHeader">
              <div>
                <div className="panelTitle">Participants</div>
                <div className="panelMeta">Add, edit, call, and monitor statuses</div>
              </div>
              <div className="panelActions">
                <button className="btn ghost" onClick={addPerson}>+ Add</button>
              </div>
            </div>

            <div className="list">
              {people.map((p) => {
                const speaking = speakingByPersonId.get(p.id) === true;
                return (
                  <div key={p.id} className="rowCard">
                    <div className={`avatar ${speaking ? "speaking" : ""}`}>
                      <div className="avatarInner" />
                    </div>

                    <div className="rowMain">
                      <div className="rowTop">
                        <input
                          className="input name"
                          placeholder="Name"
                          value={p.name}
                          onChange={(e) => updatePerson(p.id, { name: e.target.value })}
                        />

                        <span className={`status ${p.status}`}>
                          {p.status}
                        </span>
                      </div>

                      <div className="rowBottom">
                        <input
                          className="input prefix"
                          placeholder="+91"
                          value={p.prefix}
                          onChange={(e) => updatePerson(p.id, { prefix: e.target.value })}
                        />
                        <input
                          className="input phone"
                          placeholder="Phone number"
                          value={p.phone}
                          onChange={(e) => updatePerson(p.id, { phone: e.target.value })}
                        />
                      </div>
                    </div>

                    <div className="rowActions">
                      <button
                        className="btn primary small"
                        onClick={() => dialSelected([p.id])}
                        disabled={
                          !connected ||
                          dialing ||
                          !p.phone ||
                          p.phone.trim().length !== 10 ||
                          !p.prefix ||
                          ["calling", "answered", "active"].includes(p.status)
                        }
                      >
                        Call
                      </button>
                      <button
                        className="btn ghost small"
                        style={{ color: "var(--danger)", borderColor: "var(--danger)" }}
                        onClick={() => hangUpPerson(p.id)}
                      >
                        {["calling", "answered", "active"].includes(p.status) ? "Hang Up" : "Remove"}
                      </button>
                      {["answered", "active"].includes(p.status) && (
                        <button
                          className="btn ghost small"
                          style={{
                            color: p.isMuted ? "#10b981" : "var(--danger)",
                            borderColor: p.isMuted ? "#10b981" : "var(--danger)"
                          }}
                          onClick={() => toggleMute(p.id, p.isMuted)}
                        >
                          {p.isMuted ? "Unmute" : "Mute"}
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </section>

          {/* RIGHT: Live Transcript */}
          <section className="panel transcriptPanel">
            <div className="panelHeader">
              <div>
                <div className="panelTitle">Live Transcript</div>
                <div className="panelMeta">Real-time STT powered by Deepgram</div>
              </div>
              <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
                {isTranscribing ? (
                  <button className="btn outline" style={{ color: "var(--danger)", borderColor: "var(--danger)", padding: "4px 8px", fontSize: "12px" }} onClick={stopTranscription}>Stop Transcript</button>
                ) : (
                  <button className="btn outline" style={{ color: "#10b981", borderColor: "#10b981", padding: "4px 8px", fontSize: "12px" }} onClick={startTranscription}>Start Transcript</button>
                )}
              </div>
            </div>

            <div className="transcriptBody">
              {transcripts.length === 0 && !audioUrl && (
                <div className="joinText" style={{ textAlign: "center", marginTop: 40 }}>
                  No transcript yet. Join a call and hit Start Transcript.
                </div>
              )}
              {transcripts.map(t => (
                <div key={t.id} className="transcriptMessage">
                  <div className="transcriptMeta">
                    <span className="tSpeaker">{t.speaker}</span>
                    <span className="tTime">{t.time}</span>
                  </div>
                  <div className="tText">{t.text}</div>
                </div>
              ))}
              <div ref={transcriptEndRef} />
            </div>
          </section>

        </main>
      )}

      {/* AUDIO PLAYBACK MODAL OVERLAY */}
      {audioUrl && (
        <div className="audioModalOverlay">
          <div className="audioModalContent">
            <h3 style={{ marginTop: 0, marginBottom: "8px", fontSize: "20px", fontWeight: "900" }}>Session Audio Captured</h3>
            <p className="joinText" style={{ marginTop: 0, marginBottom: "20px", fontSize: "14px" }}>
              Your recorded conversation is ready to play and download.
            </p>

            <audio controls src={audioUrl} style={{ width: '100%', outline: 'none', height: 40, marginBottom: '20px' }} />

            <div style={{ display: "flex", gap: "12px", justifyContent: "flex-end" }}>
              <button className="btn ghost" onClick={() => setAudioUrl(null)}>Close</button>
              <a
                href={audioUrl}
                download={`session_${new Date().toISOString().replace(/:/g, '-')}.webm`}
                className="btn primary"
                style={{ display: 'inline-flex', alignItems: 'center', textAlign: 'center', textDecoration: 'none' }}
              >
                Download Recording (WebM)
              </a>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}






