(function () {
  const CAMERA_ENTITY = "camera.robogub";
  let activeSession = null;

  function esc(value) {
    return String(value ?? "").replace(/[&<>"']/g, (char) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    }[char]));
  }

  function ensureStyles() {
    if (document.getElementById("beastRobogubWebRtcStyles")) return;
    const style = document.createElement("style");
    style.id = "beastRobogubWebRtcStyles";
    style.textContent = `
      .beast-robogub-camera-overlay{position:fixed;inset:0;z-index:10060;background:rgba(3,6,10,.78);backdrop-filter:blur(8px);display:grid;place-items:center;padding:clamp(12px,3vw,36px)}
      .beast-robogub-camera-modal{width:min(1100px,96vw);max-height:92vh;background:var(--surface-solid,#11151a);border:1px solid var(--border);border-radius:22px;box-shadow:0 24px 80px rgba(0,0,0,.45);overflow:hidden;display:grid;grid-template-rows:auto minmax(0,1fr)}
      .beast-robogub-camera-head{display:flex;align-items:center;justify-content:space-between;gap:14px;padding:14px 16px;border-bottom:1px solid var(--border)}
      .beast-robogub-camera-head small{display:block;color:var(--ink-muted);text-transform:uppercase;letter-spacing:.06em}.beast-robogub-camera-head strong{display:block;font-size:var(--text-lg);margin-top:2px}
      .beast-robogub-camera-close{width:46px;height:46px;border:1px solid var(--border-strong);border-radius:14px;background:var(--surface-2);color:var(--ink);font-size:28px;line-height:1}
      .beast-robogub-camera-stage{position:relative;min-height:320px;background:#050608;display:grid;place-items:center;overflow:hidden}
      .beast-robogub-camera-stage video{display:block;width:100%;height:100%;max-height:78vh;object-fit:contain;background:#050608}
      .beast-robogub-camera-status{position:absolute;left:14px;top:14px;z-index:2;padding:6px 9px;border-radius:999px;background:rgba(0,0,0,.62);color:#fff;font-size:12px;font-weight:700;letter-spacing:.06em;text-transform:uppercase}
      .beast-robogub-camera-error{padding:28px;color:var(--ink-muted);text-align:center;max-width:620px;line-height:1.5}
      @media (orientation:portrait){.beast-robogub-camera-modal{width:min(96vw,900px)}.beast-robogub-camera-stage{min-height:min(64vh,760px)}}
    `;
    document.head.appendChild(style);
  }

  function socketUrl() {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    return `${protocol}//${window.location.host}${window.BeastAuth.HA_PROXY_PATH}/api/websocket`;
  }

  function setStatus(overlay, text) {
    const el = overlay?.querySelector(".beast-robogub-camera-status");
    if (el) el.textContent = text;
  }

  function showError(overlay, message) {
    const stage = overlay?.querySelector(".beast-robogub-camera-stage");
    if (!stage) return;
    stage.innerHTML = `<div class="beast-robogub-camera-error"><strong>Kunne ikke starte RoboGub livekamera</strong><br>${esc(message)}</div>`;
  }

  async function startNativeWebRtc(overlay) {
    if (typeof RTCPeerConnection === "undefined") throw new Error("Chromium understøtter ikke WebRTC på denne enhed.");
    const token = await window.BeastAuth.refreshAccessToken(false);
    if (!token) throw new Error("SmartDash kunne ikke hente et Home Assistant-token.");

    let ws;
    let pc;
    let subscriptionId = 3;
    let nextId = 4;
    let sessionId = null;
    let closed = false;
    const queuedCandidates = [];
    const video = overlay.querySelector("video");
    const remoteStream = new MediaStream();

    const send = (message) => {
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
    };
    const close = () => {
      if (closed) return;
      closed = true;
      try { if (ws?.readyState === WebSocket.OPEN) send({ id: nextId++, type: "unsubscribe_events", subscription: subscriptionId }); } catch (_) {}
      try { pc?.close(); } catch (_) {}
      try { ws?.close(); } catch (_) {}
      if (video) { try { video.pause(); } catch (_) {} video.srcObject = null; }
    };
    activeSession = { close };

    await new Promise((resolve, reject) => {
      ws = new WebSocket(socketUrl());
      const timeout = window.setTimeout(() => reject(new Error("Timeout ved forbindelse til Home Assistant WebRTC.")), 15000);
      ws.addEventListener("error", () => reject(new Error("WebSocket-forbindelsen til Home Assistant fejlede.")));
      ws.addEventListener("message", async (event) => {
        let msg;
        try { msg = JSON.parse(event.data); } catch (_) { return; }
        if (msg.type === "auth_required") { send({ type: "auth", access_token: token }); return; }
        if (msg.type === "auth_invalid") { window.clearTimeout(timeout); reject(new Error("Home Assistant afviste kamera-login.")); return; }
        if (msg.type === "auth_ok") {
          try {
            setStatus(overlay, "Forbinder");
            send({ id: 1, type: "camera/capabilities", entity_id: CAMERA_ENTITY });
          } catch (error) { reject(error); }
          return;
        }
        if (msg.type === "result" && msg.id === 1) {
          if (!msg.success) { window.clearTimeout(timeout); reject(new Error(msg.error?.message || "Kameraets capabilities kunne ikke hentes.")); return; }
          const types = msg.result?.frontend_stream_types || [];
          if (!types.includes("web_rtc")) { window.clearTimeout(timeout); reject(new Error(`Home Assistant rapporterer ikke native WebRTC for ${CAMERA_ENTITY}.`)); return; }
          send({ id: 2, type: "camera/webrtc/get_client_config", entity_id: CAMERA_ENTITY });
          return;
        }
        if (msg.type === "result" && msg.id === 2) {
          if (!msg.success) { window.clearTimeout(timeout); reject(new Error(msg.error?.message || "WebRTC-konfiguration kunne ikke hentes.")); return; }
          try {
            pc = new RTCPeerConnection(msg.result?.configuration || {});
            if (msg.result?.dataChannel) pc.createDataChannel(msg.result.dataChannel);
            pc.ontrack = (trackEvent) => {
              if (trackEvent.track.kind === "video") remoteStream.addTrack(trackEvent.track);
              if (video && video.srcObject !== remoteStream) {
                video.srcObject = remoteStream;
                video.play().catch(() => {});
              }
            };
            pc.oniceconnectionstatechange = () => {
              if (pc.iceConnectionState === "connected" || pc.iceConnectionState === "completed") setStatus(overlay, "Live");
              if (pc.iceConnectionState === "failed") setStatus(overlay, "Forbindelse fejlede");
            };
            pc.onicecandidate = (iceEvent) => {
              if (!iceEvent.candidate?.candidate) return;
              const candidate = iceEvent.candidate.toJSON();
              if (sessionId) send({ id: nextId++, type: "camera/webrtc/candidate", entity_id: CAMERA_ENTITY, session_id: sessionId, candidate });
              else queuedCandidates.push(candidate);
            };
            pc.addTransceiver("audio", { direction: "recvonly" });
            pc.addTransceiver("video", { direction: "recvonly" });
            const offer = await pc.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: true });
            await pc.setLocalDescription(offer);
            send({ id: subscriptionId, type: "camera/webrtc/offer", entity_id: CAMERA_ENTITY, offer: offer.sdp });
          } catch (error) { window.clearTimeout(timeout); reject(error); }
          return;
        }
        if (msg.type === "result" && msg.id === subscriptionId && !msg.success) {
          window.clearTimeout(timeout); reject(new Error(msg.error?.message || "Home Assistant afviste WebRTC-sessionen.")); return;
        }
        if (msg.type === "event" && msg.id === subscriptionId) {
          const data = msg.event;
          if (!data) return;
          if (data.type === "session") {
            sessionId = data.session_id;
            queuedCandidates.splice(0).forEach((candidate) => send({ id: nextId++, type: "camera/webrtc/candidate", entity_id: CAMERA_ENTITY, session_id: sessionId, candidate }));
          } else if (data.type === "answer") {
            try { await pc.setRemoteDescription({ type: "answer", sdp: data.answer }); } catch (error) { window.clearTimeout(timeout); reject(error); }
          } else if (data.type === "candidate") {
            try {
              const candidate = data.candidate?.sdpMid || data.candidate?.sdpMLineIndex != null ? data.candidate : { ...data.candidate, sdpMid: "0" };
              await pc.addIceCandidate(candidate);
            } catch (error) { console.warn("[RoboGub camera] remote ICE candidate", error); }
          } else if (data.type === "error") {
            window.clearTimeout(timeout); reject(new Error(data.message || data.code || "WebRTC-kamerafejl."));
          }
        }
        if (video?.readyState >= 2) { window.clearTimeout(timeout); resolve(); }
      });
      video?.addEventListener("loadeddata", () => { window.clearTimeout(timeout); setStatus(overlay, "Live"); resolve(); }, { once: true });
    });
  }

  function closeModal(overlay) {
    activeSession?.close?.();
    activeSession = null;
    overlay?.remove();
  }

  async function openModal() {
    document.querySelector(".beast-robogub-camera-overlay")?.remove();
    activeSession?.close?.();
    activeSession = null;
    ensureStyles();
    const overlay = document.createElement("div");
    overlay.className = "beast-robogub-camera-overlay";
    overlay.innerHTML = `<div class="beast-robogub-camera-modal" role="dialog" aria-modal="true" aria-label="RoboGub kamera"><div class="beast-robogub-camera-head"><div><small>Kamera</small><strong>RoboGub live</strong></div><button type="button" class="beast-robogub-camera-close" aria-label="Luk kamera">×</button></div><div class="beast-robogub-camera-stage"><span class="beast-robogub-camera-status">Starter</span><video autoplay muted playsinline></video></div></div>`;
    document.body.appendChild(overlay);
    overlay.addEventListener("click", (event) => { if (event.target === overlay || event.target.closest(".beast-robogub-camera-close")) closeModal(overlay); });
    try { await startNativeWebRtc(overlay); }
    catch (error) { activeSession?.close?.(); activeSession = null; showError(overlay, error.message || String(error)); }
  }

  document.addEventListener("click", (event) => {
    const button = event.target.closest?.('[data-robogub-compat-action="camera"]');
    if (!button || button.disabled) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    openModal();
  }, true);

  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    const overlay = document.querySelector(".beast-robogub-camera-overlay");
    if (overlay) closeModal(overlay);
  });
})();
