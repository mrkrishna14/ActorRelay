// The building around the process units: everything here is static scenery, none of it reads plant state.
import * as THREE from "three";

const box = (w: number, h: number, d: number, material: THREE.Material, x: number, y: number, z: number, root: THREE.Object3D) => {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);
  mesh.position.set(x, y, z);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  root.add(mesh);
  return mesh;
};

const bar = (a: THREE.Vector3, b: THREE.Vector3, radius: number, material: THREE.Material, root: THREE.Object3D) => {
  const length = a.distanceTo(b);
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, length, 10), material);
  mesh.position.copy(a).add(b).multiplyScalar(0.5);
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize());
  mesh.castShadow = true;
  root.add(mesh);
  return mesh;
};

function canvasTexture(size: number, draw: (context: CanvasRenderingContext2D) => void, repeat: [number, number]) {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext("2d");
  if (context) draw(context);
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(repeat[0], repeat[1]);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  return texture;
}

function concrete() {
  return canvasTexture(
    1024,
    (c) => {
      c.fillStyle = "#8d9193";
      c.fillRect(0, 0, 1024, 1024);
      for (let i = 0; i < 26000; i += 1) {
        const shade = 120 + Math.floor((Math.sin(i * 12.9898) * 43758.5453 % 1) * 60);
        c.fillStyle = `rgba(${shade},${shade + 2},${shade + 4},0.16)`;
        c.fillRect((i * 37.7) % 1024, (i * 91.3) % 1024, 2 + (i % 5), 2 + (i % 3));
      }
      for (let i = 0; i < 16; i += 1) {
        c.fillStyle = "rgba(55,58,60,0.09)";
        c.beginPath();
        c.ellipse((i * 271) % 1024, (i * 433) % 1024, 40 + i * 9, 26 + i * 6, i, 0, Math.PI * 2);
        c.fill();
      }
      c.strokeStyle = "rgba(40,43,46,0.75)";
      c.lineWidth = 3;
      c.strokeRect(0, 0, 1024, 1024);
    },
    [14, 10],
  );
}

function cladding() {
  return canvasTexture(
    512,
    (c) => {
      for (let x = 0; x < 512; x += 1) {
        const wave = 196 + Math.sin((x / 512) * Math.PI * 24) * 20;
        c.fillStyle = `rgb(${wave},${wave + 4},${wave + 8})`;
        c.fillRect(x, 0, 1, 512);
      }
    },
    [14, 2],
  );
}

function instanced(geometry: THREE.BufferGeometry, material: THREE.Material, spots: THREE.Vector3[], root: THREE.Object3D) {
  const mesh = new THREE.InstancedMesh(geometry, material, spots.length);
  const matrix = new THREE.Matrix4();
  spots.forEach((spot, index) => mesh.setMatrixAt(index, matrix.makeTranslation(spot.x, spot.y, spot.z)));
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  root.add(mesh);
  return mesh;
}

export const HALL = { left: -32, right: 58, back: -24, front: 26, eave: 13, ridge: 16 };

