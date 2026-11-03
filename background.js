import OBR, { buildLight } from "https://esm.sh/@owlbear-rodeo/sdk@3";
import {
  NS, CFG_KEY, SCARE_MSG, ENABLE_MODAL, RANGE_MODAL, AUDIO_CHANNEL, CONE_ANGLE,
  getCfg, roomSettings, base, showScare, soundUrlOf, analyze,
} from "./shared.js";

const LIGHT_TAG = `${NS}/light`;
const iconUrl = base("icon.svg");

let items = [];
let room = { mode: "individual", disabled: {} };
let scaring = false;
const fired = new Set();
const lightFor = new Map();   // tokenId -> { sig, ids[] }

/* =====================  SOUND ENGINE  =====================
   Sounds are fetched + decoded once (instant replay, volume boost). If a host blocks CORS we fall back
   to a plain <audio> element (no boost). A built-in boom/screech/heartbeat can be layered on top. */
const channel = new BroadcastChannel(AUDIO_CHANNEL);
const ctx = new AudioContext();
const limiter = ctx.createDynamicsCompressor();
limiter.threshold.value = -8; limiter.knee.value = 0; limiter.ratio.value = 20;
limiter.attack.value = 0.002; limiter.release.value = 0.15;
limiter.connect(ctx.destination);

const sounds = new Map();   // url -> Promise<{buffer, el}>
let stops = [];

function loadSound(url) {
  if (!sounds.has(url)) {
    sounds.set(url, (async () => {
      const rec = { buffer: null, el: null };
      try {
        const res = await fetch(url);
        if (!res.ok) throw new Error(res.status);
        rec.buffer = await ctx.decodeAudioData(await res.arrayBuffer());
      } catch {
        const a = new Audio(); a.preload = "auto"; a.src = url; a.load(); rec.el = a;
      }
      return rec;
    })());
  }
  return sounds.get(url);
}

function env(node, t, peak, dur) {
  const g = ctx.createGain();
  g.gain.setValueAtTime(peak, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + dur);
  node.connect(g).connect(limiter);
  return g;
}
function thump(t, vol) {
  const o = ctx.createOscillator(); o.type = "sine";
  o.frequency.setValueAtTime(75, t); o.frequency.exponentialRampToValueAtTime(38, t + 0.15);
  env(o, t, vol, 0.2); o.start(t); o.stop(t + 0.25);
  stops.push(() => { try { o.stop(); } catch {} });
}
function heartbeat(start, length) {
  for (let t = 0; t < length - 0.15; t += 0.75) { thump(start + t, 0.9); thump(start + t + 0.2, 0.7); }
}
function boom(t) {
  const o = ctx.createOscillator(); o.type = "sine";
  o.frequency.setValueAtTime(120, t); o.frequency.exponentialRampToValueAtTime(26, t + 0.6);
  env(o, t, 1.4, 0.8); o.start(t); o.stop(t + 0.9);

  const n = Math.floor(ctx.sampleRate * 0.6);
  const buf = ctx.createBuffer(1, n, ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / n, 2);
  const s = ctx.createBufferSource(); s.buffer = buf;
  const hp = ctx.createBiquadFilter(); hp.type = "highpass"; hp.frequency.value = 500;
  s.connect(hp); env(hp, t, 0.9, 0.6); s.start(t);

  const sc = ctx.createOscillator(); sc.type = "sawtooth";
  sc.frequency.setValueAtTime(700, t); sc.frequency.exponentialRampToValueAtTime(2600, t + 0.4);
  env(sc, t, 0.28, 0.7); sc.start(t); sc.stop(t + 0.75);
}
function stopAll() { stops.forEach((f) => f()); stops = []; }

async function playSound(m) {
  const delay = Math.max(0, m.delay || 0);
  try {
    if (ctx.state !== "running") await Promise.race([ctx.resume(), new Promise((r) => setTimeout(r, 250))]);
  } catch {}
  const rec = await loadSound(m.url);
  stopAll();
  const running = ctx.state === "running";
  if (running) {
    const t = ctx.currentTime + delay + 0.03;
    if (delay > 0.3) heartbeat(ctx.currentTime + 0.03, delay);
    if (m.boom) boom(t);
    if (rec.buffer) {
      const src = ctx.createBufferSource(); src.buffer = rec.buffer;
      const g = ctx.createGain(); g.gain.value = Math.min(4, Math.max(0.1, (m.volume || 100) / 100));
      src.connect(g).connect(limiter); src.start(t);
      stops.push(() => { try { src.stop(); } catch {} });
      return;
    }
  }
  if (rec.el) {
    setTimeout(() => {
      rec.el.currentTime = 0;
      rec.el.play().catch(() => channel.postMessage({ type: "blocked", url: m.url }));
    }, delay * 1000);
  } else if (!running) {
    channel.postMessage({ type: "blocked", url: m.url });   // let the scare window try
  }
}
channel.onmessage = (e) => { if (e.data?.type === "play") playSound(e.data); };

function preloadSounds() {
  for (const it of items) { const c = getCfg(it); if (c.jumpscare) loadSound(soundUrlOf(c)); }
}

