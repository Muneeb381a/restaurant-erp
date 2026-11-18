import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { clearCache } from './persist';
import { storageKey } from './tenant';

export interface Tokens {
  accessToken: string;
  refreshToken: string;
}

interface AuthState {
  tokens: Tokens | null;
  /** username shown on the login screen next time (never the PIN) */
  lastUsername: string;
  setTokens: (t: Tokens | null) => void;
  setLastUsername: (u: string) => void;
  logout: () => void;
}

/** Tokens survive a page reload (the counter PC keeps its session until logout / idle lock). */
export const useAuth = create<AuthState>()(
  persist(
    (set) => ({
      tokens: null,
      lastUsername: '',
      setTokens: (tokens) => set({ tokens }),
      setLastUsername: (lastUsername) => set({ lastUsername }),
      logout: () => {
        clearCache(); // nothing of this restaurant stays on the device after sign-out
        set({ tokens: null });
      },
    }),
    {
      name: storageKey('erp-auth'),
      partialize: (s) => ({ tokens: s.tokens, lastUsername: s.lastUsername }),
    },
  ),
);
