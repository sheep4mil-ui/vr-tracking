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
geometry.computeVertexNormals();
geometry.computeBoundingBox();

const segments = [
  ["hip_02", "abdomen_03"], ["abdomen_03", "chest_04"], ["chest_04", "neck_05"], ["neck_05", "head_06"],
  ["rCollar_017", "rShldr_018"], ["rShldr_018", "rForeArm_019"], ["rForeArm_019", "rHand_020"],
  ["lCollar_041", "lShldr_042"], ["lShldr_042", "lForeArm_043"], ["lForeArm_043", "lHand_044"],
  ["rThigh_083", "rShin_084"], ["rShin_084", "rFoot_085"], ["rFoot_085", "rToe_086"],
  ["lThigh_0100", "lShin_0101"], ["lShin_0101", "lFoot_0102"], ["lFoot_0102", "lToe_0103"],
].map(([startName, endName]) => {
  const startBone = boneByName.get(startName), endBone = boneByName.get(endName);
  return {
    isArm: /^[rl](Collar|Shldr|ForeArm|Hand)_/.test(startName),
    startIndex: bones.indexOf(startBone),
    endIndex: bones.indexOf(endBone),
    start: startBone.getWorldPosition(new THREE.Vector3()),
    end: endBone.getWorldPosition(new THREE.Vector3()),
  };
});

function segmentProjection(point, segment) {
  const line = segment.end.clone().sub(segment.start);
  const lengthSq = line.lengthSq();
  const amount = lengthSq ? THREE.MathUtils.clamp(point.clone().sub(segment.start).dot(line) / lengthSq, 0, 1) : 0;
  const nearest = segment.start.clone().addScaledVector(line, amount);
  return { amount, distance: point.distanceToSquared(nearest) };
}

const positions = geometry.getAttribute("position");
const skinIndices = new Uint16Array(positions.count * 4);
const skinWeights = new Float32Array(positions.count * 4);
const normalizedSize = geometry.boundingBox.getSize(new THREE.Vector3());
// Only the far-outer silhouette is unambiguously hand/finger geometry in the
// A-pose. A wider 20% cutoff also captured the broad hips and pulled them up
// with the hands; 30% stays outside the torso/hip envelope.
const armXThreshold = normalizedSize.x * 0.3;
const armYThreshold = geometry.boundingBox.min.y + normalizedSize.y * 0.32;
for (let vertex = 0; vertex < positions.count; vertex++) {
  const point = new THREE.Vector3().fromBufferAttribute(positions, vertex);
  let candidates = segments;
  // The source is an A-pose while the donor skeleton is wider. Fingertips hang
  // far below the donor hand and can otherwise look closer to the hip or leg.
  // Once a vertex is in the outer upper-body silhouette, keep it on the arm on
  // that same side all the way through the hand/fingers.
  if (Math.abs(point.x) > armXThreshold && point.y > armYThreshold) {
    const side = Math.sign(point.x);
    candidates = segments.filter((segment) => segment.isArm && Math.sign(segment.start.x) === side);
  }
  const nearest = candidates
    .map((segment) => ({ segment, ...segmentProjection(point, segment) }))
    .sort((a, b) => a.distance - b.distance)[0];
  // Smooth only across this single joint. No vertex can mix a torso/arm,
  // left/right, or arm/leg chain as the earlier proximity blend allowed.
  // Arm joints need a narrow deformation zone. Blending the hand throughout
  // the forearm lets noisy wrist rotation shear the entire limb into spikes.
  // Keep the established leg behavior unchanged.
  const blend = nearest.segment.isArm
    ? THREE.MathUtils.smoothstep(nearest.amount, 0.78, 1.0)
    : THREE.MathUtils.smoothstep(nearest.amount, 0.15, 0.85);
  skinIndices[vertex * 4] = nearest.segment.startIndex;
  skinIndices[vertex * 4 + 1] = nearest.segment.endIndex;
  skinWeights[vertex * 4] = 1 - blend;
  skinWeights[vertex * 4 + 1] = blend;
}
console.log(`Applied continuous single-chain skinning across ${segments.length} anatomical segments.`);
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