/* =====================  SCARE DELIVERY  ===================== */
async function receiveScare(cfg) {
  if ((await OBR.player.getRole()) === "GM") return;
  if (room.disabled[OBR.player.id]) return;
  if (scaring) return;
  scaring = true;
  setTimeout(() => (scaring = false), ((cfg.buildup || 0) + (cfg.duration || 2.5)) * 1000 + 1200);
  try { await showScare(cfg); }
  catch (e) { console.error("[jumpscare] could not open scare:", e); scaring = false; }
}

async function trigger(cfg) {
  if (room.mode === "party") {
    await OBR.broadcast.sendMessage(SCARE_MSG, { cfg }, { destination: "ALL" });
  } else {
    await receiveScare(cfg);
  }
}

/* =====================  TRIGGER DETECTION  ===================== */
let running = false, again = false;
async function check() {
  if (running) { again = true; return; }
  running = true;
  try {
    if (scaring) return;
    if ((await OBR.player.getRole()) === "GM") return;
    if (room.mode === "individual" && room.disabled[OBR.player.id]) return;

    const a = await analyze(items, OBR.player.id);
    if (!a.mine.length || !a.scary.length) { fired.clear(); return; }

    for (const r of a.results) {
      const id = r.s.item.id;
      if (r.entered || r.seen) {
        if (!fired.has(id)) { fired.add(id); await trigger(r.s.cfg); break; }
      } else {
        fired.delete(id);
      }
    }
  } catch (e) {
    console.error("[jumpscare] check failed:", e);
  } finally {
    running = false;
    if (again) { again = false; check(); }
  }
}

/* =====================  FOG REVEAL (local lights)  ===================== */
async function syncLights() {
  const dpi = await OBR.scene.grid.getDpi();
  const want = new Map();
  for (const it of items) {
    if (it.layer !== "CHARACTER") continue;
    const c = getCfg(it);
    if (c.range > 0 && !c.jumpscare) want.set(it.id, { it, c });
  }
  const sigOf = (c) => `${c.range}|${c.shape}|${dpi}`;

  const stale = [];
  for (const [tid, rec] of lightFor) {
    const w = want.get(tid);
    if (!w || rec.sig !== sigOf(w.c)) { stale.push(...rec.ids); lightFor.delete(tid); }
  }
  if (stale.length) await OBR.scene.local.deleteItems(stale);

  const add = [];
  for (const [tid, { it, c }] of want) {
    if (lightFor.has(tid)) continue;
    const mk = () => buildLight()
      .position(it.position).rotation(it.rotation).attachedTo(tid)
      .sourceRadius(dpi * 0.25).metadata({ [LIGHT_TAG]: true });
    const main = mk().attenuationRadius(c.range * dpi);
    if (c.shape === "cone") main.innerAngle(CONE_ANGLE).outerAngle(CONE_ANGLE);
    const lights = [main.build()];
    if (c.shape === "cone") lights.push(mk().attenuationRadius(dpi).build());  // 1-cell bubble so you see your own token
    add.push(...lights);
    lightFor.set(tid, { sig: sigOf(c), ids: lights.map((l) => l.id) });
  }
  if (add.length) await OBR.scene.local.addItems(add);
}

/* =====================  SETUP  ===================== */
OBR.onReady(async () => {
  const me = OBR.player.id;
  const openRange = (ctxMenu) =>
    OBR.modal.open({
      id: RANGE_MODAL,
      url: `${base("range.html")}?id=${encodeURIComponent(ctxMenu.items[0].id)}`,
      width: 340, height: 300,
    });
  const charOnly = { key: "layer", value: "CHARACTER" };

  OBR.contextMenu.create({
    id: `${NS}/range-gm`,
    icons: [{ icon: iconUrl, label: "Token Settings", filter: { min: 1, max: 1, every: [charOnly], roles: ["GM"] } }],
    onClick: openRange,
  });
  OBR.contextMenu.create({
    id: `${NS}/range-player`,
    icons: [{
      icon: iconUrl, label: "Token Settings",
      filter: {
        min: 1, max: 1, every: [charOnly], roles: ["PLAYER"],
        some: [{ key: "createdUserId", value: me }, { key: ["metadata", CFG_KEY, "owner"], value: me }],
      },
    }],
    onClick: openRange,
  });

  const applyRoom = (md) => { room = roomSettings(md); };
  applyRoom(await OBR.room.getMetadata());
  OBR.room.onMetadataChange((md) => { applyRoom(md); check(); });

  OBR.broadcast.onMessage(SCARE_MSG, (ev) => receiveScare(ev.data.cfg));

  OBR.modal.open({ id: ENABLE_MODAL, url: base("enable.html"), width: 320, height: 150 }).catch(() => {});

  const start = async () => {
    const old = await OBR.scene.local.getItems((i) => i.metadata?.[LIGHT_TAG]);
    if (old.length) await OBR.scene.local.deleteItems(old.map((i) => i.id));
    lightFor.clear();
    const update = (its) => {
      items = its; preloadSounds();
      syncLights().catch((e) => console.warn("[jumpscare] lights:", e));
      check();
    };
    update(await OBR.scene.items.getItems());
    OBR.scene.items.onChange(update);
  };
  if (await OBR.scene.isReady()) start();
  OBR.scene.onReadyChange((ready) => ready && start());
});
