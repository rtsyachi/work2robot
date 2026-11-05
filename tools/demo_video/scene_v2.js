// デモ用模擬作業動画 v2（docs/DEMO_INPUT.md「シナリオv2」：荷物17個・7場面）。
// ここに書いた荷物・配置・時刻・台詞の区間は「評価用の正解データ」であり、アプリの入力経路では読まない。
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';

const WIDTH = 1280;
const HEIGHT = 720;
const FPS = 24;

// 説明音声の長さ（秒）。録音がそろったら実測値で上書きする（?voice=E1:4.2,E2:...）
const VOICE = { E1: 4.5, E2: 5.6, E3: 9.9, E4: 4.7, E5: 5.7, E6: 5.1 }; // ユーザーの録音（2026-11-03）の長さ
const voiceArg = new URLSearchParams(location.search).get('voice');
if (voiceArg) for (const kv of voiceArg.split(',')) { const [k, v] = kv.split(':'); VOICE[k] = Number(v); }

// ---- 荷物（荷物マスタの初期値 app/data/masters/item_master.json と同じ寸法。w=幅x, d=奥行z, h=高さ, m） ----
const TYPES = {
  H: { w: 0.50, d: 0.375, h: 0.30, kind: 'box', color: '#8e6a3f' },
  M: { w: 0.50, d: 0.25, h: 0.20, kind: 'box', color: '#c9a46b' },
  W: { w: 0.40, d: 0.375, h: 0.25, kind: 'box', color: '#a8824f' },
  L: { w: 0.30, d: 0.25, h: 0.20, kind: 'box', color: '#e3cfa4' },
  S: { w: 0.40, d: 0.30, h: 0.20, kind: 'bag', color: '#3f6ea5' },
};
const IDS = ['H1', 'H2', 'H3', 'H4', 'M1', 'M2', 'M3', 'M4', 'M5', 'M6', 'W1', 'W2', 'L1', 'L2', 'L3', 'S1', 'S2'];
const ITEMS = Object.fromEntries(IDS.map((id) => [id, { ...TYPES[id[0]] }]));
ITEMS.S2.color = '#2f7a5a';

// ---- 配置 ----
const PALLET_H = 0.14;
// 仮置きパレット（荷物は混在して並ぶ）。行は奥→手前
const PALLETS = [
  { x: -0.50, z: -0.10, w: 1.10, d: 1.05, rows: [['H1', 'M1'], ['S1', 'H2'], ['M2', 'L2']] },
  { x: -2.15, z: -0.10, w: 1.10, d: 1.15, rows: [['H3', 'M3'], ['W1', 'M4'], ['H4', 'M5']] },
  { x: -1.30, z: 1.85, w: 1.18, d: 0.75, rows: [['L1', 'L3', 'W2'], ['M6', 'S2']] },
];
const CART = { x: 1.00, z: -0.10, w: 1.0, d: 0.75, wall: 1.35, floor: 0.15, limit: 1.2 };
const CART_FRONT = CART.z + CART.d / 2;
const STAND_Z = CART_FRONT + 0.36;

const initPos = {};
for (const p of PALLETS) {
  let z = p.z - p.d / 2 + 0.025;
  for (const row of p.rows) {
    const rd = Math.max(...row.map((id) => ITEMS[id].d));
    let x = p.x - p.w / 2 + 0.04;
    for (const id of row) {
      const it = ITEMS[id];
      initPos[id] = { x: x + it.w / 2, y: PALLET_H + it.h / 2, z: z + it.d / 2, yaw: 0 };
      x += it.w + 0.04;
    }
    z += rd + 0.025;
  }
}

