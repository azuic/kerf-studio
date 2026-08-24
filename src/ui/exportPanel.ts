import type { Panel, UiContext } from './context';
import { btnrow, button, checkbox, hint, section } from './fields';

export function createExportPanel(ctx: UiContext): Panel {
  const { el, body } = section('Compute & export');

  const auto = checkbox('Auto-preview cuts (live boolean)', ctx.store.state.autoPreview, (v) => {
    ctx.store.update(
      (s) => {
        s.autoPreview = v;
      },
      { transient: true },
    );
    if (v) ctx.requestBody();
  });
  body.appendChild(auto.el);

  body.appendChild(btnrow(button('Apply cuts now', () => ctx.computeNow())));

  const expBody = button('Download body STL', () => ctx.exportBody(), 'primary');
  const expInsert = button('Download insert STL', () => ctx.exportInsert());
  body.appendChild(btnrow(expBody, expInsert));

  body.appendChild(
    hint(
      'Binary STL in millimetres — drop straight into Bambu Studio / OrcaSlicer. The cut result ' +
        'you see is exactly what exports.',
    ),
  );

  return {
    el,
    update(state) {
      if (document.activeElement !== auto.input) auto.input.checked = state.autoPreview;
      expInsert.disabled = !ctx.hasInsert();
    },
  };
}

export function createProjectPanel(ctx: UiContext): Panel {
  const { el, body } = section('Project');

  const file = document.createElement('input');
  file.type = 'file';
  file.accept = '.json,.kerf.json';
  file.style.display = 'none';
  file.addEventListener('change', () => {
    const f = file.files?.[0];
    if (f) ctx.loadProject(f);
    file.value = '';
  });

  const undoBtn = button('Undo', () => {
    ctx.store.undo();
    ctx.requestBody();
  });
  const redoBtn = button('Redo', () => {
    ctx.store.redo();
    ctx.requestBody();
  });
  body.appendChild(btnrow(undoBtn, redoBtn));

  body.appendChild(
    btnrow(
      button('Save .kerf.json', () => ctx.saveProject()),
      button('Open…', () => file.click()),
      button('New', () => ctx.newProject()),
      file,
    ),
  );

  body.appendChild(
    hint('Work autosaves to this browser. ⌘/Ctrl+Z undoes, ⌘/Ctrl+Shift+Z redoes.'),
  );

  return {
    el,
    update() {
      undoBtn.disabled = !ctx.store.canUndo;
      redoBtn.disabled = !ctx.store.canRedo;
    },
  };
}
