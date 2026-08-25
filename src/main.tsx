import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from '@/app';
import { KerfController } from '@/controller';
import { KerfProvider } from '@/kerf-context';
import './style.css';

const root = document.getElementById('root');
if (!root) throw new Error('missing #root in index.html');

// Shark's dark variant keys off a `.dark` class, so the OS preference has to be
// mirrored onto the root element rather than handled by prefers-color-scheme alone.
const dark = window.matchMedia('(prefers-color-scheme: dark)');
const syncTheme = (matches: boolean) =>
  document.documentElement.classList.toggle('dark', matches);
syncTheme(dark.matches);
dark.addEventListener('change', (e) => syncTheme(e.matches));

// The controller owns the worker and the WebGL viewport, so it lives outside React and
// is created once — StrictMode's double-invoke must not spin up a second worker.
const controller = new KerfController();

createRoot(root).render(
  <StrictMode>
    <KerfProvider value={controller}>
      <App />
    </KerfProvider>
  </StrictMode>,
);