// 人の作業の積み方（u=左から, v=奥から, base=カゴ車の床からの高さ, rot=縦向き）。前面が開口なので各段とも奥から置く
const SLOTS = {
  H1: [0.25, 0.1875, 0.0], H2: [0.75, 0.1875, 0.0], H3: [0.75, 0.5625, 0.0], H4: [0.25, 0.5625, 0.0],
  M1: [0.25, 0.125, 0.30], M2: [0.75, 0.125, 0.30],
  M3: [0.125, 0.5, 0.30, true], M4: [0.375, 0.5, 0.30, true], M5: [0.625, 0.5, 0.30, true], M6: [0.875, 0.5, 0.30, true],
  W1: [0.20, 0.1875, 0.50], W2: [0.80, 0.1875, 0.50],
  L1: [0.15, 0.625, 0.50], L2: [0.45, 0.625, 0.50], L3: [0.80, 0.625, 0.50],
  S1: [0.20, 0.1875, 0.75], S2: [0.80, 0.1875, 0.75],
};
function slotPos(id) {
  const [u, v, base, rot] = SLOTS[id];
  return { x: CART.x - CART.w / 2 + u, y: CART.floor + base + ITEMS[id].h / 2, z: CART.z - CART.d / 2 + v, yaw: rot ? Math.PI / 2 : 0 };
}

// ---- タイムライン（決定的なキーフレーム） ----
const fwd = (yaw) => ({ x: Math.sin(yaw), z: Math.cos(yaw) });
const yawTo = (from, to) => Math.atan2(to.x - from.x, to.z - from.z);

