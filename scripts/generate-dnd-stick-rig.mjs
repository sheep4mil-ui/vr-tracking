import fs from "node:fs";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { GLTFExporter } from "three/examples/jsm/exporters/GLTFExporter.js";

globalThis.self = globalThis;
globalThis.FileReader ??= class FileReader {
  result = null;
  onloadend = null;
  async readAsArrayBuffer(blob) {
    this.result = await blob.arrayBuffer();
    this.onloadend?.();
  }
  async readAsDataURL(blob) {
    const bytes = Buffer.from(await blob.arrayBuffer());
    this.result = `data:${blob.type};base64,${bytes.toString("base64")}`;
    this.onloadend?.();
  }
};

const sourcePath = new URL("../public/models/male_skeleton.glb", import.meta.url);
const outputPath = new URL("../public/models/dnd_grey_stick_rig.glb", import.meta.url);
const source = fs.readFileSync(sourcePath);
const arrayBuffer = source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength);
const gltf = await new Promise((resolve, reject) => {
  new GLTFLoader().parse(arrayBuffer, "", resolve, reject);
});

const scene = gltf.scene;
scene.name = "DND_Grey_Stick_Rig";
scene.updateMatrixWorld(true);

const originalMeshes = [];
const bones = [];
scene.traverse((node) => {
  if (node.isMesh) originalMeshes.push(node);
  if (node.isBone) bones.push(node);
});
for (const mesh of originalMeshes) mesh.parent?.remove(mesh);

const byName = new Map(bones.map((bone) => [bone.name, bone]));
const grey = new THREE.MeshStandardMaterial({
  name: "DND_Neutral_Grey",
  color: 0x8c939b,
  roughness: 0.82,
  metalness: 0.02,
});
const white = new THREE.MeshStandardMaterial({ name: "Eye_White", color: 0xf5f5f2, roughness: 0.7 });
const black = new THREE.MeshStandardMaterial({ name: "Pupil_and_Mouth", color: 0x111318, roughness: 0.8 });
const jointGeometry = new THREE.SphereGeometry(0.22, 14, 10);
const limbGeometry = new THREE.CylinderGeometry(0.16, 0.16, 1, 12);
const bodyGeometry = new THREE.SphereGeometry(1, 20, 14);

function addJoint(name, radius = 0.22) {
  const bone = byName.get(name);
  if (!bone) return;
  const joint = new THREE.Mesh(jointGeometry, grey);
  joint.name = `Shape_${name}`;
  joint.scale.setScalar(radius / 0.22);
  bone.add(joint);
}

function addSegment(startName, endName, radius = 0.16) {
  const start = byName.get(startName);
  const end = byName.get(endName);
  if (!start || !end) return;
  scene.updateMatrixWorld(true);
  const endWorld = end.getWorldPosition(new THREE.Vector3());
  const endLocal = start.worldToLocal(endWorld.clone());
  const length = endLocal.length();
  if (length < 0.001) return;
  const limb = new THREE.Mesh(limbGeometry, grey);
  limb.name = `Shape_${startName}_to_${endName}`;
  limb.position.copy(endLocal).multiplyScalar(0.5);
  limb.scale.set(radius / 0.16, length, radius / 0.16);
  limb.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), endLocal.clone().normalize());
  start.add(limb);
}

const segments = [
  ["hip_02", "abdomen_03", 0.52],
  ["abdomen_03", "chest_04", 0.64],
  ["chest_04", "neck_05", 0.5],
  ["neck_05", "head_06", 0.3],
  ["rCollar_017", "rShldr_018", 0.3],
  ["rShldr_018", "rForeArm_019", 0.34],
  ["rForeArm_019", "rHand_020", 0.28],
  ["lCollar_041", "lShldr_042", 0.3],
  ["lShldr_042", "lForeArm_043", 0.34],
  ["lForeArm_043", "lHand_044", 0.28],
  ["rThigh_083", "rShin_084", 0.43],
  ["rShin_084", "rFoot_085", 0.34],
  ["rFoot_085", "rToe_086", 0.3],
  ["lThigh_0100", "lShin_0101", 0.43],
  ["lShin_0101", "lFoot_0102", 0.34],
  ["lFoot_0102", "lToe_0103", 0.3],
];
for (const segment of segments) addSegment(...segment);

for (const name of [
  "hip_02", "abdomen_03", "chest_04", "neck_05",
  "rShldr_018", "rForeArm_019", "rHand_020",
  "lShldr_042", "lForeArm_043", "lHand_044",
  "rThigh_083", "rShin_084", "rFoot_085",
  "lThigh_0100", "lShin_0101", "lFoot_0102",
]) addJoint(name, 0.3);

