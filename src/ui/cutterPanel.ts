import { defaultName, defaultParams } from '../model/geometry';
import type { AppState, Cutter, CutterType } from '../types';
import { baseHeight } from '../types';
import type { Panel, UiContext } from './context';
import { btnrow, button, hint, numField, row, section, type NumField } from './fields';

const ADD_BUTTONS: { type: CutterType; label: string }[] = [
  { type: 'cyl', label: '+ Round hole' },
  { type: 'box', label: '+ Rect hole' },
  { type: 'hex', label: '+ Hex hole' },
  { type: 'gap', label: '+ Wall gap' },
];

export function createCutterPanel(ctx: UiContext): Panel {
  const { el, body } = section('Cutters');

  const list = document.createElement('div');
  list.id = 'cutterList';
  body.appendChild(list);

  body.appendChild(
    btnrow(...ADD_BUTTONS.map((b) => button(b.label, () => addCutter(ctx, b.type)))),
  );
  body.appendChild(btnrow(button('+ Twist-lock (bayonet) set', () => addBayonet(ctx), 'primary')));
  body.appendChild(
    hint(
      'A wall gap is a long narrow slot that punches through both side walls but stops above ' +
        'the floor. A bayonet set stacks a shaft hole, a lug entry notch and a wider groove ' +
        'below — the matching pin drops in and twists 90° to lock.',
    ),
  );

  const props = document.createElement('div');
  body.appendChild(props);

  let listSignature = '';
  let propsSignature = '';
  let propFields: { get(s: AppState): number; field: NumField }[] = [];

  function renderList(state: AppState): void {
    list.innerHTML = '';
    if (state.cutters.length === 0) {
      list.appendChild(hint('No cutters yet — add a hole below.'));
      return;
    }
    for (const c of state.cutters) {
      const item = document.createElement('div');
      item.className = 'cutter-item' + (c.id === state.selected ? ' selected' : '');

      const check = document.createElement('input');
      check.type = 'checkbox';
      check.checked = c.enabled;
      check.title = 'enable';
      check.addEventListener('click', (e) => {
        e.stopPropagation();
        ctx.store.update((s) => {
          const t = s.cutters.find((x) => x.id === c.id);
          if (t) t.enabled = check.checked;
        });
        ctx.requestBody();
      });

      const tag = document.createElement('span');
      tag.className = c.group ? 'tag grp' : 'tag';
      tag.textContent = c.group ?? 'cut';

      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = c.name;

      item.append(check, tag, name);
      item.addEventListener('click', () => {
        ctx.store.update(
          (s) => {
            s.selected = c.id;
          },
          { transient: true },
        );
        ctx.requestBody();
      });
      list.appendChild(item);
    }
  }

  function renderProps(state: AppState): void {
    props.innerHTML = '';
    propFields = [];
    const c = state.cutters.find((x) => x.id === state.selected);
    if (!c) return;

    const title = document.createElement('div');
    title.className = 'row';
    title.style.marginTop = '12px';
    const strong = document.createElement('strong');
    strong.style.fontSize = '13px';
    strong.textContent = c.name;
    title.appendChild(strong);
    props.appendChild(title);

    const editParam =
      (key: keyof Cutter['params'], clampMin?: number) =>
      (v: number): void => {
        ctx.store.update(
          (s) => {
            const t = s.cutters.find((x) => x.id === c.id);
            if (t) t.params[key] = clampMin === undefined ? v : Math.max(clampMin, v);
          },
          { coalesce: `cutter:${c.id}:${String(key)}` },
        );
        ctx.requestBody();
      };

    const track = (get: (s: AppState) => number, field: NumField): NumField => {
      propFields.push({ get, field });
      return field;
    };
    const cur = (s: AppState): Cutter | undefined => s.cutters.find((x) => x.id === c.id);
    const p = (key: keyof Cutter['params'], fallback = 0) => (s: AppState) =>
      (cur(s)?.params[key] as number | undefined) ?? fallback;

    if (c.type === 'cyl' || c.type === 'groove') {
      props.appendChild(
        row(track(p('dia'), numField('Diameter', c.params.dia ?? 10, 0.5, editParam('dia'), 0.5))),
      );
    }
    if (c.type === 'hex') {
      props.appendChild(
        row(track(p('af'), numField('Across flats', c.params.af ?? 10, 0.5, editParam('af'), 0.5))),
      );
    }
    if (c.type === 'box' || c.type === 'gap') {
      props.appendChild(
        row(
          track(p('w'), numField('Width X', c.params.w ?? 10, 0.5, editParam('w'), 0.5)),
          track(p('l'), numField('Length Z', c.params.l ?? 10, 0.5, editParam('l'), 0.5)),
        ),
      );
    }
    props.appendChild(
      row(
        track(p('depth'), numField('Depth', c.params.depth, 0.5, editParam('depth'), 0.5)),
        track(
          p('topOffset'),
          numField('Start below top', c.params.topOffset, 0.5, editParam('topOffset', 0), 0),
        ),
      ),
    );
    props.appendChild(
      row(
        track(p('x'), numField('Pos X', c.params.x, 0.5, editParam('x'))),
        track(p('z'), numField('Pos Z', c.params.z, 0.5, editParam('z'))),
        track(p('rotY'), numField('Rot Y°', c.params.rotY, 5, editParam('rotY'))),
      ),
    );

    props.appendChild(
      btnrow(
        button('Duplicate', () => duplicate(ctx, c.id)),
        button('Delete', () => remove(ctx, c.id), 'danger'),
      ),
    );

    if (c.group) {
      props.appendChild(
        hint(
          `Part of twist-lock set ${c.group}. Keep shaft, entry and groove centred on the same ` +
            `X/Z. The insert generator builds the matching pin from the set's stored parameters, ` +
            `not from manual edits to these three cutters.`,
        ),
      );
    }
  }

  return {
    el,
    update(state) {
      const sig = state.cutters
        .map((c) => `${c.id}:${c.name}:${c.enabled ? 1 : 0}:${c.group ?? ''}`)
        .join('|');
      const listSig = `${sig}#${String(state.selected)}`;
      if (listSig !== listSignature) {
        listSignature = listSig;
        renderList(state);
      }

      const sel = state.cutters.find((x) => x.id === state.selected);
      const propSig = sel ? `${sel.id}:${sel.type}:${sel.name}` : '';
      if (propSig !== propsSignature) {
        propsSignature = propSig;
        renderProps(state);
      } else {
        for (const { get, field } of propFields) field.sync(get(state));
      }
    },
  };
}

