"use client";

import { useEffect, useRef, useState } from "react";
import { FaceLandmarker, FilesetResolver, HandLandmarker, PoseLandmarker, type NormalizedLandmark } from "@mediapipe/tasks-vision";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import Peer, { type DataConnection } from "peerjs";

type TrackerState = "idle" | "loading" | "ready" | "tracking" | "error";
type DeviceMode = "phone" | "computer";
type HandPose = "camera" | "open" | "fist" | "point" | "pinch" | "thumb";
type JoyDevice = {
  device: HIDDevice;
  side: "l" | "r";
  orientation: THREE.Quaternion;
  gyroBias: THREE.Vector3;
  lastTime: number;
  packet: number;
};
type BoneDriver = {
  bone: THREE.Bone;
  semantic: string;
  restDirection: THREE.Vector3;
  restReference: THREE.Vector3;
  restLocalQuaternion: THREE.Quaternion;
  restWorldQuaternion: THREE.Quaternion;
};

const POSE_CONNECTIONS = [
  [11, 12], [11, 13], [13, 15], [12, 14], [14, 16],
  [11, 23], [12, 24], [23, 24], [23, 25], [25, 27],
  [24, 26], [26, 28], [27, 29], [29, 31], [28, 30], [30, 32],
];

function jointMaterial(color: number) {
  return new THREE.MeshStandardMaterial({ color, roughness: 0.52, metalness: 0.08 });
}

