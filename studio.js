'use strict';

// ── ICE CONFIG ──────────────────────────────────────────────────────────────

const ICE = {
  iceServers: [
    {
      urls: [
        'stun:stun.l.google.com:19302',
        'stun:stun1.l.google.com:19302',
        'stun:stun2.l.google.com:19302',
        'stun:stun3.l.google.com:19302',
        'stun:stun4.l.google.com:19302',
        'stun:stun.cloudflare.com:3478'
      ]
    },
    {
      urls: [
        'turn:relay1.expressturn.com:3478',
        'turn:relay1.expressturn.com:3478?transport=tcp'
      ],
      username: 'efVW0M1DAFIS3RBT7Q',
      credential: 'aIBCqbxYIuqNvBaH'
    },
    {
      urls: [
        'turn:a.relay.metered.ca:80',
        'turn:a.relay.metered.ca:80?transport=tcp',
        'turn:a.relay.metered.ca:443',
        'turns:a.relay.metered.ca:443?transport=tcp'
      ],
      username: 'e8dd65f8a766da5e68e30431',
      credential: 'uSMQbTjbM2VEcHFP'
    }
  ],
  sdpSemantics: 'unified-plan',
  iceTransportPolicy: 'all'
};

// ── STATE ───────────────────────────────────────────────────────────────────

let localStream = null;
let peer = null;
let isHost = false;

// Map of peerId → { call, stream, dataChannel, iceTimer, pingInterval }
const connections = new Map();

// Recording state
let recordings = [];       // Array of { rec, chunks, label }
let timerInterval = null;
let timerSecs = 0;

// Controls
let micOn = true;
let camOn = true;

// Host config
let maxParticipants = 2;   // Including the host
let pendingSlots = 2;

// Keep-alive: re-negotiate every 25 min to prevent WebRTC stale-stream freeze
const KEEPALIVE_RENEGOTIATE_MS = 25 * 60 * 1000;

let toastTimer = null;

// ── GALLERY LAYOUT ──────────────────────────────────────────────────────────

function totalCells() {
  return 1 + connections.size;
}

function applyLayout() {
  const n = isHost ? maxParticipants : totalCells();
  document.getElementById('gallery').className = `layout-${Math.min(n, 4)}`;
}

function buildPresetGrid(total) {
  const gallery = document.getElementById('gallery');
  gallery.querySelectorAll('.video-cell:not(#cell-local)').forEach(el => el.remove());
  for (let i = 1; i < total; i++) {
    const ph = document.createElement('div');
    ph.className = 'video-cell placeholder';
    ph.id = `cell-placeholder-${i}`;
    ph.innerHTML = `
      <div class="placeholder-inner">
        <div class="waiting-icon visible"></div>
        <div class="waiting-text"><strong>Guest ${i}</strong>Waiting…</div>
      </div>`;
    gallery.appendChild(ph);
  }
  gallery.className = `layout-${Math.min(total, 4)}`;
}

function addRemoteCell(peerId, label) {
  const gallery = document.getElementById('gallery');
  const placeholder = gallery.querySelector('.video-cell.placeholder');

  let cell;
  if (placeholder) {
    cell = placeholder;
    cell.className = 'video-cell';
    cell.id = `cell-${peerId}`;
  } else {
    cell = document.createElement('div');
    cell.className = 'video-cell';
    cell.id = `cell-${peerId}`;
    gallery.appendChild(cell);
    applyLayout();
  }

  cell.innerHTML = `
    <video id="v-${peerId}" autoplay playsinline></video>
    <div class="waiting-overlay" id="waiting-${peerId}">
      <div class="waiting-icon visible"></div>
      <div class="waiting-text"><strong>${label}</strong>Connecting…</div>
    </div>
    <div id="reconnect-overlay-${peerId}" class="reconnect-overlay">
      <div class="reconnect-text">
        <strong>Connection interrupted</strong>
        Attempting to restore…
      </div>
      <button class="btn-reconnect" onclick="manualReconnect('${peerId}')">Reconnect now</button>
    </div>
    <div class="cell-label" id="label-${peerId}" style="display:none"><span>●</span>${label}</div>
  `;
}

