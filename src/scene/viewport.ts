import {
  AmbientLight,
  AxesHelper,
  BufferGeometry,
  Color,
  DirectionalLight,
  EdgesGeometry,
  Float32BufferAttribute,
  GridHelper,
  Group,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshStandardMaterial,
  PerspectiveCamera,
  PlaneGeometry,
  Scene,
  Vector3,
  WebGLRenderer,
} from 'three';
import type { GeometryPayload } from '../csg/protocol';
import type { Solid } from '../model/geometry';

/** Bambu P1S build plate, used as the viewport's size reference. */
const PLATE = 256;

/** Long enough to read at a glance, short enough not to crowd a small part. */
const AXIS_LENGTH = 40;

export class Viewport {
  readonly scene = new Scene();
  readonly camera = new PerspectiveCamera(40, 1, 0.5, 4000);
  private renderer: WebGLRenderer;
  private host: HTMLElement;

  private bodyMesh: Mesh | null = null;
  private insertMesh: Mesh | null = null;
  private ghosts = new Group();

  private matBody = new MeshStandardMaterial({
    color: 0x9aa3aa,
    metalness: 0.05,
    roughness: 0.6,
    flatShading: true,
  });
  private matInsert = new MeshStandardMaterial({
    color: 0x2467d6,
    metalness: 0.05,
    roughness: 0.55,
    flatShading: true,
  });
  private matCut = new MeshStandardMaterial({
    color: 0xe5484d,
    transparent: true,
    opacity: 0.42,
    roughness: 0.7,
    depthWrite: false,
  });
  private matCutSel = new MeshStandardMaterial({
    color: 0xe5484d,
    transparent: true,
    opacity: 0.7,
    roughness: 0.5,
    depthWrite: false,
  });

  /* spherical orbit around a target — no OrbitControls dependency */
  private theta = 0.9;
  private phi = 1.05;
  private dist = 220;
  private target = new Vector3(0, 20, 0);

  constructor(host: HTMLElement) {
    this.host = host;
    this.renderer = new WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    host.appendChild(this.renderer.domElement);

    const key = new DirectionalLight(0xffffff, 0.85);
    key.position.set(120, 220, 140);
    const fill = new DirectionalLight(0xdfe8ff, 0.35);
    fill.position.set(-150, 80, -100);
    this.scene.add(key, fill, new AmbientLight(0xffffff, 0.45));

    this.scene.add(new GridHelper(PLATE, 16, 0xb9c1c7, 0xd3d9dd));

    // At the default camera azimuth both world X and Z project diagonally on screen, so
    // an axis-aligned cutter can read as skewed. These make the bed's axes unambiguous.
    // Red is deliberately avoided — it is the cutter colour.
    const axes = new AxesHelper(AXIS_LENGTH);
    axes.setColors(
      new Color(0xd9730d), // X — orange
      new Color(0x00963b), // Y — green
      new Color(0x2467d6), // Z — blue
    );
    // Lift a hair off the plate so the grid does not z-fight with the axis lines.
    axes.position.y = 0.02;
    this.scene.add(axes);
    this.scene.add(
      new LineSegments(
        new EdgesGeometry(new PlaneGeometry(PLATE, PLATE).rotateX(-Math.PI / 2)),
        new LineBasicMaterial({ color: 0x8d979e }),
      ),
    );
    this.scene.add(this.ghosts);

    this.bindControls();
    new ResizeObserver(() => this.resize()).observe(host);
    this.resize();
    this.updateCamera();

    const loop = (): void => {
      requestAnimationFrame(loop);
      this.renderer.render(this.scene, this.camera);
    };
    loop();
  }

