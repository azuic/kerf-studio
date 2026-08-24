import './style.css';
import { App } from './ui/app';

function required<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id} in index.html`);
  return el as T;
}

new App(
  required('sidebar'),
  required('viewport'),
  required('status'),
  required('busy'),
);