function removeRemoteCell(peerId) {
  const el = document.getElementById(`cell-${peerId}`);
  if (!el) return;

  if (isHost) {
    el.className = 'video-cell placeholder';
    el.id = `cell-placeholder-${Date.now()}`;
    el.innerHTML = `
      <div class="placeholder-inner">
        <div class="waiting-icon visible"></div>
        <div class="waiting-text"><strong>Guest Slot</strong>Waiting…</div>
      </div>`;
  } else {
    el.remove();
    applyLayout();
  }
}

// ── BOOT ────────────────────────────────────────────────────────────────────

async function setup() {
  buildLocalCell();

  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
      audio: { echoCancellation: true, noiseSuppression: true, sampleRate: 48000, autoGainControl: true }
    });
  } catch {
    try {
      localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      toast('Camera unavailable — audio only');
    } catch {
      toast('Media access denied');
      return;
    }
  }

  const localVid = document.getElementById('v-local');
  localVid.srcObject = localStream;
  localVid.play().catch(() => {});
  vad(localStream, 'cell-local');

  initPeer();
}

function buildLocalCell() {
  const gallery = document.getElementById('gallery');
  gallery.innerHTML = `
    <div class="video-cell local" id="cell-local">
      <video id="v-local" autoplay muted playsinline></video>
      <div class="cell-label"><span>●</span>Host</div>
    </div>
  `;
  applyLayout();
}

// ── PEER INIT ────────────────────────────────────────────────────────────────

function initPeer() {
  peer = new Peer(undefined, { config: ICE, debug: 0 });

  peer.on('open', id => {
    document.getElementById('my-id').innerText = id;
    document.getElementById('modal-id').innerText = id;
    document.getElementById('btn-enter').disabled = false;
    document.getElementById('status-dot').className = 'status-dot connecting';
  });

  peer.on('call', call => {
    if (!isHost) {
      // This participant is a guest — answer the incoming call from host
      answerCall(call, 'Host');
    }
  });

  peer.on('error', e => {
    console.error('[Peer]', e);
    toast('Connection error: ' + (e.type || e));
  });

  // Reconnect peer if it disconnects from signalling server
  peer.on('disconnected', () => {
    setTimeout(() => {
      if (!peer.destroyed) peer.reconnect();
    }, 2000);
  });
}

// ── CONNECT (host side) ──────────────────────────────────────────────────────

function connectToGuest() {
  const inputEl = document.getElementById('guest-id');
  const id = inputEl.value.trim();
  if (!id) { toast('Enter a guest ID first'); return; }
  if (!localStream) { toast('Stream not ready'); return; }
  if (connections.has(id)) { toast('Already connected to this ID'); return; }
  if (totalCells() >= maxParticipants) {
    toast(`Max ${maxParticipants} participants reached`);
    return;
  }

  inputEl.value = '';
  const label = `Guest ${connections.size + 1}`;
  addRemoteCell(id, label);
  doCall(id, label);
}

function doCall(peerId, label) {
  document.getElementById('status-dot').className = 'status-dot connecting';
  toast('Connecting…');

  const call = peer.call(peerId, localStream);

  const entry = {
    call,
    stream: null,
    dataChannel: null,
    iceTimer: null,
    pingInterval: null,
    label,
    peerId,
    renegotiateTimer: null
  };
  connections.set(peerId, entry);

  call.on('stream', stream => onRemote(peerId, stream, label));
  call.on('close', () => onDisconnect(peerId));
  call.on('error', () => onDisconnect(peerId));

  try {
    const dc = call.peerConnection.createDataChannel('kojan-sig');
    entry.dataChannel = dc;
    setupDataChannel(dc, peerId);
  } catch(e) {}

  attachIceMonitor(call, peerId);
  scheduleKeepalive(peerId);
}

// ── ANSWER (guest side) ──────────────────────────────────────────────────────

