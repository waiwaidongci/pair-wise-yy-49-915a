import { writable, get } from 'svelte/store'
import { browser } from '$app/environment'
import { curriculumStore, type CurriculumState } from '../stores'
import {
  createPackage,
  migrateRegistry,
  generateNext,
  generateShard,
  deliverPackage,
  submitMaterial,
  invalidateStalePackages,
  reissue,
  emptyRegistry,
  type RegistryState,
  type AccessPackage,
  type CourseMaterial,
} from './engine'

const PACKAGE_KEY = 'curriculum-access-packages-v1'

function load(): RegistryState {
  if (!browser) return emptyRegistry()
  return migrateRegistry(JSON.parse(localStorage.getItem(PACKAGE_KEY) ?? 'null'))
}

function snapshotContent(state: CurriculumState) {
  return {
    contentVersion: state.contentVersion,
    revision: state.revision,
    nodes: structuredClone(state.nodes),
    mappings: structuredClone(state.mappings),
    reviewItems: structuredClone(state.reviewItems),
  }
}

function createPackageStore() {
  const { subscribe, update, set } = writable<RegistryState>(load())

  /** 发起调阅：固定毕业要求、课程、映射与审阅意见（连同当前内容版本一起冻结）。 */
  function initiate(params: { requirementIds: string[]; courseIds: string[]; createdBy: string }): AccessPackage {
    let created!: AccessPackage
    const now = new Date().toISOString()
    update((registry) => {
      const content = get(curriculumStore)
      const result = createPackage(registry, {
        requirementIds: params.requirementIds,
        courseIds: params.courseIds,
        createdBy: params.createdBy || '认证专家组',
        now,
        snapshot: { createdAt: now, ...snapshotContent(content) },
      })
      created = result.pkg
      return result.state
    })
    return created
  }

  /** 生成（或失败后续作）下一片未完成课程；已完成分片不重复。 */
  function generate(packageId: string, opts: { forceError?: string } = {}) {
    update((registry) => generateNext(registry, packageId, { now: new Date().toISOString(), forceError: opts.forceError }))
  }

  /** 按课程号重跑指定分片（仅失败/待生成分片有效）。 */
  function regenerateShard(packageId: string, courseId: string, opts: { forceError?: string } = {}) {
    update((registry) => generateShard(registry, packageId, courseId, { now: new Date().toISOString(), forceError: opts.forceError }))
  }

  function deliver(packageId: string) {
    update((registry) => deliverPackage(registry, packageId, new Date().toISOString()))
  }

  /** 管理员补交材料：仅接收当前内容版本的首次提交，晚到/并发提交保留草稿。 */
  function submit(input: {
    packageId: string
    courseId: string
    requirementId: string
    content: string
    submittedBy: string
    baseVersion: number
  }) {
    let result: ReturnType<typeof submitMaterial> | undefined
    update((registry) => {
      const currentVersion = get(curriculumStore).contentVersion
      result = submitMaterial(registry, { ...input, currentVersion, now: new Date().toISOString() })
      return result.state
    })
    return result
  }

  /** 草稿基于当前版本重新提交（两名管理员冲突后的人工续作入口）；只有被接收才移除草稿。 */
  function applyDraft(draftId: string, content?: string) {
    const registry = get({ subscribe })
    const draft = registry.drafts.find((item) => item.id === draftId)
    if (!draft) return
    const result = submit({
      packageId: draft.packageId,
      courseId: draft.courseId,
      requirementId: draft.requirementId,
      content: content ?? draft.content,
      submittedBy: draft.submittedBy,
      baseVersion: get(curriculumStore).contentVersion,
    })
    if (result?.accepted) discardDraft(draftId)
    return result
  }

  function discardDraft(draftId: string) {
    update((registry) => ({ ...registry, drafts: registry.drafts.filter((draft) => draft.id !== draftId) }))
  }

  /** 失效包按当前图谱重算：新包号、新快照，并与原包双向关联。 */
  function reissuePackage(packageId: string, createdBy: string) {
    let issued: AccessPackage | undefined
    update((registry) => {
      const content = get(curriculumStore)
      const now = new Date().toISOString()
      const result = reissue(registry, {
        packageId,
        createdBy: createdBy || '认证专家组',
        current: { now, ...snapshotContent(content) },
      })
      if (!result) return registry
      issued = result.pkg
      return result.state
    })
    return issued
  }

  function reset() {
    set(emptyRegistry())
  }

  return {
    subscribe,
    initiate,
    generate,
    regenerateShard,
    deliver,
    submit,
    applyDraft,
    discardDraft,
    reissuePackage,
    reset,
  }
}

export const packageStore = createPackageStore()

if (browser) {
  packageStore.subscribe((registry) => localStorage.setItem(PACKAGE_KEY, JSON.stringify(registry)))

  const syncVersion = (version: number) => {
    const { state, invalidated } = invalidateStalePackages(get(packageStore), version, new Date().toISOString())
    if (invalidated.length > 0) (packageStore as unknown as { set(value: RegistryState): void }).set(state)
  }

  // 页面加载先对齐一次：上次会话遗留、版本已落后的未交付包同样失效。
  let lastVersion = get(curriculumStore).contentVersion
  syncVersion(lastVersion)

  // 图谱或审阅结论一变（contentVersion 推进），未交付调阅包立即失效；已交付包冻结。
  curriculumStore.subscribe((content) => {
    if (content.contentVersion === lastVersion) return
    lastVersion = content.contentVersion
    syncVersion(content.contentVersion)
  })
}

export type { AccessPackage, CourseMaterial }