export default function MotionStudio() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const landmarkerRef = useRef<PoseLandmarker | null>(null);
  const handLandmarkerRef = useRef<HandLandmarker | null>(null);
  const faceLandmarkerRef = useRef<FaceLandmarker | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const frameRef = useRef<number | null>(null);
  const jointsRef = useRef<THREE.Mesh[]>([]);
  const bonesRef = useRef<THREE.Line[]>([]);
  const modelRef = useRef<THREE.Object3D | null>(null);
  const rigRef = useRef<Map<string, BoneDriver>>(new Map());
  const sceneRef = useRef<THREE.Scene | null>(null);
  const [state, setState] = useState<TrackerState>("idle");
  const [message, setMessage] = useState("Camera is off");
  const [fps, setFps] = useState(0);
  const [modelName, setModelName] = useState("Live mannequin");
  const timingRef = useRef({ last: performance.now(), frames: 0 });
  const peerRef = useRef<Peer | null>(null);
  const connectionsRef = useRef<DataConnection[]>([]);
  const lastBroadcastRef = useRef(0);
  const [mode, setMode] = useState<DeviceMode>("phone");
  const [pairCode, setPairCode] = useState("");
  const [connectionState, setConnectionState] = useState("Not connected");
  const joyDevicesRef = useRef<JoyDevice[]>([]);
  const activeJoyPoseRef = useRef<Record<"l" | "r", HandPose>>({ l: "camera", r: "camera" });
  const [joyStatus, setJoyStatus] = useState("Joy-Cons not connected");
  const [swapSides, setSwapSides] = useState(true);
  const swapSidesRef = useRef(true);
  const [swapArms, setSwapArms] = useState(true);
  const swapArmsRef = useRef(true);
  const [upperBodyOnly, setUpperBodyOnly] = useState(false);
  const upperBodyOnlyRef = useRef(false);
  const [handLatchEnabled, setHandLatchEnabled] = useState(true);
  const handLatchEnabledRef = useRef(true);
  const handsLatchedRef = useRef(false);
  const smoothedPointsRef = useRef<THREE.Vector3[]>([]);
  const expressionMeshesRef = useRef<THREE.Mesh[]>([]);
  const jawRef = useRef<{ bone: THREE.Bone; rest: THREE.Quaternion } | null>(null);
  const latestDetailRef = useRef<{ hands: number[][][]; handedness: string[]; face: Record<string, number> }>({ hands: [], handedness: [], face: {} });
  const overlayDetailRef = useRef<{ hands: NormalizedLandmark[][]; face: NormalizedLandmark[] }>({ hands: [], face: [] });

  useEffect(() => {
    const mount = viewportRef.current;
    if (!mount) return;
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x080d18);
    scene.fog = new THREE.Fog(0x080d18, 7, 16);
    sceneRef.current = scene;
    const camera = new THREE.PerspectiveCamera(38, mount.clientWidth / mount.clientHeight, 0.1, 100);
    camera.position.set(0, 0.15, 6.5);
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    renderer.setSize(mount.clientWidth, mount.clientHeight);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    mount.appendChild(renderer.domElement);

    scene.add(new THREE.HemisphereLight(0xbcd7ff, 0x172033, 2.4));
    const key = new THREE.DirectionalLight(0xffffff, 3.2);
    key.position.set(3, 5, 4);
    scene.add(key);
    const floor = new THREE.Mesh(
      new THREE.CircleGeometry(3.2, 64),
      new THREE.MeshStandardMaterial({ color: 0x111a2a, roughness: 0.9 })
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -2.42;
    scene.add(floor);
    const grid = new THREE.GridHelper(6, 12, 0x2a3953, 0x172236);
    grid.position.y = -2.4;
    scene.add(grid);

    const material = jointMaterial(0x72f2c6);
    jointsRef.current = Array.from({ length: 33 }, () => {
      const joint = new THREE.Mesh(new THREE.SphereGeometry(0.055, 14, 10), material);
      scene.add(joint);
      return joint;
    });
    bonesRef.current = POSE_CONNECTIONS.map(() => {
      const geometry = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]);
      const line = new THREE.Line(geometry, new THREE.LineBasicMaterial({ color: 0xa6c8ff, transparent: true, opacity: 0.85 }));
      scene.add(line);
      return line;
    });
    new GLTFLoader().load("./models/male_skeleton.glb", (gltf) => {
      installModel(gltf.scene, "male_skeleton.glb");
    });

    const resize = () => {
      if (!mount) return;
      camera.aspect = mount.clientWidth / mount.clientHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(mount.clientWidth, mount.clientHeight);
    };
    const animate = () => {
      renderer.render(scene, camera);
      frameRef.current = requestAnimationFrame(animate);
    };
    window.addEventListener("resize", resize);
    animate();
    return () => {
      window.removeEventListener("resize", resize);
      if (frameRef.current) cancelAnimationFrame(frameRef.current);
      renderer.dispose();
      mount.removeChild(renderer.domElement);
      peerRef.current?.destroy();
    };
  }, []);

  function createPairCode() {
    return Math.random().toString(36).slice(2, 8).toUpperCase();
  }

  function beginBroadcastSession() {
    peerRef.current?.destroy();
    connectionsRef.current = [];
    const code = createPairCode();
    setPairCode(code);
    setConnectionState("Opening room…");
    const peer = new Peer(`motion-mirror-${code.toLowerCase()}`);
    peerRef.current = peer;
    peer.on("open", () => setConnectionState("Waiting for computer"));
    peer.on("connection", (connection) => {
      connectionsRef.current.push(connection);
      connection.on("open", () => setConnectionState("Computer connected"));
      connection.on("close", () => {
        connectionsRef.current = connectionsRef.current.filter((item) => item !== connection);
        setConnectionState("Computer disconnected");
      });
    });
    peer.on("error", () => setConnectionState("Connection service unavailable"));
  }

  function connectToPhone() {
    const cleanCode = pairCode.trim().toLowerCase();
    if (cleanCode.length !== 6) {
      setConnectionState("Enter the 6-character phone code");
      return;
    }
    peerRef.current?.destroy();
    setConnectionState("Connecting…");
    const peer = new Peer();
    peerRef.current = peer;
    peer.on("open", () => {
      const connection = peer.connect(`motion-mirror-${cleanCode}`, { reliable: false });
      connectionsRef.current = [connection];
      connection.on("open", () => setConnectionState("Receiving live motion"));
      connection.on("data", (data) => {
        const packet = data as { pose?: number[][]; hands?: number[][][]; handedness?: string[]; face?: Record<string, number> };
        if (!Array.isArray(packet.pose)) return;
        const landmarks = packet.pose.map((point) => ({
          x: Number(point[0]), y: Number(point[1]), z: Number(point[2]), visibility: Number(point[3] ?? 1),
        })) as NormalizedLandmark[];
        updateRig(landmarks);
        (packet.hands ?? []).forEach((hand, index) => driveHand(packet.handedness?.[index] ?? "Left", hand));
        updateFace(packet.face ?? {});
      });
      connection.on("close", () => setConnectionState("Phone disconnected"));
      connection.on("error", () => setConnectionState("Connection failed"));
    });
    peer.on("error", () => setConnectionState("Could not find that phone"));
  }

  function drawOverlay(landmarks: NormalizedLandmark[]) {
    const canvas = overlayRef.current;
    const video = videoRef.current;
    if (!canvas || !video) return;
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.lineWidth = Math.max(3, canvas.width / 240);
    ctx.strokeStyle = "#72f2c6";
    ctx.fillStyle = "#ffffff";
    for (const [a, b] of POSE_CONNECTIONS) {
      const p = landmarks[a], q = landmarks[b];
      if ((p.visibility ?? 1) < 0.45 || (q.visibility ?? 1) < 0.45) continue;
      ctx.beginPath();
      ctx.moveTo(p.x * canvas.width, p.y * canvas.height);
      ctx.lineTo(q.x * canvas.width, q.y * canvas.height);
      ctx.stroke();
    }
    landmarks.forEach((p) => {
      if ((p.visibility ?? 1) < 0.45) return;
      ctx.beginPath();
      ctx.arc(p.x * canvas.width, p.y * canvas.height, Math.max(3, canvas.width / 180), 0, Math.PI * 2);
      ctx.fill();
    });
    ctx.fillStyle = "#ffd66e";
    overlayDetailRef.current.hands.forEach((hand) => {
      hand.forEach((point) => {
        ctx.beginPath();
        ctx.arc(point.x * canvas.width, point.y * canvas.height, Math.max(2.5, canvas.width / 300), 0, Math.PI * 2);
        ctx.fill();
      });
    });
    ctx.fillStyle = "rgba(117, 169, 255, .8)";
    overlayDetailRef.current.face.forEach((point, index) => {
      if (index % 2 !== 0) return;
      ctx.beginPath();
      ctx.arc(point.x * canvas.width, point.y * canvas.height, Math.max(1.2, canvas.width / 700), 0, Math.PI * 2);
      ctx.fill();
    });
  }

  function updateRig(world: NormalizedLandmark[]) {
    if (!world.length) return;
    const metricPoints = world.map((p) => new THREE.Vector3(-p.x, -p.y, -p.z));
    const palmCenter = (indices: number[]) => indices
      .reduce((sum, index) => sum.add(metricPoints[index]), new THREE.Vector3())
      .multiplyScalar(1 / indices.length);
    const leftPalm = palmCenter([15, 17, 19, 21]);
    const rightPalm = palmCenter([16, 18, 20, 22]);
    const palmDistance = leftPalm.distanceTo(rightPalm);
    if (!handLatchEnabledRef.current) handsLatchedRef.current = false;
    else if (!handsLatchedRef.current && palmDistance <= 0.04) handsLatchedRef.current = true;
    else if (handsLatchedRef.current && palmDistance >= 0.09) handsLatchedRef.current = false;
    const rawPoints = world.map((p) => new THREE.Vector3(-p.x * 3.2, -p.y * 3.2, -p.z * 3.2));
    if (smoothedPointsRef.current.length !== rawPoints.length) {
      smoothedPointsRef.current = rawPoints.map((point) => point.clone());
    } else {
      rawPoints.forEach((point, index) => smoothedPointsRef.current[index].lerp(point, 0.58));
    }
    const points = smoothedPointsRef.current.map((point) => point.clone());
    if (handsLatchedRef.current) {
      const sharedPalm = [15, 17, 19, 21, 16, 18, 20, 22]
        .reduce((sum, index) => sum.add(points[index]), new THREE.Vector3())
        .multiplyScalar(1 / 8);
      for (const index of [15, 17, 19, 21, 16, 18, 20, 22]) points[index].copy(sharedPalm);
    }
    const hip = points[23].clone().add(points[24]).multiplyScalar(0.5);
    const center = new THREE.Vector3(0, 0.15, 0).sub(hip);
    points.forEach((p, i) => jointsRef.current[i]?.position.copy(p.add(center)));
    POSE_CONNECTIONS.forEach(([a, b], i) => {
      const attr = bonesRef.current[i]?.geometry.getAttribute("position") as THREE.BufferAttribute;
      if (!attr) return;
      attr.setXYZ(0, points[a].x, points[a].y, points[a].z);
      attr.setXYZ(1, points[b].x, points[b].y, points[b].z);
      attr.needsUpdate = true;
      bonesRef.current[i].geometry.computeBoundingSphere();
    });
    driveModel(points);
  }

  function segmentForBone(semantic: string, p: THREE.Vector3[]) {
    const hip = p[23].clone().add(p[24]).multiplyScalar(0.5);
    const shoulders = p[11].clone().add(p[12]).multiplyScalar(0.5);
    const hand = (a: number, b: number, c: number) => p[a].clone().add(p[b]).add(p[c]).multiplyScalar(1 / 3);
    const left = { shoulder: 11, elbow: 13, wrist: 15, hand: [17, 19, 21], hip: 23, knee: 25, ankle: 27, foot: 31 };
    const right = { shoulder: 12, elbow: 14, wrist: 16, hand: [18, 20, 22], hip: 24, knee: 26, ankle: 28, foot: 32 };
    const leftLeg = swapSidesRef.current ? right : left;
    const rightLeg = swapSidesRef.current ? left : right;
    const leftArm = swapArmsRef.current ? right : left;
    const rightArm = swapArmsRef.current ? left : right;
    const table: Record<string, [THREE.Vector3, THREE.Vector3]> = {
      hip: [hip.clone().add(new THREE.Vector3(0, -0.25, 0)), hip],
      abdomen: [hip, shoulders.clone().lerp(hip, 0.48)],
      chest: [hip.clone().lerp(shoulders, 0.48), shoulders],
      neck: [shoulders, p[0]],
      head: [shoulders.clone().lerp(p[0], 0.65), p[0]],
      rCollar: [shoulders, p[right.shoulder]], rShldr: [p[rightArm.shoulder], p[rightArm.elbow]], rForeArm: [p[rightArm.elbow], p[rightArm.wrist]], rHand: [p[right.wrist], hand(...right.hand as [number, number, number])],
      lCollar: [shoulders, p[left.shoulder]], lShldr: [p[leftArm.shoulder], p[leftArm.elbow]], lForeArm: [p[leftArm.elbow], p[leftArm.wrist]], lHand: [p[left.wrist], hand(...left.hand as [number, number, number])],
      rThigh: [p[rightLeg.hip], p[rightLeg.knee]], rShin: [p[rightLeg.knee], p[rightLeg.ankle]], rFoot: [p[rightLeg.ankle], p[rightLeg.foot]],
      lThigh: [p[leftLeg.hip], p[leftLeg.knee]], lShin: [p[leftLeg.knee], p[leftLeg.ankle]], lFoot: [p[leftLeg.ankle], p[leftLeg.foot]],
    };
    return table[semantic];
  }

  function driveModel(points: THREE.Vector3[]) {
    const model = modelRef.current;
    if (!model || !rigRef.current.size) return;
    for (const driver of rigRef.current.values()) {
      if (/Collar/.test(driver.semantic)) {
        driver.bone.quaternion.slerp(driver.restLocalQuaternion, 0.45);
        driver.bone.updateMatrixWorld(true);
        continue;
      }
      if (driver.semantic === "neck") {
        driver.bone.quaternion.slerp(driver.restLocalQuaternion, 0.5);
        driver.bone.updateMatrixWorld(true);
        continue;
      }
      if (upperBodyOnlyRef.current && /Thigh|Shin|Foot/.test(driver.semantic)) {
        driver.bone.quaternion.slerp(driver.restLocalQuaternion, 0.35);
        driver.bone.updateMatrixWorld(true);
        continue;
      }
      const segment = segmentForBone(driver.semantic, points);
      if (!segment) continue;
      const target = segment[1].clone().sub(segment[0]).normalize();
      if (!Number.isFinite(target.x) || target.lengthSq() < 0.01) continue;
      const delta = new THREE.Quaternion().setFromUnitVectors(driver.restDirection, target);
      const desiredWorld = delta.multiply(driver.restWorldQuaternion);
      const parentWorld = new THREE.Quaternion();
      driver.bone.parent?.getWorldQuaternion(parentWorld);
      const desiredLocal = parentWorld.invert().multiply(desiredWorld);
      driver.bone.quaternion.copy(
        driver.semantic === "head"
          ? driver.restLocalQuaternion.clone().slerp(desiredLocal, 0.42)
          : desiredLocal
      );
      driver.bone.updateMatrixWorld(true);
    }
  }

  function fingerSemantic(name: string) {
    const n = name.toLowerCase();
    let side = "";
    if (/^r(thumb|index|mid|ring|pinky)/.test(n) || /_(r)_/.test(n) || /\.r_/.test(n)) side = "r";
    if (/^l(thumb|index|mid|ring|pinky)/.test(n) || /_(l)_/.test(n) || /\.l_/.test(n)) side = "l";
    if (!side) return undefined;
    const finger = n.includes("thumb") ? "Thumb" : n.includes("index") ? "Index" : n.includes("middle") || n.includes("mid") ? "Middle" : n.includes("ring") ? "Ring" : n.includes("pinky") ? "Pinky" : "";
    if (!finger) return undefined;
    const base = n.includes("_base");
    const match = n.match(/(?:thumb|index|middle|mid|ring|pinky)(?:0?)([123])/);
    const lucario = n.match(/(?:thumb|index|middle|ring)(0[12])/);
    const joint = base ? 0 : match ? Number(match[1]) : lucario ? Number(lucario[1]) : 1;
    return `${side}${finger}${joint}`;
  }

  function driveHand(handedness: string, raw: number[][]) {
    if (raw.length < 21) return;
    const side = handedness.toLowerCase().startsWith("left") ? "l" : "r";
    const activePose = activeJoyPoseRef.current[side];
    if (activePose !== "camera") {
      applyHandPose(side, activePose);
      return;
    }
    const p = raw.map((point) => new THREE.Vector3(-Number(point[0]), -Number(point[1]), -Number(point[2])));
    const fingerStarts: Record<string, number> = { Thumb: 1, Index: 5, Middle: 9, Ring: 13, Pinky: 17 };
    const joyConnected = joyDevicesRef.current.some((joy) => joy.side === side);
    const wristDriver = joyConnected ? undefined : [...rigRef.current.values()].find((driver) => driver.semantic === `${side}Hand`);
    if (wristDriver) {
      const forward = p[9].clone().sub(p[0]).normalize();
      const across = side === "l" ? p[5].clone().sub(p[17]).normalize() : p[17].clone().sub(p[5]).normalize();
      const firstDelta = new THREE.Quaternion().setFromUnitVectors(wristDriver.restDirection, forward);
      const rotatedReference = wristDriver.restReference.clone().applyQuaternion(firstDelta);
      const projectedReference = rotatedReference.sub(forward.clone().multiplyScalar(rotatedReference.dot(forward))).normalize();
      const projectedAcross = across.sub(forward.clone().multiplyScalar(across.dot(forward))).normalize();
      if (projectedReference.lengthSq() > 0.01 && projectedAcross.lengthSq() > 0.01) {
        const rollDelta = new THREE.Quaternion().setFromUnitVectors(projectedReference, projectedAcross);
        const desiredWorld = rollDelta.multiply(firstDelta).multiply(wristDriver.restWorldQuaternion);
        const parentWorld = new THREE.Quaternion();
        wristDriver.bone.parent?.getWorldQuaternion(parentWorld);
        wristDriver.bone.quaternion.copy(parentWorld.invert().multiply(desiredWorld));
        wristDriver.bone.updateMatrixWorld(true);
      }
    }
    for (const driver of rigRef.current.values()) {
      if (!driver.semantic.startsWith(side) || !/Thumb|Index|Middle|Ring|Pinky/.test(driver.semantic)) continue;
      const match = driver.semantic.match(/^[lr](Thumb|Index|Middle|Ring|Pinky)([0-3])$/);
      if (!match) continue;
      const start = fingerStarts[match[1]];
      const joint = Number(match[2]);
      const a = joint === 0 ? 0 : start + joint - 1;
      const b = joint === 0 ? start : Math.min(start + joint, start + 3);
      const target = p[b].clone().sub(p[a]).normalize();
      if (target.lengthSq() < 0.01) continue;
      const desiredWorld = new THREE.Quaternion().setFromUnitVectors(driver.restDirection, target).multiply(driver.restWorldQuaternion);
      const parentWorld = new THREE.Quaternion();
      driver.bone.parent?.getWorldQuaternion(parentWorld);
      driver.bone.quaternion.copy(parentWorld.invert().multiply(desiredWorld));
      driver.bone.updateMatrixWorld(true);
    }
  }

  function updateFace(values: Record<string, number>) {
    const sensitiveMouthValue = (name: string, score: number) => {
      if (name !== "jawOpen" && !name.startsWith("mouth")) return score;
      return THREE.MathUtils.clamp((score - 0.004) * 2.4, 0, 1);
    };
    expressionMeshesRef.current.forEach((mesh) => {
      if (!mesh.morphTargetDictionary || !mesh.morphTargetInfluences) return;
      Object.entries(values).forEach(([name, score]) => {
        const index = mesh.morphTargetDictionary?.[name];
        if (index !== undefined) mesh.morphTargetInfluences![index] = sensitiveMouthValue(name, score);
      });
    });
    if (jawRef.current) {
      const openness = sensitiveMouthValue("jawOpen", values.jawOpen ?? 0);
      jawRef.current.bone.quaternion.copy(jawRef.current.rest).multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(openness * 0.6, 0, 0)));
    }
  }

  function applyHandPose(side: "l" | "r", pose: HandPose) {
    const curls: Record<string, number> = {
      Thumb: pose === "open" || pose === "thumb" ? 0 : pose === "pinch" ? 0.6 : 0.9,
      Index: pose === "open" || pose === "point" ? 0 : pose === "pinch" ? 0.75 : 1.15,
      Middle: pose === "open" ? 0 : pose === "pinch" ? 0.35 : 1.15,
      Ring: pose === "open" ? 0 : pose === "pinch" ? 0.35 : 1.2,
      Pinky: pose === "open" ? 0 : pose === "pinch" ? 0.35 : 1.2,
    };
    for (const driver of rigRef.current.values()) {
      const match = driver.semantic.match(new RegExp(`^${side}(Thumb|Index|Middle|Ring|Pinky)([0-3])$`));
      if (!match) continue;
      const amount = curls[match[1]] * (Number(match[2]) === 0 ? 0.35 : 1);
      driver.bone.quaternion.copy(driver.restLocalQuaternion).multiply(
        new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), amount * (side === "l" ? 1 : -1))
      );
      driver.bone.updateMatrixWorld(true);
    }
  }

  function handleJoyReport(joy: JoyDevice, event: HIDInputReportEvent) {
    const data = event.data;
    const now = performance.now();
    const dt = Math.min((now - joy.lastTime) / 1000, 0.05);
    joy.lastTime = now;
    if (event.reportId !== 0x30 || data.byteLength < 24) return;
    const rawGyro = new THREE.Vector3(
      data.getInt16(18, true) * 0.0010653,
      data.getInt16(20, true) * 0.0010653,
      data.getInt16(22, true) * 0.0010653
    );
    if (rawGyro.length() < 0.18) joy.gyroBias.lerp(rawGyro, 0.025);
    const corrected = rawGyro.clone().sub(joy.gyroBias);
    const gx = corrected.x;
    const gy = corrected.y;
    const gz = corrected.z;
    const speed = Math.hypot(gx, gy, gz);
    if (speed > 0.075) {
      joy.orientation.multiply(
        new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(gx, gy, gz).normalize(), speed * dt)
      ).normalize();
    }
    joy.orientation.slerp(new THREE.Quaternion(), 0.0012);
    const shared = data.getUint8(3);
    if (shared & (joy.side === "r" ? 0x04 : 0x08)) {
      joy.orientation.identity();
      joy.gyroBias.copy(rawGyro);
    }
    const wrist = [...rigRef.current.values()].find((driver) => driver.semantic === `${joy.side}Hand`);
    if (wrist) {
      wrist.bone.quaternion.copy(wrist.restLocalQuaternion).multiply(joy.orientation);
      wrist.bone.updateMatrixWorld(true);
    }
    const buttons = data.getUint8(joy.side === "r" ? 2 : 4);
    const triggerPressed = Boolean(buttons & 0x80);
    if (triggerPressed) {
      activeJoyPoseRef.current[joy.side] = "fist";
      applyHandPose(joy.side, "fist");
      return;
    }
    const pose: HandPose = joy.side === "r"
      ? buttons & 0x08 ? "open" : buttons & 0x04 ? "fist" : buttons & 0x02 ? "point" : buttons & 0x01 ? "pinch" : buttons & 0x40 ? "thumb" : "camera"
      : buttons & 0x02 ? "open" : buttons & 0x01 ? "fist" : buttons & 0x04 ? "point" : buttons & 0x08 ? "pinch" : buttons & 0x40 ? "thumb" : "camera";
    activeJoyPoseRef.current[joy.side] = pose;
    if (pose !== "camera") applyHandPose(joy.side, pose);
  }

  async function sendJoySubcommand(joy: JoyDevice, command: number, args: number[]) {
    const neutralRumble = [0x00, 0x01, 0x40, 0x40, 0x00, 0x01, 0x40, 0x40];
    const packet = new Uint8Array([joy.packet++ & 0x0f, ...neutralRumble, command, ...args]);
    await joy.device.sendReport(0x01, packet);
  }

  async function connectJoyCons() {
    if (!("hid" in navigator)) {
      setJoyStatus("Use desktop Chrome or Edge for Joy-Cons");
      return;
    }
    try {
      const devices = await navigator.hid.requestDevice({
        filters: [
          { vendorId: 0x057e, productId: 0x2006 },
          { vendorId: 0x057e, productId: 0x2007 },
        ],
      });
      const connected: JoyDevice[] = [];
      for (const device of devices) {
        if (!device.opened) await device.open();
        const joy: JoyDevice = {
          device,
          side: device.productId === 0x2006 ? "l" : "r",
          orientation: new THREE.Quaternion(),
          gyroBias: new THREE.Vector3(),
          lastTime: performance.now(),
          packet: 0,
        };
        device.addEventListener("inputreport", (event) => handleJoyReport(joy, event as HIDInputReportEvent));
        await sendJoySubcommand(joy, 0x40, [0x01]);
        await sendJoySubcommand(joy, 0x03, [0x30]);
        connected.push(joy);
      }
      joyDevicesRef.current = connected;
      setJoyStatus(connected.length
        ? `${connected.map((joy) => joy.side === "l" ? "Left" : "Right").join(" + ")} Joy-Con connected`
        : "No Joy-Con selected");
    } catch {
      setJoyStatus("Joy-Con connection cancelled");
    }
  }

  function classifyBone(name: string) {
    const n = name.toLowerCase();
    const exact: Array<[RegExp, string]> = [
      [/^hip_|^hips_|^root[._]?x_/, "hip"],
      [/^abdomen_|^spine_017|^spine_01[._]?x_/, "abdomen"],
      [/^chest_|^spine_03[._]?x_/, "chest"],
      [/^neck_|^neck[._]?x_/, "neck"], [/^head_|^head[._]?x_/, "head"],
      [/^rcollar_/, "rCollar"], [/^lcollar_/, "lCollar"],
      [/^shoulder_r_/, "rCollar"], [/^shoulder_l_/, "lCollar"],
      [/^shoulder[._]?r_/, "rCollar"], [/^shoulder[._]?l_/, "lCollar"],
      [/^rshldr_/, "rShldr"], [/^lshldr_/, "lShldr"],
      [/^arm_r_/, "rShldr"], [/^arm_l_/, "lShldr"],
      [/^arm_stretch[._]?r_/, "rShldr"], [/^arm_stretch[._]?l_/, "lShldr"],
      [/^rforearm_/, "rForeArm"], [/^lforearm_/, "lForeArm"],
      [/^forearm_r_/, "rForeArm"], [/^forearm_l_/, "lForeArm"],
      [/^forearm_stretch[._]?r_/, "rForeArm"], [/^forearm_stretch[._]?l_/, "lForeArm"],
      [/^rhand_/, "rHand"], [/^lhand_/, "lHand"],
      [/^wrist_r_/, "rHand"], [/^wrist_l_/, "lHand"],
      [/^hand[._]?r_/, "rHand"], [/^hand[._]?l_/, "lHand"],
      [/^rthigh_/, "rThigh"], [/^lthigh_/, "lThigh"],
      [/^leg_r_/, "rThigh"], [/^leg_l_/, "lThigh"],
      [/^thigh_stretch[._]?r_/, "rThigh"], [/^thigh_stretch[._]?l_/, "lThigh"],
      [/^rshin_/, "rShin"], [/^lshin_/, "lShin"],
      [/^lowerleg_r_/, "rShin"], [/^lowerleg_l_/, "lShin"],
      [/^leg_stretch[._]?r_/, "rShin"], [/^leg_stretch[._]?l_/, "lShin"],
      [/^rfoot_/, "rFoot"], [/^lfoot_/, "lFoot"],
      [/^foot_r_/, "rFoot"], [/^foot_l_/, "lFoot"],
      [/^foot[._]?r_/, "rFoot"], [/^foot[._]?l_/, "lFoot"],
    ];
    return exact.find(([pattern]) => pattern.test(n))?.[1] ?? fingerSemantic(name);
  }

  function installModel(model: THREE.Object3D, fileName: string) {
    const scene = sceneRef.current;
    if (!scene) return;
    if (modelRef.current) scene.remove(modelRef.current);
    const lowerFileName = fileName.toLowerCase();
    if (lowerFileName.includes("miles")) model.rotation.y -= Math.PI / 2;
    const modelBounds = () => {
      if (!lowerFileName.includes("lucario")) return new THREE.Box3().setFromObject(model);
      const boneBounds = new THREE.Box3();
      model.traverse((node) => {
        if (node instanceof THREE.Bone || (node as THREE.Bone).isBone) {
          boneBounds.expandByPoint(node.getWorldPosition(new THREE.Vector3()));
        }
      });
      return boneBounds.isEmpty() ? new THREE.Box3().setFromObject(model) : boneBounds;
    };
    model.updateMatrixWorld(true);
    const box = modelBounds();
    const size = box.getSize(new THREE.Vector3());
    const scale = 4.2 / Math.max(size.y, 0.01);
    model.scale.multiplyScalar(scale);
    model.updateMatrixWorld(true);
    const normalized = modelBounds();
    const center = normalized.getCenter(new THREE.Vector3());
    model.position.add(new THREE.Vector3(-center.x, -2.38 - normalized.min.y, -0.65 - center.z));
    model.traverse((node) => {
      if (node instanceof THREE.Mesh) {
        node.castShadow = true;
        node.receiveShadow = true;
        const materials = Array.isArray(node.material) ? node.material : [node.material];
        materials.forEach((material) => {
          material.transparent = false;
          material.opacity = 1;
          material.visible = true;
          material.needsUpdate = true;
        });
      }
    });
    scene.add(model);
    model.updateMatrixWorld(true);
    const drivers = new Map<string, BoneDriver>();
    expressionMeshesRef.current = [];
    jawRef.current = null;
    model.traverse((node) => {
      if (node instanceof THREE.Mesh && node.morphTargetDictionary) expressionMeshesRef.current.push(node);
      if (node instanceof THREE.Bone && /lowerjaw|(^|_)jaw/i.test(node.name)) {
        jawRef.current = { bone: node, rest: node.quaternion.clone() };
      }
      if (!(node instanceof THREE.Bone) && !(node as THREE.Bone).isBone) return;
      const boneNode = node as THREE.Bone;
      const semantic = classifyBone(node.name);
      if (!semantic) return;
      const child = node.children.find((candidate) => candidate instanceof THREE.Bone || (candidate as THREE.Bone).isBone) as THREE.Bone | undefined;
      if (!child) return;
      const start = node.getWorldPosition(new THREE.Vector3());
      const end = child.getWorldPosition(new THREE.Vector3());
      drivers.set(node.name, {
        bone: boneNode,
        semantic,
        restDirection: end.sub(start).normalize(),
        restReference: new THREE.Vector3(1, 0, 0).applyQuaternion(node.getWorldQuaternion(new THREE.Quaternion())).normalize(),
        restLocalQuaternion: node.quaternion.clone(),
        restWorldQuaternion: node.getWorldQuaternion(new THREE.Quaternion()),
      });
    });
    rigRef.current = drivers;
    modelRef.current = model;
    jointsRef.current.forEach((joint) => { joint.visible = false; });
    bonesRef.current.forEach((bone) => { bone.visible = false; });
    setModelName(`${fileName} · ${drivers.size} body bones mapped`);
  }

  function loadBundledModel(path: string, name: string) {
    setMessage(`Loading ${name}…`);
    new GLTFLoader().load(path, (gltf) => {
      installModel(gltf.scene, name);
      setMessage(state === "tracking" ? "Body locked" : "Model ready");
    }, undefined, () => setMessage(`${name} could not be loaded`));
  }

  async function startTracking() {
    try {
      setState("loading");
      setMessage("Loading body tracker…");
      if (!landmarkerRef.current) {
        const vision = await FilesetResolver.forVisionTasks(
          "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm"
        );
        landmarkerRef.current = await PoseLandmarker.createFromOptions(vision, {
          baseOptions: {
            modelAssetPath:
              "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/latest/pose_landmarker_full.task",
            delegate: "GPU",
          },
          runningMode: "VIDEO",
          numPoses: 1,
          minPoseDetectionConfidence: 0.55,
          minTrackingConfidence: 0.55,
        });
        handLandmarkerRef.current = await HandLandmarker.createFromOptions(vision, {
          baseOptions: {
            modelAssetPath: "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task",
            delegate: "GPU",
          },
          runningMode: "VIDEO",
          numHands: 2,
          minHandDetectionConfidence: 0.5,
          minTrackingConfidence: 0.5,
        });
        faceLandmarkerRef.current = await FaceLandmarker.createFromOptions(vision, {
          baseOptions: {
            modelAssetPath: "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task",
            delegate: "GPU",
          },
          runningMode: "VIDEO",
          numFaces: 1,
          outputFaceBlendshapes: true,
          minFaceDetectionConfidence: 0.5,
          minTrackingConfidence: 0.5,
        });
      }
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
        audio: false,
      });
      streamRef.current = stream;
      const video = videoRef.current!;
      video.srcObject = stream;
      await video.play();
      setState("tracking");
      setMessage("Step back until your whole body is visible");
      let lastVideoTime = -1;
      const track = () => {
        if (!landmarkerRef.current || !videoRef.current || !streamRef.current) return;
        if (video.currentTime !== lastVideoTime) {
          lastVideoTime = video.currentTime;
          const result = landmarkerRef.current.detectForVideo(video, performance.now());
          if (timingRef.current.frames % 2 === 0 && handLandmarkerRef.current && faceLandmarkerRef.current) {
            const timestamp = performance.now();
            const hands = handLandmarkerRef.current.detectForVideo(video, timestamp);
            const face = faceLandmarkerRef.current.detectForVideo(video, timestamp);
            const handPoints = hands.worldLandmarks.map((hand) => hand.map((point) => [point.x, point.y, point.z]));
            const handedness = hands.handedness.map((categories) => {
              const detected = categories[0]?.categoryName ?? "Left";
              return detected === "Left" ? "Right" : "Left";
            });
            const faceValues = Object.fromEntries((face.faceBlendshapes[0]?.categories ?? []).map((category) => [category.categoryName, category.score]));
            latestDetailRef.current = { hands: handPoints, handedness, face: faceValues };
            overlayDetailRef.current = {
              hands: hands.landmarks,
              face: face.faceLandmarks[0] ?? [],
            };
            handPoints.forEach((hand, index) => driveHand(handedness[index], hand));
            updateFace(faceValues);
          }
          if (result.landmarks[0]) {
            drawOverlay(result.landmarks[0]);
            updateRig(result.worldLandmarks[0] ?? result.landmarks[0]);
            const broadcastLandmarks = result.worldLandmarks[0] ?? result.landmarks[0];
            const now = performance.now();
            if (mode === "phone" && now - lastBroadcastRef.current >= 32) {
              const packet = {
                pose: broadcastLandmarks.map((point) => [point.x, point.y, point.z, point.visibility ?? 1]),
                ...latestDetailRef.current,
              };
              connectionsRef.current.forEach((connection) => {
                if (connection.open) connection.send(packet);
              });
              lastBroadcastRef.current = now;
            }
            setMessage("Body locked");
          } else setMessage("Move your full body into frame");
          timingRef.current.frames++;
          const now = performance.now();
          if (now - timingRef.current.last > 1000) {
            setFps(Math.round((timingRef.current.frames * 1000) / (now - timingRef.current.last)));
            timingRef.current = { last: now, frames: 0 };
          }
        }
        requestAnimationFrame(track);
      };
      requestAnimationFrame(track);
    } catch (error) {
      console.error(error);
      setState("error");
      setMessage("Camera or tracker could not start");
    }
  }

  function stopTracking() {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    setState("ready");
    setMessage("Camera paused");
    setFps(0);
  }

  function loadModel(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    const scene = sceneRef.current;
    if (!file || !scene) return;
    const url = URL.createObjectURL(file);
    new GLTFLoader().load(url, (gltf) => {
      installModel(gltf.scene, file.name);
      URL.revokeObjectURL(url);
    }, undefined, () => {
      setMessage("That GLB could not be loaded");
      URL.revokeObjectURL(url);
    });
  }

  return (
    <main className="studio">
      <header className="topbar">
        <div>
          <p className="eyebrow">IPHONE MOTION CAPTURE</p>
          <h1>Motion Mirror</h1>
        </div>
        <div className={`status status-${state}`}>
          <span /> {state === "tracking" ? "Live" : state === "loading" ? "Starting" : "Standby"}
        </div>
      </header>

      <nav className="mode-switch" aria-label="Device mode">
        <button className={mode === "phone" ? "active" : ""} onClick={() => { setMode("phone"); beginBroadcastSession(); }}>Phone · Broadcast</button>
        <button className={mode === "computer" ? "active" : ""} onClick={() => { stopTracking(); setMode("computer"); setPairCode(""); setConnectionState("Enter the code shown on your phone"); }}>Computer · Receive</button>
      </nav>

      <section className="workspace">
        <article className="panel camera-panel">
          <div className="panel-head"><span>01</span><h2>{mode === "phone" ? "Phone camera" : "Phone connection"}</h2><small>{fps ? `${fps} FPS` : mode === "phone" ? "Broadcaster" : "Receiver"}</small></div>
          {mode === "phone" ? <>
            <div className="camera-stage">
              <video ref={videoRef} playsInline muted />
              <canvas ref={overlayRef} />
              {state !== "tracking" && <div className="camera-placeholder"><div className="scan-icon" /><p>Your camera stays on your phone.</p></div>}
              <div className="camera-message">{message}</div>
            </div>
            <div className="pair-strip">
              <div><small>PAIRING CODE</small><strong>{pairCode || "Press start"}</strong></div>
              <span>{connectionState}</span>
            </div>
            <div className="controls">
              {state !== "tracking"
                ? <button className="primary" onClick={() => { if (!pairCode) beginBroadcastSession(); startTracking(); }} disabled={state === "loading"}>{state === "loading" ? "Preparing…" : "Start broadcasting"}</button>
                : <button className="secondary" onClick={stopTracking}>Pause camera</button>}
            </div>
          </> : <div className="receiver-card">
            <div className="signal-rings"><span /><span /><span /></div>
            <h3>Connect to your phone</h3>
            <p>Type the six-character code shown on the phone.</p>
            <input
              value={pairCode}
              onChange={(event) => setPairCode(event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6))}
              placeholder="ABC123"
              aria-label="Phone pairing code"
              autoCapitalize="characters"
            />
            <button className="primary" onClick={connectToPhone}>Connect</button>
            <div className="connection-label">{connectionState}</div>
          </div>}
        </article>

        <article className="panel model-panel">
          <div className="panel-head"><span>02</span><h2>3D mirror</h2><small>{modelName}</small></div>
          <div className="viewport" ref={viewportRef}><div className="axis-label">LIVE 3D</div></div>
          <select
            className="model-select"
            aria-label="Choose a built-in model"
            defaultValue="./models/male_skeleton.glb"
            onChange={(event) => {
              const option = event.currentTarget.selectedOptions[0];
              loadBundledModel(event.currentTarget.value, option.text);
            }}
          >
            <option value="./models/male_skeleton.glb">Male skeleton</option>
            <option value="./models/dnd_low_poly_human_rigged_v7.glb">D&amp;D low-poly human</option>
            <option value="./models/spiderverse_miles.glb">Spider-Verse Miles</option>
            <option value="./models/lucario_thicc.glb">Lucario</option>
          </select>
          <label className="calibration-toggle">
            <input
              type="checkbox"
              checked={handLatchEnabled}
              onChange={(event) => {
                setHandLatchEnabled(event.target.checked);
                handLatchEnabledRef.current = event.target.checked;
                if (!event.target.checked) handsLatchedRef.current = false;
              }}
            />
            4 cm hand latch
          </label>
          <label className="calibration-toggle">
            <input
              type="checkbox"
              checked={swapSides}
              onChange={(event) => {
                swapSidesRef.current = event.target.checked;
                setSwapSides(event.target.checked);
              }}
            />
            Swap legs left/right
          </label>
          <label className="calibration-toggle">
            <input
              type="checkbox"
              checked={swapArms}
              onChange={(event) => {
                swapArmsRef.current = event.target.checked;
                setSwapArms(event.target.checked);
              }}
            />
            Swap arms left/right
          </label>
          <label className="calibration-toggle">
            <input
              type="checkbox"
              checked={upperBodyOnly}
              onChange={(event) => {
                upperBodyOnlyRef.current = event.target.checked;
                setUpperBodyOnly(event.target.checked);
              }}
            />
            Upper body only
          </label>
          <label className="file-button">
            <input type="file" accept=".glb,model/gltf-binary" onChange={loadModel} />
            Load your .GLB model
          </label>
          <p className="privacy-note">The selected model is loaded locally and is not uploaded.</p>
        </article>
      </section>

      <footer>
        <div><b>For best tracking</b><span>Place the phone vertically, light your whole body, and leave space around your hands and feet.</span></div>
        <div className="legend">
          <span className="credits">
            Models:
            <a href="https://sketchfab.com/3d-models/male-skeleton-11b57ebfcf6c4e3b88d0cbe618ee70a7" target="_blank" rel="noreferrer"> projectkaizen</a>,
            <a href="https://sketchfab.com/3d-models/spiderverse-miles-d5b3db27579b431d939737b85ab185c5" target="_blank" rel="noreferrer"> victoregwuatu731</a>,
            <a href="https://sketchfab.com/3d-models/lucario-thicc-c93a439731be4ca9b7bf66c2b37384c4" target="_blank" rel="noreferrer"> Gatomoderno</a> · CC BY 4.0
          </span>
          <i className="mint" /> tracked joints <i className="blue" /> body links
        </div>
      </footer>
    </main>
  );
}
