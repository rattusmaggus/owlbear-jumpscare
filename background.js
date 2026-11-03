import OBR, { buildLight } from "https://esm.sh/@owlbear-rodeo/sdk@3";
import { NS, ROOM_KEY, SETTINGS_MODAL, getCfg, base, showScare } from "./shared.js";

const LIGHT_TAG = `${NS}/light`;
const iconUrl = base("icon.svg");

let items = [];
let disabled = {};            // playerId -> true  (set by GM in the toolbar popover)
let scaring = false;
const fired = new Set();      // jumpscare tokens already triggered while still "active"
const lightFor = new Map();   // tokenId -> { sig, lightId }

/* ---------- geometry ---------- */
// Is `target` inside the circle/cone owned by `origin`? Cone faces the token's "up", rotated by token rotation.
function inArea(origin, facingDeg, cfg, target, dpi) {
  const dx = target.x - origin.x, dy = target.y - origin.y;
  const dist = Math.hypot(dx, dy);
  if (dist > cfg.range * dpi) return false;
  if (cfg.shape !== "cone" || dist < 1) return true;
  const r = (facingDeg * Math.PI) / 180;
  const dot = (dx * Math.sin(r) + dy * -Math.cos(r)) / dist;
  return Math.acos(Math.max(-1, Math.min(1, dot))) <= ((cfg.angle / 2) * Math.PI) / 180;
}

async function centerOf(item) {
  try {
    const b = await OBR.scene.items.getItemBounds([item.id]);
    return b.center;
  } catch {
    return item.position;
  }
}

/* ---------- jumpscare detection (runs on each player's own client) ---------- */
let running = false, again = false;
async function check() {
  if (running) { again = true; return; }
  running = true;
  try {
    if (scaring) return;
    if ((await OBR.player.getRole()) === "GM") return;
    if (disabled[OBR.player.id]) return;

    const dpi = await OBR.scene.grid.getDpi();
    const me = OBR.player.id;

    const chars = items
      .filter((i) => i.layer === "CHARACTER")
      .map((i) => ({ item: i, cfg: getCfg(i) }));

    const mineRaw = chars.filter((c) => !c.cfg.jumpscare && c.item.createdUserId === me);
    const scaryRaw = chars.filter((c) => c.cfg.jumpscare);
    if (!mineRaw.length || !scaryRaw.length) { fired.clear(); return; }

    const withCenter = (list) =>
      Promise.all(list.map(async (c) => ({ ...c, center: await centerOf(c.item) })));
    const [mine, scary] = await Promise.all([withCenter(mineRaw), withCenter(scaryRaw)]);

    for (const s of scary) {
      // Rule 3: my creature walked INTO the scary creature's range (sight doesn't matter)
      const entered = s.cfg.range > 0 &&
        mine.some((m) => inArea(s.center, s.item.rotation, s.cfg, m.center, dpi));
      // Rule 2: the scary creature is inside MY creature's sight area
      const seen = mine.some((m) =>
        m.cfg.range > 0 && inArea(m.center, m.item.rotation, m.cfg, s.center, dpi));

      if (entered || seen) {
        if (!fired.has(s.item.id)) {
          fired.add(s.item.id);
          scaring = true;
          await showScare(s.cfg);
          setTimeout(() => (scaring = false), (s.cfg.duration || 2.5) * 1000 + 800);
          break;
        }
      } else {
        fired.delete(s.item.id); // re-arm after they leave
      }
    }
  } finally {
    running = false;
    if (again) { again = false; check(); }
  }
}

/* ---------- fog reveal: local Light items for creatures with range > 0 (not jumpscare) ---------- */
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
        height: 640,
      }),
  });

  const applyRoom = (md) => { disabled = md?.[ROOM_KEY]?.disabled ?? {}; };
  applyRoom(await OBR.room.getMetadata());
  OBR.room.onMetadataChange((md) => { applyRoom(md); check(); });

  const start = async () => {
    // clear leftovers from a previous session
    const old = await OBR.scene.local.getItems((i) => i.metadata?.[LIGHT_TAG]);
    if (old.length) await OBR.scene.local.deleteItems(old.map((i) => i.id));
    lightFor.clear();

    const update = (its) => { items = its; syncLights(); check(); };
    update(await OBR.scene.items.getItems());
    OBR.scene.items.onChange(update);
  };
  if (await OBR.scene.isReady()) start();
  OBR.scene.onReadyChange((ready) => ready && start());
});
