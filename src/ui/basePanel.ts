import { checkMesh } from '../io/stl';
import { getStlPositions } from '../state/assets';
import type { AppState, BaseType } from '../types';
import { baseHeight, baseSpanX, baseSpanZ } from '../types';
import type { Panel, UiContext } from './context';
import { btnrow, button, labeled, numField, section, select, type NumField } from './fields';

const BASE_TYPES: { value: BaseType; label: string }[] = [
  { value: 'box', label: 'Solid box' },
  { value: 'hbox', label: 'Hollow box (open top)' },
  { value: 'cyl', label: 'Solid cylinder' },
  { value: 'cup', label: 'Cup (hollow cylinder)' },
  { value: 'stl', label: 'Imported STL' },
];

export function createBasePanel(ctx: UiContext): Panel {
  const { el, body } = section('Base model');

  const typeSelect = select((v) => {
    ctx.store.update((s) => {
      s.base.type = v as BaseType;
    });
    ctx.requestBody();
  });
  typeSelect.setOptions(BASE_TYPES, ctx.store.state.base.type);
  body.appendChild(labeled('Type', typeSelect.el));

  const dims = document.createElement('div');
  dims.className = 'row';
  body.appendChild(dims);

  const file = document.createElement('input');
  file.type = 'file';
  file.accept = '.stl';
  file.style.display = 'none';
  file.addEventListener('change', () => {
    const f = file.files?.[0];
    if (f) ctx.importStl(f);
    file.value = '';
  });

  body.appendChild(
    btnrow(
      button('Import STL…', () => file.click()),
      file,
    ),
  );

  const info = document.createElement('div');
  info.className = 'readout';
  body.appendChild(info);

  const meshNote = document.createElement('div');
  meshNote.className = 'hint';
  body.appendChild(meshNote);

  // Rebuild the dimension row only when the base type changes; otherwise sync values.
  let builtFor: BaseType | null = null;
  let fields: NumField[] = [];

  function buildDims(state: AppState): void {
    dims.innerHTML = '';
    fields = [];
    const b = state.base;

    const edit = (key: 'w' | 'd' | 'h' | 'r' | 'wall' | 'floor') => (v: number) => {
      ctx.store.update(
        (s) => {
          s.base[key] = v;
        },
        { coalesce: `base:${key}` },
      );
      ctx.requestBody();
    };

    const add = (f: NumField): void => {
      fields.push(f);
      dims.appendChild(f.el);
    };

    if (b.type === 'box' || b.type === 'hbox') {
      add(numField('W (X)', b.w, 1, edit('w'), 2));
      add(numField('D (Z)', b.d, 1, edit('d'), 2));
      add(numField('H (Y)', b.h, 1, edit('h'), 2));
    } else if (b.type === 'cyl' || b.type === 'cup') {
      add(numField('Radius', b.r, 1, edit('r'), 1));
      add(numField('H (Y)', b.h, 1, edit('h'), 2));
    } else {
      const d = document.createElement('div');
      d.className = 'hint';
      d.textContent = b.stlName
        ? `Loaded: ${b.stlName}`
        : 'Use “Import STL…” to load a model. It is centred in XZ and dropped onto the plate.';
      dims.appendChild(d);
    }

    if (b.type === 'hbox' || b.type === 'cup') {
      add(numField('Wall', b.wall, 0.4, edit('wall'), 0.8));
      add(numField('Floor', b.floor, 0.4, edit('floor'), 0.4));
    }
    builtFor = b.type;
  }

  function syncDims(state: AppState): void {
    const b = state.base;
    let i = 0;
    if (b.type === 'box' || b.type === 'hbox') {
      fields[i++]?.sync(b.w);
      fields[i++]?.sync(b.d);
      fields[i++]?.sync(b.h);
    } else if (b.type === 'cyl' || b.type === 'cup') {
      fields[i++]?.sync(b.r);
      fields[i++]?.sync(b.h);
    }
    if (b.type === 'hbox' || b.type === 'cup') {
      fields[i++]?.sync(b.wall);
      fields[i++]?.sync(b.floor);
    }
  }

  return {
    el,
    update(state) {
      typeSelect.setOptions(BASE_TYPES, state.base.type);
      if (builtFor !== state.base.type) buildDims(state);
      else syncDims(state);

      const b = state.base;
      info.textContent =
        `footprint ${baseSpanX(b).toFixed(1)} × ${baseSpanZ(b).toFixed(1)} mm · ` +
        `height ${baseHeight(b).toFixed(1)} mm` +
        (b.type === 'stl' && b.stlTris ? ` · ${b.stlTris.toLocaleString()} tris` : '');

      meshNote.textContent = describeMesh(state);
      meshNote.style.display = meshNote.textContent ? '' : 'none';
    },
  };
}

/**
 * Imported meshes are checked once on load. A boolean against a mesh with open or
 * non-manifold edges is undefined behaviour in any CSG engine, so say so up front
 * rather than letting the result quietly come out wrong.
 */
let lastCheckedName = '';
let lastCheckText = '';

function describeMesh(state: AppState): string {
  if (state.base.type !== 'stl') return '';
  const positions = getStlPositions();
  if (!positions) return '';
  if (state.base.stlName === lastCheckedName) return lastCheckText;

  const c = checkMesh(positions);
  lastCheckedName = state.base.stlName;
  lastCheckText = c.ok
    ? ''
    : `Mesh warning: ${c.openEdges} open edge${c.openEdges === 1 ? '' : 's'}, ` +
      `${c.nonManifoldEdges} non-manifold, ${c.degenerate} degenerate triangle` +
      `${c.degenerate === 1 ? '' : 's'}. Booleans on a mesh that is not watertight can produce ` +
      `wrong results — repair it before cutting.`;
  return lastCheckText;
}
