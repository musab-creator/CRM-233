import * as THREE from 'three';
import { TILE_METRES } from './shingle-texture';

/**
 * Builds the demo house as real geometry, in metres, front facing +Z.
 *
 * The roof is modelled the way a roof is actually framed — hip planes at a 6/12
 * pitch with overhangs, a front-facing gable, and ridge and hip caps — because
 * the shingle material only reads correctly if the surfaces it sits on have the
 * right slope and the right UV run. UVs are laid out in metres along the slope
 * so course lines stay horizontal and consistently sized on every plane.
 */

/** 6/12 pitch. */
const PITCH = Math.atan(0.5);
const OVERHANG = 0.45;

const BODY_W = 13;
const BODY_D = 9;
const WALL_H = 2.7;

const WING_W = 5.2;
const WING_D = 3.4;

const WALL_COLOR = '#e7e0d4';
const TRIM_COLOR = '#f7f5f1';

/** Pushes a triangle with per-vertex UVs into the buffers. */
function pushTriangle(
  positions: number[],
  uvs: number[],
  a: THREE.Vector3,
  b: THREE.Vector3,
  c: THREE.Vector3,
  ua: THREE.Vector2,
  ub: THREE.Vector2,
  uc: THREE.Vector2,
) {
  positions.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
  uvs.push(ua.x, ua.y, ub.x, ub.y, uc.x, uc.y);
}

function finish(positions: number[], uvs: number[]): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  // UVs arrive in metres; scale into texture tiles.
  const scaled = uvs.map((v) => v / TILE_METRES);
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(scaled, 2));
  geometry.computeVertexNormals();
  return geometry;
}

/**
 * Hip roof over a rectangular body: two trapezoids and two triangles meeting at
 * a ridge running along X.
 */
function hipRoofGeometry(w: number, d: number): THREE.BufferGeometry {
  const W = w + OVERHANG * 2;
  const D = d + OVERHANG * 2;
  const h = (D / 2) * Math.tan(PITCH);
  const slope = Math.hypot(D / 2, h);
  const rx = Math.max(0, (W - D) / 2);

  const eaveNW = new THREE.Vector3(-W / 2, 0, -D / 2);
  const eaveNE = new THREE.Vector3(W / 2, 0, -D / 2);
  const eaveSE = new THREE.Vector3(W / 2, 0, D / 2);
  const eaveSW = new THREE.Vector3(-W / 2, 0, D / 2);
  const ridgeW = new THREE.Vector3(-rx, h, 0);
  const ridgeE = new THREE.Vector3(rx, h, 0);

  const positions: number[] = [];
  const uvs: number[] = [];

  // Front and back slopes. u runs along the eave, v runs up the slope.
  pushTriangle(
    positions, uvs,
    eaveSW, eaveSE, ridgeE,
    new THREE.Vector2(0, 0), new THREE.Vector2(W, 0), new THREE.Vector2(W / 2 + rx, slope),
  );
  pushTriangle(
    positions, uvs,
    eaveSW, ridgeE, ridgeW,
    new THREE.Vector2(0, 0), new THREE.Vector2(W / 2 + rx, slope), new THREE.Vector2(W / 2 - rx, slope),
  );
  pushTriangle(
    positions, uvs,
    eaveNE, eaveNW, ridgeW,
    new THREE.Vector2(0, 0), new THREE.Vector2(W, 0), new THREE.Vector2(W / 2 + rx, slope),
  );
  pushTriangle(
    positions, uvs,
    eaveNE, ridgeW, ridgeE,
    new THREE.Vector2(0, 0), new THREE.Vector2(W / 2 + rx, slope), new THREE.Vector2(W / 2 - rx, slope),
  );

  // Hip ends. u runs along the eave (in Z), v up the slope.
  pushTriangle(
    positions, uvs,
    eaveNW, eaveSW, ridgeW,
    new THREE.Vector2(0, 0), new THREE.Vector2(D, 0), new THREE.Vector2(D / 2, slope),
  );
  pushTriangle(
    positions, uvs,
    eaveSE, eaveNE, ridgeE,
    new THREE.Vector2(0, 0), new THREE.Vector2(D, 0), new THREE.Vector2(D / 2, slope),
  );

  return finish(positions, uvs);
}

