"use client";

import { useEffect, useRef, useState } from "react";
import { FilesetResolver, PoseLandmarker, type NormalizedLandmark } from "@mediapipe/tasks-vision";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import Peer, { type DataConnection } from "peerjs";

type TrackerState = "idle" | "loading" | "ready" | "tracking" | "error";
type DeviceMode = "phone" | "computer";
type BoneDriver = {
  bone: THREE.Bone;
  semantic: string;
  restDirection: THREE.Vector3;
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
  const [swapSides, setSwapSides] = useState(true);
  const swapSidesRef = useRef(true);
  const smoothedPointsRef = useRef<THREE.Vector3[]>([]);

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
        if (!Array.isArray(data)) return;
        const landmarks = data.map((point) => ({
          x: Number(point[0]), y: Number(point[1]), z: Number(point[2]), visibility: Number(point[3] ?? 1),
        })) as NormalizedLandmark[];
        updateRig(landmarks);
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
  }

  function updateRig(world: NormalizedLandmark[]) {
    if (!world.length) return;
    const rawPoints = world.map((p) => new THREE.Vector3(-p.x * 3.2, -p.y * 3.2, -p.z * 3.2));
    if (smoothedPointsRef.current.length !== rawPoints.length) {
      smoothedPointsRef.current = rawPoints.map((point) => point.clone());
    } else {
      rawPoints.forEach((point, index) => smoothedPointsRef.current[index].lerp(point, 0.58));
    }
    const points = smoothedPointsRef.current.map((point) => point.clone());
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
    const table: Record<string, [THREE.Vector3, THREE.Vector3]> = {
      hip: [hip.clone().add(new THREE.Vector3(0, -0.25, 0)), hip],
      abdomen: [hip, shoulders.clone().lerp(hip, 0.48)],
      chest: [hip.clone().lerp(shoulders, 0.48), shoulders],
      neck: [shoulders, p[0]],
      head: [shoulders.clone().lerp(p[0], 0.65), p[0]],
      rCollar: [shoulders, p[right.shoulder]], rShldr: [p[right.shoulder], p[right.elbow]], rForeArm: [p[right.elbow], p[right.wrist]], rHand: [p[right.wrist], hand(...right.hand as [number, number, number])],
      lCollar: [shoulders, p[left.shoulder]], lShldr: [p[left.shoulder], p[left.elbow]], lForeArm: [p[left.elbow], p[left.wrist]], lHand: [p[left.wrist], hand(...left.hand as [number, number, number])],
      rThigh: [p[rightLeg.hip], p[rightLeg.knee]], rShin: [p[rightLeg.knee], p[rightLeg.ankle]], rFoot: [p[rightLeg.ankle], p[rightLeg.foot]],
      lThigh: [p[leftLeg.hip], p[leftLeg.knee]], lShin: [p[leftLeg.knee], p[leftLeg.ankle]], lFoot: [p[leftLeg.ankle], p[leftLeg.foot]],
    };
    return table[semantic];
  }

  function driveModel(points: THREE.Vector3[]) {
    const model = modelRef.current;
    if (!model || !rigRef.current.size) return;
    for (const driver of rigRef.current.values()) {
      const segment = segmentForBone(driver.semantic, points);
      if (!segment) continue;
      const target = segment[1].clone().sub(segment[0]).normalize();
      if (!Number.isFinite(target.x) || target.lengthSq() < 0.01) continue;
      const delta = new THREE.Quaternion().setFromUnitVectors(driver.restDirection, target);
      const desiredWorld = delta.multiply(driver.restWorldQuaternion);
      const parentWorld = new THREE.Quaternion();
      driver.bone.parent?.getWorldQuaternion(parentWorld);
      driver.bone.quaternion.copy(parentWorld.invert().multiply(desiredWorld));
      driver.bone.updateMatrixWorld(true);
    }
  }

  function classifyBone(name: string) {
    const n = name.toLowerCase();
    const exact: Array<[RegExp, string]> = [
      [/^hip_|^hips_|^root\.x_/, "hip"],
      [/^abdomen_|^spine_017|^spine_01\./, "abdomen"],
      [/^chest_|^spine_03\./, "chest"],
      [/^neck_|^neck\./, "neck"], [/^head_|^head\./, "head"],
      [/^rcollar_/, "rCollar"], [/^lcollar_/, "lCollar"],
      [/^shoulder_r_/, "rCollar"], [/^shoulder_l_/, "lCollar"],
      [/^shoulder\.r_/, "rCollar"], [/^shoulder\.l_/, "lCollar"],
      [/^rshldr_/, "rShldr"], [/^lshldr_/, "lShldr"],
      [/^arm_r_/, "rShldr"], [/^arm_l_/, "lShldr"],
      [/^arm_stretch\.r_/, "rShldr"], [/^arm_stretch\.l_/, "lShldr"],
      [/^rforearm_/, "rForeArm"], [/^lforearm_/, "lForeArm"],
      [/^forearm_r_/, "rForeArm"], [/^forearm_l_/, "lForeArm"],
      [/^forearm_stretch\.r_/, "rForeArm"], [/^forearm_stretch\.l_/, "lForeArm"],
      [/^rhand_/, "rHand"], [/^lhand_/, "lHand"],
      [/^wrist_r_/, "rHand"], [/^wrist_l_/, "lHand"],
      [/^hand\.r_/, "rHand"], [/^hand\.l_/, "lHand"],
      [/^rthigh_/, "rThigh"], [/^lthigh_/, "lThigh"],
      [/^leg_r_/, "rThigh"], [/^leg_l_/, "lThigh"],
      [/^thigh_stretch\.r_/, "rThigh"], [/^thigh_stretch\.l_/, "lThigh"],
      [/^rshin_/, "rShin"], [/^lshin_/, "lShin"],
      [/^lowerleg_r_/, "rShin"], [/^lowerleg_l_/, "lShin"],
      [/^leg_stretch\.r_/, "rShin"], [/^leg_stretch\.l_/, "lShin"],
      [/^rfoot_/, "rFoot"], [/^lfoot_/, "lFoot"],
      [/^foot_r_/, "rFoot"], [/^foot_l_/, "lFoot"],
      [/^foot\.r_/, "rFoot"], [/^foot\.l_/, "lFoot"],
    ];
    return exact.find(([pattern]) => pattern.test(n))?.[1];
  }

  function installModel(model: THREE.Object3D, fileName: string) {
    const scene = sceneRef.current;
    if (!scene) return;
    if (modelRef.current) scene.remove(modelRef.current);
    const box = new THREE.Box3().setFromObject(model);
    const size = box.getSize(new THREE.Vector3());
    const scale = 4.2 / Math.max(size.y, 0.01);
    model.scale.setScalar(scale);
    const normalized = new THREE.Box3().setFromObject(model);
    const center = normalized.getCenter(new THREE.Vector3());
    model.position.set(-center.x, -2.38 - normalized.min.y, -0.65 - center.z);
    model.traverse((node) => {
      if (node instanceof THREE.Mesh) {
        node.castShadow = true;
        node.receiveShadow = true;
        node.material.transparent = false;
        node.material.opacity = 1;
      }
    });
    scene.add(model);
    model.updateMatrixWorld(true);
    const drivers = new Map<string, BoneDriver>();
    model.traverse((node) => {
      if (!(node instanceof THREE.Bone)) return;
      const semantic = classifyBone(node.name);
      if (!semantic) return;
      const child = node.children.find((candidate) => candidate instanceof THREE.Bone) as THREE.Bone | undefined;
      if (!child) return;
      const start = node.getWorldPosition(new THREE.Vector3());
      const end = child.getWorldPosition(new THREE.Vector3());
      drivers.set(node.name, {
        bone: node,
        semantic,
        restDirection: end.sub(start).normalize(),
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
          if (result.landmarks[0]) {
            drawOverlay(result.landmarks[0]);
            updateRig(result.worldLandmarks[0] ?? result.landmarks[0]);
            const broadcastLandmarks = result.worldLandmarks[0] ?? result.landmarks[0];
            const now = performance.now();
            if (mode === "phone" && now - lastBroadcastRef.current >= 32) {
              const packet = broadcastLandmarks.map((point) => [point.x, point.y, point.z, point.visibility ?? 1]);
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
            <option value="./models/spiderverse_miles.glb">Spider-Verse Miles</option>
            <option value="./models/lucario_thicc.glb">Lucario</option>
          </select>
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
