// -----------------------------------------------------
// API base: robust selection for local vs Render
(function(){
  const isLocal = location.protocol === "file:" ||
                  location.hostname === "localhost" ||
                  location.hostname.startsWith("127.");
  if (!window.API_BASE || typeof window.API_BASE !== "string" || !window.API_BASE.trim()) {
    window.API_BASE = isLocal
      ? "http://localhost:8000"
      : location.origin; // same-origin in Render/production
  }
})();

// -----------------------------------------------------
// Utilities
function $(id){ return document.getElementById(id); }
function setStatus(msg){ $("viewerStatus").textContent = msg; }
function now(){ const d = new Date(); return `[${d.toTimeString().slice(0,8)}]`; }
function jstr(o){ try{ return JSON.stringify(o); }catch{return String(o);} }
async function flog(area, message, extra=null, level="INFO"){
  const line = `${now()} [${area}] ${message} | ${jstr(extra??"")}`;
  const el = $("debugLog");
  el.value += (el.value ? "\n" : "") + line;
  el.scrollTop = el.scrollHeight;
  // fire-and-forget to backend
  try {
    await fetch(`${window.API_BASE}/api/log`, {
      method: "POST", headers: {"Content-Type":"application/json"},
      body: JSON.stringify({ area, message, extra, level })
    });
  } catch {}
}

// -----------------------------------------------------
// Elements
const nameEl   = $("aname");
const videoEl  = $("avatarVideo");
const audioEl  = $("avatarAudio");
const placeholderEl = $("avatarPlaceholder");

// Controls
const startBtn = $("startBtn");
const stopBtn  = $("stopBtn");
const enBtn    = $("enableBtn");
const disBtn   = $("disableBtn");
const speakBtn = $("speakBtn");
const promptTxt= $("promptTxt");

const selAvatar = $("avatarId");
const selVoice  = $("voiceId");
const selPose   = $("poseName");

// Mic elements (optional)
const micBlock  = $("micBlock");
const micSelect = $("micDevice");
const micStart  = $("micStartBtn");
const micStop   = $("micStopBtn");
const micText   = $("micTranscript");

// -----------------------------------------------------
// State
let LIVE = false, AUDIO_ENABLED = false;
let pc = null;
let OFFER_SDP = null;
let RTC_CONFIG = { iceServers: [{ urls: ["stun:stun.l.google.com:19302"] }] };

let HAS_WHISPER = false;  // toggles mic UI
let micStream = null;
let mediaRecorder = null;
let recordTimer = null;
let chunkMs = 4000;       // 4s chunking to match common Whisper configs

// -----------------------------------------------------
// Health check (enables mic UI if backend has Whisper)
(async () => {
  try {
    const r = await fetch(`${window.API_BASE}/api/health`);
    const j = await r.json().catch(()=>({}));
    await flog("frontend", "perfume.js loaded", { api_base: window.API_BASE, ping: r.status, health: j });
    setStatus("Ready.");
    if (j && (j.has_whisper || j.hasWhisper)) {
      HAS_WHISPER = true;
      micBlock.style.display = "";
      await populateDevices();
    }
  } catch (e) {
    await flog("frontend", "perfume.js init failed", { err: String(e) }, "ERROR");
    setStatus("init error");
  }
})();

// -----------------------------------------------------
// UI helpers
function showPlaceholder(show){
  placeholderEl.style.display = show ? "flex" : "none";
  videoEl.style.display = show ? "none" : "block";
}
function setLive(on){
  LIVE = on;
  startBtn.disabled = on;
  stopBtn.disabled = !on;
  speakBtn.disabled = !on;
  enBtn.disabled = !on || AUDIO_ENABLED;
  disBtn.disabled = !on || !AUDIO_ENABLED;
  if (!on) {
    audioEl.srcObject = null;
    videoEl.srcObject = null;
    showPlaceholder(true);
  }
}

