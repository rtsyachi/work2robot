// デモ用模擬作業動画のシーン（docs/DEMO_INPUT.md の台本 場面1〜6）。
// ここに書いた荷物・配置・時刻は「評価用の正解データ」であり、アプリの入力経路では読まない。
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';

const WIDTH = 1280;
const HEIGHT = 720;
const FPS = 24;

// ---- シーン定義（単位 m。size = [幅x, 高さy, 奥行z]） ----
const ITEMS = {
  A: { size: [0.50, 0.30, 0.40], kind: 'box', color: '#c9a46b' }, // 底面が広く軽い
  B: { size: [0.30, 0.25, 0.25], kind: 'box', color: '#9c7646' }, // 小さく重い
  C: { size: [0.45, 0.20, 0.35], kind: 'bag', color: '#3f6ea5' }, // ソフトバッグ
  D: { size: [0.40, 0.20, 0.30], kind: 'bag', color: '#6d4f96', fragile: true }, // ワレモノ
};
const ORDER = ['A', 'B', 'C', 'D'];
const TABLE = { x: -1.6, z: 0, w: 1.9, d: 0.6, h: 0.7 };
const TABLE_X = { A: -2.25, B: -1.8, C: -1.33, D: -0.85 };
const CART = { x: 0.6, z: 0, w: 0.8, d: 0.6, h: 1.7, floor: 0.15 };
const CART_SLOT = {
  A: { x: 0.45, z: -0.10, onTopOf: null },
  B: { x: 0.85, z: -0.175, onTopOf: null },
  C: { x: 0.45, z: -0.10, onTopOf: 'A' },
  D: { x: 0.45, z: -0.10, onTopOf: 'C' },
};

const tablePos = (id) => ({ x: TABLE_X[id], y: TABLE.h + ITEMS[id].size[1] / 2, z: TABLE.z });
function cartPos(id) {
  const slot = CART_SLOT[id];
  const base = slot.onTopOf ? cartPos(slot.onTopOf).y + ITEMS[slot.onTopOf].size[1] / 2 : CART.floor;
  return { x: slot.x, y: base + ITEMS[id].size[1] / 2, z: slot.z };
}
const rest = (w) => ({ x: w.x, y: 0.85, z: w.z - 0.25 });

// ---- タイムライン（決定的なキーフレーム） ----
function buildTimeline() {
  const tr = { worker: [], grip: [], gw: [], box: {} };
  ORDER.forEach((id) => { tr.box[id] = []; });
  const cur = { worker: { x: -1.6, z: 0.8 }, gw: 0.2, box: {} };
  cur.grip = rest(cur.worker);
  ORDER.forEach((id) => { cur.box[id] = tablePos(id); });
  let t = 0;
  const snap = () => {
    tr.worker.push([t, { ...cur.worker }]);
    tr.grip.push([t, { ...cur.grip }]);
    tr.gw.push([t, cur.gw]);
    ORDER.forEach((id) => tr.box[id].push([t, { ...cur.box[id] }]));
  };
  const step = (dur, fn, carry) => {
    snap();
    fn();
    if (carry) cur.box[carry] = { ...cur.grip };
    t += dur;
    snap();
  };
  const events = [{ scene: 1, label: '全体（積付前）', start: 0, end: 2 }];
  step(2.0, () => {});
  ORDER.forEach((id, i) => {
    const s = ITEMS[id].size;
    const tp = tablePos(id);
    const cp = cartPos(id);
    const fragile = !!ITEMS[id].fragile;
    const start = t;
    const pickSpot = { x: tp.x, z: 0.75 };
    const placeSpot = { x: cp.x - 0.5, z: 0.7 };
    step(0.9, () => { cur.worker = pickSpot; cur.grip = rest(pickSpot); });
    step(0.5, () => { cur.grip = { ...tp }; cur.gw = s[0] / 2 + 0.02; });
    step(0.4, () => { cur.grip = { ...tp, y: tp.y + 0.25 }; }, id);
    if (fragile) {
      // ラベルを確認する（目の高さに持ち上げて静止）
      step(0.6, () => { cur.grip = { x: tp.x + 0.45, y: 1.3, z: 0.95 }; }, id); // 体の横・カメラ側でラベルを見せる
      step(1.2, () => {}, id);
    }
    step(1.2, () => { cur.worker = placeSpot; cur.grip = { x: cp.x, y: cp.y + 0.12, z: 0.55 }; }, id);
    step(fragile ? 1.0 : 0.6, () => { cur.grip = { x: cp.x, y: cp.y + 0.04, z: cp.z }; }, id);
    step(fragile ? 1.0 : 0.3, () => { cur.grip = { ...cp }; }, id); // ワレモノは押し込まずゆっくり下ろす
    step(0.5, () => { cur.grip = rest(placeSpot); cur.gw = 0.2; });
    events.push({ scene: i + 2, item: id, start, end: t });
  });
  // 積付先を隠さないよう、作業者は手前左へ下がる
  const away = { x: -0.6, z: 1.1 };
  step(1.0, () => { cur.worker = away; cur.grip = rest(away); });
  const endStart = t;
  step(2.0, () => {});
  events.push({ scene: 6, label: '完成状態', start: endStart, end: t });
  return { tr, duration: t, events };
}

