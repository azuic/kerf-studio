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
  MathUtils,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  PerspectiveCamera,
  Plane,
  PlaneGeometry,
  Raycaster,
  Scene,
  Vector2,
  Vector3,
  WebGLRenderer,
} from 'three';
import type { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import type { GeometryPayload } from '../csg/protocol';
import type { Solid } from '../model/geometry';

/** Bambu P1S build plate, used as the viewport's size reference. */
const PLATE = 256;

/** Long enough to read at a glance, short enough not to crowd a small part. */
const AXIS_LENGTH = 40;

/** Hold to snap a viewport drag to whole millimetres. */
const SNAP_MM = 1;

/** Hold to snap the rotation gizmo. */
const GIZMO_SNAP_DEG = 15;

/** Opaque enough to read the form, sheer enough to see a hole buried inside it. */
const BODY_XRAY_OPACITY = 0.34;

/** Angles come back from the gizmo as raw floats; keep the numeric fields readable. */
function round(v: number): number {
  return Math.round(v * 1e3) / 1e3;
}

export interface GhostItem {
  id: number;
  solid: Solid;
  selected: boolean;
  /** The cutter's entry point in world space — the anchor a drag actually moves. */
  entry: { x: number; y: number; z: number };
}

export interface GizmoTarget {
  id: number;
  entry: { x: number; y: number; z: number };
  rot: { x: number; y: number; z: number };
}

interface CutterDrag {
  id: number;
  /** 'ground' slides across XZ; 'vertical' raises and lowers along Y. */
  mode: 'ground' | 'vertical';
  plane: Plane;
  /** Entry point minus the first hit, so the cutter does not jump to the cursor. */
  offset: Vector3;
  moved: boolean;
}

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

  /* picking and dragging cutters */
  private raycaster = new Raycaster();
  private ndc = new Vector2();
  private drag: CutterDrag | null = null;

  /** Fired when a cutter ghost is clicked. */
  onCutterPick: ((id: number) => void) | null = null;
  /** Fired once when a drag begins, so the caller can open a single undo step. */
  onCutterDragStart: ((id: number) => void) | null = null;
  /** Fired continuously with the cutter's new entry point. */
  onCutterDragMove: ((id: number, x: number, y: number, z: number) => void) | null = null;
  onCutterDragEnd: (() => void) | null = null;

  /* rotation gizmo */
  private gizmo: TransformControls | null = null;
  /**
   * The gizmo drives this stand-in rather than a ghost mesh, because it must pivot about
   * the cutter's *entry point*. A ghost's own origin is the solid's centre, half its
   * length down the axis, which would swing the hole away from where it enters.
   */
  private gizmoProxy = new Object3D();
  private gizmoId: number | null = null;
  /** Last requested target, replayed once the control finishes loading. */
  private gizmoTarget: GizmoTarget | null = null;
  private gizmoLoading = false;

  onCutterRotateStart: ((id: number) => void) | null = null;
  onCutterRotate: ((id: number, rotX: number, rotY: number, rotZ: number) => void) | null = null;
  onCutterRotateEnd: (() => void) | null = null;

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
    this.gizmoProxy.rotation.order = 'XYZ';
    this.scene.add(this.gizmoProxy);

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

  /**
   * TransformControls is loaded on demand: it is only needed once a cutter exists and
   * the gizmo is shown, so it stays out of the initial download.
   */
  private async ensureGizmo(): Promise<void> {
    if (this.gizmo || this.gizmoLoading) return;
    this.gizmoLoading = true;
    const { TransformControls } = await import(
      'three/examples/jsm/controls/TransformControls.js'
    );

    const g = new TransformControls(this.camera, this.renderer.domElement);
    g.setMode('rotate');
    // World space so the rings line up with the plate's X/Y/Z indicator and with the
    // numeric fields, which are world-axis Euler angles.
    g.setSpace('world');
    g.size = 0.85;

    g.addEventListener('objectChange', () => {
      if (this.gizmoId === null) return;
      const e = this.gizmoProxy.rotation;
      this.onCutterRotate?.(
        this.gizmoId,
        round(MathUtils.radToDeg(e.x)),
        round(MathUtils.radToDeg(e.y)),
        round(MathUtils.radToDeg(e.z)),
      );
    });

    g.addEventListener('dragging-changed', (ev) => {
      const dragging = (ev as unknown as { value: boolean }).value;
      if (dragging) {
        if (this.gizmoId !== null) this.onCutterRotateStart?.(this.gizmoId);
      } else {
        this.onCutterRotateEnd?.();
      }
    });

    // ⌘/ctrl snaps, matching the drag convention.
    const setSnap = (on: boolean) => {
      g.rotationSnap = on ? MathUtils.degToRad(GIZMO_SNAP_DEG) : null;
    };
    window.addEventListener('keydown', (e) => setSnap(e.metaKey || e.ctrlKey));
    window.addEventListener('keyup', (e) => setSnap(e.metaKey || e.ctrlKey));

    this.scene.add(g.getHelper());
    this.gizmo = g;
    this.gizmoLoading = false;
    // A target may have been requested while this was loading.
    this.applyGizmoTarget();
  }

  /**
   * X-ray: render the body translucent so cutters buried inside it stay visible.
   *
   * `depthWrite` has to go off with it. A transparent surface that still writes depth
   * would occlude the ghosts behind it just as the opaque one did, which is the whole
   * problem this solves.
   */
  setXray(on: boolean): void {
    this.matBody.transparent = on;
    this.matBody.opacity = on ? BODY_XRAY_OPACITY : 1;
    this.matBody.depthWrite = !on;
    this.matBody.needsUpdate = true;
  }

  /** Body opacity, for the browser tests. */
  bodyOpacity(): number {
    return this.matBody.opacity;
  }

  gizmoAttached(): boolean {
    return this.gizmo?.object === this.gizmoProxy && this.gizmoId !== null;
  }

  gizmoAxis(): string | null {
    return this.gizmo?.axis ?? null;
  }

  /** True while the pointer is over a gizmo handle, or actively turning one. */
  private gizmoBusy(): boolean {
    return this.gizmo !== null && (this.gizmo.dragging || this.gizmo.axis !== null);
  }

  /** Point the gizmo at a cutter, or pass null to hide it. */
  setGizmo(target: GizmoTarget | null): void {
    // Never re-seat the proxy mid-turn; that would fight the handle the user is holding.
    if (this.gizmo?.dragging) return;
    this.gizmoTarget = target;
    if (!this.gizmo) {
      if (target) void this.ensureGizmo();
      return;
    }
    this.applyGizmoTarget();
  }

  private applyGizmoTarget(): void {
    const g = this.gizmo;
    if (!g) return;
    const target = this.gizmoTarget;

    if (!target) {
      this.gizmoId = null;
      g.detach();
      return;
    }
    this.gizmoId = target.id;
    this.gizmoProxy.position.set(target.entry.x, target.entry.y, target.entry.z);
    this.gizmoProxy.rotation.set(
      MathUtils.degToRad(target.rot.x),
      MathUtils.degToRad(target.rot.y),
      MathUtils.degToRad(target.rot.z),
      'XYZ',
    );
    this.gizmoProxy.updateMatrixWorld(true);
    if (g.object !== this.gizmoProxy) g.attach(this.gizmoProxy);
  }

  /** Pointer position in normalised device coordinates for the current canvas size. */
  private setNdc(e: { clientX: number; clientY: number }): void {
    const r = this.renderer.domElement.getBoundingClientRect();
    this.ndc.set(
      ((e.clientX - r.left) / r.width) * 2 - 1,
      -((e.clientY - r.top) / r.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(this.ndc, this.camera);
  }

  private pickCutter(e: { clientX: number; clientY: number }): Mesh | null {
    this.setNdc(e);
    const hits = this.raycaster.intersectObjects(this.ghosts.children, false);
    return hits.length ? (hits[0].object as Mesh) : null;
  }

  /**
   * Start dragging the cutter under the pointer.
   *
   * Ground drags run on a horizontal plane through the cutter's current entry point, so
   * it slides across the bed at a constant height. Vertical drags use a plane that faces
   * the camera, which keeps the cutter tracking the cursor from any orbit angle.
   */
  private beginCutterDrag(mesh: Mesh, e: PointerEvent): void {
    const id = mesh.userData.cutterId as number;
    const entry = (mesh.userData.entry as Vector3).clone();

    const mode: CutterDrag['mode'] = e.altKey ? 'vertical' : 'ground';
    const plane =
      mode === 'ground'
        ? new Plane(new Vector3(0, 1, 0), -entry.y)
        : (() => {
            const facing = new Vector3()
              .subVectors(this.camera.position, entry)
              .setY(0)
              .normalize();
            return new Plane(facing, -facing.dot(entry));
          })();

    this.setNdc(e);
    const hit = new Vector3();
    if (!this.raycaster.ray.intersectPlane(plane, hit)) return;

    this.drag = { id, mode, plane, offset: entry.clone().sub(hit), moved: false };
    this.onCutterPick?.(id);
  }

  private updateCutterDrag(e: PointerEvent): void {
    const d = this.drag;
    if (!d) return;
    this.setNdc(e);
    const hit = new Vector3();
    if (!this.raycaster.ray.intersectPlane(d.plane, hit)) return;

    const next = hit.add(d.offset);
    const snap = (v: number) =>
      e.metaKey || e.ctrlKey ? Math.round(v / SNAP_MM) * SNAP_MM : Math.round(v * 1e3) / 1e3;

    // The plane fixes the axes this drag must not change; take those straight from the
    // cutter's current entry point rather than trusting the intersection to be exact.
    const current = this.entryOf(d.id);
    if (!current) return;

    // Open the undo step *before* the first move lands, or the snapshot captures a
    // position the cutter has already been dragged to.
    if (!d.moved) {
      d.moved = true;
      this.onCutterDragStart?.(d.id);
    }

    if (d.mode === 'ground') {
      this.onCutterDragMove?.(d.id, snap(next.x), current.y, snap(next.z));
    } else {
      this.onCutterDragMove?.(d.id, current.x, snap(next.y), current.z);
    }
  }

  /** Client-space position of a cutter's entry point. Used by the browser tests. */
  projectEntry(id: number): { x: number; y: number } | null {
    const entry = this.entryOf(id);
    if (!entry) return null;
    const v = entry.clone().project(this.camera);
    const r = this.renderer.domElement.getBoundingClientRect();
    return {
      x: r.left + ((v.x + 1) / 2) * r.width,
      y: r.top + ((1 - v.y) / 2) * r.height,
    };
  }

  private bindControls(): void {
    const el = this.renderer.domElement;
    let dragging = false;
    let panning = false;
    let lx = 0;
    let ly = 0;

    el.addEventListener('pointerdown', (e) => {
      // The gizmo has its own listeners on this element; when the pointer is on one of
      // its handles it owns the gesture, so neither orbit nor cutter-drag may start.
      if (this.gizmoBusy()) return;
      el.setPointerCapture(e.pointerId);

      // A plain left press on a cutter grabs it; anything else falls through to orbit.
      if (e.button === 0 && !e.shiftKey) {
        const hit = this.pickCutter(e);
        if (hit) {
          this.beginCutterDrag(hit, e);
          return;
        }
      }

      dragging = true;
      panning = e.button === 2 || e.button === 1 || e.shiftKey;
      lx = e.clientX;
      ly = e.clientY;
    });
    el.addEventListener('pointermove', (e) => {
      if (this.drag) {
        this.updateCutterDrag(e);
        return;
      }
      if (!dragging) {
        el.style.cursor = this.gizmoBusy() ? '' : this.pickCutter(e) ? 'grab' : '';
        return;
      }
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
      if (this.drag) {
        const wasDrag = this.drag.moved;
        this.drag = null;
        el.style.cursor = '';
        if (wasDrag) this.onCutterDragEnd?.();
      }
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
    // Draw the body before the ghosts so that in x-ray they blend on top of it rather
    // than fighting for order by centroid distance.
    this.bodyMesh.renderOrder = 1;
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

  /**
   * World matrices of the current cutter ghosts, keyed by cutter id. Ghost order tracks
   * the enabled cutters, so callers must match on the id rather than an index.
   */
  ghostMatrices(): { id: number; matrix: number[] }[] {
    return this.ghosts.children.map((c) => {
      c.updateMatrixWorld(true);
      return { id: c.userData.cutterId as number, matrix: [...c.matrixWorld.elements] };
    });
  }

  /** Translucent red previews of the cutter solids, rebuilt whenever params change. */
  setGhosts(items: GhostItem[]): void {
    while (this.ghosts.children.length) {
      const child = this.ghosts.children.pop() as Mesh;
      child.geometry.dispose();
    }
    for (const { id, solid, selected, entry } of items) {
      const mesh = new Mesh(solid.geom, selected ? this.matCutSel : this.matCut);
      mesh.applyMatrix4(solid.matrix);
      // The ghost meshes are rebuilt on every store change, so the id — not the object —
      // is what a drag holds on to. The entry point is carried explicitly because the
      // mesh's own origin is the solid's centre, which sits `depth/2` down the axis.
      mesh.userData.cutterId = id;
      mesh.userData.entry = new Vector3(entry.x, entry.y, entry.z);
      mesh.renderOrder = 2;
      this.ghosts.add(mesh);
    }
  }

  private entryOf(id: number): Vector3 | null {
    const mesh = this.ghosts.children.find((c) => c.userData.cutterId === id);
    return (mesh?.userData.entry as Vector3 | undefined) ?? null;
  }
}