function buildTimeline() {
  const tr = { worker: [], yaw: [], grip: [], gw: [], walk: [], spin: [] };
  const rests = Object.fromEntries(IDS.map((id) => [id, [[0, initPos[id]]]]));
  const carries = Object.fromEntries(IDS.map((id) => [id, []]));
  const cur = { worker: { x: 0.2, z: 1.45 }, yaw: Math.PI, gw: 0.2, walk: 0, spin: 0 };
  cur.grip = restGrip(cur.worker, cur.yaw);
  const pos = { ...initPos };
  const inCart = [];
  let t = 0;
  let carrying = null;
  let voiceEnd = 0;
  const cues = [];
  const scenes = [];

  function restGrip(w, yaw) { const f = fwd(yaw); return { x: w.x + f.x * 0.18, y: 0.82, z: w.z + f.z * 0.18 }; }
  function chestGrip(w, yaw) { const f = fwd(yaw); return { x: w.x + f.x * 0.34, y: 1.02, z: w.z + f.z * 0.34 }; }
  const snap = () => {
    tr.worker.push([t, { ...cur.worker }]);
    tr.yaw.push([t, cur.yaw]);
    tr.grip.push([t, { ...cur.grip }]);
    tr.gw.push([t, cur.gw]);
    tr.walk.push([t, cur.walk]);
    tr.spin.push([t, cur.spin]);
  };
  const step = (dur, fn) => { snap(); fn(); t += dur; snap(); };
  const setYaw = (y) => { while (y - cur.yaw > Math.PI) y -= 2 * Math.PI; while (y - cur.yaw < -Math.PI) y += 2 * Math.PI; cur.yaw = y; };
  const hold = (dur) => step(dur, () => {});
  const follow = () => { cur.grip = carrying ? chestGrip(cur.worker, cur.yaw) : restGrip(cur.worker, cur.yaw); if (!carrying) cur.gw = 0.2; };

  function turn(yaw) {
    const before = cur.yaw;
    setYaw(yaw);
    const d = Math.abs(cur.yaw - before);
    cur.yaw = before;
    if (d < 0.05) return;
    step(0.08 + d * 0.09, () => { setYaw(yaw); follow(); });
  }
  // パレット・カゴ車を突き抜けないよう、奥の通路へは手前の通路を経由する
  function walkTo(x, z, faceYaw) {
    const LANE = 0.92;
    if (Math.abs(x - cur.worker.x) > 0.3) {
      if (cur.worker.z < 0.6) walkStraight(cur.worker.x, LANE);
      if (z < 0.6) walkStraight(x, LANE);
    }
    walkStraight(x, z);
    if (faceYaw !== undefined) turn(faceYaw);
  }
  function walkStraight(x, z) {
    const dist = Math.hypot(x - cur.worker.x, z - cur.worker.z);
    if (dist > 0.05) {
      // 大きく向きを変えるときだけ先に振り向き、それ以外は歩きながら向きを変える
      const dir = yawTo(cur.worker, { x, z });
      let dy = dir - cur.yaw;
      dy = Math.abs(Math.atan2(Math.sin(dy), Math.cos(dy)));
      if (dy > 1.6) step(0.2, () => { setYaw(cur.yaw + (Math.atan2(Math.sin(dir - cur.yaw), Math.cos(dir - cur.yaw))) * 0.6); follow(); });
      const speed = carrying ? 1.7 : 1.9;
      step(dist / speed, () => { setYaw(dir); cur.worker = { x, z }; cur.walk += dist; follow(); });
    }
  }
  function say(id) {
    if (t < voiceEnd) hold(voiceEnd - t);
    cues.push({ id, start: t, end: t + VOICE[id] });
    voiceEnd = t + VOICE[id] + 0.4;
  }
  function untilVoiceDone() { if (t < voiceEnd) hold(voiceEnd - t); }

  function pickStand(p) {
    const pal = PALLETS.find((q) => Math.abs(p.x - q.x) < q.w / 2 && Math.abs(p.z - q.z) < q.d / 2);
    if (!pal) return { x: p.x, z: p.z + 0.62 };
    const front = { x: p.x, z: pal.z + pal.d / 2 + 0.3 };
    if (pal.z > 1) return { x: p.x, z: pal.z - pal.d / 2 - 0.3 }; // 手前のパレットは通路側から
    if (front.z - p.z <= 1.0) return front;
    const left = { x: pal.x - pal.w / 2 - 0.27, z: p.z };
    const right = { x: pal.x + pal.w / 2 + 0.27, z: p.z };
    return Math.abs(p.x - left.x) < Math.abs(p.x - right.x) ? left : right;
  }
  // 体の横方向の幅（つかむ手の間隔）
  function spanAcross(id, boxYaw, workerYaw) {
    const it = ITEMS[id];
    const rel = Math.abs(Math.sin(boxYaw - workerYaw));
    return (rel > 0.5 ? it.d : it.w) / 2 + 0.035;
  }

  function pick(id) {
    const p = pos[id];
    const st = pickStand(p);
    walkTo(st.x, st.z, yawTo(st, p));
    step(0.35, () => { cur.grip = { x: p.x, y: p.y, z: p.z }; cur.gw = spanAcross(id, p.yaw, cur.yaw); });
    carrying = { id, t0: t, baseYaw: p.yaw, pickYaw: cur.yaw };
    step(0.2, () => { cur.grip = { ...cur.grip, y: p.y + 0.15 }; });
    step(0.2, () => { cur.grip = chestGrip(cur.worker, cur.yaw); });
  }
  function release(id, target) {
    const c = carrying;
    carries[id].push({ t0: c.t0, t1: t, baseYaw: c.baseYaw, pickYaw: c.pickYaw });
    pos[id] = target;
    rests[id].push([t, target]);
    carrying = null;
    step(0.25, () => { cur.spin = 0; follow(); });
  }
  function placeAt(id, target, standX, standZ, faceYaw) {
    const c = carrying;
    // 運びながら向きを合わせる（最終的な箱の向き = 元の向き + 体の回転 + 持ち替え）
    let need = target.yaw - c.baseYaw - (faceYaw - c.pickYaw);
    need = Math.atan2(Math.sin(need), Math.cos(need));
    if (need > Math.PI / 2) need -= Math.PI; if (need < -Math.PI / 2) need += Math.PI;
    walkTo(standX, standZ, faceYaw);
    if (Math.abs(need - cur.spin) > 0.01) step(0.25, () => { cur.spin = need; cur.gw = spanAcross(id, target.yaw, cur.yaw); });
    const top = Math.max(0, ...inCart.filter((q) => Math.abs(pos[q].x - target.x) < 0.75).map((q) => pos[q].y + ITEMS[q].h / 2));
    const clearY = Math.max(target.y + 0.06, top + ITEMS[id].h / 2 + 0.05, 0.75);
    step(0.35, () => { cur.grip = { x: target.x, y: clearY, z: target.z }; cur.gw = spanAcross(id, target.yaw, cur.yaw); });
    step(0.3, () => { cur.grip = { x: target.x, y: target.y, z: target.z }; });
    release(id, target);
  }
  function load(id) {
    pick(id);
    const s = slotPos(id);
    placeAt(id, s, s.x, STAND_Z, Math.PI);
    inCart.push(id);
  }
  function scene(no, label, fn) { const start = t; fn(); scenes.push({ scene: no, label, start, end: t }); }

  // 場面1 作業開始：カゴ車の前で表示板と高さの線を見る
  scene(1, '作業開始', () => {
    hold(0.6);
    say('E1');
    walkTo(CART.x + 0.35, STAND_Z + 0.15, Math.PI * 0.8);
    step(0.6, () => { cur.grip = { x: cx1 + 0.12, y: CART.floor + 0.95, z: CART.z + 0.25 }; cur.gw = 0.05; }); // 右側面の表示板を指す
    hold(0.6);
    step(0.6, () => { cur.grip = { x: CART.x, y: CART.floor + CART.limit, z: CART_FRONT + 0.05 }; }); // 高さの線
    hold(0.5);
    step(0.4, () => { follow(); });
    turn(-Math.PI / 2); // 仮置きの荷物を見る
    untilVoiceDone();
  });
  // 場面2 重い箱で下段の土台：H1・H2を奥、H3・H4を手前
  scene(2, '重い箱で下段の土台', () => {
    say('E2');
    for (const id of ['H1', 'H2', 'H3', 'H4']) load(id);
  });
  // 場面3 レンガ積み
  scene(3, 'レンガ積み', () => {
    load('M1');
    say('E3');
    for (const id of ['M2', 'M3', 'M4', 'M5', 'M6']) load(id);
  });
  // 場面4 偏荷重の回避：W1を奥の左に置いた後、W2を奥の右へ
  scene(4, '偏荷重の回避', () => {
    load('W1');
    step(0.4, () => { cur.worker = { x: CART.x, z: STAND_Z + 0.1 }; follow(); });
    hold(0.4);
    say('E4');
    untilVoiceDone();
    load('W2');
  });
  // 場面5 軽い箱を上段へ（説明なし）
  scene(5, '軽い箱を上段へ', () => {
    for (const id of ['L1', 'L2', 'L3']) load(id);
  });
  // 場面6 上積み厳禁：バッグを最後に一番上へ
  scene(6, '上積み厳禁', () => {
    pick('S1');
    say('E5');
    const s = slotPos('S1');
    placeAt('S1', s, s.x, STAND_Z, Math.PI);
    inCart.push('S1');
    load('S2');
  });
  // 場面7 終了確認
  scene(7, '終了確認', () => {
    walkTo(CART.x, STAND_Z + 0.35, Math.PI);
    say('E6');
    hold(0.8);
    walkTo(CART.x + CART.w / 2 + 0.28, CART.z + 0.1, -Math.PI / 2); // 右側面からはみ出しを見る
    hold(0.9);
    walkTo(CART.x - 0.1, STAND_Z + 0.55, Math.PI);
    untilVoiceDone();
    walkTo(CART.x - 1.0, STAND_Z + 0.75, Math.PI);
    hold(1.5);
  });
  return { tr, rests, carries, duration: t, scenes, cues };
}