// -----------------------------------------------------
// WebRTC helpers
function newPC(){
  if (pc) try { pc.close(); } catch {}
  pc = new RTCPeerConnection(RTC_CONFIG);
  pc.onicecandidate = (_ev)=>{ /* trickle=false on server; ignore */ };
  pc.ontrack = (ev)=>{
    if (ev.track.kind === "video") {
      videoEl.srcObject = ev.streams[0];
    } else if (ev.track.kind === "audio") {
      audioEl.srcObject = ev.streams[0];
    }
  };
  return pc;
}

// -----------------------------------------------------
// Viewer flow
async function startViewer(){
  setStatus("starting session…");
  nameEl.textContent = "—";
  setLive(false);
  showPlaceholder(true);

  const FIXED = {
    avatar_id: selAvatar.value || "June_HR_public",
    voice_id:  selVoice.value  || "68dedac41a9f46a6a4271a95c733823c",
    pose_name: selPose.value   || "June HR"
  };
  await flog("viewer", "Start button pressed", FIXED);
  setStatus("requesting viewer params…");

  let j = null;
  try {
    const r = await fetch(`${window.API_BASE}/api/start-session`, {
      method: "POST", headers: {"Content-Type":"application/json"}, body: JSON.stringify(FIXED)
    });
    j = await r.json().catch(()=>({}));
    await flog("viewer", "/api/start-session response", { http: r.status, body: j });
    if (r.status >= 400 || !j.offer_sdp) throw new Error("start-session failed or no offer_sdp");
  } catch (e) {
    await flog("viewer", "start-session failed", { err: String(e) }, "ERROR");
    setStatus("init error (start-session)");
    showPlaceholder(true);
    return;
  }

  OFFER_SDP = j.offer_sdp;
  nameEl.textContent = j.avatar_name || selAvatar.value || "—";

  // Build peer connection
  setStatus("creating peer connection…");
  newPC();
  const offer = { type: "offer", sdp: OFFER_SDP };
  await pc.setRemoteDescription(offer);

  // Add recv-only tracks
  pc.addTransceiver("video", { direction: "recvonly" });
  pc.addTransceiver("audio", { direction: "recvonly" });

  setStatus("creating local answer…");
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);

  const body = { answer_sdp: pc.localDescription.sdp };
  let join = null;
  try {
    const r = await fetch(`${window.API_BASE}/api/join-session`, {
      method: "POST", headers: {"Content-Type":"application/json"}, body: JSON.stringify(body)
    });
    join = await r.json().catch(()=>({}));
    await flog("viewer", "/api/join-session response", { http: r.status, body: join });
    if (r.status >= 400 || !join.success) throw new Error("join-session failed");
  } catch (e) {
    await flog("viewer", "join-session failed", { err: String(e) }, "ERROR");
    setStatus("init error (join-session)");
    showPlaceholder(true);
    try { pc.close(); } catch {}
    return;
  }

  // Live!
  setLive(true);
  AUDIO_ENABLED = false;
  enBtn.disabled = false; disBtn.disabled = true;
  audioEl.muted = true; // start muted until user enables
  setStatus("Live (audio disabled). Click Enable Audio to hear the avatar.");
  showPlaceholder(false);
}

async function stopViewer(){
  setLive(false);
  setStatus("stopping…");
  try {
    await fetch(`${window.API_BASE}/api/stop-session`, { method: "POST" });
  } catch {}
  try { pc && pc.close(); } catch {}
  pc = null;
  setStatus("Stopped.");
}

// -----------------------------------------------------
// Audio gate (for avatar playback)
enBtn.addEventListener("click", async ()=>{
  AUDIO_ENABLED = true;
  enBtn.disabled = true;
  disBtn.disabled = false;
  audioEl.muted = false;
  await flog("viewer", "Audio enabled");
  setStatus("Live (audio ON).");
});
disBtn.addEventListener("click", async ()=>{
  AUDIO_ENABLED = false;
  enBtn.disabled = false;
  disBtn.disabled = true;
  audioEl.muted = true;
  await flog("viewer", "Audio disabled");
  setStatus("Live (audio OFF).");
});