function answerCall(call, label) {
  const peerId = call.peer;
  addRemoteCell(peerId, label);

  const entry = {
    call,
    stream: null,
    dataChannel: null,
    iceTimer: null,
    pingInterval: null,
    label,
    peerId,
    renegotiateTimer: null
  };
  connections.set(peerId, entry);

  call.answer(localStream);
  call.on('stream', stream => onRemote(peerId, stream, label));
  call.on('close', () => onDisconnect(peerId));
  call.on('error', () => onDisconnect(peerId));

  try {
    call.peerConnection.ondatachannel = ev => {
      entry.dataChannel = ev.channel;
      setupDataChannel(ev.channel, peerId);
    };
  } catch(e) {}

  // Relabel local cell for guest's perspective
  const localLabel = document.querySelector('#cell-local .cell-label');
  if (localLabel) localLabel.innerHTML = '<span>●</span>You';

  attachIceMonitor(call, peerId);
  scheduleKeepalive(peerId);
  toast('Connected to host');
}

// ── KEEPALIVE — prevents 30-40 min stream freeze ─────────────────────────────
// WebRTC connections can have their video/audio silently freeze on some
// browser/OS/network combos after 20-40 min due to DTLS rekeying or SRTP
// counter rollover. The fix is to periodically trigger a lightweight
// renegotiation, which restarts the media pipeline without dropping the call.

function scheduleKeepalive(peerId) {
  const entry = connections.get(peerId);
  if (!entry) return;

  clearTimeout(entry.renegotiateTimer);
  entry.renegotiateTimer = setTimeout(() => {
    triggerRenegotiation(peerId);
  }, KEEPALIVE_RENEGOTIATE_MS);
}

function triggerRenegotiation(peerId) {
  const entry = connections.get(peerId);
  if (!entry || !entry.call) return;

  const pc = entry.call.peerConnection;
  if (!pc || pc.connectionState === 'closed' || pc.connectionState === 'failed') return;

  try {
    // Toggle a video track enabled state briefly to force renegotiation
    // This is lightweight and invisible to the user
    if (pc.restartIce) {
      pc.restartIce();
    } else {
      // Fallback: create offer with iceRestart flag
      pc.createOffer({ iceRestart: true })
        .then(offer => pc.setLocalDescription(offer))
        .catch(() => {});
    }
    console.log('[Keepalive] Renegotiation triggered for', peerId);
  } catch(e) {
    console.warn('[Keepalive]', e);
  }

  // Schedule next keepalive
  scheduleKeepalive(peerId);
}

// ── ICE MONITORING ───────────────────────────────────────────────────────────

function attachIceMonitor(call, peerId) {
  const pc = call.peerConnection;

  pc.oniceconnectionstatechange = () => {
    const s = pc.iceConnectionState;
    console.log('[ICE]', peerId, s);
    const entry = connections.get(peerId);
    if (!entry) return;

    if (s === 'connected' || s === 'completed') {
      clearTimeout(entry.iceTimer);
      updateGlobalStatus();
      hideReconnectOverlay(peerId);
    }

    if (s === 'disconnected') {
      updateGlobalStatus();
      toast('Connection unstable — holding…');
      clearTimeout(entry.iceTimer);
      entry.iceTimer = setTimeout(() => {
        const cur = pc.iceConnectionState;
        if (cur === 'disconnected' || cur === 'failed') {
          try { pc.restartIce(); toast('Restarting ICE…'); } catch(e) { showReconnectOverlay(peerId); }
        }
      }, 4000);
    }

    if (s === 'failed') {
      clearTimeout(entry.iceTimer);
      try {
        pc.restartIce();
        toast('ICE failed — restarting…');
        entry.iceTimer = setTimeout(() => {
          const cur = pc.iceConnectionState;
          if (cur !== 'connected' && cur !== 'completed') showReconnectOverlay(peerId);
        }, 6000);
      } catch(e) {
        showReconnectOverlay(peerId);
      }
    }

    if (s === 'closed') {
      onDisconnect(peerId);
    }
  };

  pc.onconnectionstatechange = () => {
    console.log('[PC]', peerId, pc.connectionState);
    if (pc.connectionState === 'failed') showReconnectOverlay(peerId);
  };
}

function updateGlobalStatus() {
  const dot = document.getElementById('status-dot');
  if (connections.size === 0) {
    dot.className = 'status-dot connecting';
    return;
  }
  const allConnected = [...connections.values()].every(e => {
    if (!e.call) return false;
    const s = e.call.peerConnection.iceConnectionState;
    return s === 'connected' || s === 'completed';
  });
  dot.className = allConnected ? 'status-dot connected' : 'status-dot reconnecting';
}