const ease = (u) => u * u * (3 - 2 * u);
function lerp(a, b, u) {
  if (typeof a === 'number') return a + (b - a) * u;
  const o = {};
  for (const k in a) o[k] = a[k] + (b[k] - a[k]) * u;
  return o;
}
function sample(track, t) {
  if (t <= track[0][0]) return track[0][1];
  for (let i = 1; i < track.length; i++) {
    const [t1, v1] = track[i];
    if (t <= t1) {
      const [t0, v0] = track[i - 1];
      const u = t1 === t0 ? 1 : ease((t - t0) / (t1 - t0));
      return lerp(v0, v1, u);
    }
  }
  return track[track.length - 1][1];
}

// ---- 描画 ----
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(WIDTH, HEIGHT);
renderer.setPixelRatio(1);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color('#d9dde2');
const camera = new THREE.PerspectiveCamera(40, WIDTH / HEIGHT, 0.1, 50);
camera.position.set(1.0, 3.3, 4.0);
camera.lookAt(-0.6, 0.45, -0.1);

scene.add(new THREE.HemisphereLight('#ffffff', '#8a8f96', 0.9));
const sun = new THREE.DirectionalLight('#ffffff', 1.6);
sun.position.set(3, 6, 4);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -4, right: 4, top: 4, bottom: -4 });
scene.add(sun);

const std = (color, opts = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.8, ...opts });
function addMesh(geo, mat, pos, parent = scene) {
  const m = new THREE.Mesh(geo, mat);
  m.position.set(pos.x, pos.y, pos.z);
  m.castShadow = true;
  m.receiveShadow = true;
  parent.add(m);
  return m;
}

// 床・壁・通路線
const floor = addMesh(new THREE.PlaneGeometry(12, 12), std('#a3a8ae'), { x: 0, y: 0, z: 0 });
floor.rotation.x = -Math.PI / 2;
const lane = addMesh(new THREE.PlaneGeometry(6, 0.08), std('#e2b93b'), { x: -0.5, y: 0.002, z: 1.25 });
lane.rotation.x = -Math.PI / 2;
addMesh(new THREE.BoxGeometry(12, 4, 0.1), std('#c4c8cc'), { x: 0, y: 2, z: -1.6 });

// 仮置き台
addMesh(new THREE.BoxGeometry(TABLE.w, 0.05, TABLE.d), std('#7b6a55'), { x: TABLE.x, y: TABLE.h - 0.025, z: TABLE.z });
for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
  addMesh(new THREE.BoxGeometry(0.05, TABLE.h - 0.05, 0.05), std('#555'),
    { x: TABLE.x + sx * (TABLE.w / 2 - 0.05), y: (TABLE.h - 0.05) / 2, z: TABLE.z + sz * (TABLE.d / 2 - 0.05) });
}

