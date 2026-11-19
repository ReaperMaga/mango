import { create } from 'zustand'

/**
 * Whether this phone has a network right now, as the system reports it (`useNetworkWatch` in
 * `screens/lifecycle.ts` keeps it current). `online` is null until the first report. Nothing is
 * saved: it is read fresh on every start.
 */
export interface NetworkState {
  online: boolean | null
  /** The interface in use ('WIFI', 'CELLULAR', …), as expo-network names it. */
  kind: string
  set(online: boolean | null, kind: string): void
}

export const useNetwork = create<NetworkState>()(set => ({
  online: null,
  kind: 'UNKNOWN',
  set: (online, kind) => set({ online, kind }),
}))