/** Front-facing gable roof: two slopes meeting at a ridge running along Z. */
function gableRoofGeometry(w: number, d: number): THREE.BufferGeometry {
  const W = w + OVERHANG * 2;
  const D = d + OVERHANG;
  const h = (W / 2) * Math.tan(PITCH);
  const slope = Math.hypot(W / 2, h);

  const positions: number[] = [];
  const uvs: number[] = [];

  const eaveWestBack = new THREE.Vector3(-W / 2, 0, -D);
  const eaveWestFront = new THREE.Vector3(-W / 2, 0, OVERHANG);
  const eaveEastBack = new THREE.Vector3(W / 2, 0, -D);
  const eaveEastFront = new THREE.Vector3(W / 2, 0, OVERHANG);
  const ridgeBack = new THREE.Vector3(0, h, -D);
  const ridgeFront = new THREE.Vector3(0, h, OVERHANG);

  const run = D + OVERHANG;

  // West slope
  pushTriangle(
    positions, uvs,
    eaveWestBack, eaveWestFront, ridgeFront,
    new THREE.Vector2(0, 0), new THREE.Vector2(run, 0), new THREE.Vector2(run, slope),
  );
  pushTriangle(
    positions, uvs,
    eaveWestBack, ridgeFront, ridgeBack,
    new THREE.Vector2(0, 0), new THREE.Vector2(run, slope), new THREE.Vector2(0, slope),
  );
  // East slope
  pushTriangle(
    positions, uvs,
    eaveEastFront, eaveEastBack, ridgeBack,
    new THREE.Vector2(0, 0), new THREE.Vector2(run, 0), new THREE.Vector2(run, slope),
  );
  pushTriangle(
    positions, uvs,
    eaveEastFront, ridgeBack, ridgeFront,
    new THREE.Vector2(0, 0), new THREE.Vector2(run, slope), new THREE.Vector2(0, slope),
  );

  return finish(positions, uvs);
}

