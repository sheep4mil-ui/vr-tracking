import fs from "node:fs";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { GLTFExporter } from "three/examples/jsm/exporters/GLTFExporter.js";

globalThis.self = globalThis;
globalThis.FileReader ??= class FileReader {
  result = null;
  onloadend = null;
  async readAsArrayBuffer(blob) { this.result = await blob.arrayBuffer(); this.onloadend?.(); }
  async readAsDataURL(blob) {
    this.result = `data:${blob.type};base64,${Buffer.from(await blob.arrayBuffer()).toString("base64")}`;
    this.onloadend?.();
  }
};

async function loadGlb(path) {
  const bytes = fs.readFileSync(path);
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  return await new Promise((resolve, reject) => new GLTFLoader().parse(buffer, "", resolve, reject));
}

const sourcePath = process.argv[2];
const outputPath = process.argv[3] ?? "public/models/dnd_low_poly_human_rigged.glb";
if (!sourcePath) throw new Error("Usage: node scripts/rig-low-poly-human.mjs <source.glb> [output.glb]");

const [sourceGltf, rigGltf] = await Promise.all([
  loadGlb(sourcePath),
  loadGlb("public/models/male_skeleton.glb"),
]);
const sourceScene = sourceGltf.scene;
const rigScene = rigGltf.scene;
sourceScene.updateMatrixWorld(true);
rigScene.updateMatrixWorld(true);

let sourceMesh;
sourceScene.traverse((node) => { if (!sourceMesh && node.isMesh) sourceMesh = node; });
if (!sourceMesh) throw new Error("The source GLB has no mesh.");

const oldMeshes = [];
const bones = [];
rigScene.traverse((node) => {
  if (node.isMesh) oldMeshes.push(node);
  if (node.isBone) bones.push(node);
});
const boneByName = new Map(bones.map((bone) => [bone.name, bone]));

// Capture the proven male-mesh skinning before removing its visible geometry.
// Bone proximity alone cannot tell where a shoulder or elbow surface should
// bend; nearest-surface weight transfer preserves those authored joint zones.
const referenceVertices = [];
for (const mesh of oldMeshes) {
  if (!mesh.isSkinnedMesh) continue;
  const meshPositions = mesh.geometry.getAttribute("position");
  const meshIndices = mesh.geometry.getAttribute("skinIndex");
  const meshWeights = mesh.geometry.getAttribute("skinWeight");
  if (!meshPositions || !meshIndices || !meshWeights) continue;
  for (let vertex = 0; vertex < meshPositions.count; vertex++) {
    const indices = [];
    const weights = [];
    for (let slot = 0; slot < 4; slot++) {
      const sourceIndex = meshIndices.getComponent(vertex, slot);
      const sourceBone = mesh.skeleton.bones[sourceIndex];
      indices.push(sourceBone ? bones.indexOf(boneByName.get(sourceBone.name)) : 0);
      weights.push(meshWeights.getComponent(vertex, slot));
    }
    referenceVertices.push({
      point: new THREE.Vector3().fromBufferAttribute(meshPositions, vertex).applyMatrix4(mesh.matrixWorld),
      indices,
      weights,
    });
  }
}
for (const mesh of oldMeshes) mesh.parent?.remove(mesh);

let geometry = sourceMesh.geometry.clone();
geometry.applyMatrix4(sourceMesh.matrixWorld);
geometry.computeBoundingBox();
const sourceBox = geometry.boundingBox;
const sourceSize = sourceBox.getSize(new THREE.Vector3());
const sourceCenter = sourceBox.getCenter(new THREE.Vector3());

const rigBounds = new THREE.Box3();
for (const bone of bones) rigBounds.expandByPoint(bone.getWorldPosition(new THREE.Vector3()));
const rigSize = rigBounds.getSize(new THREE.Vector3());
const targetHeight = rigSize.y;
const scale = targetHeight / Math.max(sourceSize.y, 0.001);
const normalize = new THREE.Matrix4().makeScale(scale, scale, scale);
normalize.setPosition(-sourceCenter.x * scale, rigBounds.min.y - sourceBox.min.y * scale, -sourceCenter.z * scale);
geometry.applyMatrix4(normalize);
// Detach shared indexed vertices so a low-poly triangle can move as one rigid
// face. Otherwise one corner can follow the torso while another follows a hand,
// creating the enormous spikes visible in the recording.
if (geometry.index) geometry = geometry.toNonIndexed();
geometry.computeVertexNormals();
geometry.computeBoundingBox();

