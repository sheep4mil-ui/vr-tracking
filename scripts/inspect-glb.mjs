import fs from "node:fs";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

globalThis.self = globalThis;
const path = process.argv[2];
const bytes = fs.readFileSync(path);
const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
const gltf = await new Promise((resolve, reject) => new GLTFLoader().parse(buffer, "", resolve, reject));
const bones = [];
const bonePositions = {};
const meshes = [];
const skins = [];
gltf.scene.updateMatrixWorld(true);
gltf.scene.traverse((node) => {
  if (node.isBone) {
    bones.push(node.name);
    if (/^(hip|chest|neck|head|[rl](Collar|Shldr|ForeArm|Hand|Thigh|Shin|Foot))_/.test(node.name)) {
      bonePositions[node.name] = node.getWorldPosition(new THREE.Vector3()).toArray();
    }
  }
  if (node.isMesh) meshes.push({
    name: node.name,
    skinned: Boolean(node.isSkinnedMesh),
    vertices: node.geometry.attributes.position?.count,
    morphs: Object.keys(node.morphTargetDictionary ?? {}),
  });
  if (node.isSkinnedMesh) skins.push({ name: node.name, bones: node.skeleton.bones.map((bone) => bone.name) });
});
const box = new THREE.Box3().setFromObject(gltf.scene);
console.log(JSON.stringify({
  bytes: bytes.length,
  bones: bones.length,
  boneNames: bones,
  bonePositions,
  meshes,
  skins,
  size: box.getSize(new THREE.Vector3()).toArray(),
}, null, 2));
