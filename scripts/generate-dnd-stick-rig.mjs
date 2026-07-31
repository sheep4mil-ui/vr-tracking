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
const lipGrey = new THREE.MeshStandardMaterial({ name: "Mouth_Lips", color: 0x666c73, roughness: 0.88 });
const jointGeometry = new THREE.SphereGeometry(0.22, 14, 10);
const limbGeometry = new THREE.CylinderGeometry(0.16, 0.16, 1, 12);
const bodyGeometry = new THREE.SphereGeometry(1, 20, 14);

function addJoint(name, radius = 0.22) {
  const bone = byName.get(name);
  if (!bone) return;
  scene.updateMatrixWorld(true);
  const worldPosition = bone.getWorldPosition(new THREE.Vector3());
  const joint = new THREE.Mesh(jointGeometry, grey);
  joint.name = `Shape_${name}`;
  joint.position.copy(worldPosition);
  joint.scale.setScalar(radius / 0.22);
  scene.add(joint);
  scene.updateMatrixWorld(true);
  bone.attach(joint);
}

function addSegment(startName, endName, radius = 0.16) {
  const start = byName.get(startName);
  const end = byName.get(endName);
  if (!start || !end) return;
  scene.updateMatrixWorld(true);
  const startWorld = start.getWorldPosition(new THREE.Vector3());
  const endWorld = end.getWorldPosition(new THREE.Vector3());
  const direction = endWorld.clone().sub(startWorld);
  const length = direction.length();
  if (length < 0.001) return;
  const limb = new THREE.Mesh(limbGeometry, grey);
  limb.name = `Shape_${startName}_to_${endName}`;
  limb.position.copy(startWorld).addScaledVector(direction, 0.5);
  limb.scale.set(radius / 0.16, length, radius / 0.16);
  limb.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction.normalize());
  scene.add(limb);
  scene.updateMatrixWorld(true);
  start.attach(limb);
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

// Build visible articulated fingers directly from the proven finger chains.
for (const bone of bones) {
  if (!/^[rl](Thumb|Index|Mid|Ring|Pinky)[123]_/i.test(bone.name)) continue;
  const child = bone.children.find((node) => node.isBone && /^[rl](Thumb|Index|Mid|Ring|Pinky)[123]_/i.test(node.name));
  if (!child) continue;
  addSegment(bone.name, child.name, /Thumb/i.test(bone.name) ? 0.105 : 0.085);
  addJoint(bone.name, /Thumb/i.test(bone.name) ? 0.105 : 0.085);
}

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
  scene.updateMatrixWorld(true);
  const mesh = new THREE.Mesh(bodyGeometry, material);
  mesh.name = name;
  mesh.position.copy(bone.getWorldPosition(new THREE.Vector3())).add(position);
  mesh.scale.copy(scale);
  scene.add(mesh);
  scene.updateMatrixWorld(true);
  bone.attach(mesh);
  return mesh;
}

// Broad, overlapping forms make a neutral human-proportioned mannequin while
// leaving each piece rigidly attached to the proven tracking hierarchy.
addBodyShape("hip_02", "Body_Pelvis", new THREE.Vector3(1.3, 0.88, 0.82), new THREE.Vector3(0, 0.3, 0));
addBodyShape("abdomen_03", "Body_Waist", new THREE.Vector3(1.02, 1.08, 0.72), new THREE.Vector3(0, 0.5, 0));
addBodyShape("chest_04", "Body_Ribcage", new THREE.Vector3(1.62, 1.42, 0.94), new THREE.Vector3(0, 0.18, 0));
addBodyShape("chest_04", "Body_RightPectoral", new THREE.Vector3(0.78, 0.48, 0.32), new THREE.Vector3(-0.62, 0.48, 0.78));
addBodyShape("chest_04", "Body_LeftPectoral", new THREE.Vector3(0.78, 0.48, 0.32), new THREE.Vector3(0.62, 0.48, 0.78));
addBodyShape("rShldr_018", "Body_RightDeltoid", new THREE.Vector3(0.58, 0.62, 0.58));
addBodyShape("lShldr_042", "Body_LeftDeltoid", new THREE.Vector3(0.58, 0.62, 0.58));
addBodyShape("abdomen_03", "Body_UpperCore", new THREE.Vector3(0.62, 0.34, 0.25), new THREE.Vector3(0, 0.55, 0.66));
addBodyShape("abdomen_03", "Body_MiddleCore", new THREE.Vector3(0.57, 0.3, 0.24), new THREE.Vector3(0, 0.08, 0.64));
addBodyShape("hip_02", "Body_LowerCore", new THREE.Vector3(0.6, 0.3, 0.23), new THREE.Vector3(0, 0.76, 0.66));
addBodyShape("head_06", "Body_Head", new THREE.Vector3(0.82, 1.05, 0.88), new THREE.Vector3(0, 0.52, 0));
addBodyShape("rHand_020", "Body_RightPalm", new THREE.Vector3(0.4, 0.58, 0.28));
addBodyShape("lHand_044", "Body_LeftPalm", new THREE.Vector3(0.4, 0.58, 0.28));
addBodyShape("rFoot_085", "Body_RightFoot", new THREE.Vector3(0.46, 0.36, 0.82), new THREE.Vector3(0, 0, 0.38));
addBodyShape("lFoot_0102", "Body_LeftFoot", new THREE.Vector3(0.46, 0.36, 0.82), new THREE.Vector3(0, 0, 0.38));

function addAnchor(parentName, name, worldOffset = new THREE.Vector3()) {
  const parent = byName.get(parentName);
  if (!parent) return;
  scene.updateMatrixWorld(true);
  const anchor = new THREE.Object3D();
  anchor.name = name;
  anchor.position.copy(parent.getWorldPosition(new THREE.Vector3())).add(worldOffset);
  scene.add(anchor);
  scene.updateMatrixWorld(true);
  parent.attach(anchor);
  return anchor;
}

const itemSocket = addAnchor("rHand_020", "RightHand_ItemSocket", new THREE.Vector3(0, -0.12, 0.28));
if (itemSocket) {
  const grip = new THREE.Object3D();
  grip.name = "RightHand_GripPoint";
  itemSocket.add(grip);
}
addAnchor("rHand_020", "RightHand_Collider");
addAnchor("lHand_044", "LeftHand_Collider");

const head = byName.get("head_06");
if (head) {
  scene.updateMatrixWorld(true);
  const featureAtWorld = (name, worldPosition, scale, material) => {
    const mesh = new THREE.Mesh(bodyGeometry, material);
    mesh.name = name;
    mesh.position.copy(worldPosition);
    mesh.scale.copy(scale);
    scene.add(mesh);
    scene.updateMatrixWorld(true);
    head.attach(mesh);
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
  featureAtWorld("Face_Nose", new THREE.Vector3(0, 16.88, 0.78), new THREE.Vector3(0.18, 0.3, 0.28), grey);
  featureAtWorld("Face_MouthInterior", new THREE.Vector3(0, 16.53, 0.805), new THREE.Vector3(0.36, 0.16, 0.06), black);
  featureAtWorld("Face_UpperLip", new THREE.Vector3(0, 16.59, 0.865), new THREE.Vector3(0.36, 0.07, 0.055), lipGrey);
  const mouth = featureAtWorld("Face_LowerLip", new THREE.Vector3(0, 16.48, 0.865), new THREE.Vector3(0.34, 0.075, 0.055), lipGrey);
  const jaw = byName.get("lowerJaw_09");
  if (jaw && mouth) {
    scene.updateMatrixWorld(true);
    jaw.attach(mouth);
  }
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