const ease = (u) => u * u * (3 - 2 * u);
function lerp(a, b, u) {
  if (typeof a === 'number') return a + (b - a) * u;
  const o = {};
  for (const k in a) o[k] = a[k] + (b[k] - a[k]) * u;
  return o;
}
function sample(track, t, linear = false) {
  if (t <= track[0][0]) return track[0][1];
  for (let i = 1; i < track.length; i++) {
    const [t1, v1] = track[i];
    if (t <= t1) {
      const [t0, v0] = track[i - 1];
      const u = t1 === t0 ? 1 : (t - t0) / (t1 - t0);
      return lerp(v0, v1, linear ? u : ease(u));
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

const scene3 = new THREE.Scene();
scene3.background = new THREE.Color('#d9dde2');
const camera = new THREE.PerspectiveCamera(36, WIDTH / HEIGHT, 0.1, 50);
camera.position.set(2.5, 4.1, 3.9);
camera.lookAt(-0.45, 0.25, 0.25);

scene3.add(new THREE.HemisphereLight('#ffffff', '#8a8f96', 0.95));
const sun = new THREE.DirectionalLight('#ffffff', 1.5);
sun.position.set(2.5, 6, 4);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -5, right: 5, top: 4, bottom: -4 });
scene3.add(sun);

const std = (color, opts = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.8, ...opts });
function addMesh(geo, mat, p, parent = scene3) {
  const m = new THREE.Mesh(geo, mat);
  m.position.set(p.x, p.y, p.z);
  m.castShadow = true;
  m.receiveShadow = true;
  parent.add(m);
  return m;
}
function setLimb(mesh, a, b) {
  const va = new THREE.Vector3(a.x, a.y, a.z);
  const vb = new THREE.Vector3(b.x, b.y, b.z);
  const dir = vb.clone().sub(va);
  const len = Math.max(dir.length(), 1e-4);
  mesh.position.copy(va).add(vb).multiplyScalar(0.5);
  mesh.scale.set(1, len, 1);
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
}