const positions = geometry.getAttribute("position");
const skinIndices = new Uint16Array(positions.count * 4);
const skinWeights = new Float32Array(positions.count * 4);
const cellSize = 0.5;
const referenceGrid = new Map();
const cellKey = (x, y, z) => `${x},${y},${z}`;
for (const reference of referenceVertices) {
  const x = Math.floor(reference.point.x / cellSize);
  const y = Math.floor(reference.point.y / cellSize);
  const z = Math.floor(reference.point.z / cellSize);
  const key = cellKey(x, y, z);
  if (!referenceGrid.has(key)) referenceGrid.set(key, []);
  referenceGrid.get(key).push(reference);
}
for (let triangle = 0; triangle + 2 < positions.count; triangle += 3) {
  const point = new THREE.Vector3();
  for (let corner = 0; corner < 3; corner++) {
    point.add(new THREE.Vector3().fromBufferAttribute(positions, triangle + corner));
  }
  point.multiplyScalar(1 / 3);
  const cx = Math.floor(point.x / cellSize), cy = Math.floor(point.y / cellSize), cz = Math.floor(point.z / cellSize);
  let candidates = [];
  for (let radius = 0; radius <= 8 && candidates.length === 0; radius++) {
    for (let x = cx - radius; x <= cx + radius; x++) for (let y = cy - radius; y <= cy + radius; y++) {
      for (let z = cz - radius; z <= cz + radius; z++) {
        if (radius && Math.max(Math.abs(x - cx), Math.abs(y - cy), Math.abs(z - cz)) !== radius) continue;
        candidates.push(...(referenceGrid.get(cellKey(x, y, z)) ?? []));
      }
    }
  }
  let nearest = candidates[0];
  let nearestDistance = Infinity;
  for (const candidate of candidates) {
    const distance = point.distanceToSquared(candidate.point);
    if (distance < nearestDistance) { nearest = candidate; nearestDistance = distance; }
  }
  if (!nearest) throw new Error(`No reference skin weights found for triangle ${triangle / 3}.`);
  const total = nearest.weights.reduce((sum, weight) => sum + weight, 0) || 1;
  for (let corner = 0; corner < 3; corner++) {
    for (let slot = 0; slot < 4; slot++) {
      skinIndices[(triangle + corner) * 4 + slot] = nearest.indices[slot];
      skinWeights[(triangle + corner) * 4 + slot] = nearest.weights[slot] / total;
    }
  }
}
console.log(`Transferred skinning from ${referenceVertices.length} authored male-mesh vertices.`);
geometry.setAttribute("skinIndex", new THREE.Uint16BufferAttribute(skinIndices, 4));
geometry.setAttribute("skinWeight", new THREE.Float32BufferAttribute(skinWeights, 4));

const material = Array.isArray(sourceMesh.material)
  ? sourceMesh.material.map((item) => item.clone())
  : sourceMesh.material.clone();
const character = new THREE.SkinnedMesh(geometry, material);
character.name = "LowPolyHuman_Skinned";
character.castShadow = true;
character.receiveShadow = true;
rigScene.add(character);
character.bind(new THREE.Skeleton(bones));

function addAnchor(parentName, name, offset = new THREE.Vector3()) {
  const parent = boneByName.get(parentName);
  if (!parent) return;
  rigScene.updateMatrixWorld(true);
  const anchor = new THREE.Object3D();
  anchor.name = name;
  anchor.position.copy(parent.getWorldPosition(new THREE.Vector3())).add(offset);
  rigScene.add(anchor);
  rigScene.updateMatrixWorld(true);
  parent.attach(anchor);
  return anchor;
}
const socket = addAnchor("rHand_020", "RightHand_ItemSocket", new THREE.Vector3(0, -0.12, 0.28));
if (socket) { const grip = new THREE.Object3D(); grip.name = "RightHand_GripPoint"; socket.add(grip); }
addAnchor("rHand_020", "RightHand_Collider");
addAnchor("lHand_044", "LeftHand_Collider");

rigScene.name = "DND_LowPolyHuman_Rigged";
rigScene.updateMatrixWorld(true);
const result = await new Promise((resolve, reject) => new GLTFExporter().parse(rigScene, resolve, reject, {
  binary: true,
  onlyVisible: false,
  trs: true,
}));
fs.writeFileSync(outputPath, Buffer.from(result));
console.log(`Created ${outputPath}: ${positions.count} vertices, ${bones.length} bones.`);
