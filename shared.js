import OBR from "https://esm.sh/@owlbear-rodeo/sdk@3";
export { OBR };

export const NS = "com.example.jumpscare";          // only place to change the namespace
export const CFG_KEY = `${NS}/config`;              // per-token settings
export const ROOM_KEY = `${NS}/settings`;           // room settings (which players are disabled)
export const SCARE_MODAL = `${NS}/scare`;
export const SETTINGS_MODAL = `${NS}/settings-modal`;
export const ENABLE_MODAL = `${NS}/enable-sound`;
export const AUDIO_CHANNEL = `${NS}-audio`;

export const DEFAULT_CFG = {
  jumpscare: false,   // is this a jumpscare creature?
  range: 0,           // in grid cells, 0 = no range
  shape: "circle",    // "circle" | "cone"
  angle: 90,          // cone width in degrees
  owner: "",          // player id that controls this creature ("" = whoever created the token)
  image: "",          // png/jpg/gif/webp URL (or path relative to this extension)
  sound: "",          // mp3/ogg/wav URL (or path relative to this extension)
  duration: 2.5,      // seconds
};

export const getCfg = (item) => ({ ...DEFAULT_CFG, ...(item.metadata?.[CFG_KEY] || {}) });
export const base = (file) => new URL(file, import.meta.url).href;
export const isMine = (item, cfg, me) => (cfg.owner ? cfg.owner === me : item.createdUserId === me);

export const soundUrlOf = (cfg) => new URL(cfg.sound || "scare.mp3", base("x")).href;

// Starts the sound immediately (played by the always-open background page, which keeps files preloaded),
// then opens the visual. The scare window only plays sound itself if the background reports it was blocked.
export async function showScare(cfg) {
  try {
    const ch = new BroadcastChannel(AUDIO_CHANNEL);
    ch.postMessage({ type: "play", url: soundUrlOf(cfg) });
    ch.close();
  } catch {}
  const p = new URLSearchParams({
    img: cfg.image || "",
    snd: cfg.sound || "",
    dur: String(cfg.duration || 2.5),
    t: String(Date.now()),
  });
  await OBR.modal.open({
    id: SCARE_MODAL,
    url: `${base("jumpscare.html")}?${p}`,
    fullScreen: true,
    hidePaper: true,
    hideBackdrop: true,
  });
}

/* ---------- geometry ---------- */
export function inArea(origin, facingDeg, cfg, target, dpi) {
  const dx = target.x - origin.x, dy = target.y - origin.y;
  const dist = Math.hypot(dx, dy);
  if (dist > cfg.range * dpi) return false;
  if (cfg.shape !== "cone" || dist < 1) return true;
  const r = (facingDeg * Math.PI) / 180;
  const dot = (dx * Math.sin(r) + dy * -Math.cos(r)) / dist;
  return Math.acos(Math.max(-1, Math.min(1, dot))) <= ((cfg.angle / 2) * Math.PI) / 180;
}

export async function centerOf(item) {
  try { return (await OBR.scene.items.getItemBounds([item.id])).center; }
  catch { return item.position; }
}

// Shared by the background trigger logic AND the Diagnose button.
export async function analyze(items, me) {
  const dpi = await OBR.scene.grid.getDpi();
  const chars = items.filter((i) => i.layer === "CHARACTER").map((i) => ({ item: i, cfg: getCfg(i) }));
  const addCenter = (list) => Promise.all(list.map(async (c) => ({ ...c, center: await centerOf(c.item) })));
  const [mine, scary] = await Promise.all([
    addCenter(chars.filter((c) => !c.cfg.jumpscare && isMine(c.item, c.cfg, me))),
    addCenter(chars.filter((c) => c.cfg.jumpscare)),
  ]);
  const otherLayer = items.filter((i) => i.layer !== "CHARACTER" && i.metadata?.[CFG_KEY]).length;

  const results = scary.map((s) => {
    // Rule 3: my creature entered the scary creature's range
    const entered = s.cfg.range > 0 &&
      mine.some((m) => inArea(s.center, s.item.rotation, s.cfg, m.center, dpi));
    // Rule 2: the scary creature is inside my creature's sight area
    const seen = mine.some((m) => m.cfg.range > 0 && inArea(m.center, m.item.rotation, m.cfg, s.center, dpi));
    const nearest = mine.length
      ? Math.min(...mine.map((m) => Math.hypot(m.center.x - s.center.x, m.center.y - s.center.y) / dpi))
      : null;
    return { s, entered, seen, nearest };
  });
  return { dpi, mine, scary, results, otherLayer };
}