// 床・壁・通路線
const floor = addMesh(new THREE.PlaneGeometry(14, 12), std('#a3a8ae'), { x: 0, y: 0, z: 0 });
floor.rotation.x = -Math.PI / 2;
const lane = addMesh(new THREE.PlaneGeometry(9, 0.08), std('#e2b93b'), { x: 0.3, y: 0.002, z: 2.45 });
lane.rotation.x = -Math.PI / 2;
addMesh(new THREE.BoxGeometry(14, 4, 0.1), std('#c4c8cc'), { x: 0, y: 2, z: -1.5 });

// 仮置きパレット
const wood = std('#9b7b55');
for (const p of PALLETS) {
  addMesh(new THREE.BoxGeometry(p.w, 0.03, p.d), wood, { x: p.x, y: PALLET_H - 0.015, z: p.z });
  for (const sx of [-1, 0, 1]) addMesh(new THREE.BoxGeometry(0.1, PALLET_H - 0.03, p.d), std('#7d6243'), { x: p.x + sx * (p.w / 2 - 0.05), y: (PALLET_H - 0.03) / 2, z: p.z });
}

// カゴ車（前面＝カメラ側が開口）
const metal = std('#8f969d', { metalness: 0.6, roughness: 0.4 });
addMesh(new THREE.BoxGeometry(CART.w, 0.04, CART.d), metal, { x: CART.x, y: CART.floor - 0.02, z: CART.z });
for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
  addMesh(new THREE.CylinderGeometry(0.04, 0.04, 0.05, 12), std('#222'),
    { x: CART.x + sx * (CART.w / 2 - 0.07), y: 0.045, z: CART.z + sz * (CART.d / 2 - 0.07) }).rotation.z = Math.PI / 2;
}
const cx0 = CART.x - CART.w / 2, cx1 = CART.x + CART.w / 2, cz0 = CART.z - CART.d / 2, cz1 = CART.z + CART.d / 2;
const ctop = CART.floor + CART.wall;
function bar(a, b, r = 0.011, mat = metal) { setLimb(addMesh(new THREE.CylinderGeometry(r, r, 1, 6), mat, { x: 0, y: 0, z: 0 }), a, b); }
for (let x = cx0; x <= cx1 + 1e-6; x += 0.125) bar({ x, y: CART.floor, z: cz0 }, { x, y: ctop, z: cz0 });
for (let z = cz0; z <= cz1 + 1e-6; z += 0.125) {
  bar({ x: cx0, y: CART.floor, z }, { x: cx0, y: ctop, z });
  bar({ x: cx1, y: CART.floor, z }, { x: cx1, y: ctop, z });
}
for (let y = CART.floor + 0.3; y <= ctop + 1e-6; y += 0.35) {
  bar({ x: cx0, y, z: cz0 }, { x: cx1, y, z: cz0 });
  bar({ x: cx0, y, z: cz0 }, { x: cx0, y, z: cz1 });
  bar({ x: cx1, y, z: cz0 }, { x: cx1, y, z: cz1 });
}
// 積付高さの線（黄色）
const lineMat = std('#f2c200', { roughness: 0.5 });
const ly = CART.floor + CART.limit;
bar({ x: cx0, y: ly, z: cz0 }, { x: cx1, y: ly, z: cz0 }, 0.016, lineMat);
bar({ x: cx0, y: ly, z: cz0 }, { x: cx0, y: ly, z: cz1 }, 0.016, lineMat);
bar({ x: cx1, y: ly, z: cz0 }, { x: cx1, y: ly, z: cz1 }, 0.016, lineMat);

