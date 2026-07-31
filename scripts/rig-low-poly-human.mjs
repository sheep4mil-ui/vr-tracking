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
for (const mesh of oldMeshes) mesh.parent?.remove(mesh);
const boneByName = new Map(bones.map((bone) => [bone.name, bone]));

const geometry = sourceMesh.geometry.clone();
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
geometry.computeVertexNormals();
geometry.computeBoundingBox();

const segments = [
  ["hip_02", "abdomen_03"], ["abdomen_03", "chest_04"], ["chest_04", "neck_05"], ["neck_05", "head_06"],
  ["rCollar_017", "rShldr_018"], ["rShldr_018", "rForeArm_019"], ["rForeArm_019", "rHand_020"],
  ["lCollar_041", "lShldr_042"], ["lShldr_042", "lForeArm_043"], ["lForeArm_043", "lHand_044"],
  ["rThigh_083", "rShin_084"], ["rShin_084", "rFoot_085"], ["rFoot_085", "rToe_086"],
  ["lThigh_0100", "lShin_0101"], ["lShin_0101", "lFoot_0102"], ["lFoot_0102", "lToe_0103"],
  ["lowerJaw_09", "head_06"],
].map(([startName, endName]) => {
  const startBone = boneByName.get(startName), endBone = boneByName.get(endName);
  return {
    boneIndex: bones.indexOf(startBone),
    start: startBone.getWorldPosition(new THREE.Vector3()),
    end: endBone.getWorldPosition(new THREE.Vector3()),
  };
});

function distanceToSegment(point, start, end) {
  const line = end.clone().sub(start);
  const lengthSq = line.lengthSq();
  const amount = lengthSq ? THREE.MathUtils.clamp(point.clone().sub(start).dot(line) / lengthSq, 0, 1) : 0;
  return point.distanceTo(start.clone().addScaledVector(line, amount));
}

const positions = geometry.getAttribute("position");
const skinIndices = new Uint16Array(positions.count * 4);
const skinWeights = new Float32Array(positions.count * 4);
for (let vertex = 0; vertex < positions.count; vertex++) {
  const point = new THREE.Vector3().fromBufferAttribute(positions, vertex);
  const nearest = segments
    .map((segment) => ({ ...segment, distance: distanceToSegment(point, segment.start, segment.end) }))
    .sort((a, b) => a.distance - b.distance)
    .slice(0, 2);
  const influences = nearest.map((item) => 1 / Math.max(item.distance, 0.035));
  const total = influences[0] + influences[1];
  skinIndices[vertex * 4] = nearest[0].boneIndex;
  skinIndices[vertex * 4 + 1] = nearest[1].boneIndex;
  skinWeights[vertex * 4] = influences[0] / total;
  skinWeights[vertex * 4 + 1] = influences[1] / total;
}
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
