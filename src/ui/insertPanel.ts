import type { AppState, InsertSource } from '../types';
import type { Panel, UiContext } from './context';
import { btnrow, button, checkbox, hint, labeled, numField, row, section } from './fields';

function encodeSource(src: InsertSource): string {
  return src.kind === 'group' ? `grp:${src.groupId}` : `cut:${src.cutterId}`;
}

function decodeSource(v: string): InsertSource | null {
  if (v.startsWith('grp:')) return { kind: 'group', groupId: v.slice(4) };
  if (v.startsWith('cut:')) return { kind: 'cutter', cutterId: Number(v.slice(4)) };
  return null;
}

/** Groups first, then loose cutters whose shape has a meaningful mating part. */
function sourceOptions(state: AppState): { value: string; label: string }[] {
  const opts: { value: string; label: string }[] = [];
  for (const gid of Object.keys(state.groups)) {
    opts.push({ value: `grp:${gid}`, label: `Twist-lock set ${gid} → pin` });
  }
  for (const c of state.cutters) {
    if (c.group) continue;
    if (c.type !== 'cyl' && c.type !== 'box' && c.type !== 'hex') continue;
    opts.push({ value: `cut:${c.id}`, label: `${c.name} #${c.id}` });
  }
  return opts;
}

export function createInsertPanel(ctx: UiContext): Panel {
  const { el, body } = section('Mating insert');

  const sourceSelect = document.createElement('select');
  sourceSelect.addEventListener('change', () => {
    ctx.store.update((s) => {
      s.insert.source = decodeSource(sourceSelect.value);
    });
  });

  const clearance = numField(
    'Clearance / side',
    ctx.store.state.insert.clearance,
    0.05,
    (v) => {
      ctx.store.update(
        (s) => {
          s.insert.clearance = Math.max(0, v);
        },
        { coalesce: 'insert:clearance' },
      );
    },
    0,
  );

  body.appendChild(row(labeled('Build from', sourceSelect), clearance));

  const cap = checkbox('Add cap / knob on top', ctx.store.state.insert.withCap, (v) => {
    ctx.store.update((s) => {
      s.insert.withCap = v;
    });
  });
  body.appendChild(cap.el);

  const generate = button('Generate insert', () => ctx.generateInsert(), 'primary');
  const clear = button('Remove', () => ctx.clearInsert());
  body.appendChild(btnrow(generate, clear));

  body.appendChild(
    hint(
      'The insert copies the selected hole’s shape shrunk by the clearance on every side, so it ' +
        'snaps or twist-locks into the printed cavity. 0.20 mm suits a P1S with a 0.4 mm nozzle; ' +
        'use 0.10–0.15 for press fits, 0.30 for free rotation.',
    ),
  );

  let optionSig = '';

  return {
    el,
    update(state) {
      const opts = sourceOptions(state);
      const sig = opts.map((o) => o.value + o.label).join('|');
      if (sig !== optionSig) {
        optionSig = sig;
        sourceSelect.innerHTML = '';
        for (const o of opts) {
          const opt = document.createElement('option');
          opt.value = o.value;
          opt.textContent = o.label;
          sourceSelect.appendChild(opt);
        }
      }

      const wanted = state.insert.source ? encodeSource(state.insert.source) : '';
      const valid = opts.some((o) => o.value === wanted);
      if (valid) {
        if (sourceSelect.value !== wanted) sourceSelect.value = wanted;
      } else if (opts.length) {
        // The chosen source vanished (cutter deleted, project loaded) — adopt the first.
        sourceSelect.value = opts[0].value;
        const next = decodeSource(opts[0].value);
        if (next) {
          ctx.store.update(
            (s) => {
              s.insert.source = next;
            },
            { transient: true },
          );
        }
      }

      clearance.sync(state.insert.clearance);
      if (document.activeElement !== cap.input) cap.input.checked = state.insert.withCap;
      generate.disabled = opts.length === 0;
      clear.disabled = !ctx.hasInsert();
    },
  };
}
