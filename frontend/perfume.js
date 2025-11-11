// -----------------------------------------------------
// API base: robust selection for local vs Render
(function(){
  const isLocal = location.protocol === "file:" ||
                  location.hostname === "localhost" ||
                  location.hostname.startsWith("127.");
  if (!window.API_BASE || typeof window.API_BASE !== "string" || !window.API_BASE.trim()) {
    window.API_BASE = isLocal
      ? "http://localhost:8000"
      : location.origin; // ← same-origin in Render/production
  }
})();

// Helpers
function $(id){ return document.getElementById(id); }
function setStatus(msg){ $("viewerStatus").textContent = msg; }
function now(){ const d = new Date(); return `[${d.toTimeString().slice(0,8)}]`; }
function jstr(o){ try{ return JSON.stringify(o); }catch{return String(o);} }
async function flog(area, message, extra=null, level="INFO"){
  const line = `${now()} [${area}] ${message} | ${jstr(extra??"")}`;
  const el = $("debugLog");
  el.value += (el.value ? "\n" : "") + line;
  el.scrollTop = el.scrollHeight;
  try {
    await fetch(`${window.API_BASE}/api/log`, {
      method: "POST", headers: {"Content-Type":"application/json"},
      body: JSON.stringify({ area, message, extra, level })
    });
  } catch {}
}

// Refs
const nameEl   = $("aname");
const videoEl  = $("avatarVideo");
const audioEl  = $("avatarAudio");
const gateEl   = $("audioGate");
const gateBtn  = $("enableBtn");
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

// State
let LIVE = false, AUDIO_ENABLED = false;
let LOCAL_DESC = null, OFFER_SDP = null, pc = null;
let RTC_CONFIG = { iceServers: [{ urls: ["stun:stun.l.google.com:19302"] }] };

// Initial health check (use /api/health; your perfume2 backend has this)
(async () => {
  try {
    const r = await fetch(`${window.API_BASE}/api/health`);
    await flog("frontend", "perfume.js loaded", { api_base: window.API_BASE, ping: r.status });
    setStatus("Ready.");
  } catch (e) {
    await flog("frontend", "perfume.js init failed", { err: String(e) }, "ERROR");
    setStatus("init error");
  }
})();

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

// WebRTC utils
function newPC(){
  if (pc) try { pc.close(); } catch {}
  pc = new RTCPeerConnection(RTC_CONFIG);
  pc.onicecandidate = (ev)=>{ /* backend uses trickle=false, so we ignore */ };
  pc.ontrack = (ev)=>{
    if (ev.track.kind === "video") {
      videoEl.srcObject = ev.streams[0];
    } else if (ev.track.kind === "audio") {
      audioEl.srcObject = ev.streams[0];
    }
  };
  return pc;
}

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
  const vTransceiver = pc.addTransceiver("video", { direction: "recvonly" });
  const aTransceiver = pc.addTransceiver("audio", { direction: "recvonly" });

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

// Audio gate (unmute/mute tag)
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

// Speak
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

// Buttons
startBtn.addEventListener("click", startViewer);
stopBtn.addEventListener("click", stopViewer);

// Clear log
$("clearLogBtn").addEventListener("click", ()=>{
  $("debugLog").value = "";
});

// Expose for optional auto-start
window.__startSession = startViewer;