function addCutter(ctx: UiContext, type: CutterType): void {
  ctx.store.update((s) => {
    const c: Cutter = {
      id: s.nextId++,
      type,
      name: defaultName(type),
      enabled: true,
      group: null,
      params: defaultParams(type, s.base),
    };
    s.cutters.push(c);
    s.selected = c.id;
  });
  ctx.requestBody();
}

/**
 * A twist-lock set is three stacked cutters sharing a group id:
 *   1. the shaft hole, 2. the lug entry notch, 3. a wider groove buried at the bottom.
 * The pin drops through the shaft and notch, its lugs land in the groove, twist 90° → locked.
 */
function addBayonet(ctx: UiContext): void {
  ctx.store.update((s) => {
    const gid = 'G' + s.nextGroup++;
    const h = baseHeight(s.base) || 20;
    const P = {
      dia: 12,
      lugW: 4,
      lugLen: 3.2,
      lugTh: 3,
      depth: Math.min(Math.max(8, h * 0.4), Math.max(2, h - 2)),
      x: 0,
      z: 0,
      grooveH: 3.6,
    };
    P.grooveH = P.lugTh + 0.6;
    s.groups[gid] = P;

    const mk = (type: CutterType, name: string, params: Cutter['params']): void => {
      s.cutters.push({ id: s.nextId++, type, name, enabled: true, group: gid, params });
      s.selected = s.nextId - 1;
    };
    mk('cyl', 'Bayonet · shaft', {
      dia: P.dia,
      depth: P.depth,
      x: P.x,
      z: P.z,
      rotY: 0,
      topOffset: 0,
    });
    mk('box', 'Bayonet · lug entry', {
      w: P.dia + 2 * P.lugLen,
      l: P.lugW,
      depth: P.depth,
      x: P.x,
      z: P.z,
      rotY: 0,
      topOffset: 0,
    });
    mk('groove', 'Bayonet · groove', {
      dia: P.dia + 2 * P.lugLen,
      depth: P.grooveH,
      x: P.x,
      z: P.z,
      rotY: 0,
      topOffset: Math.max(0, P.depth - P.grooveH),
    });
    s.insert.source = { kind: 'group', groupId: gid };
  });
  ctx.requestBody();
}

function duplicate(ctx: UiContext, id: number): void {
  ctx.store.update((s) => {
    const c = s.cutters.find((x) => x.id === id);
    if (!c) return;
    const copy: Cutter = {
      ...structuredClone(c),
      id: s.nextId++,
      name: c.name + ' copy',
    };
    copy.params.x += 8;
    s.cutters.push(copy);
    s.selected = copy.id;
  });
  ctx.requestBody();
}

function remove(ctx: UiContext, id: number): void {
  ctx.store.update((s) => {
    const c = s.cutters.find((x) => x.id === id);
    if (!c) return;
    s.cutters = s.cutters.filter((x) => x.id !== id);
    if (c.group && !s.cutters.some((x) => x.group === c.group)) {
      delete s.groups[c.group];
      if (s.insert.source?.kind === 'group' && s.insert.source.groupId === c.group) {
        s.insert.source = null;
      }
    }
    if (s.insert.source?.kind === 'cutter' && s.insert.source.cutterId === id) {
      s.insert.source = null;
    }
    s.selected = s.cutters.length ? s.cutters[s.cutters.length - 1].id : null;
  });
  ctx.requestBody();
}