function showReconnectOverlay(peerId) {
  const el = document.getElementById(`reconnect-overlay-${peerId}`);
  if (el) el.classList.add('show');
  updateGlobalStatus();
}

function hideReconnectOverlay(peerId) {
  const el = document.getElementById(`reconnect-overlay-${peerId}`);
  if (el) el.classList.remove('show');
}

function manualReconnect(peerId) {
  if (!isHost) { toast('Only the host can reconnect.'); return; }
  const entry = connections.get(peerId);
  if (!entry) return;

  const label = entry.label;
  if (entry.call) { try { entry.call.close(); } catch(e) {} }
  connections.delete(peerId);

  // Re-add cell and re-call
  addRemoteCell(peerId, label);
  doCall(peerId, label);
}

// ── REMOTE STREAM ────────────────────────────────────────────────────────────

function onRemote(peerId, stream, label) {
  const entry = connections.get(peerId);
  if (entry) entry.stream = stream;

  const vid = document.getElementById(`v-${peerId}`);
  if (!vid) return;

  vid.srcObject = null;
  vid.srcObject = stream;
  vid.onloadedmetadata = () => vid.play().catch(e => console.warn('[play]', e));
  vid.play().catch(() => {});

  const overlay = document.getElementById(`waiting-${peerId}`);
  if (overlay) overlay.style.display = 'none';

  const lbl = document.getElementById(`label-${peerId}`);
  if (lbl) lbl.style.display = 'block';

  updateGlobalStatus();
  hideReconnectOverlay(peerId);
  toast(`${label} stream live`);

  vadSafe(stream, `cell-${peerId}`);
}

function onDisconnect(peerId) {
  const entry = connections.get(peerId);
  if (entry) {
    clearTimeout(entry.iceTimer);
    clearTimeout(entry.renegotiateTimer);
    clearInterval(entry.pingInterval);
  }
  connections.delete(peerId);
  removeRemoteCell(peerId);
  updateGlobalStatus();
  toast('Participant disconnected');
}

// ── DATA CHANNEL ─────────────────────────────────────────────────────────────

function setupDataChannel(dc, peerId) {
  const entry = connections.get(peerId);

  dc.onopen = () => {
    if (entry) {
      entry.pingInterval = setInterval(() => {
        if (dc.readyState === 'open') {
          try { dc.send('PING'); } catch(e) {}
        }
      }, 15000);
    }
  };

  dc.onclose = () => {
    if (entry) clearInterval(entry.pingInterval);
  };

  dc.onmessage = e => {
    if (e.data === 'REC_START') document.getElementById('rec-notify').classList.add('show');
    if (e.data === 'REC_STOP')  document.getElementById('rec-notify').classList.remove('show');
  };
}

function dcBroadcast(msg) {
  for (const entry of connections.values()) {
    if (entry.dataChannel && entry.dataChannel.readyState === 'open') {
      try { entry.dataChannel.send(msg); } catch(e) {}
    }
  }
}

// ── VOICE ACTIVITY DETECTION ─────────────────────────────────────────────────

function vadSafe(stream, cellId) {
  try {
    const audioOnly = new MediaStream(stream.getAudioTracks());
    vad(audioOnly, cellId);
  } catch {
    vad(stream, cellId);
  }
}

function vad(stream, cellId) {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const src = ctx.createMediaStreamSource(stream);
    const an = ctx.createAnalyser();
    an.fftSize = 256;
    src.connect(an);
    const buf = new Uint8Array(an.frequencyBinCount);
    const el = document.getElementById(cellId);
    let running = true;
    (function tick() {
      if (!running || !el) return;
      an.getByteFrequencyData(buf);
      const avg = buf.reduce((a, b) => a + b, 0) / buf.length;
      el.classList.toggle('speaking', avg > 12);
      requestAnimationFrame(tick);
    })();
    stream.getAudioTracks()[0]?.addEventListener('ended', () => {
      running = false;
      ctx.close();
    });
  } catch(e) {
    console.warn('[VAD]', e);
  }
}

// ── RECORDING ────────────────────────────────────────────────────────────────