// テクスチャ
function labelTexture(draw, w = 256, h = 256) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}
const JP = '"Yu Gothic UI", "Meiryo", sans-serif';
const plateTex = labelTexture((g, w, h) => {
  g.fillStyle = '#fff'; g.fillRect(0, 0, w, h);
  g.strokeStyle = '#1b4f9c'; g.lineWidth = 14; g.strokeRect(7, 7, w - 14, h - 14);
  g.fillStyle = '#111'; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.font = `bold 70px ${JP}`; g.fillText('最大積載', w / 2, h * 0.3);
  g.font = 'bold 110px Arial'; g.fillText('150kg', w / 2, h * 0.7);
}, 512, 320);
function decal(parent, tex, w, h, p, rotX = 0, rotY = 0) {
  const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshStandardMaterial({ map: tex, roughness: 0.9 }));
  m.position.set(p.x, p.y, p.z);
  m.rotation.set(rotX, rotY, 0);
  parent.add(m);
  return m;
}
decal(scene3, plateTex, 0.30, 0.19, { x: cx1 + 0.02, y: CART.floor + 0.95, z: CART.z + 0.1 }, 0, Math.PI / 2); // 右側面の表示板
const lineTex = labelTexture((g, w, h) => {
  g.fillStyle = '#f2c200'; g.fillRect(0, 0, w, h);
  g.fillStyle = '#111'; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.font = `bold 64px ${JP}`; g.fillText('積付高さ ここまで', w / 2, h / 2 + 4);
}, 640, 110);
decal(scene3, lineTex, 0.42, 0.072, { x: CART.x, y: ly + 0.05, z: cz0 + 0.012 });

const tagTex = (id) => labelTexture((g, w, h) => {
  g.fillStyle = '#fff'; g.fillRect(0, 0, w, h);
  g.strokeStyle = '#111'; g.lineWidth = 12; g.strokeRect(6, 6, w - 12, h - 12);
  g.fillStyle = '#111'; g.font = 'bold 150px Arial'; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText(id, w / 2, h / 2 + 8);
}, 320, 256);

