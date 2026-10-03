import { writable } from 'svelte/store'
import { browser } from '$app/environment'
import { migratePackages } from './packages'
import type { RetrievalPackage } from './packages'

const KEY = 'retrieval-packages-v1'
const saved = browser ? localStorage.getItem(KEY) : null
const initial = saved ? migratePackages(JSON.parse(saved)) : { schemaVersion: 1, packages: [] }

function createPackageStore() {
  const { subscribe, update } = writable<{ schemaVersion: number; packages: RetrievalPackage[] }>(initial)
  return {
    subscribe,
    upsert(pkg: RetrievalPackage) {
      update((state) => {
        const exists = state.packages.some((p) => p.id === pkg.id)
        return {
          ...state,
          packages: exists
            ? state.packages.map((p) => (p.id === pkg.id ? pkg : p))
            : [...state.packages, pkg],
        }
      })
    },
    remove(id: string) {
      update((state) => ({ ...state, packages: state.packages.filter((p) => p.id !== id) }))
    },
    reset() {
      update(() => ({ schemaVersion: 1, packages: [] }))
    },
  }
}

export const packageStore = createPackageStore()

if (browser) {
  packageStore.subscribe((state) => localStorage.setItem(KEY, JSON.stringify(state)))
}
