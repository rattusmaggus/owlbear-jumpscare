import OBR, { buildLight } from "https://esm.sh/@owlbear-rodeo/sdk@3";
import {
  NS, ROOM_KEY, SETTINGS_MODAL, ENABLE_MODAL, AUDIO_CHANNEL,
  getCfg, base, showScare, soundUrlOf, analyze,
} from "./shared.js";

const LIGHT_TAG = `${NS}/light`;
const iconUrl = base("icon.svg");

let items = [];
let disabled = {};
let scaring = false;
const fired = new Set();
const lightFor = new Map();

/* ---------- sound: preloaded + reused so it starts instantly every time ---------- */
const channel = new BroadcastChannel(AUDIO_CHANNEL);
const sounds = new Map();   // url -> HTMLAudioElement
let current = null;

function getSound(url) {
  let a = sounds.get(url);
  if (!a) {
    a = new Audio();
    a.preload = "auto";
    a.src = url;
    a.load();
    sounds.set(url, a);
  }
  return a;
}
function playSound(url) {
  try {
    if (current && current !== getSound(url)) current.pause();
    const a = getSound(url);
    current = a;
    a.currentTime = 0;
    a.play().catch((err) => {
      console.warn("[jumpscare] sound blocked:", err?.message);
      channel.postMessage({ type: "blocked", url });   // let the scare window try
    });
  } catch (err) { console.warn("[jumpscare]", err); }
}
channel.onmessage = (e) => { if (e.data?.type === "play") playSound(e.data.url); };

function preloadSounds() {
  for (const it of items) {
    const c = getCfg(it);
    if (c.jumpscare) getSound(soundUrlOf(c));
  }
}

/* ---------- trigger detection (each player's own client) ---------- */
let running = false, again = false;
async function check() {
  if (running) { again = true; return; }
  running = true;
  try {
    if (scaring) return;
    if ((await OBR.player.getRole()) === "GM") return;
    if (disabled[OBR.player.id]) return;

    const a = await analyze(items, OBR.player.id);
    if (!a.mine.length || !a.scary.length) { fired.clear(); return; }

    for (const r of a.results) {
      const id = r.s.item.id;
      if (r.entered || r.seen) {
        if (!fired.has(id)) {
          fired.add(id);
          scaring = true;
          const dur = (r.s.cfg.duration || 2.5) * 1000 + 800;
          setTimeout(() => (scaring = false), dur);
          try { await showScare(r.s.cfg); }
          catch (e) { console.error("[jumpscare] could not open scare:", e); scaring = false; }
          break;
        }
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

/* ---------- fog reveal: local lights for creatures with range > 0 (not jumpscare) ---------- */
async function syncLights() {
  const dpi = await OBR.scene.grid.getDpi();
  const want = new Map();
  for (const it of items) {
    if (it.layer !== "CHARACTER") continue;
    const c = getCfg(it);
    if (c.range > 0 && !c.jumpscare) want.set(it.id, { it, c });
  }
  const sigOf = (c) => `${c.range}|${c.shape}|${c.angle}|${dpi}`;

  const stale = [];
  for (const [tid, rec] of lightFor) {
    const w = want.get(tid);
    if (!w || rec.sig !== sigOf(w.c)) { stale.push(rec.lightId); lightFor.delete(tid); }
  }
  if (stale.length) await OBR.scene.local.deleteItems(stale);

  const add = [];
  for (const [tid, { it, c }] of want) {
    if (lightFor.has(tid)) continue;
    const b = buildLight()
      .position(it.position)
      .rotation(it.rotation)
      .attachedTo(tid)
      .attenuationRadius(c.range * dpi)
      .sourceRadius(dpi * 0.25)
      .metadata({ [LIGHT_TAG]: true });
    if (c.shape === "cone") b.innerAngle(c.angle).outerAngle(c.angle);
    const light = b.build();
    add.push(light);
    lightFor.set(tid, { sig: sigOf(c), lightId: light.id });
  }
  if (add.length) await OBR.scene.local.addItems(add);
}

/* ---------- setup ---------- */
OBR.onReady(async () => {
  OBR.contextMenu.create({
    id: `${NS}/settings`,
    icons: [{
      icon: iconUrl,
      label: "Jumpscare Settings",
      filter: { min: 1, max: 1, every: [{ key: "layer", value: "CHARACTER" }], roles: ["GM"] },
    }],
    onClick: (ctx) =>
      OBR.modal.open({
        id: SETTINGS_MODAL,
        url: `${base("token.html")}?id=${encodeURIComponent(ctx.items[0].id)}`,
        width: 420,
        height: 700,
      }),
  });

  const applyRoom = (md) => { disabled = md?.[ROOM_KEY]?.disabled ?? {}; };
  applyRoom(await OBR.room.getMetadata());
  OBR.room.onMetadataChange((md) => { applyRoom(md); check(); });

  // Players: one click per session so the browser lets us play sound later
  OBR.modal.open({ id: ENABLE_MODAL, url: base("enable.html"), width: 320, height: 150 }).catch(() => {});

  const start = async () => {
    const old = await OBR.scene.local.getItems((i) => i.metadata?.[LIGHT_TAG]);
    if (old.length) await OBR.scene.local.deleteItems(old.map((i) => i.id));
    lightFor.clear();
    const update = (its) => { items = its; preloadSounds(); syncLights().catch((e) => console.warn("[jumpscare] lights:", e)); check(); };
    update(await OBR.scene.items.getItems());
    OBR.scene.items.onChange(update);
  };
  if (await OBR.scene.isReady()) start();
  OBR.scene.onReadyChange((ready) => ready && start());
});