const itemObj = {};
for (const id of IDS) {
  const it = ITEMS[id];
  const geo = it.kind === 'bag' ? new RoundedBoxGeometry(it.w, it.h, it.d, 4, 0.06) : new THREE.BoxGeometry(it.w, it.h, it.d);
  const grp = new THREE.Group();
  const body = new THREE.Mesh(geo, std(it.color, { roughness: it.kind === 'bag' ? 0.95 : 0.75 }));
  body.castShadow = true; body.receiveShadow = true;
  grp.add(body);
  const tw = Math.min(it.w * 0.7, 0.24);
  decal(grp, tagTex(id), tw, tw * 0.8, { x: 0, y: it.h / 2 + 0.004, z: 0 }, -Math.PI / 2); // 天面タグ
  decal(grp, tagTex(id), 0.12, 0.096, { x: -it.w / 2 + 0.09, y: 0, z: it.d / 2 + 0.004 }); // 前面タグ
  if (it.kind === 'box') {
    const tape = new THREE.Mesh(new THREE.PlaneGeometry(0.05, it.d), std('#d8c49a'));
    tape.rotation.x = -Math.PI / 2; tape.position.set(it.w * 0.3, it.h / 2 + 0.002, 0); grp.add(tape);
  }
  scene3.add(grp);
  itemObj[id] = grp;
}

// 作業者（簡易マネキン。シミュレータのロボットとは別の見た目）
const limb = (r, color) => addMesh(new THREE.CylinderGeometry(r, r, 1, 14), std(color), { x: 0, y: 0, z: 0 });
const worker = {
  torso: limb(0.15, '#2c3e66'),
  head: addMesh(new THREE.SphereGeometry(0.11, 20, 16), std('#e0b48f'), { x: 0, y: 0, z: 0 }),
  cap: addMesh(new THREE.SphereGeometry(0.115, 20, 10, 0, Math.PI * 2, 0, Math.PI / 2), std('#e2b93b'), { x: 0, y: 0, z: 0 }),
  armL: limb(0.045, '#2c3e66'), armR: limb(0.045, '#2c3e66'),
  handL: addMesh(new THREE.SphereGeometry(0.05, 12, 10), std('#e8d23a'), { x: 0, y: 0, z: 0 }),
  handR: addMesh(new THREE.SphereGeometry(0.05, 12, 10), std('#e8d23a'), { x: 0, y: 0, z: 0 }),
  thighL: limb(0.07, '#55595f'), thighR: limb(0.07, '#55595f'),
  shinL: limb(0.06, '#55595f'), shinR: limb(0.06, '#55595f'),
  footL: addMesh(new THREE.BoxGeometry(0.1, 0.06, 0.22), std('#333'), { x: 0, y: 0, z: 0 }),
  footR: addMesh(new THREE.BoxGeometry(0.1, 0.06, 0.22), std('#333'), { x: 0, y: 0, z: 0 }),
};
const SEG = 0.46;
function legIK(name, hip, foot, f) {
  const d = Math.hypot(foot.x - hip.x, foot.y - hip.y, foot.z - hip.z);
  let knee;
  if (d >= 2 * SEG - 1e-3) knee = { x: (hip.x + foot.x) / 2, y: (hip.y + foot.y) / 2, z: (hip.z + foot.z) / 2 };
  else {
    const k = Math.sqrt(SEG * SEG - (d / 2) * (d / 2));
    knee = { x: (hip.x + foot.x) / 2 + f.x * k, y: (hip.y + foot.y) / 2, z: (hip.z + foot.z) / 2 + f.z * k };
  }
  setLimb(worker['thigh' + name], hip, knee);
  setLimb(worker['shin' + name], knee, foot);
}
function poseWorker(w, yaw, grip, gw, walk, moving) {
  const f = fwd(yaw);
  const r = { x: -f.z, z: f.x };
  const reach = (grip.x - w.x) * f.x + (grip.z - w.z) * f.z;
  const crouch = Math.min(Math.max((0.8 - grip.y) / 0.5, 0), 1);
  const lean = Math.min(Math.max((reach - 0.32) * 1.2, 0) + crouch * 0.4, 0.8);
  const hip = { x: w.x - f.x * crouch * 0.1, y: 0.9 - crouch * 0.4, z: w.z - f.z * crouch * 0.1 };
  const up = 0.52;
  const sh = { x: hip.x + f.x * up * Math.sin(lean), y: hip.y + up * Math.cos(lean), z: hip.z + f.z * up * Math.sin(lean) };
  setLimb(worker.torso, hip, sh);
  const hd = 0.17;
  worker.head.position.set(sh.x + f.x * hd * Math.sin(lean) * 1.1, sh.y + hd * Math.cos(lean), sh.z + f.z * hd * Math.sin(lean) * 1.1);
  worker.cap.position.copy(worker.head.position).add(new THREE.Vector3(0, 0.02, 0));
  const shL = { x: sh.x - r.x * 0.19, y: sh.y - 0.03, z: sh.z - r.z * 0.19 };
  const shR = { x: sh.x + r.x * 0.19, y: sh.y - 0.03, z: sh.z + r.z * 0.19 };
  const hL = { x: grip.x - r.x * gw, y: grip.y, z: grip.z - r.z * gw };
  const hR = { x: grip.x + r.x * gw, y: grip.y, z: grip.z + r.z * gw };
  setLimb(worker.armL, shL, hL);
  setLimb(worker.armR, shR, hR);
  worker.handL.position.set(hL.x, hL.y, hL.z);
  worker.handR.position.set(hR.x, hR.y, hR.z);
  const ph = (walk / 0.36) * Math.PI;
  for (const [name, side, off] of [['L', -1, 0], ['R', 1, Math.PI]]) {
    const s = Math.sin(ph + off) * 0.17 * moving;
    const lift = Math.max(0, Math.cos(ph + off)) * 0.07 * moving;
    const spread = 0.11 + crouch * 0.06;
    const foot = { x: w.x + r.x * side * spread + f.x * s, y: 0.06 + lift, z: w.z + r.z * side * spread + f.z * s };
    const hipS = { x: hip.x + r.x * side * 0.1, y: hip.y, z: hip.z + r.z * side * 0.1 };
    legIK(name, hipS, foot, f);
    const fm = worker['foot' + name];
    fm.position.set(foot.x + f.x * 0.05, 0.03 + lift, foot.z + f.z * 0.05);
    fm.rotation.set(0, yaw, 0);
  }
}

