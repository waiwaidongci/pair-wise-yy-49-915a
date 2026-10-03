import { writable } from 'svelte/store'
import { browser } from '$app/environment'
import type { GraphNode, Mapping, ReviewItem } from './seed'
import { seedState } from './seed'

export type CurriculumState = {
  /** 图谱/审阅内容版本号：课程、映射、审阅结论每变更一次 +1；节点坐标变化不计。 */
  contentVersion: number
  nodes: GraphNode[]
  mappings: Mapping[]
  reviewItems: ReviewItem[]
  revision: string
  locked: boolean
  draft: string
}

const STORAGE_KEY = 'curriculum-map-draft-v1'

/** 兼容升级：已有本地数据缺少版本号时，先补齐为 v1 再使用。 */
function migrate(raw: string | null): CurriculumState {
  const fallback: CurriculumState = {
    ...structuredClone(seedState),
    contentVersion: 1,
    draft: 'C-308 对 GR-06 的案例证据不足，需补充评分记录。',
  }
  if (!raw) return fallback
  try {
    const parsed = JSON.parse(raw) as Partial<CurriculumState>
    return {
      ...fallback,
      ...parsed,
      nodes: Array.isArray(parsed.nodes) ? parsed.nodes : fallback.nodes,
      mappings: Array.isArray(parsed.mappings) ? parsed.mappings : fallback.mappings,
      reviewItems: Array.isArray(parsed.reviewItems) ? parsed.reviewItems : fallback.reviewItems,
      contentVersion: typeof parsed.contentVersion === 'number' ? parsed.contentVersion : 1,
    }
  } catch {
    return fallback
  }
}

const initial = migrate(browser ? localStorage.getItem(STORAGE_KEY) : null)

function withBump(state: CurriculumState, patch: Partial<CurriculumState>): CurriculumState {
  return { ...state, ...patch, contentVersion: state.contentVersion + 1 }
}

function createCurriculumStore() {
  const { subscribe, update, set } = writable<CurriculumState>(initial)
  return {
    subscribe,
    set,
    update,
    /** 仅布局调整：不推进内容版本，避免无谓地使调阅包失效。 */
    moveNode(id: string, x: number, y: number) {
      update((state) => ({ ...state, nodes: state.nodes.map((node) => (node.id === id ? { ...node, x, y } : node)) }))
    },
    /** 映射变更：内容版本 +1，未交付调阅包随之失效。 */
    addMapping(source: string, target: string, relation: Mapping['relation'], weight: number) {
      if (source === target) return
      update((state) =>
        withBump(state, { mappings: [...state.mappings, { id: `M-${Date.now()}`, source, target, relation, weight }] }),
      )
    },
    /** 审阅结论变更（状态/意见/证据）才推进版本；无实际变化不动。 */
    updateReview(id: string, status: ReviewItem['status'], comment: string) {
      update((state) => {
        const current = state.reviewItems.find((item) => item.id === id)
        if (!current || (current.status === status && current.comment === comment)) return state
        return withBump(state, {
          reviewItems: state.reviewItems.map((item) => (item.id === id ? { ...item, status, comment } : item)),
        })
      })
    },
    /** 课程负责人经服务端校验后新增的修订条目同样计入内容版本。 */
    addReviewItem(item: ReviewItem) {
      update((state) =>
        state.reviewItems.some((existing) => existing.id === item.id)
          ? state
          : withBump(state, { reviewItems: [item, ...state.reviewItems] }),
      )
    },
    saveDraft(draft: string) {
      update((state) => ({ ...state, draft }))
    },
    lock(revision: string) {
      update((state) => ({ ...state, revision, locked: true }))
    },
  }
}

export const curriculumStore = createCurriculumStore()

if (browser) {
  curriculumStore.subscribe((state) => localStorage.setItem(STORAGE_KEY, JSON.stringify(state)))
}

export function validateCurriculum(state: CurriculumState) {
  const issues: Array<{ id: string; severity: '错误' | '警告'; title: string; detail: string }> = []
  const outgoing = new Map<string, Mapping[]>()
  state.mappings.forEach((mapping) => outgoing.set(mapping.source, [...(outgoing.get(mapping.source) ?? []), mapping]))
  state.nodes.filter((node) => node.type === '毕业要求').forEach((node) => {
    if (!(outgoing.get(node.id) ?? []).some((mapping) => state.nodes.find((item) => item.id === mapping.target)?.type === '课程')) {
      issues.push({ id: `coverage-${node.id}`, severity: '错误', title: `${node.label.split('\n')[0]} 存在覆盖缺口`, detail: '未关联任何课程支撑证据。' })
    }
  })
  const seen = new Set<string>()
  state.mappings.forEach((mapping) => {
    const key = `${mapping.source}-${mapping.target}-${mapping.relation}`
    if (seen.has(key)) issues.push({ id: `dup-${mapping.id}`, severity: '警告', title: `${mapping.id} 为重复映射`, detail: '相同来源、目标和关系重复录入，可合并。' })
    seen.add(key)
  })
  return issues
}
