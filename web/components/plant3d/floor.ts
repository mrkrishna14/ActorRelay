// The working production floor around the two live units. All of it is static scenery: only those two units read plant state.
import * as THREE from "three";

const stainless = () => new THREE.MeshStandardMaterial({ color: 0xc4c9cd, metalness: 0.9, roughness: 0.38 });
const paint = (color: number) => new THREE.MeshStandardMaterial({ color, metalness: 0.3, roughness: 0.52 });

function solid(root: THREE.Object3D, geometry: THREE.BufferGeometry, material: THREE.Material, x: number, y: number, z: number) {
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.set(x, y, z);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  root.add(mesh);
  return mesh;
}

const block = (root: THREE.Object3D, w: number, h: number, d: number, material: THREE.Material, x: number, y: number, z: number) => solid(root, new THREE.BoxGeometry(w, h, d), material, x, y, z);

function run(root: THREE.Object3D, points: [number, number, number][], radius: number, material: THREE.Material) {
  for (let i = 1; i < points.length; i += 1) {
    const [ax = 0, ay = 0, az = 0] = points[i - 1] ?? [];
    const [bx = 0, by = 0, bz = 0] = points[i] ?? [];
    const a = new THREE.Vector3(ax, ay, az);
    const b = new THREE.Vector3(bx, by, bz);
    const pipe = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, a.distanceTo(b), 12), material);
    pipe.position.copy(a).add(b).multiplyScalar(0.5);
    pipe.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize());
    pipe.castShadow = true;
    root.add(pipe);
    const elbow = new THREE.Mesh(new THREE.SphereGeometry(radius * 1.15, 12, 10), material);
    elbow.position.copy(b);
    root.add(elbow);
  }
}

function tank(root: THREE.Object3D, x: number, z: number, radius: number, height: number, skin: THREE.Material, leg: THREE.Material, blue: THREE.Material) {
  const base = 0.9;
  solid(root, new THREE.CylinderGeometry(radius, radius, height, 40), skin, x, base + height / 2, z);
  const top = solid(root, new THREE.SphereGeometry(radius, 40, 14, 0, Math.PI * 2, 0, Math.PI / 2), skin, x, base + height, z);
  top.scale.y = 0.3;
  const bottom = solid(root, new THREE.SphereGeometry(radius, 40, 14, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2), skin, x, base, z);
  bottom.scale.y = 0.24;
  for (let i = 0; i < 4; i += 1) {
    const angle = (i / 4) * Math.PI * 2 + 0.78;
    solid(root, new THREE.CylinderGeometry(0.08, 0.1, base, 10), leg, x + Math.cos(angle) * radius * 0.88, base / 2, z + Math.sin(angle) * radius * 0.88);
  }
  for (const y of [base + height * 0.33, base + height * 0.66]) {
    const band = solid(root, new THREE.TorusGeometry(radius + 0.01, 0.025, 8, 48), leg, x, y, z);
    band.rotation.x = Math.PI / 2;
  }
  solid(root, new THREE.CylinderGeometry(0.2, 0.24, 0.5, 18), blue, x, base + height + radius * 0.3 + 0.28, z);
  solid(root, new THREE.CylinderGeometry(0.34, 0.34, 0.1, 18), leg, x + radius * 0.5, base + height + radius * 0.22, z + 0.2);
}

function pumpSkid(root: THREE.Object3D, x: number, z: number, blue: THREE.Material, dark: THREE.Material, steel: THREE.Material) {
  block(root, 1.9, 0.14, 0.8, dark, x, 0.12, z);
  const volute = solid(root, new THREE.CylinderGeometry(0.32, 0.32, 0.26, 22), blue, x + 0.55, 0.52, z);
  volute.rotation.x = Math.PI / 2;
  const motor = solid(root, new THREE.CylinderGeometry(0.24, 0.24, 0.86, 18), steel, x - 0.3, 0.46, z);
  motor.rotation.z = Math.PI / 2;
  block(root, 0.24, 0.16, 0.18, dark, x - 0.3, 0.76, z);
  run(root, [[x + 0.55, 0.85, z], [x + 0.55, 2.6, z], [x + 0.55, 2.6, z - 2.4], [x + 0.55, 6.4, z - 2.4]], 0.07, steel);
}