function recMime() {
  return [
    'video/webm;codecs=vp8,opus',
    'video/webm;codecs=vp9,opus',
    'video/webm'
  ].find(t => MediaRecorder.isTypeSupported(t)) || '';
}

// Record straight from the live MediaStreamTracks with no AudioContext
// re-routing. Piping audio through an AudioContext (createMediaStreamSource
// → DelayNode → createMediaStreamDestination) resamples it onto the
// AudioContext's own hardware clock; on many browser/OS combos that clock
// drifts slightly from the track's native clock, which is what caused the
// lower pitch and creeping lag. Recording the tracks directly avoids the
// resample entirely, and MediaRecorder timestamps stay tied to the source.
function buildRecStream(stream) {
  const recStream = new MediaStream();
  stream.getVideoTracks().forEach(t => recStream.addTrack(t));
  stream.getAudioTracks().forEach(t => recStream.addTrack(t));
  return recStream;
}

function startRecording() {
  if (!localStream) { toast('No stream'); return; }

  recordings = [];
  const mimeType = recMime();
  const opts = {
    mimeType,
    videoBitsPerSecond: 2_500_000,
    audioBitsPerSecond: 160_000
  };

  // Local track
  const localRec = new MediaRecorder(buildRecStream(localStream), opts);
  const localChunks = [];
  localRec.ondataavailable = e => e.data.size > 0 && localChunks.push(e.data);
  localRec.onerror = e => console.error('[Recorder:local]', e.error || e);
  localRec.start(1000);
  recordings.push({ rec: localRec, chunks: localChunks, label: 'Kojan_Host' });

  // Remote tracks
  for (const [, entry] of connections) {
    if (!entry.stream) continue;
    const remoteRec = new MediaRecorder(buildRecStream(entry.stream), opts);
    const remoteChunks = [];
    remoteRec.ondataavailable = e => e.data.size > 0 && remoteChunks.push(e.data);
    remoteRec.onerror = e => console.error('[Recorder:remote]', e.error || e);
    remoteRec.start(1000);
    const safeName = entry.label.replace(/\s+/g, '_');
    recordings.push({ rec: remoteRec, chunks: remoteChunks, label: `Kojan_${safeName}` });
  }

  const btn = document.getElementById('btn-start');
  btn.disabled = true;
  btn.classList.add('recording');
  btn.innerHTML = '<div class="rec-dot"></div> Recording Live';
  document.getElementById('btn-stop').disabled = false;

  timerSecs = 0;
  const tel = document.getElementById('rec-timer');
  tel.classList.add('visible');
  timerInterval = setInterval(() => {
    timerSecs++;
    tel.innerText = `${String(Math.floor(timerSecs / 60)).padStart(2,'0')}:${String(timerSecs % 60).padStart(2,'0')}`;
  }, 1000);

  document.getElementById('rec-notify').classList.add('show');
  dcBroadcast('REC_START');
  toast('Recording started');
}

function stopRecording() {
  clearInterval(timerInterval);
  document.getElementById('rec-timer').classList.remove('visible');

  const btn = document.getElementById('btn-start');
  btn.disabled = false;
  btn.classList.remove('recording');
  btn.innerHTML = '<div class="rec-dot"></div> Start Recording';
  document.getElementById('btn-stop').disabled = true;
  document.getElementById('rec-notify').classList.remove('show');
  dcBroadcast('REC_STOP');

  let pending = recordings.filter(r => r.rec.state !== 'inactive').length;
  if (!pending) return;

  for (const track of recordings) {
    if (track.rec.state === 'inactive') continue;

    track.rec.onstop = () => {
      const blob = new Blob(track.chunks, { type: 'video/webm' });
      saveBlob(blob, `${track.label}.webm`);
      pending--;
      if (pending === 0) toast(`Saved ${recordings.length} track(s)`);
    };
    track.rec.stop();
  }
}

function saveBlob(blob, name) {
  const a = Object.assign(document.createElement('a'), {
    href: URL.createObjectURL(blob),
    download: name
  });
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(a.href), 8000);
}

// ── CONTROLS ─────────────────────────────────────────────────────────────────

