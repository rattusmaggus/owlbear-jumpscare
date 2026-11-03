import OBR from "https://esm.sh/@owlbear-rodeo/sdk@3";
export { OBR };

export const NS = "com.rattusmaggus.jumpscare";          // change "example" to your name
export const CFG_KEY = `${NS}/config`;              // per-token settings
export const ROOM_KEY = `${NS}/settings`;           // room settings (which players are disabled)
export const SCARE_MODAL = `${NS}/scare`;
export const SETTINGS_MODAL = `${NS}/settings-modal`;

export const DEFAULT_CFG = {
  jumpscare: false,   // is this a jumpscare creature?
  range: 0,           // in grid cells, 0 = no range
  shape: "circle",    // "circle" | "cone"
  angle: 90,          // cone width in degrees
  image: "",          // png/jpg/gif/webp URL (or path relative to this extension)
  sound: "",          // mp3/ogg/wav URL (or path relative to this extension)
  duration: 2.5,      // seconds
};

export const getCfg = (item) => ({ ...DEFAULT_CFG, ...(item.metadata?.[CFG_KEY] || {}) });
export const base = (file) => new URL(file, import.meta.url).href;

// Opens the scare on THIS client only. The scare page closes itself.
export async function showScare(cfg) {
  const p = new URLSearchParams({
    img: cfg.image || "",
    snd: cfg.sound || "",
    dur: String(cfg.duration || 2.5),
    t: String(Date.now()),            // cache-bust so GIFs restart
  });
  await OBR.modal.open({
    id: SCARE_MODAL,
    url: `${base("jumpscare.html")}?${p}`,
    fullScreen: true,
    hidePaper: true,
    hideBackdrop: true,
  });
}