// カゴ車（前面＝カメラ側が開口）
const metal = std('#8f969d', { metalness: 0.6, roughness: 0.4 });
addMesh(new THREE.BoxGeometry(CART.w, 0.04, CART.d), metal, { x: CART.x, y: CART.floor - 0.02, z: CART.z });
for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
  addMesh(new THREE.CylinderGeometry(0.035, 0.035, 0.05, 12), std('#222'),
    { x: CART.x + sx * (CART.w / 2 - 0.06), y: 0.04, z: CART.z + sz * (CART.d / 2 - 0.06) }).rotation.z = Math.PI / 2;
}
const x0 = CART.x - CART.w / 2, x1 = CART.x + CART.w / 2, z0 = CART.z - CART.d / 2, z1 = CART.z + CART.d / 2;
const top = CART.floor + CART.h;
function bar(a, b, r = 0.012) {
  const m = addMesh(new THREE.CylinderGeometry(r, r, 1, 6), metal, { x: 0, y: 0, z: 0 });
  setLimb(m, a, b);
}
for (let x = x0; x <= x1 + 1e-6; x += 0.1) bar({ x, y: CART.floor, z: z0 }, { x, y: top, z: z0 }); // 背面
for (let z = z0; z <= z1 + 1e-6; z += 0.1) {
  bar({ x: x0, y: CART.floor, z }, { x: x0, y: top, z }); // 左側面
  bar({ x: x1, y: CART.floor, z }, { x: x1, y: top, z }); // 右側面
}
for (let y = CART.floor + 0.3; y <= top + 1e-6; y += 0.4) {
  bar({ x: x0, y, z: z0 }, { x: x1, y, z: z0 });
  bar({ x: x0, y, z: z0 }, { x: x0, y, z: z1 });
  bar({ x: x1, y, z: z0 }, { x: x1, y, z: z1 });
}

// ラベル（テクスチャ）
function labelTexture(draw, w = 256, h = 256) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}
const tagTex = (id) => labelTexture((g, w, h) => {
  g.fillStyle = '#fff'; g.fillRect(0, 0, w, h);
  g.strokeStyle = '#111'; g.lineWidth = 12; g.strokeRect(6, 6, w - 12, h - 12);
  g.fillStyle = '#111'; g.font = 'bold 190px Arial'; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText(id, w / 2, h / 2 + 8);
});
const fragileTex = labelTexture((g, w, h) => {
  g.fillStyle = '#d32020'; g.fillRect(0, 0, w, h);
  g.fillStyle = '#fff'; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.font = 'bold 96px "Yu Gothic UI", "Meiryo", sans-serif';
  g.fillText('ワレモノ', w / 2, h * 0.38);
  g.font = 'bold 52px "Yu Gothic UI", "Meiryo", sans-serif';
  g.fillText('取扱注意', w / 2, h * 0.78);
}, 512, 256);

function decal(parent, tex, w, h, pos, rotX = 0) {
  const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshStandardMaterial({ map: tex, roughness: 0.9 }));
  m.position.set(pos.x, pos.y, pos.z);
  m.rotation.x = rotX;
  parent.add(m);
}

const itemObj = {};
for (const id of ORDER) {
  const it = ITEMS[id];
  const [w, h, d] = it.size;
  const geo = it.kind === 'bag' ? new RoundedBoxGeometry(w, h, d, 4, 0.06) : new THREE.BoxGeometry(w, h, d);
  const grp = new THREE.Group();
  const body = new THREE.Mesh(geo, std(it.color, { roughness: it.kind === 'bag' ? 0.95 : 0.75 }));
  body.castShadow = true; body.receiveShadow = true;
  grp.add(body);
  const tag = Math.min(w, d) * 0.45;
  decal(grp, tagTex(id), tag, tag, { x: 0, y: h / 2 + 0.003, z: 0 }, -Math.PI / 2); // 天面タグ
  decal(grp, tagTex(id), 0.11, 0.11, { x: -w / 2 + 0.09, y: 0, z: d / 2 + 0.003 }); // 前面タグ
  if (it.kind === 'box') { // ガムテープ
    const tape = new THREE.Mesh(new THREE.PlaneGeometry(w, 0.05), std('#d8c49a'));
    tape.rotation.x = -Math.PI / 2; tape.position.y = h / 2 + 0.002; grp.add(tape);
  }
  if (it.fragile) decal(grp, fragileTex, 0.26, 0.13, { x: 0.06, y: 0, z: d / 2 + 0.004 });
  scene.add(grp);
  itemObj[id] = grp;
}

