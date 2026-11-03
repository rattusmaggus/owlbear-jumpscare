import OBR from "https://esm.sh/@owlbear-rodeo/sdk@3";
export { OBR };

export const NS = "com.example.jumpscare";          // only place to change the namespace
export const CFG_KEY = `${NS}/config`;              // per-token settings
export const ROOM_KEY = `${NS}/settings`;           // room settings { mode, disabled }
export const SCARE_MODAL = `${NS}/scare`;
export const SETTINGS_MODAL = `${NS}/settings-modal`;
export const RANGE_MODAL = `${NS}/range-modal`;
export const ENABLE_MODAL = `${NS}/enable-sound`;
export const AUDIO_CHANNEL = `${NS}-audio`;
export const SCARE_MSG = `${NS}/scare-msg`;         // broadcast used by Party mode

export const CONE_ANGLE = 90;                       // cones are always 90 degrees

export const DEFAULT_CFG = {
  jumpscare: false,   // is this a jumpscare creature?
  range: 0,           // grid cells, 0 = none
  shape: "circle",    // "circle" | "cone"
  owner: "",          // player id controlling it ("" = whoever created the token)
  image: "",          // png/jpg/gif/webp URL or path in the repo
  sound: "",          // mp3/ogg/wav URL or path in the repo
  duration: 2.5,      // seconds of scare
  volume: 200,        // % (above 100 = boost)
  boom: true,         // built-in impact boom + screech
  buildup: 0.6,       // seconds of dark heartbeat build-up before the scare
};

export const getCfg = (item) => ({ ...DEFAULT_CFG, ...(item.metadata?.[CFG_KEY] || {}) });
export const base = (file) => new URL(file, import.meta.url).href;
export const isMine = (item, cfg, me) => (cfg.owner ? cfg.owner === me : item.createdUserId === me);
export const soundUrlOf = (cfg) => new URL(cfg.sound || "scare.mp3", base("x")).href;

export const roomSettings = (md) => ({
  mode: md?.[ROOM_KEY]?.mode === "party" ? "party" : "individual",
  disabled: md?.[ROOM_KEY]?.disabled ?? {},
});
export async function saveRoomSettings(patch) {
  const md = await OBR.room.getMetadata();
  await OBR.room.setMetadata({ [ROOM_KEY]: { ...(md[ROOM_KEY] ?? {}), ...patch } });
}

// Opens the scare on THIS client. { back: true } reopens the settings window afterwards (for test buttons).
export async function showScare(cfg, opts = {}) {
  const c = { ...DEFAULT_CFG, ...cfg };
  const p = new URLSearchParams({
    img: c.image || "",
    snd: soundUrlOf(c),
    dur: String(c.duration),
    vol: String(c.volume),
    boom: c.boom ? "1" : "0",
    build: String(c.buildup),
    back: opts.back ? "1" : "0",
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
// `bubble`: a cone also "sees" a 1-cell circle around its token (matches the fog reveal)
export function inArea(origin, facingDeg, cfg, target, dpi, bubble = false) {
  const dx = target.x - origin.x, dy = target.y - origin.y;
  const dist = Math.hypot(dx, dy);
  if (bubble && cfg.shape === "cone" && dist <= dpi) return true;
  if (dist > cfg.range * dpi) return false;
  if (cfg.shape !== "cone" || dist < 1) return true;
  const r = (facingDeg * Math.PI) / 180;
  const dot = (dx * Math.sin(r) + dy * -Math.cos(r)) / dist;
  return Math.acos(Math.max(-1, Math.min(1, dot))) <= ((CONE_ANGLE / 2) * Math.PI) / 180;
}

export async function centerOf(item) {
  try { return (await OBR.scene.items.getItemBounds([item.id])).center; }
  catch { return item.position; }
}

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
    const entered = s.cfg.range > 0 &&
      mine.some((m) => inArea(s.center, s.item.rotation, s.cfg, m.center, dpi));
    const seen = mine.some((m) => m.cfg.range > 0 && inArea(m.center, m.item.rotation, m.cfg, s.center, dpi, true));
    const nearest = mine.length
      ? Math.min(...mine.map((m) => Math.hypot(m.center.x - s.center.x, m.center.y - s.center.y) / dpi))
      : null;
    return { s, entered, seen, nearest };
  });
  return { dpi, mine, scary, results, otherLayer };
}