function toggleMic() {
  if (!localStream) return;
  micOn = !micOn;
  localStream.getAudioTracks().forEach(t => t.enabled = micOn);
  const b = document.getElementById('btn-mic');
  b.innerText = micOn ? '🎙 Mic On' : '🔇 Mic Off';
  b.style.color = micOn ? '' : '#E53935';
  b.style.borderColor = micOn ? '' : '#E53935';
}

function toggleCam() {
  if (!localStream) return;
  camOn = !camOn;
  localStream.getVideoTracks().forEach(t => t.enabled = camOn);
  const b = document.getElementById('btn-cam');
  b.innerText = camOn ? '📷 Cam On' : '🚫 Cam Off';
  b.style.color = camOn ? '' : '#E53935';
  b.style.borderColor = camOn ? '' : '#E53935';
}

function copyId() {
  const id = document.getElementById('my-id').innerText;
  if (!id || id === '...') return;
  navigator.clipboard.writeText(id).then(() => toast('ID copied'));
}

function closeModal() {
  document.getElementById('id-modal').style.display = 'none';
  document.getElementById('v-local').play().catch(() => {});
}

function toast(msg) {
  const t = document.getElementById('toast');
  t.innerText = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 3000);
}

// ── HOST MODAL ────────────────────────────────────────────────────────────────

function openHostModal() {
  document.getElementById('host-passkey').value = '';
  document.getElementById('host-err').innerText = '';
  document.getElementById('host-slot-row').style.display = 'none';
  pendingSlots = maxParticipants;
  document.getElementById('slot-count').innerText = pendingSlots;
  document.getElementById('host-modal').classList.add('show');
  setTimeout(() => document.getElementById('host-passkey').focus(), 100);
}

function closeHostModal() {
  document.getElementById('host-modal').classList.remove('show');
}

function adjustSlots(delta) {
  pendingSlots = Math.max(2, Math.min(4, pendingSlots + delta));
  document.getElementById('slot-count').innerText = pendingSlots;
}

function checkPasskey() {
  const val = document.getElementById('host-passkey').value;
  if (val === 'bl4z3@2303') {
    document.getElementById('host-passkey').value = '';
    document.getElementById('host-slot-row').style.display = 'block';

    // Show unlock button as confirm now
    const unlockBtn = document.querySelector('.btn-unlock');
    unlockBtn.innerText = 'Confirm & Enter';
    unlockBtn.onclick = confirmHostSettings;

    document.getElementById('host-err').innerText = '';
  } else {
    document.getElementById('host-err').innerText = 'Incorrect passkey';
    document.getElementById('host-passkey').value = '';
    document.getElementById('host-passkey').focus();
  }
}

function confirmHostSettings() {
  maxParticipants = pendingSlots;
  isHost = true;

  closeHostModal();
  buildPresetGrid(maxParticipants);
  document.getElementById('host-controls-bar').style.display = 'flex';
  document.getElementById('record-controls').style.display = 'flex';

  const unlockBtn = document.querySelector('.btn-unlock');
  unlockBtn.innerText = 'Unlock';
  unlockBtn.onclick = checkPasskey;

  toast(`Host controls unlocked · ${maxParticipants} slots`);
}

function exitStudio() {
  if (!confirm('Leave the studio? This will end your session.')) return;

  for (const [, entry] of connections) {
    clearTimeout(entry.iceTimer);
    clearTimeout(entry.renegotiateTimer);
    clearInterval(entry.pingInterval);
    try { entry.call.close(); } catch(e) {}
  }
  connections.clear();

  if (localStream) localStream.getTracks().forEach(t => t.stop());
  clearInterval(timerInterval);

  document.body.innerHTML = '<div style="background:#0A0A0A;color:#444;font-family:\'DM Mono\',monospace;height:100vh;display:flex;align-items:center;justify-content:center;font-size:11px;letter-spacing:.14em;">SESSION ENDED</div>';
}

// ── KEYBOARD SHORTCUTS ────────────────────────────────────────────────────────

document.addEventListener('keydown', e => {
  if (e.key === 'Enter' && document.getElementById('host-modal').classList.contains('show')) {
    const unlockBtn = document.querySelector('.btn-unlock');
    unlockBtn.click();
  }
});

// Resume AudioContext on first user interaction (required by some browsers)
document.addEventListener('click', () => {}, { once: true });

// ── INIT ─────────────────────────────────────────────────────────────────────

setup();