export function addHall(scene: THREE.Scene) {
  const { left, right, back, front, eave, ridge } = HALL;
  const width = right - left;
  const depth = front - back;
  const midX = (left + right) / 2;
  const midZ = (back + front) / 2;
  const root = new THREE.Group();
  scene.add(root);

  const frame = new THREE.MeshStandardMaterial({ color: 0x4d5d6b, metalness: 0.55, roughness: 0.55 });
  const purlin = new THREE.MeshStandardMaterial({ color: 0x8b969f, metalness: 0.6, roughness: 0.5 });
  const wall = new THREE.MeshStandardMaterial({ map: cladding(), metalness: 0.2, roughness: 0.62 });
  const galvanized = new THREE.MeshStandardMaterial({ color: 0xb4bbc1, metalness: 0.75, roughness: 0.42 });
  const yellow = new THREE.MeshStandardMaterial({ color: 0xd6a51c, metalness: 0.15, roughness: 0.58 });
  const steelBlue = new THREE.MeshStandardMaterial({ color: 0x2d5f8b, metalness: 0.3, roughness: 0.48 });
  const steelGrey = new THREE.MeshStandardMaterial({ color: 0x8b9298, metalness: 0.4, roughness: 0.5 });
  const cabinet = new THREE.MeshStandardMaterial({ color: 0xa9b0b4, metalness: 0.3, roughness: 0.55 });
  const wood = new THREE.MeshStandardMaterial({ color: 0x9a7a55, roughness: 0.85 });
  const tote = new THREE.MeshStandardMaterial({ color: 0xe6e8e4, roughness: 0.4, transparent: true, opacity: 0.82 });
  const glass = new THREE.MeshStandardMaterial({ color: 0xdfeaf2, roughness: 0.2, metalness: 0.1, transparent: true, opacity: 0.85 });
  const sky = new THREE.MeshBasicMaterial({ color: 0xf2f7fb });

  const floor = new THREE.Mesh(new THREE.PlaneGeometry(width + 40, depth + 40), new THREE.MeshStandardMaterial({ map: concrete(), metalness: 0.05, roughness: 0.68 }));
  floor.rotation.x = -Math.PI / 2;
  floor.position.set(midX, 0, midZ);
  floor.receiveShadow = true;
  root.add(floor);

  // Walls, with a window band and a roller door.
  const side = new THREE.PlaneGeometry(width, eave);
  const backWall = new THREE.Mesh(side, wall);
  backWall.position.set(midX, eave / 2, back);
  backWall.receiveShadow = true;
  root.add(backWall);
  const end = new THREE.PlaneGeometry(depth, eave);
  const leftWall = new THREE.Mesh(end, wall);
  leftWall.rotation.y = Math.PI / 2;
  leftWall.position.set(left, eave / 2, midZ);
  root.add(leftWall);
  const rightWall = new THREE.Mesh(end, wall);
  rightWall.rotation.y = -Math.PI / 2;
  rightWall.position.set(right, eave / 2, midZ);
  root.add(rightWall);
  for (let x = left + 7; x < right - 4; x += 12) box(7.6, 1.8, 0.08, glass, x, 10.6, back + 0.08, root);
  const door = box(6.5, 5.5, 0.16, new THREE.MeshStandardMaterial({ color: 0x6b7780, metalness: 0.4, roughness: 0.5 }), 8, 2.75, back + 0.12, root);
  door.castShadow = false;
  for (let y = 0.4; y < 5.5; y += 0.4) box(6.5, 0.03, 0.2, purlin, 8, y, back + 0.13, root);

  // Portal frames every 12 m, purlins and a roof with skylight strips.
  for (let x = left; x <= right; x += 12) {
    box(0.42, eave, 0.42, frame, x, eave / 2, back + 0.3, root);
    box(0.42, eave, 0.42, frame, x, eave / 2, front - 0.3, root);
    bar(new THREE.Vector3(x, eave, back), new THREE.Vector3(x, ridge, midZ), 0.17, frame, root);
    bar(new THREE.Vector3(x, ridge, midZ), new THREE.Vector3(x, eave, front), 0.17, frame, root);
    bar(new THREE.Vector3(x, eave, back), new THREE.Vector3(x, eave, front), 0.09, frame, root);
    for (let s = -2; s <= 2; s += 1) {
      const z = midZ + s * 4.6;
      const y = ridge - (Math.abs(z - midZ) / (depth / 2)) * (ridge - eave);
      bar(new THREE.Vector3(x, eave, z), new THREE.Vector3(x, y, z), 0.05, frame, root);
    }
  }
  for (let s = 0; s <= 8; s += 1) {
    const z = back + (s / 8) * depth;
    const y = ridge - (Math.abs(z - midZ) / (depth / 2)) * (ridge - eave);
    box(width, 0.12, 0.08, purlin, midX, y - 0.1, z, root);
  }
  const slope = Math.atan2(ridge - eave, depth / 2);
  const roofLength = Math.hypot(ridge - eave, depth / 2);
  [-1, 1].forEach((sign) => {
    const roof = new THREE.Mesh(new THREE.PlaneGeometry(width, roofLength), new THREE.MeshStandardMaterial({ color: 0xc8ced3, roughness: 0.7, side: THREE.DoubleSide }));
    roof.rotation.x = Math.PI / 2 + sign * slope;
    roof.position.set(midX, (eave + ridge) / 2 + 0.05, midZ + (sign * depth) / 4);
    root.add(roof);
    for (let x = left + 6; x < right; x += 12) {
      const light = new THREE.Mesh(new THREE.PlaneGeometry(5, roofLength * 0.72), sky);
      light.rotation.x = roof.rotation.x;
      light.position.set(x, (eave + ridge) / 2 - 0.02, midZ + (sign * depth) / 4);
      root.add(light);
    }
  });

  // Overhead crane, ventilation duct and cable tray.
  [back + 1.2, front - 1.2].forEach((z) => box(width, 0.5, 0.3, yellow, midX, 11.2, z, root));
  box(0.6, 0.8, depth - 2.4, yellow, 34, 11.5, midZ, root);
  box(1.4, 0.7, 1.4, frame, 34, 10.8, 3, root);
  bar(new THREE.Vector3(34, 10.5, 3), new THREE.Vector3(34, 6.5, 3), 0.03, frame, root);
  box(0.5, 0.3, 0.5, yellow, 34, 6.4, 3, root);
  bar(new THREE.Vector3(left, 11.9, -15), new THREE.Vector3(right, 11.9, -15), 0.6, galvanized, root);
  for (let x = left + 6; x < right; x += 12) bar(new THREE.Vector3(x, 12.5, -15), new THREE.Vector3(x, 13.4, -15), 0.03, frame, root);
  box(width, 0.06, 0.7, galvanized, midX, 9.9, -11, root);
  for (let x = left + 6; x < right; x += 6) box(0.05, 0.9, 0.05, frame, x, 10.4, -11, root);

  // Control cabinets along the back wall, each with a door seam and handle.
  for (let i = 0; i < 9; i += 1) {
    const x = -22 + i * 1.5;
    box(1.42, 2.2, 0.7, cabinet, x, 1.1, back + 0.7, root);
    box(0.02, 2.05, 0.02, frame, x, 1.12, back + 1.06, root);
    box(0.06, 0.26, 0.04, frame, x + 0.5, 1.2, back + 1.07, root);
  }
  for (let i = 0; i < 4; i += 1) box(1.0, 1.6, 0.4, cabinet, 22 + i * 1.4, 1.6, back + 0.4, root);

  // Stored drums, pallets, totes and a small forklift: the things a working hall always has.
  const drum = new THREE.CylinderGeometry(0.3, 0.3, 0.88, 22);
  const blueDrums: THREE.Vector3[] = [];
  const greyDrums: THREE.Vector3[] = [];
  [[-23, 12], [-23, 15.2], [-19.6, 12], [44, -18], [47.2, -18], [12, 15]].forEach(([px = 0, pz = 0], index) => {
    box(2.5, 0.12, 2.5, wood, px + 0.65, 0.08, pz + 0.65, root);
    box(2.5, 0.1, 2.5, wood, px + 0.65, 0.2, pz + 0.65, root);
    for (let a = 0; a < 3; a += 1) {
      for (let b = 0; b < 3; b += 1) (index % 2 ? greyDrums : blueDrums).push(new THREE.Vector3(px + a * 0.65, 0.7, pz + b * 0.65));
    }
  });
  instanced(drum, steelBlue, blueDrums, root);
  instanced(drum, steelGrey, greyDrums, root);
  [[-26, 2], [-26, -3], [51, 8], [51, 12.5]].forEach(([x = 0, z = 0]) => {
    box(1.2, 1.15, 1.0, tote, x, 0.72, z, root);
    const cage = new THREE.Mesh(new THREE.BoxGeometry(1.26, 1.2, 1.06), new THREE.MeshStandardMaterial({ color: 0x9aa2a8, metalness: 0.7, roughness: 0.4, wireframe: true }));
    cage.position.set(x, 0.74, z);
    root.add(cage);
    box(1.3, 0.14, 1.1, frame, x, 0.08, z, root);
  });

  const lift = new THREE.Group();
  lift.position.set(-16, 0, 19);
  lift.rotation.y = 0.5;
  root.add(lift);
  box(1.1, 0.8, 2.0, yellow, 0, 0.75, 0, lift);
  box(1.0, 0.1, 1.3, frame, 0, 2.05, 0.2, lift);
  [[-0.47, 0.75], [0.47, 0.75], [-0.47, -0.3], [0.47, -0.3]].forEach(([x = 0, z = 0]) => box(0.05, 1.0, 0.05, frame, x, 1.55, z + 0.2, lift));
  box(0.9, 2.5, 0.12, frame, 0, 1.25, 1.05, lift);
  box(0.12, 0.08, 1.1, steelGrey, -0.3, 0.12, 1.6, lift);
  box(0.12, 0.08, 1.1, steelGrey, 0.3, 0.12, 1.6, lift);
  [[-0.56, 0.7], [0.56, 0.7], [-0.56, -0.7], [0.56, -0.7]].forEach(([x = 0, z = 0]) => {
    const wheel = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.3, 0.24, 18), new THREE.MeshStandardMaterial({ color: 0x1d1f21, roughness: 0.9 }));
    wheel.rotation.z = Math.PI / 2;
    wheel.position.set(x, 0.3, z);
    wheel.castShadow = true;
    lift.add(wheel);
  });

  // Painted walkways and bollards.
  const paint = new THREE.MeshStandardMaterial({ color: 0xd3a51f, roughness: 0.75 });
  [[midX, 12.6, width - 6, 0.16], [midX, 19.4, width - 6, 0.16], [midX, -10, width - 6, 0.16]].forEach(([x = 0, z = 0, w = 1, d = 1]) => {
    const line = new THREE.Mesh(new THREE.PlaneGeometry(w, d), paint);
    line.rotation.x = -Math.PI / 2;
    line.position.set(x, 0.012, z);
    line.receiveShadow = true;
    root.add(line);
  });
  for (let x = -26; x < 52; x += 6) bar(new THREE.Vector3(x, 0, 12.2), new THREE.Vector3(x, 1, 12.2), 0.07, yellow, root);

  return root;
}