function addBodyShape(boneName, name, scale, position = new THREE.Vector3(), material = grey) {
  const bone = byName.get(boneName);
  if (!bone) return;
  const mesh = new THREE.Mesh(bodyGeometry, material);
  mesh.name = name;
  mesh.position.copy(position);
  mesh.scale.copy(scale);
  bone.add(mesh);
  return mesh;
}

// Broad, overlapping forms make a neutral human-proportioned mannequin while
// leaving each piece rigidly attached to the proven tracking hierarchy.
addBodyShape("hip_02", "Body_Pelvis", new THREE.Vector3(1.28, 0.86, 0.62), new THREE.Vector3(0, 0.32, 0));
addBodyShape("abdomen_03", "Body_Abdomen", new THREE.Vector3(1.08, 1.05, 0.58), new THREE.Vector3(0, 0.55, 0));
addBodyShape("chest_04", "Body_Chest", new THREE.Vector3(1.52, 1.28, 0.7), new THREE.Vector3(0, 0.22, 0));
addBodyShape("head_06", "Body_Head", new THREE.Vector3(0.82, 1.05, 0.82), new THREE.Vector3(0, 0.52, 0));
addBodyShape("rHand_020", "Body_RightHand", new THREE.Vector3(0.38, 0.62, 0.23));
addBodyShape("lHand_044", "Body_LeftHand", new THREE.Vector3(0.38, 0.62, 0.23));
addBodyShape("rFoot_085", "Body_RightFoot", new THREE.Vector3(0.42, 0.34, 0.75), new THREE.Vector3(0, 0, 0.34));
addBodyShape("lFoot_0102", "Body_LeftFoot", new THREE.Vector3(0.42, 0.34, 0.75), new THREE.Vector3(0, 0, 0.34));

const head = byName.get("head_06");
if (head) {
  scene.updateMatrixWorld(true);
  const featureAtWorld = (name, worldPosition, scale, material) => {
    const mesh = new THREE.Mesh(bodyGeometry, material);
    mesh.name = name;
    mesh.position.copy(head.worldToLocal(worldPosition.clone()));
    mesh.scale.copy(scale);
    head.add(mesh);
    return mesh;
  };
  const rightEye = byName.get("rEye_00")?.getWorldPosition(new THREE.Vector3());
  const leftEye = byName.get("lEye_07")?.getWorldPosition(new THREE.Vector3());
  for (const [side, eyeWorld] of [["Right", rightEye], ["Left", leftEye]]) {
    if (!eyeWorld) continue;
    const eye = featureAtWorld(`Face_${side}Eye`, eyeWorld, new THREE.Vector3(0.22, 0.27, 0.14), white);
    const pupil = new THREE.Mesh(bodyGeometry, black);
    pupil.name = `Face_${side}Pupil`;
    pupil.position.set(0, 0, 0.92);
    pupil.scale.set(0.34, 0.34, 0.24);
    eye.add(pupil);
  }
  featureAtWorld("Face_Nose", new THREE.Vector3(0, 16.88, 0.72), new THREE.Vector3(0.17, 0.28, 0.24), grey);
  featureAtWorld("Face_Mouth", new THREE.Vector3(0, 16.52, 0.72), new THREE.Vector3(0.32, 0.065, 0.055), black);
}

// Keep the complete hierarchy encoded as a glTF skin, even though the visible
// stick geometry is rigidly parented to the same bones.
const anchorGeometry = new THREE.BufferGeometry();
anchorGeometry.setAttribute("position", new THREE.Float32BufferAttribute([
  0, 0, 0,
  0.001, 0, 0,
  0, 0.001, 0,
], 3));
anchorGeometry.setAttribute("skinIndex", new THREE.Uint16BufferAttribute([
  0, 0, 0, 0,
  0, 0, 0, 0,
  0, 0, 0, 0,
], 4));
anchorGeometry.setAttribute("skinWeight", new THREE.Float32BufferAttribute([
  1, 0, 0, 0,
  1, 0, 0, 0,
  1, 0, 0, 0,
], 4));
const anchor = new THREE.SkinnedMesh(
  anchorGeometry,
  new THREE.MeshBasicMaterial({ name: "Rig_Anchor", visible: false }),
);
anchor.name = "Rig_Anchor_Do_Not_Delete";
scene.add(anchor);
anchor.bind(new THREE.Skeleton(bones));

scene.updateMatrixWorld(true);
const result = await new Promise((resolve, reject) => {
  new GLTFExporter().parse(scene, resolve, reject, {
    binary: true,
    onlyVisible: false,
    trs: true,
  });
});
fs.writeFileSync(outputPath, Buffer.from(result));
console.log(`Created ${outputPath.pathname} with ${bones.length} bones.`);
