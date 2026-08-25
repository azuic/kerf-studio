import { createContext, useContext, useSyncExternalStore } from 'react';
import type { KerfController, ViewState } from '@/controller';
import type { AppState } from '@/types';

const Ctx = createContext<KerfController | null>(null);

export const KerfProvider = Ctx.Provider;

export function useKerf(): KerfController {
  const c = useContext(Ctx);
  if (!c) throw new Error('useKerf must be used inside <KerfProvider>');
  return c;
}

/**
 * The store mutates its state in place, so there is no new object identity to compare.
 * Subscribing to the revision counter is what makes React re-render; components then
 * read the live state.
 */
export function useAppState(): AppState {
  const kerf = useKerf();
  useSyncExternalStore(
    (fn) => kerf.store.subscribe(fn),
    () => kerf.store.version,
  );
  return kerf.store.state;
}

export function useViewState(): ViewState {
  const kerf = useKerf();
  return useSyncExternalStore(kerf.subscribeView, kerf.getView);
}