const TL = buildTimeline();
function boxState(id, t) {
  for (const c of TL.carries[id]) {
    if (t >= c.t0 && t < c.t1) {
      const g = sample(TL.tr.grip, t);
      const y = sample(TL.tr.yaw, t);
      return { ...g, yaw: c.baseYaw + (y - c.pickYaw) + sample(TL.tr.spin, t) };
    }
  }
  let p = TL.rests[id][0][1];
  for (const [t0, q] of TL.rests[id]) if (t >= t0) p = q;
  return p;
}
function renderFrame(t) {
  const { tr } = TL;
  const walk = sample(tr.walk, t, true);
  const moving = Math.min(Math.abs(walk - sample(tr.walk, Math.max(0, t - 0.1), true)) / 0.1, 1);
  poseWorker(sample(tr.worker, t, true), sample(tr.yaw, t), sample(tr.grip, t), sample(tr.gw, t), walk, moving);
  for (const id of IDS) {
    const p = boxState(id, t);
    itemObj[id].position.set(p.x, p.y, p.z);
    itemObj[id].rotation.set(0, p.yaw, 0);
  }
  const s = Math.floor(t);
  document.getElementById('ts').textContent = `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  renderer.render(scene3, camera);
}

window.W2R = { fps: FPS, duration: TL.duration, events: { scenes: TL.scenes, voice_cues: TL.cues }, renderFrame };
renderFrame(0);
window.W2R_READY = true;
