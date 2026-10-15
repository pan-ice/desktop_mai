import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { VRMLoaderPlugin, VRMUtils, type VRM } from "@pixiv/three-vrm";
import { MMDLoader } from "three-stdlib";
import type { ImportedModel, Mood } from "../../shared/types";

export async function mount(
  host: HTMLElement,
  model: ImportedModel,
  mood: () => Mood,
  reduced: boolean,
): Promise<() => void> {
  const renderer = new THREE.WebGLRenderer({
    alpha: true,
    antialias: true,
    powerPreference: "low-power",
  });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
  renderer.setClearColor(0x000000, 0);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(30, 1, 0.01, 1000);
  camera.position.set(0, 1, 3.5);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enablePan = false;
  controls.enableZoom = false;
  controls.target.set(0, 0.9, 0);
  scene.add(new THREE.HemisphereLight(0xffffff, 0xadb8ad, 2.6));
  const light = new THREE.DirectionalLight(0xffefdc, 2.5);
  light.position.set(2, 4, 3);
  scene.add(light);
  let avatar: THREE.Object3D;
  let vrm: VRM | undefined;
  try {
    if (model.kind === "mmd") {
      const loader = new MMDLoader();
      avatar = await new Promise<THREE.SkinnedMesh>((resolve, reject) =>
        loader.load(model.assetUrl, resolve, undefined, reject),
      );
      avatar.scale.setScalar(0.08);
    } else {
      const loader = new GLTFLoader();
      loader.register((parser) => new VRMLoaderPlugin(parser));
      const gltf = await loader.loadAsync(model.assetUrl);
      vrm = gltf.userData.vrm as VRM | undefined;
      avatar = gltf.scene;
      if (vrm) {
        VRMUtils.rotateVRM0(vrm);
        vrm.humanoid
          .getNormalizedBoneNode("leftUpperArm")
          ?.rotation.set(0, 0, 1.15);
        vrm.humanoid
          .getNormalizedBoneNode("rightUpperArm")
          ?.rotation.set(0, 0, -1.15);
      }
    }
  } catch (error) {
    controls.dispose();
    renderer.dispose();
    throw error;
  }
  scene.add(avatar);
  const box = new THREE.Box3().setFromObject(avatar);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  controls.target.copy(center);
  camera.position.set(
    center.x,
    center.y,
    center.z + Math.max(size.y, size.x) * 2.1,
  );
  camera.lookAt(center);
  const resize = () => {
    const width = host.clientWidth || 250,
      height = host.clientHeight || 300;
    renderer.setSize(width, height);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
  };
  host.replaceChildren(renderer.domElement);
  const observer = new ResizeObserver(resize);
  observer.observe(host);
  resize();
  const clock = new THREE.Clock();
  let frame = 0;
  let lastFrame = 0;
  const baseY = avatar.position.y;
  const morphs: {
    mesh: THREE.Mesh;
    mouth?: number;
    happy?: number;
    blink?: number;
  }[] = [];
  if (model.kind === "mmd")
    avatar.traverse((object) => {
      if (!(object instanceof THREE.Mesh) || !object.morphTargetDictionary)
        return;
      const dictionary = object.morphTargetDictionary;
      morphs.push({
        mesh: object,
        mouth: dictionary["あ"] ?? dictionary["A"],
        happy: dictionary["笑い"] ?? dictionary["笑顔"],
        blink: dictionary["まばたき"] ?? dictionary["Blink"],
      });
    });
  const pointer = { x: 0, y: 0 };
  const track = (event: PointerEvent) => {
    const rect = host.getBoundingClientRect();
    pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = ((event.clientY - rect.top) / rect.height) * 2 - 1;
  };
  host.addEventListener("pointermove", track);
  const render = (timestamp = 0) => {
    frame = requestAnimationFrame(render);
    if (
      document.hidden ||
      timestamp - lastFrame < (reduced ? 1000 / 20 : 1000 / 30)
    )
      return;
    lastFrame = timestamp;
    const delta = Math.min(clock.getDelta(), 0.1),
      time = clock.elapsedTime;
    if (!reduced)
      avatar.position.y = baseY + Math.sin(time * 1.7) * size.y * 0.004;
    if (vrm) {
      vrm.expressionManager?.setValue(
        "aa",
        mood() === "speaking" ? 0.25 + Math.sin(time * 15) * 0.2 : 0,
      );
      vrm.expressionManager?.setValue("happy", mood() === "happy" ? 0.6 : 0);
      vrm.expressionManager?.setValue(
        "blink",
        mood() === "sleeping" ? 1 : !reduced && time % 4.8 < 0.13 ? 1 : 0,
      );
      vrm.update(delta);
      const head = vrm.humanoid.getNormalizedBoneNode("head");
      if (head && !reduced) {
        head.rotation.y = pointer.x * 0.2;
        head.rotation.x = pointer.y * 0.12;
      }
    }
    for (const morph of morphs) {
      const values = morph.mesh.morphTargetInfluences;
      if (!values) continue;
      if (morph.mouth !== undefined)
        values[morph.mouth] =
          mood() === "speaking" ? 0.3 + Math.sin(time * 15) * 0.2 : 0;
      if (morph.happy !== undefined)
        values[morph.happy] = mood() === "happy" ? 0.65 : 0;
      if (morph.blink !== undefined)
        values[morph.blink] =
          mood() === "sleeping" ? 1 : !reduced && time % 4.8 < 0.13 ? 1 : 0;
    }
    controls.update();
    renderer.render(scene, camera);
  };
  render();
  return () => {
    cancelAnimationFrame(frame);
    observer.disconnect();
    host.removeEventListener("pointermove", track);
    controls.dispose();
    if (vrm) VRMUtils.deepDispose(avatar);
    else
      avatar.traverse((object) => {
        if (object instanceof THREE.Mesh) {
          object.geometry.dispose();
          for (const material of Array.isArray(object.material)
            ? object.material
            : [object.material]) {
            for (const value of Object.values(material))
              if (value instanceof THREE.Texture) value.dispose();
            material.dispose();
          }
        }
      });
    renderer.dispose();
    renderer.forceContextLoss();
    renderer.domElement.remove();
  };
}