  private bindControls(): void {
    const el = this.renderer.domElement;
    let dragging = false;
    let panning = false;
    let lx = 0;
    let ly = 0;

    el.addEventListener('pointerdown', (e) => {
      dragging = true;
      panning = e.button === 2 || e.button === 1 || e.shiftKey;
      lx = e.clientX;
      ly = e.clientY;
      el.setPointerCapture(e.pointerId);
    });
    el.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const dx = e.clientX - lx;
      const dy = e.clientY - ly;
      lx = e.clientX;
      ly = e.clientY;
      if (panning) {
        const s = this.dist * 0.0016;
        const right = new Vector3()
          .subVectors(this.camera.position, this.target)
          .cross(this.camera.up)
          .normalize();
        this.target.addScaledVector(right, dx * s);
        this.target.y += dy * s;
      } else {
        this.theta -= dx * 0.008;
        this.phi -= dy * 0.008;
      }
      this.updateCamera();
    });
    window.addEventListener('pointerup', () => {
      dragging = false;
    });
    el.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        this.dist *= 1 + Math.sign(e.deltaY) * 0.09;
        this.updateCamera();
      },
      { passive: false },
    );
    el.addEventListener('contextmenu', (e) => e.preventDefault());

    let pinch: number | null = null;
    el.addEventListener(
      'touchmove',
      (e) => {
        if (e.touches.length === 2) {
          const d = Math.hypot(
            e.touches[0].clientX - e.touches[1].clientX,
            e.touches[0].clientY - e.touches[1].clientY,
          );
          if (pinch !== null) {
            this.dist *= pinch / d;
            this.updateCamera();
          }
          pinch = d;
          e.preventDefault();
        }
      },
      { passive: false },
    );
    el.addEventListener('touchend', () => {
      pinch = null;
    });
  }

  private updateCamera(): void {
    this.phi = Math.max(0.08, Math.min(Math.PI - 0.08, this.phi));
    this.dist = Math.max(20, Math.min(1500, this.dist));
    this.camera.position.set(
      this.target.x + this.dist * Math.sin(this.phi) * Math.sin(this.theta),
      this.target.y + this.dist * Math.cos(this.phi),
      this.target.z + this.dist * Math.sin(this.phi) * Math.cos(this.theta),
    );
    this.camera.lookAt(this.target);
  }

  private resize(): void {
    const w = this.host.clientWidth;
    const h = this.host.clientHeight;
    if (w === 0 || h === 0) return;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  /** Frame the model after a base change big enough that the old view is useless. */
  frame(spanX: number, spanZ: number, height: number): void {
    this.target.set(0, height / 2, 0);
    this.dist = Math.max(60, Math.hypot(spanX, spanZ, height) * 2.1);
    this.updateCamera();
  }

  private static geometryFrom(payload: GeometryPayload): BufferGeometry {
    const g = new BufferGeometry();
    g.setAttribute('position', new Float32BufferAttribute(payload.position, 3));
    if (payload.normal.length === payload.position.length) {
      g.setAttribute('normal', new Float32BufferAttribute(payload.normal, 3));
    } else {
      g.computeVertexNormals();
    }
    return g;
  }

  setBody(payload: GeometryPayload | null): void {
    if (this.bodyMesh) {
      this.scene.remove(this.bodyMesh);
      this.bodyMesh.geometry.dispose();
      this.bodyMesh = null;
    }
    if (!payload || payload.triangles === 0) return;
    this.bodyMesh = new Mesh(Viewport.geometryFrom(payload), this.matBody);
    this.scene.add(this.bodyMesh);
  }

  setInsert(payload: GeometryPayload | null): void {
    if (this.insertMesh) {
      this.scene.remove(this.insertMesh);
      this.insertMesh.geometry.dispose();
      this.insertMesh = null;
    }
    if (!payload || payload.triangles === 0) return;
    this.insertMesh = new Mesh(Viewport.geometryFrom(payload), this.matInsert);
    this.scene.add(this.insertMesh);
  }

  /** World matrices of the current cutter ghosts, for debugging and tests. */
  ghostMatrices(): number[][] {
    return this.ghosts.children.map((c) => {
      c.updateMatrixWorld(true);
      return [...c.matrixWorld.elements];
    });
  }

  /** Translucent red previews of the cutter solids, rebuilt whenever params change. */
  setGhosts(items: { solid: Solid; selected: boolean }[]): void {
    while (this.ghosts.children.length) {
      const child = this.ghosts.children.pop() as Mesh;
      child.geometry.dispose();
    }
    for (const { solid, selected } of items) {
      const mesh = new Mesh(solid.geom, selected ? this.matCutSel : this.matCut);
      mesh.applyMatrix4(solid.matrix);
      this.ghosts.add(mesh);
    }
  }
}