// -----------------------------------------------------
// Speak (TTS from typed text via backend)
speakBtn.addEventListener("click", async ()=>{
  const text = (promptTxt.value || "").trim();
  if (!text) return;
  await flog("viewer", "Speak clicked", { text_len: text.length });
  try {
    const r = await fetch(`${window.API_BASE}/api/speak`, {
      method: "POST", headers: {"Content-Type":"application/json"},
      body: JSON.stringify({ text })
    });
    const j = await r.json().catch(()=>({}));
    await flog("viewer", "/api/speak response", { http: r.status, body: j });
    if (r.status >= 400) throw new Error("speak failed");
  } catch (e) {
    await flog("viewer", "speak failed", { err: String(e) }, "ERROR");
  }
});

// -----------------------------------------------------
// Buttons
startBtn.addEventListener("click", startViewer);
stopBtn.addEventListener("click", stopViewer);

// Clear log
$("clearLogBtn").addEventListener("click", ()=>{
  $("debugLog").value = "";
});

// Expose for optional auto-start
window.__startSession = startViewer;

// -----------------------------------------------------
// Microphone / Transcription support (only if backend has Whisper)
async function populateDevices(){
  try{
    const devices = await navigator.mediaDevices.enumerateDevices();
    const audioInputs = devices.filter(d => d.kind === "audioinput");
    micSelect.innerHTML = "";
    audioInputs.forEach(d=>{
      const o = document.createElement("option");
      o.value = d.deviceId; o.textContent = d.label || `Mic ${micSelect.length+1}`;
      micSelect.appendChild(o);
    });
  } catch(e){
    await flog("mic", "enumerateDevices failed", { err: String(e) }, "ERROR");
  }
}

async function startMic(){
  if (!HAS_WHISPER) return;
  micStart.disabled = true;
  micStop.disabled = false;
  micText.value = "";

  try{
    const constraints = { audio: { deviceId: micSelect.value ? { exact: micSelect.value } : undefined } };
    micStream = await navigator.mediaDevices.getUserMedia(constraints);
  } catch(e){
    await flog("mic", "getUserMedia failed", { err: String(e) }, "ERROR");
    micStart.disabled = false; micStop.disabled = true;
    return;
  }

  try{
    mediaRecorder = new MediaRecorder(micStream, { mimeType: "audio/webm" });
  } catch(e){
    await flog("mic", "MediaRecorder init failed", { err: String(e) }, "ERROR");
    micStart.disabled = false; micStop.disabled = true;
    return;
  }

  mediaRecorder.ondataavailable = async (ev)=>{
    if (!ev.data || !ev.data.size) return;
    try{
      const blob = ev.data;
      const form = new FormData();
      form.append("chunk", blob, "chunk.webm");
      const r = await fetch(`${window.API_BASE}/api/transcribe-chunk`, { method: "POST", body: form });
      const j = await r.json().catch(()=>({}));
      await flog("mic", "/api/transcribe-chunk response", { http: r.status, body: j });
      if (j && j.text) {
        micText.value += (micText.value ? "\n" : "") + j.text;
        micText.scrollTop = micText.scrollHeight;
      }
    } catch(e){
      await flog("mic", "transcribe-chunk failed", { err: String(e) }, "ERROR");
    }
  };

  mediaRecorder.start(); // start stream
  // cycle requestData every chunkMs
  recordTimer = setInterval(()=>{
    if (mediaRecorder && mediaRecorder.state === "recording") {
      try { mediaRecorder.requestData(); } catch {}
    }
  }, chunkMs);

  await flog("mic", "mic started", { device: micSelect.value, chunk_ms: chunkMs });
}

async function stopMic(){
  try{
    if (recordTimer) { clearInterval(recordTimer); recordTimer = null; }
    if (mediaRecorder && mediaRecorder.state !== "inactive") mediaRecorder.stop();
  } catch {}
  try{
    if (micStream) micStream.getTracks().forEach(t => t.stop());
  } catch {}
  micStream = null; mediaRecorder = null;
  micStart.disabled = false; micStop.disabled = true;
  await flog("mic", "mic stopped");
}

micStart.addEventListener("click", startMic);
micStop.addEventListener("click", stopMic);

// refresh devices on permission grant
navigator.mediaDevices && navigator.mediaDevices.addEventListener &&
navigator.mediaDevices.addEventListener("devicechange", async()=>{
  if (HAS_WHISPER) await populateDevices();
});
