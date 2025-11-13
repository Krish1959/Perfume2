/* Perfume2 — Frontend
 * - Keeps all features: Avatar session, mic voicechat, GPT button, logs, UI status.
 * - Restores tile buttons behavior:
 *      Single-click  => English reply
 *      Double-click  => Mandarin reply
 *   Both: write to EditBox + speak via Avatar.
 */

(() => {
  // -----------------------------
  // Config / helpers
  // -----------------------------
  const qs = (s, r = document) => r.querySelector(s);
  const qsa = (s, r = document) => Array.from(r.querySelectorAll(s));
  const params = new URLSearchParams(location.search);
  const API_BASE = params.get("api") || "";
  const fe = (area, message, extra = {}, level = "INFO") => {
    try {
      fetch(`${API_BASE}/api/log`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ area, message, extra, level }),
      });
    } catch {}
    console[level === "ERROR" ? "error" : "log"](
      `[${area}] ${message}`,
      extra || ""
    );
  };

  const el = {
    startBtn: qs("#startBtn"),
    stopBtn: qs("#stopBtn"),
    recBtn: qs("#recBtn"),
    gptBtn: qs("#gptBtn"),
    editBox: qs("#editBox"),
    avatarVideo: qs("#avatarVideo"),
    status: qs("#status"),
    tilesRoot: qs("#perfumeGrid") || document, // fallback
  };

  const state = {
    sessionId: null,
    sessionToken: null,
    offerSdp: null,
    rtcConfig: null,
    pc: null,
    mic: {
      stream: null,
      recorder: null,
      chunks: [],
      isRecording: false,
    },
  };

  const setStatus = (t) => {
    if (el.status) el.status.textContent = t;
  };

  const softUserMsg = (t) => {
    // Do not expose internal errors; keep messages gentle.
    setStatus(t);
    fe("ui", t);
  };

  // Ping
  (async () => {
    try {
      const r = await fetch(`${API_BASE}/api/ping`);
      fe("frontend", "perfume.js loaded", {
        api_base: API_BASE || location.origin,
        ping: r.status,
      });
    } catch (e) {
      fe("frontend", "perfume.js load error", {
        err: String(e),
        api_base: API_BASE || location.origin,
      });
    }
  })();

  // -----------------------------
  // Avatar (HeyGen) session
  // -----------------------------
  async function startSession() {
    setStatus("Connecting avatar…");
    try {
      const r = await fetch(`${API_BASE}/api/start-session`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          // can override with UI controls if you have them
          avatar_id: qs("#avatarId")?.value || "June_HR_public",
          voice_id: qs("#voiceId")?.value || "68dedac41a9f46a6a4271a95c733823c",
          pose_name: qs("#poseName")?.value || "June HR",
        }),
      });
      const j = await r.json();
      fe("viewer", "/api/start-session response", { http: r.status, body: j });
      if (r.status !== 200 || j.status !== "ready") {
        softUserMsg("Avatar not ready. Please retry.");
        return;
      }
      state.sessionId = j.session_id;
      state.sessionToken = j.session_token;
      state.offerSdp = j.offer_sdp;
      state.rtcConfig = j.rtc_config || { iceServers: [] };
      await heygenStart();
      setStatus("Ready.");
    } catch (e) {
      softUserMsg("Unable to connect avatar.");
      fe("viewer", "start-session failed", { err: String(e) }, "ERROR");
    }
  }

  async function heygenStart() {
    // Minimal WebRTC to receive avatar A/V
    const pc = new RTCPeerConnection(state.rtcConfig || {});
    state.pc = pc;

    // Prepare to receive media
    pc.addTransceiver("video");
    pc.addTransceiver("audio");

    // Attach remote tracks to <video>
    const remoteStream = new MediaStream();
    pc.ontrack = (ev) => {
      ev.streams?.[0]?.getTracks().forEach((t) => remoteStream.addTrack(t));
      if (el.avatarVideo && el.avatarVideo.srcObject !== remoteStream) {
        el.avatarVideo.srcObject = remoteStream;
        el.avatarVideo.play().catch(() => {});
      }
    };

    await pc.setRemoteDescription({ type: "offer", sdp: state.offerSdp });
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);

    const fd = new FormData();
    fd.append("session_id", state.sessionId);
    fd.append("answer_sdp", answer.sdp);
    fd.append("session_token", state.sessionToken);

    const r = await fetch(`${API_BASE}/api/heygen/start`, { method: "POST", body: fd });
    const j = await r.json();
    fe("viewer", "/api/heygen/start response", { http: r.status, body: j });
    if (r.status !== 200) {
      softUserMsg("Avatar negotiation failed.");
    }
  }

  async function stopSession() {
    try {
      await fetch(`${API_BASE}/api/stop-session`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          session_id: state.sessionId,
          session_token: state.sessionToken,
        }),
      });
    } catch {}
    try {
      state.pc?.getSenders().forEach((s) => s.track && s.track.stop());
      state.pc?.close();
    } catch {}
    state.pc = null;
    state.sessionId = null;
    state.sessionToken = null;
    setStatus("Stopped.");
  }

  async function speakWithAvatar(text) {
    if (!text || !state.sessionId || !state.sessionToken) {
      // Start session automatically if not running.
      if (!state.sessionId) {
        await startSession();
        if (!state.sessionId) return;
      }
    }
    try {
      const res = await fetch(`${API_BASE}/api/send-task`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          session_id: state.sessionId,
          session_token: state.sessionToken,
          text,
        }),
      });
      const j = await res.json();
      fe("say", "avatar speak task", { http: res.status, body: j });
    } catch (e) {
      fe("say", "avatar speak failed", { err: String(e) }, "ERROR");
    }
  }

  // -----------------------------
  // GPT button (free-form chat)
  // -----------------------------
  async function sendGptFromEditBox() {
    const text = el.editBox?.value?.trim() || "";
    if (!text) return;
    setStatus("Thinking…");
    try {
      const fd = new FormData();
      fd.append("text", text);
      const r = await fetch(`${API_BASE}/api/chat`, { method: "POST", body: fd });
      const j = await r.json();
      if (r.status !== 200) {
        softUserMsg("Please try again.");
        fe("viewer", "chat error", { http: r.status, body: j }, "ERROR");
        return;
      }
      const reply = (j.response || "").trim();
      if (el.editBox) el.editBox.value = reply;
      speakWithAvatar(reply);
      setStatus("Ready.");
    } catch (e) {
      softUserMsg("Please try again.");
      fe("viewer", "chat exception", { err: String(e) }, "ERROR");
    }
  }

  // -----------------------------
  // MIC: voicechat (kept intact)
  // -----------------------------
  async function ensureMic() {
    if (state.mic.stream) return state.mic.stream;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      state.mic.stream = stream;
      return stream;
    } catch (e) {
      softUserMsg("Mic permission required.");
      throw e;
    }
  }

  function stopRecorder() {
    try { state.mic.recorder?.stop(); } catch {}
    state.mic.isRecording = false;
  }

  function toggleRec() {
    if (state.mic.isRecording) {
      stopRecorder();
      el.recBtn && (el.recBtn.textContent = "Rec");
      setStatus("Processing voice…");
      return;
    }
    // start
    ensureMic()
      .then((stream) => {
        state.mic.chunks = [];
        const rec = new MediaRecorder(stream, { mimeType: "audio/webm;codecs=opus" });
        state.mic.recorder = rec;
        rec.ondataavailable = (ev) => {
          if (ev.data && ev.data.size > 0) state.mic.chunks.push(ev.data);
        };
        rec.onstop = async () => {
          try {
            const blob = new Blob(state.mic.chunks, { type: "audio/webm;codecs=opus" });
            await sendVoiceToServer(blob);
          } finally {
            state.mic.chunks = [];
            setStatus("Ready.");
          }
        };
        rec.start();
        state.mic.isRecording = true;
        el.recBtn && (el.recBtn.textContent = "End");
        fe("mic", "Mic pressed");
      })
      .catch((e) => fe("mic", "Mic failed", { err: String(e) }, "ERROR"));
  }

  async function sendVoiceToServer(blob) {
    const fd = new FormData();
    fd.append("file", blob, "voice.webm");
    fe("mic", "sending to /api/voicechat", {
      type: blob.type,
      size: blob.size,
    });
    const r = await fetch(`${API_BASE}/api/voicechat`, { method: "POST", body: fd });
    const j = await r.json();
    fe("mic", "/api/voicechat response", { http: r.status, body: j });
    if (r.status !== 200) {
      softUserMsg("Please try again.");
      return;
    }
    const reply = (j.response || "").trim();
    // Voice part kept intact: write reply to EditBox and send to Avatar
    if (el.editBox) el.editBox.value = reply;
    speakWithAvatar(reply);
  }

  // -----------------------------
  // TILE buttons — restored behavior
  //   Single-click: English
  //   Double-click: Mandarin
  //   Always: write to EditBox + speak
  // -----------------------------
  function collectPerfumeTiles() {
    // Prefer elements explicitly marked for perfume tiles
    let tiles = qsa(".perfume-tile[data-name]", el.tilesRoot);
    if (tiles.length) return tiles;

    // Fallbacks for older markup variants you used earlier
    tiles = qsa(".tile[data-name]", el.tilesRoot);
    if (tiles.length) return tiles;

    tiles = qsa("[data-name].tile-perfume", el.tilesRoot);
    if (tiles.length) return tiles;

    // Last resort: any element inside #perfumeGrid that carries a name
    tiles = qsa("#perfumeGrid [data-name]");
    return tiles;
  }

  function wireTileHandlers() {
    const tiles = collectPerfumeTiles();
    if (!tiles.length) return;

    // To disambiguate single vs double click reliably across browsers
    const CLICK_DELAY = 250; // ms
    const timerByEl = new WeakMap();

    tiles.forEach((tile) => {
      const name =
        tile.getAttribute("data-name") ||
        tile.dataset?.name ||
        tile.title ||
        tile.alt ||
        tile.textContent?.trim() ||
        "";

      const doSingle = () => handleTile(name, /*isDouble*/ false);
      const doDouble = () => handleTile(name, /*isDouble*/ true);

      // Click timer to separate single from double
      tile.addEventListener("click", (ev) => {
        const old = timerByEl.get(tile);
        if (old) {
          clearTimeout(old);
        }
        const t = setTimeout(() => {
          timerByEl.delete(tile);
          doSingle();
        }, CLICK_DELAY);
        timerByEl.set(tile, t);
      });

      tile.addEventListener("dblclick", (ev) => {
        const old = timerByEl.get(tile);
        if (old) clearTimeout(old);
        timerByEl.delete(tile);
        doDouble();
      });
    });
  }

  async function handleTile(perfumeName, isDouble) {
    if (!perfumeName) return;
    try {
      setStatus(isDouble ? "解释中…" : "Explaining…");

      const fd = new FormData();
      fd.append("name", perfumeName);
      // The backend toggles zh if this flag is present
      if (isDouble) fd.append("is_double_click", "1");

      const r = await fetch(`${API_BASE}/api/perfume-explain`, {
        method: "POST",
        body: fd,
      });
      const j = await r.json();
      if (r.status !== 200) {
        softUserMsg(isDouble ? "请再试一次。" : "Please try again.");
        fe("tile", "perfume-explain error", { http: r.status, body: j }, "ERROR");
        return;
      }

      const reply = (j.response || "").trim();
      if (el.editBox) el.editBox.value = reply;
      await speakWithAvatar(reply);
      setStatus("Ready.");
    } catch (e) {
      softUserMsg(isDouble ? "请再试一次。" : "Please try again.");
      fe("tile", "tile exception", { err: String(e) }, "ERROR");
    }
  }

  // -----------------------------
  // Wire UI
  // -----------------------------
  el.startBtn && el.startBtn.addEventListener("click", async () => {
    fe("viewer", "Start button pressed", {
      avatar_id: qs("#avatarId")?.value || "June_HR_public",
      voice_id: qs("#voiceId")?.value || "68dedac41a9f46a6a4271a95c733823c",
      pose_name: qs("#poseName")?.value || "June HR",
    });
    await startSession();
  });

  el.stopBtn && el.stopBtn.addEventListener("click", async () => {
    await stopSession();
  });

  el.recBtn && el.recBtn.addEventListener("click", toggleRec);

  el.gptBtn && el.gptBtn.addEventListener("click", sendGptFromEditBox);

  // Tiles
  wireTileHandlers();

  // Cosmetic ready message
  setStatus("Ready.");
})();