export function addFactoryFloor(scene: THREE.Scene) {
  const root = new THREE.Group();
  scene.add(root);
  const skin = stainless();
  const steel = paint(0x8b9499);
  const dark = paint(0x46525c);
  const blue = paint(0x2d5f8b);
  const green = paint(0x3f7a5a);
  const orange = paint(0xc2682a);
  const grey = paint(0xaab1b6);
  const yellow = paint(0xd6a51c);
  const belt = new THREE.MeshStandardMaterial({ color: 0x25292c, roughness: 0.85 });
  const carton = new THREE.MeshStandardMaterial({ color: 0xb08d62, roughness: 0.85 });

  // Process row along the back of the hall.
  for (let i = 0; i < 8; i += 1) tank(root, -24 + i * 10.6, -19, i % 3 === 2 ? 1.5 : 1.9, i % 2 ? 4.6 : 5.6, skin, steel, blue);
  run(root, [[-30, 7.7, -16.4], [54, 7.7, -16.4]], 0.11, skin);
  for (let i = 0; i < 8; i += 1) {
    const x = -24 + i * 10.6;
    run(root, [[x, 7.7, -16.4], [x, 7.7, -18.2], [x, 6.8, -18.6]], 0.07, skin);
  }

  // Service mezzanine above the process row.
  block(root, 88, 0.12, 2.4, dark, 13, 7.1, -14.6);
  for (let x = -30; x <= 56; x += 8) {
    block(root, 0.16, 7.1, 0.16, dark, x, 3.55, -13.5);
    block(root, 0.05, 1.05, 0.05, yellow, x, 7.7, -13.45);
  }
  block(root, 88, 0.05, 0.05, yellow, 13, 8.2, -13.45);
  block(root, 88, 0.05, 0.05, yellow, 13, 7.7, -13.45);

  // Pump bank feeding the overhead lines.
  for (let i = 0; i < 9; i += 1) pumpSkid(root, -29 + i * 3.1, 8.2 + (i % 2) * 0.1, i % 3 === 0 ? green : blue, dark, steel);

  // Heat exchangers on saddles, in the aisle between units.
  for (let i = 0; i < 3; i += 1) {
    const z = -9.6 + i * 1.8;
    const shell = solid(root, new THREE.CylinderGeometry(0.46, 0.46, 5, 24), grey, 13.2, 1.3, z);
    shell.rotation.z = Math.PI / 2;
    [-2.5, 2.5].forEach((dx) => {
      const head = solid(root, new THREE.SphereGeometry(0.46, 18, 12), grey, 13.2 + dx, 1.3, z);
      head.scale.x = 0.45;
      block(root, 0.2, 0.86, 0.9, dark, 13.2 + dx * 0.68, 0.43, z);
    });
  }

  // Boiler house at the left end.
  const boiler = solid(root, new THREE.CylinderGeometry(1.5, 1.5, 6.6, 36), orange, -26.8, 2.1, -6.6);
  boiler.rotation.x = Math.PI / 2;
  block(root, 3.8, 0.55, 7.4, dark, -26.8, 0.28, -6.6);
  block(root, 1.5, 1.8, 1.0, grey, -26.8, 1.8, -2.7);
  run(root, [[-26.8, 3.6, -9], [-26.8, 12.6, -9]], 0.42, steel);
  run(root, [[-26.8, 3.6, -5.6], [-26.8, 8.6, -5.6], [-13, 8.6, -4.2]], 0.2, grey);

  // Air compressors, receivers and a chiller at the right end.
  for (let i = 0; i < 2; i += 1) {
    block(root, 2.5, 1.7, 1.3, blue, 47 + i * 3.4, 0.85, -7.5);
    const receiver = solid(root, new THREE.CylinderGeometry(0.62, 0.62, 2.8, 22), grey, 47 + i * 3.4, 1.5, -5.2);
    receiver.castShadow = true;
  }
  block(root, 5.6, 2.2, 2, grey, 49, 1.1, -11);
  for (let i = 0; i < 4; i += 1) solid(root, new THREE.CylinderGeometry(0.42, 0.42, 0.1, 22), dark, 47 + i * 1.3, 2.26, -11);

  // Filling line: conveyor from the filler through labelling and packing to the palletizer.
  const lineZ = 15.8;
  const lineFrom = -13;
  const lineTo = 34;
  block(root, lineTo - lineFrom, 0.1, 0.9, belt, (lineFrom + lineTo) / 2, 1.0, lineZ);
  [-0.5, 0.5].forEach((dz) => block(root, lineTo - lineFrom, 0.14, 0.05, steel, (lineFrom + lineTo) / 2, 1.1, lineZ + dz));
  for (let x = lineFrom + 1; x < lineTo; x += 3) {
    block(root, 0.07, 0.95, 0.07, steel, x, 0.48, lineZ - 0.42);
    block(root, 0.07, 0.95, 0.07, steel, x, 0.48, lineZ + 0.42);
  }
  const bottles = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.09, 0.09, 0.34, 10), new THREE.MeshStandardMaterial({ color: 0xdfe6ea, roughness: 0.25 }), 110);
  const place = new THREE.Matrix4();
  for (let i = 0; i < 110; i += 1) bottles.setMatrixAt(i, place.makeTranslation(lineFrom + 7 + i * 0.3, 1.22, lineZ));
  bottles.castShadow = true;
  root.add(bottles);
  [
    [lineFrom + 2, 3.2, 2.6, 2.4, grey],
    [lineFrom + 18, 2.4, 2.1, 2.2, blue],
    [lineFrom + 30, 3.4, 2.5, 2.8, grey],
  ].forEach(([x, w, h, d, material]) => {
    block(root, w as number, h as number, d as number, material as THREE.Material, x as number, (h as number) / 2, lineZ);
    block(root, (w as number) * 0.7, 0.8, 0.04, new THREE.MeshStandardMaterial({ color: 0xdfeaf2, roughness: 0.2, transparent: true, opacity: 0.7 }), x as number, (h as number) * 0.62, lineZ + (d as number) / 2 + 0.03);
  });

  // Palletizer frame with finished stacks.
  [[lineTo + 1, lineZ - 1.6], [lineTo + 4.6, lineZ - 1.6], [lineTo + 1, lineZ + 1.6], [lineTo + 4.6, lineZ + 1.6]].forEach(([x = 0, z = 0]) => block(root, 0.16, 4.2, 0.16, yellow, x, 2.1, z));
  block(root, 3.8, 0.16, 3.4, yellow, lineTo + 2.8, 4.2, lineZ);
  const cases = new THREE.InstancedMesh(new THREE.BoxGeometry(0.56, 0.36, 0.42), carton, 96);
  let index = 0;
  [[lineTo + 2.2, lineZ - 0.5], [lineTo + 8, lineZ - 0.5], [lineTo + 8, lineZ + 2.2]].forEach(([x = 0, z = 0]) => {
    block(root, 1.9, 0.14, 1.5, new THREE.MeshStandardMaterial({ color: 0x9a7a55, roughness: 0.85 }), x + 0.55, 0.08, z + 0.4);
    for (let level = 0; level < 4; level += 1) {
      for (let a = 0; a < 3; a += 1) {
        for (let b = 0; b < 3 && index < 96; b += 1) {
          cases.setMatrixAt(index, place.makeTranslation(x + a * 0.58, 0.34 + level * 0.37, z + b * 0.44));
          index += 1;
        }
      }
    }
  });
  cases.count = index;
  cases.castShadow = true;
  root.add(cases);

  // Pallet racking along the far right wall.
  for (let bay = 0; bay < 5; bay += 1) {
    const z = -2 + bay * 3;
    [-0.8, 0.8].forEach((dx) => {
      block(root, 0.1, 8, 0.1, blue, 55.4 + dx, 4, z);
      block(root, 0.1, 8, 0.1, blue, 55.4 + dx, 4, z + 2.7);
    });
    [2.6, 5.2, 7.8].forEach((y) => {
      block(root, 1.7, 0.12, 2.9, orange, 55.4, y, z + 1.35);
      block(root, 1.2, 1.1, 2.2, carton, 55.4, y + 0.62, z + 1.35);
    });
  }

  // Parallel service pipes high on the rack, in their usual colours.
  [[0.08, skin, 9.6], [0.1, green, 9.9], [0.07, blue, 10.2], [0.09, grey, 10.5]].forEach(([radius, material, y], rowIndex) => {
    run(root, [[-30, y as number, -6.4 - rowIndex * 0.3], [54, y as number, -6.4 - rowIndex * 0.3]], radius as number, material as THREE.Material);
  });
  for (let x = -30; x <= 54; x += 8) {
    block(root, 0.1, 10.9, 0.1, dark, x, 5.45, -6.1);
    block(root, 0.1, 10.9, 0.1, dark, x, 5.45, -7.7);
    block(root, 0.1, 0.1, 1.7, dark, x, 9.4, -6.9);
  }

  // Glazed control room on the left wall.
  block(root, 8, 3, 5, grey, -27.5, 8.6, 16);
  block(root, 7.4, 1.5, 0.05, new THREE.MeshStandardMaterial({ color: 0xcfe2ee, roughness: 0.15, transparent: true, opacity: 0.75 }), -27.5, 9, 18.53);
  block(root, 8, 0.2, 5, dark, -27.5, 7, 16);
  [[-31, 13.6], [-24, 13.6], [-31, 18.4], [-24, 18.4]].forEach(([x = 0, z = 0]) => block(root, 0.18, 7, 0.18, dark, x, 3.5, z));

  return root;
}