/** A ridge/hip cap run: a slim box laid along the line from a to b. */
function capMesh(
  a: THREE.Vector3,
  b: THREE.Vector3,
  material: THREE.Material,
  width = 0.34,
): THREE.Mesh {
  const length = a.distanceTo(b);
  const geometry = new THREE.BoxGeometry(width, 0.075, length);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.copy(a).add(b).multiplyScalar(0.5);
  mesh.quaternion.setFromUnitVectors(
    new THREE.Vector3(0, 0, 1),
    b.clone().sub(a).normalize(),
  );
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

function box(
  w: number,
  h: number,
  d: number,
  color: string,
  roughness = 0.9,
): THREE.Mesh {
  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(w, h, d),
    new THREE.MeshStandardMaterial({ color, roughness, metalness: 0 }),
  );
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

function window3d(w: number, h: number): THREE.Group {
  const group = new THREE.Group();
  const frame = box(w, h, 0.09, TRIM_COLOR, 0.7);
  const glass = new THREE.Mesh(
    new THREE.BoxGeometry(w - 0.16, h - 0.16, 0.05),
    new THREE.MeshStandardMaterial({
      color: '#33414d',
      roughness: 0.12,
      metalness: 0.55,
    }),
  );
  glass.position.z = 0.04;
  group.add(frame, glass);
  return group;
}

export interface HouseModel {
  group: THREE.Group;
  /** Every mesh that wears the shingle material, for color swaps. */
  roofMeshes: THREE.Mesh[];
  capMeshes: THREE.Mesh[];
}

export function buildHouse(
  roofMaterial: THREE.Material,
  capMaterial: THREE.Material,
): HouseModel {
  const group = new THREE.Group();
  const roofMeshes: THREE.Mesh[] = [];
  const capMeshes: THREE.Mesh[] = [];

  // ---- Main body ----
  const body = box(BODY_W, WALL_H, BODY_D, WALL_COLOR, 0.95);
  body.position.y = WALL_H / 2;
  group.add(body);

  // ---- Main hip roof ----
  const hip = new THREE.Mesh(hipRoofGeometry(BODY_W, BODY_D), roofMaterial);
  hip.position.y = WALL_H;
  hip.castShadow = true;
  hip.receiveShadow = true;
  group.add(hip);
  roofMeshes.push(hip);

  {
    const W = BODY_W + OVERHANG * 2;
    const D = BODY_D + OVERHANG * 2;
    const h = (D / 2) * Math.tan(PITCH);
    const rx = Math.max(0, (W - D) / 2);
    const y = WALL_H;
    const ridgeW = new THREE.Vector3(-rx, h + y, 0);
    const ridgeE = new THREE.Vector3(rx, h + y, 0);
    capMeshes.push(capMesh(ridgeW, ridgeE, capMaterial, 0.4));
    // Four hip lines running from the eave corners up to the ridge ends.
    capMeshes.push(capMesh(new THREE.Vector3(-W / 2, y, -D / 2), ridgeW, capMaterial));
    capMeshes.push(capMesh(new THREE.Vector3(-W / 2, y, D / 2), ridgeW, capMaterial));
    capMeshes.push(capMesh(new THREE.Vector3(W / 2, y, -D / 2), ridgeE, capMaterial));
    capMeshes.push(capMesh(new THREE.Vector3(W / 2, y, D / 2), ridgeE, capMaterial));
  }

  // ---- Front gable wing ----
  const wingX = -BODY_W / 2 + WING_W / 2 + 1.4;
  const wingZ = BODY_D / 2;
  const wing = box(WING_W, WALL_H, WING_D * 2, WALL_COLOR, 0.95);
  wing.position.set(wingX, WALL_H / 2, wingZ);
  group.add(wing);

  const gable = new THREE.Mesh(gableRoofGeometry(WING_W, WING_D), roofMaterial);
  gable.position.set(wingX, WALL_H, wingZ + WING_D);
  gable.castShadow = true;
  gable.receiveShadow = true;
  group.add(gable);
  roofMeshes.push(gable);

  {
    const h = ((WING_W + OVERHANG * 2) / 2) * Math.tan(PITCH);
    const front = new THREE.Vector3(wingX, WALL_H + h, wingZ + WING_D + OVERHANG);
    const back = new THREE.Vector3(wingX, WALL_H + h, wingZ + WING_D - (WING_D + OVERHANG));
    capMeshes.push(capMesh(front, back, capMaterial, 0.4));
  }

  // Gable end wall filling the triangle under the wing roof.
  {
    const W = WING_W + OVERHANG * 2;
    const h = (W / 2) * Math.tan(PITCH);
    const shape = new THREE.Shape();
    shape.moveTo(-WING_W / 2, 0);
    shape.lineTo(WING_W / 2, 0);
    shape.lineTo(0, h * (WING_W / W));
    shape.closePath();
    const pediment = new THREE.Mesh(
      new THREE.ShapeGeometry(shape),
      new THREE.MeshStandardMaterial({ color: WALL_COLOR, roughness: 0.95 }),
    );
    pediment.position.set(wingX, WALL_H, wingZ + WING_D + 0.001);
    pediment.castShadow = true;
    pediment.receiveShadow = true;
    group.add(pediment);
  }

  // ---- Fascia along the eaves ----
  {
    const W = BODY_W + OVERHANG * 2;
    const D = BODY_D + OVERHANG * 2;
    const y = WALL_H - 0.09;
    const front = box(W, 0.2, 0.1, TRIM_COLOR, 0.7);
    front.position.set(0, y, D / 2);
    const back = front.clone();
    back.position.set(0, y, -D / 2);
    const left = box(0.1, 0.2, D, TRIM_COLOR, 0.7);
    left.position.set(-W / 2, y, 0);
    const right = left.clone();
    right.position.set(W / 2, y, 0);
    group.add(front, back, left, right);
  }

  // ---- Garage, entry, windows on the front elevation ----
  const frontZ = BODY_D / 2 + 0.06;

  const garage = box(4.4, 2.1, 0.12, TRIM_COLOR, 0.6);
  garage.position.set(BODY_W / 2 - 3.2, 1.05, frontZ);
  group.add(garage);
  for (let i = 1; i <= 3; i++) {
    const groove = box(4.4, 0.03, 0.02, '#d8d4cc', 0.8);
    groove.position.set(BODY_W / 2 - 3.2, i * 0.52, frontZ + 0.07);
    group.add(groove);
  }

  const door = box(1.05, 2.1, 0.12, '#5b4636', 0.7);
  door.position.set(wingX, 1.05, wingZ + WING_D + 0.07);
  group.add(door);

  const frontWindow = window3d(1.5, 1.25);
  frontWindow.position.set(wingX - 1.9, 1.6, wingZ + WING_D + 0.06);
  group.add(frontWindow);

  const sideWindowA = window3d(1.3, 1.2);
  sideWindowA.position.set(-BODY_W / 2 - 0.06, 1.6, 1.4);
  sideWindowA.rotation.y = -Math.PI / 2;
  group.add(sideWindowA);

  const sideWindowB = window3d(1.3, 1.2);
  sideWindowB.position.set(-BODY_W / 2 - 0.06, 1.6, -1.8);
  sideWindowB.rotation.y = -Math.PI / 2;
  group.add(sideWindowB);

  // ---- Grounds ----
  const driveway = box(5.2, 0.04, 7, '#b9b4ad', 0.95);
  driveway.position.set(BODY_W / 2 - 3.2, 0.02, BODY_D / 2 + 3.6);
  driveway.castShadow = false;
  group.add(driveway);

  const walk = box(1.2, 0.04, 3.4, '#c3beb6', 0.95);
  walk.position.set(wingX, 0.02, wingZ + WING_D + 2.1);
  walk.castShadow = false;
  group.add(walk);

  const shrubMaterial = new THREE.MeshStandardMaterial({ color: '#4c6b42', roughness: 1 });
  for (const [x, z, r] of [
    [wingX - 2.6, wingZ + WING_D + 0.9, 0.42],
    [wingX - 1.6, wingZ + WING_D + 0.9, 0.34],
    [-BODY_W / 2 + 0.8, BODY_D / 2 + 0.7, 0.38],
    [BODY_W / 2 - 0.7, BODY_D / 2 + 0.8, 0.44],
  ] as const) {
    const shrub = new THREE.Mesh(new THREE.IcosahedronGeometry(r, 1), shrubMaterial);
    shrub.position.set(x, r * 0.8, z);
    shrub.castShadow = true;
    shrub.receiveShadow = true;
    group.add(shrub);
  }

  for (const cap of capMeshes) group.add(cap);

  return { group, roofMeshes, capMeshes };
}