/** The access steel around one tank: platform, handrail and stair. Static, placed in the unit's own coordinates. */
export function addAccess(root: THREE.Object3D, topY: number, radius: number) {
  const grating = new THREE.MeshStandardMaterial({ color: 0x59636b, metalness: 0.65, roughness: 0.55, side: THREE.DoubleSide });
  const rail = new THREE.MeshStandardMaterial({ color: 0xd6a51c, metalness: 0.15, roughness: 0.55 });
  const frame = new THREE.MeshStandardMaterial({ color: 0x4d5d6b, metalness: 0.55, roughness: 0.55 });
  const y = topY - 0.25;
  const outer = radius + 1.25;
  const deck = new THREE.Mesh(new THREE.RingGeometry(radius + 0.05, outer, 72, 1, Math.PI * 0.52, Math.PI * 1.46), grating);
  deck.rotation.x = -Math.PI / 2;
  deck.position.y = y;
  deck.castShadow = true;
  deck.receiveShadow = true;
  root.add(deck);

  const arc = (height: number, tube: number) => {
    const ring = new THREE.Mesh(new THREE.TorusGeometry(outer, tube, 8, 90, Math.PI * 1.46), rail);
    ring.rotation.x = -Math.PI / 2;
    ring.rotation.z = Math.PI * 0.52;
    ring.position.y = y + height;
    ring.castShadow = true;
    root.add(ring);
  };
  arc(1.1, 0.03);
  arc(0.55, 0.022);

  for (let i = 0; i <= 20; i += 1) {
    const angle = Math.PI * 0.52 + (i / 20) * Math.PI * 1.46;
    const x = Math.cos(angle) * outer;
    const z = -Math.sin(angle) * outer;
    bar(new THREE.Vector3(x, y, z), new THREE.Vector3(x, y + 1.1, z), 0.024, rail, root);
    if (i % 5 === 0) bar(new THREE.Vector3(x, 0.15, z), new THREE.Vector3(x, y, z), 0.07, frame, root);
  }

  // Straight stair from the floor to the platform on the rear left.
  const steps = Math.round(y / 0.2);
  const run = 0.26;
  for (let i = 0; i < steps; i += 1) {
    const step = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.04, 0.26), grating);
    step.position.set(-outer - 0.6, 0.2 + i * 0.2, -1.2 + (steps - i) * run - steps * run);
    step.castShadow = true;
    root.add(step);
  }
  const low = new THREE.Vector3(-outer - 0.15, 0.2, -1.2);
  const high = new THREE.Vector3(-outer - 0.15, y, -1.2 - steps * run);
  [0, -0.9].forEach((dx) => {
    const a = low.clone().add(new THREE.Vector3(dx, 0, 0));
    const b = high.clone().add(new THREE.Vector3(dx, 0, 0));
    bar(a, b, 0.05, frame, root);
    bar(a.clone().add(new THREE.Vector3(0, 1, 0)), b.clone().add(new THREE.Vector3(0, 1, 0)), 0.024, rail, root);
    bar(a, a.clone().add(new THREE.Vector3(0, 1, 0)), 0.024, rail, root);
    bar(b, b.clone().add(new THREE.Vector3(0, 1, 0)), 0.024, rail, root);
  });
}

/** A round dial gauge on a short stalk. The caller rotates the returned needle from live state. */
export function addGauge(root: THREE.Object3D, position: THREE.Vector3, facing: number) {
  const group = new THREE.Group();
  group.position.copy(position);
  group.rotation.y = facing;
  root.add(group);
  const face = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 0.05, 28), new THREE.MeshStandardMaterial({ color: 0xf1f1ec, roughness: 0.45 }));
  face.rotation.x = Math.PI / 2;
  group.add(face);
  const rim = new THREE.Mesh(new THREE.TorusGeometry(0.205, 0.022, 8, 28), new THREE.MeshStandardMaterial({ color: 0x3b4044, metalness: 0.7, roughness: 0.4 }));
  rim.position.z = 0.026;
  group.add(rim);
  const needle = new THREE.Mesh(new THREE.BoxGeometry(0.018, 0.17, 0.008), new THREE.MeshStandardMaterial({ color: 0x15181a }));
  needle.geometry.translate(0, 0.075, 0);
  needle.position.z = 0.032;
  group.add(needle);
  return needle;
}