// 作業者（簡易マネキン。シミュレータのロボットとは別の見た目）
function setLimb(mesh, a, b) {
  const up = new THREE.Vector3(0, 1, 0);
  const va = new THREE.Vector3(a.x, a.y, a.z);
  const vb = new THREE.Vector3(b.x, b.y, b.z);
  const dir = vb.clone().sub(va);
  const len = Math.max(dir.length(), 1e-4);
  mesh.position.copy(va).add(vb).multiplyScalar(0.5);
  mesh.scale.set(1, len, 1);
  mesh.quaternion.setFromUnitVectors(up, dir.normalize());
}
const limb = (r, color) => addMesh(new THREE.CylinderGeometry(r, r, 1, 14), std(color), { x: 0, y: 0, z: 0 });
const worker = {
  torso: limb(0.15, '#2c3e66'),
  head: addMesh(new THREE.SphereGeometry(0.11, 20, 16), std('#e0b48f'), { x: 0, y: 0, z: 0 }),
  cap: addMesh(new THREE.SphereGeometry(0.115, 20, 10, 0, Math.PI * 2, 0, Math.PI / 2), std('#e2b93b'), { x: 0, y: 0, z: 0 }),
  armL: limb(0.045, '#2c3e66'), armR: limb(0.045, '#2c3e66'),
  handL: addMesh(new THREE.SphereGeometry(0.05, 12, 10), std('#e8d23a'), { x: 0, y: 0, z: 0 }),
  handR: addMesh(new THREE.SphereGeometry(0.05, 12, 10), std('#e8d23a'), { x: 0, y: 0, z: 0 }),
  legL: limb(0.07, '#55595f'), legR: limb(0.07, '#55595f'),
};
function poseWorker(w, grip, gw) {
  const dx = grip.x - w.x, dz = grip.z - w.z;
  const dist = Math.hypot(dx, dz);
  const lean = Math.min(Math.max(dist - 0.35, 0), 0.35);
  const lx = dist > 1e-6 ? (dx / dist) * lean : 0;
  const lz = dist > 1e-6 ? (dz / dist) * lean : 0;
  const drop = Math.min(Math.max((0.95 - grip.y) * 0.6, 0), 0.3);
  const hip = { x: w.x + lx * 0.3, y: 0.9 - drop, z: w.z + lz * 0.3 };
  const sh = { x: w.x + lx, y: 1.42 - drop, z: w.z + lz };
  setLimb(worker.torso, hip, sh);
  worker.head.position.set(sh.x + lx * 0.2, sh.y + 0.18, sh.z + lz * 0.2);
  worker.cap.position.copy(worker.head.position).add(new THREE.Vector3(0, 0.02, 0));
  const shL = { x: sh.x - 0.2, y: sh.y - 0.03, z: sh.z };
  const shR = { x: sh.x + 0.2, y: sh.y - 0.03, z: sh.z };
  const hL = { x: grip.x - gw, y: grip.y, z: grip.z };
  const hR = { x: grip.x + gw, y: grip.y, z: grip.z };
  setLimb(worker.armL, shL, hL);
  setLimb(worker.armR, shR, hR);
  worker.handL.position.set(hL.x, hL.y, hL.z);
  worker.handR.position.set(hR.x, hR.y, hR.z);
  setLimb(worker.legL, { x: hip.x - 0.1, y: hip.y, z: hip.z }, { x: w.x - 0.12, y: 0, z: w.z });
  setLimb(worker.legR, { x: hip.x + 0.1, y: hip.y, z: hip.z }, { x: w.x + 0.12, y: 0, z: w.z });
}

const timeline = buildTimeline();
function renderFrame(t) {
  const { tr } = timeline;
  poseWorker(sample(tr.worker, t), sample(tr.grip, t), sample(tr.gw, t));
  for (const id of ORDER) {
    const p = sample(tr.box[id], t);
    itemObj[id].position.set(p.x, p.y, p.z);
  }
  const s = Math.floor(t);
  document.getElementById('ts').textContent = `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  renderer.render(scene, camera);
}

window.W2R = { fps: FPS, duration: timeline.duration, events: timeline.events, renderFrame };
renderFrame(0);
window.W2R_READY = true;
