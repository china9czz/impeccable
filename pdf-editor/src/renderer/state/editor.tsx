import { createContext, useContext, useEffect, useMemo, useSyncExternalStore, type ReactNode } from 'react';
import { EditorStore, type EditorState } from '../pdfcore/store';
import { getPlatform } from '../platform';

const StoreContext = createContext<EditorStore | null>(null);

export function StoreProvider({ children }: { children: ReactNode }) {
  const store = useMemo(() => new EditorStore(getPlatform()), []);
  // Exposed for the E2E harness and manual debugging in devtools.
  useEffect(() => {
    window.__vellumStore = store;
    return () => {
      delete window.__vellumStore;
    };
  }, [store]);
  return <StoreContext.Provider value={store}>{children}</StoreContext.Provider>;
}

export function useStore(): EditorStore {
  const store = useContext(StoreContext);
  if (!store) throw new Error('useStore must be used inside StoreProvider');
  return store;
}

export function useEditorState(): EditorState {
  const store = useStore();
  return useSyncExternalStore(store.subscribe, store.getState);
}
