import { create } from "zustand"

export interface LogEntry {
  id: string
  title: string
  content: string
  timestamp: number
  read: boolean
}

interface LogState {
  entries: LogEntry[]
  panelOpen: boolean
  addLog: (title: string, content: string) => void
  markAllRead: () => void
  clearLogs: () => void
  openPanel: () => void
  closePanel: () => void
  togglePanel: () => void
}

let nextId = 0

export const useLogStore = create<LogState>((set) => ({
  entries: [],
  panelOpen: false,
  addLog: (title, content) =>
    set((state) => ({
      entries: [
        {
          id: String(++nextId),
          title,
          content,
          timestamp: Date.now(),
          read: false,
        },
        ...state.entries,
      ].slice(0, 500),
    })),
  markAllRead: () =>
    set((state) => ({
      entries: state.entries.map((e) => ({ ...e, read: true })),
    })),
  clearLogs: () => set({ entries: [] }),
  openPanel: () =>
    set((state) => ({
      panelOpen: true,
      entries: state.entries.map((e) => ({ ...e, read: true })),
    })),
  closePanel: () => set({ panelOpen: false }),
  togglePanel: () =>
    set((state) => {
      if (state.panelOpen) return { panelOpen: false }
      return {
        panelOpen: true,
        entries: state.entries.map((e) => ({ ...e, read: true })),
      }
    }),
}))

export function addLog(title: string, content: string): void {
  useLogStore.getState().addLog(title, content)
}
