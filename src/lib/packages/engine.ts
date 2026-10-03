import type { GraphNode, Mapping, ReviewItem } from '../seed'

/**
 * 专业认证调阅包引擎（纯函数，不依赖 Svelte / 浏览器，便于自测）。
 *
 * 关键不变量：
 * - 调阅包发起时固定毕业要求、课程、映射、审阅意见（snapshot）。
 * - 分片按课程生成，失败后按原包号从「第一片未完成」处继续，已完成分片不重复。
 * - 材料补交走乐观版本控制：只接收基于当前内容版本的首次提交，其余保留为草稿。
 * - 图谱/审阅结论变化（内容版本号变化）后，未交付包失效并按新包号重算；已交付包快照冻结，只做差异追溯。
 */

export type EvidenceRecord = {
  requirementId: string
  content: string
  submittedBy: string
  updatedAt: string
}

/** 管理员补齐的材料，按内容版本号归档，保证与封面版本对得上。 */
export type CourseMaterial = {
  courseId: string
  requirementId: string
  contentVersion: number
  content: string
  submittedBy: string
  updatedAt: string
}

/** 晚到提交保留下来的草稿，不覆盖已接收材料。 */
export type MaterialDraft = {
  id: string
  packageId: string
  courseId: string
  requirementId: string
  /** 起草时所依据的内容版本。 */
  baseVersion: number
  content: string
  submittedBy: string
  reason: 'stale-version' | 'superseded'
  savedAt: string
}

export type CurriculumSnapshot = {
  contentVersion: number
  revision: string
  createdAt: string
  nodes: GraphNode[]
  mappings: Mapping[]
  reviewItems: ReviewItem[]
}

export type ShardIssue = {
  kind: '未审阅' | '缺失证据'
  refId: string
  requirementId: string
  detail: string
}

export type CourseShard = {
  courseId: string
  order: number
  status: 'pending' | 'failed' | 'done'
  error?: string
  generatedAt?: string
  /** 封面标注的内容版本，必须与包快照一致。 */
  coverVersion: number
  issues: ShardIssue[]
  materials: EvidenceRecord[]
}

export type PackageStatus = 'generating' | 'ready' | 'delivered' | 'invalidated'

export type AccessPackage = {
  /** 原包号：失败续作沿用同一编号。 */
  id: string
  seq: number
  requirementIds: string[]
  courseIds: string[]
  status: PackageStatus
  createdBy: string
  createdAt: string
  snapshot: CurriculumSnapshot
  shards: CourseShard[]
  deliveredAt?: string
  invalidatedAt?: string
  invalidReason?: string
  /** 失效重算后，新包指向旧包、旧包指向新包。 */
  supersedesId?: string
  successorId?: string
}

export type RegistryState = {
  packages: AccessPackage[]
  materials: CourseMaterial[]
  drafts: MaterialDraft[]
  seq: number
}

export function emptyRegistry(): RegistryState {
  return { packages: [], materials: [], drafts: [], seq: 0 }
}

/** 兼容升级：旧本地数据没有版本号结构时先补齐字段。 */
export function migrateRegistry(raw: unknown): RegistryState {
  if (!raw || typeof raw !== 'object') return emptyRegistry()
  const data = raw as Partial<RegistryState>
  return {
    packages: Array.isArray(data.packages) ? data.packages : [],
    materials: Array.isArray(data.materials) ? data.materials : [],
    drafts: Array.isArray(data.drafts) ? data.drafts : [],
    seq: typeof data.seq === 'number' ? data.seq : 0,
  }
}

export function formatPackageId(seq: number, now: Date = new Date()): string {
  const ymd = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`
  return `PKG-${ymd}-${String(seq).padStart(3, '0')}`
}

/** 从支撑所选毕业要求的课程中随机抽课；不足时用其余课程补足。 */
export function sampleCourses(
  allCourseIds: string[],
  mappings: Mapping[],
  requirementIds: string[],
  count: number,
  rng: () => number = Math.random,
): string[] {
  const scoped = new Set(
    mappings
      .filter((m) => requirementIds.includes(m.source) && m.relation === '支撑')
      .map((m) => m.target)
      .filter((id) => allCourseIds.includes(id)),
  )
  const linked = shuffle(allCourseIds.filter((id) => scoped.has(id)), rng)
  const rest = shuffle(allCourseIds.filter((id) => !scoped.has(id)), rng)
  return [...linked, ...rest].slice(0, Math.max(0, Math.min(count, allCourseIds.length)))
}

function shuffle<T>(items: T[], rng: () => number): T[] {
  const copy = [...items]
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1))
    ;[copy[i], copy[j]] = [copy[j]!, copy[i]!]
  }
  return copy
}

export type CreatePackageInput = {
  requirementIds: string[]
  courseIds: string[]
  createdBy: string
  snapshot: CurriculumSnapshot
  now: string
  supersedesId?: string
}

export function createPackage(state: RegistryState, input: CreatePackageInput): { state: RegistryState; pkg: AccessPackage } {
  const seq = state.seq + 1
  const pkg: AccessPackage = {
    id: formatPackageId(seq, new Date(input.now)),
    seq,
    requirementIds: [...input.requirementIds],
    courseIds: [...input.courseIds],
    status: 'generating',
    createdBy: input.createdBy,
    createdAt: input.now,
    // 深拷贝，保证发起后外部对图谱/审阅的继续修改不会穿透到已冻结快照。
    snapshot: {
      ...input.snapshot,
      nodes: structuredClone(input.snapshot.nodes),
      mappings: structuredClone(input.snapshot.mappings),
      reviewItems: structuredClone(input.snapshot.reviewItems),
    },
    supersedesId: input.supersedesId,
    shards: input.courseIds.map((courseId, order) => ({
      courseId,
      order,
      status: 'pending',
      coverVersion: input.snapshot.contentVersion,
      issues: [],
      materials: [],
    })),
  }
  const packages = [pkg, ...state.packages]
  const next = { ...state, packages, seq }
  if (input.supersedesId) {
    return {
      state: {
        ...next,
        packages: packages.map((item) => (item.id === input.supersedesId ? { ...item, successorId: pkg.id } : item)),
      },
      pkg,
    }
  }
  return { state: next, pkg }
}

/** 该课程在快照中实际支撑了哪些（范围内的）毕业要求。 */
export function linkedRequirements(pkg: AccessPackage, courseId: string): string[] {
  return [
    ...new Set(
      pkg.snapshot.mappings
        .filter((m) => m.target === courseId && m.relation === '支撑' && pkg.requirementIds.includes(m.source))
        .map((m) => m.source),
    ),
  ]
}

/** 按快照内的审阅意见 + 当前版本下已接收材料，列出某门课「未审阅 / 缺失证据」。 */
export function evaluateShard(pkg: AccessPackage, courseId: string, materials: CourseMaterial[]): { issues: ShardIssue[]; included: EvidenceRecord[] } {
  const requirements = linkedRequirements(pkg, courseId)
  const snapshot = pkg.snapshot
  const issues: ShardIssue[] = []

  snapshot.reviewItems
    .filter((item) => item.courseId === courseId && requirements.includes(item.requirementId))
    .forEach((item) => {
      if (item.status === '待审阅') {
        issues.push({ kind: '未审阅', refId: item.id, requirementId: item.requirementId, detail: '审阅意见尚未出具，证据未获院系确认。' })
      } else if (item.status === '已退回') {
        issues.push({ kind: '未审阅', refId: item.id, requirementId: item.requirementId, detail: `审阅结论为退回：${item.comment || '需补充后重新送审。'}` })
      }
    })

  const acceptedAtVersion = materials.filter((m) => m.courseId === courseId && m.contentVersion === snapshot.contentVersion)
  requirements.forEach((requirementId) => {
    const approved = snapshot.reviewItems.some(
      (item) => item.courseId === courseId && item.requirementId === requirementId && item.status === '已附议',
    )
    const material = acceptedAtVersion.some((m) => m.requirementId === requirementId)
    if (!approved && !material) {
      issues.push({ kind: '缺失证据', refId: `${courseId}/${requirementId}`, requirementId, detail: '既无附议结论，也无当前版本下补齐的支撑证据。' })
    }
  })

  const included: EvidenceRecord[] = acceptedAtVersion
    .filter((m) => requirements.includes(m.requirementId))
    .map((m) => ({ requirementId: m.requirementId, content: m.content, submittedBy: m.submittedBy, updatedAt: m.updatedAt }))

  return { issues, included }
}

export type GenerateOptions = {
  now: string
  /** 演练用：强制本片失败，验证断点续作。 */
  forceError?: string
}

/**
 * 生成指定课程分片。已完成的分片原样返回（幂等，绝不重复生成）。
 * 失败只落错误标记，不影响其他分片。
 */
export function generateShard(state: RegistryState, packageId: string, courseId: string, opts: GenerateOptions): RegistryState {
  return updatePackage(state, packageId, (pkg) => {
    if (pkg.status === 'delivered' || pkg.status === 'invalidated') return pkg
    const shard = pkg.shards.find((item) => item.courseId === courseId)
    if (!shard || shard.status === 'done') return pkg

    if (opts.forceError) {
      return {
        ...pkg,
        shards: pkg.shards.map((item) => (item.courseId === courseId ? { ...item, status: 'failed', error: opts.forceError } : item)),
      }
    }

    const { issues, included } = evaluateShard(pkg, courseId, state.materials)
    const shards = pkg.shards.map((item) =>
      item.courseId === courseId
        ? { ...item, status: 'done' as const, error: undefined, generatedAt: opts.now, coverVersion: pkg.snapshot.contentVersion, issues, materials: included }
        : item,
    )
    return { ...pkg, shards, status: shards.every((item) => item.status === 'done') ? 'ready' : 'generating' }
  })
}

/** 续作起点：第一片未完成（pending/failed）的课程；全部完成返回 null。 */
export function resumePoint(pkg: AccessPackage): { index: number; courseId: string } | null {
  const index = pkg.shards.findIndex((shard) => shard.status !== 'done')
  if (index === -1) return null
  return { index, courseId: pkg.shards[index]!.courseId }
}

export function completedCount(pkg: AccessPackage): number {
  return pkg.shards.filter((shard) => shard.status === 'done').length
}

/** 从断点继续：生成下一片未完成课程，已完成分片不重复。 */
export function generateNext(state: RegistryState, packageId: string, opts: GenerateOptions & { forceErrorOnResume?: boolean }): RegistryState {
  const pkg = state.packages.find((item) => item.id === packageId)
  if (!pkg) return state
  const point = resumePoint(pkg)
  if (!point) return state
  return generateShard(state, packageId, point.courseId, { now: opts.now, forceError: opts.forceError ? opts.forceError : undefined })
}

export function deliverPackage(state: RegistryState, packageId: string, now: string): RegistryState {
  return updatePackage(state, packageId, (pkg) =>
    pkg.status === 'ready' ? { ...pkg, status: 'delivered', deliveredAt: now } : pkg,
  )
}

export type SubmitMaterialInput = {
  packageId: string
  courseId: string
  requirementId: string
  content: string
  submittedBy: string
  /** 管理员打开补材料表单时看到的版本；晚到者据此判定。 */
  baseVersion: number
  currentVersion: number
  now: string
}

export type SubmitMaterialResult = { state: RegistryState; accepted: boolean; reason?: MaterialDraft['reason']; draftId?: string }

/**
 * 两名管理员同时补齐材料：
 * - 只接收基于「当前内容版本」且该课程/要求尚无在版材料的首次提交；
 * - 版本落后 -> stale-version 草稿；已有在版接收记录 -> superseded 草稿。
 */
export function submitMaterial(state: RegistryState, input: SubmitMaterialInput): SubmitMaterialResult {
  const pkg = state.packages.find((item) => item.id === input.packageId)
  if (!pkg || pkg.status === 'delivered' || pkg.status === 'invalidated') {
    return { state, accepted: false }
  }

  const keepDraft = (reason: MaterialDraft['reason']): SubmitMaterialResult => {
    const draft: MaterialDraft = {
      id: `DRF-${state.drafts.length + 1}-${Date.now().toString(36)}`,
      packageId: input.packageId,
      courseId: input.courseId,
      requirementId: input.requirementId,
      baseVersion: input.baseVersion,
      content: input.content,
      submittedBy: input.submittedBy,
      reason,
      savedAt: input.now,
    }
    return { state: { ...state, drafts: [draft, ...state.drafts] }, accepted: false, reason, draftId: draft.id }
  }

  if (input.baseVersion !== input.currentVersion) {
    return keepDraft('stale-version')
  }
  const exists = state.materials.some(
    (m) =>
      m.courseId === input.courseId &&
      m.requirementId === input.requirementId &&
      m.contentVersion === input.currentVersion,
  )
  if (exists) return keepDraft('superseded')

  const material: CourseMaterial = {
    courseId: input.courseId,
    requirementId: input.requirementId,
    contentVersion: input.currentVersion,
    content: input.content,
    submittedBy: input.submittedBy,
    updatedAt: input.now,
  }
  return { state: { ...state, materials: [...state.materials, material] }, accepted: true }
}

/**
 * 图谱或审阅结论一变（内容版本推进）：未交付包一律失效；已交付包保留原快照。
 */
export function invalidateStalePackages(state: RegistryState, currentVersion: number, now: string): { state: RegistryState; invalidated: AccessPackage[] } {
  const invalidated: AccessPackage[] = []
  const packages = state.packages.map((pkg) => {
    if (pkg.status !== 'delivered' && pkg.status !== 'invalidated' && pkg.snapshot.contentVersion !== currentVersion) {
      const next = {
        ...pkg,
        status: 'invalidated' as const,
        invalidatedAt: now,
        invalidReason: `图谱或审阅结论已由 v${pkg.snapshot.contentVersion} 变更为 v${currentVersion}，原调阅材料作废，需按当前版本重算。`,
      }
      invalidated.push(next)
      return next
    }
    return pkg
  })
  return { state: { ...state, packages }, invalidated }
}

export type ReissueInput = {
  packageId: string
  createdBy: string
  current: { contentVersion: number; revision: string; now: string; nodes: GraphNode[]; mappings: Mapping[]; reviewItems: ReviewItem[] }
}

/** 失效包重算：另起新包号，沿用固定范围，双向关联，已完成记录不再复用（内容已变）。 */
export function reissue(state: RegistryState, input: ReissueInput): { state: RegistryState; pkg: AccessPackage } | null {
  const old = state.packages.find((item) => item.id === input.packageId)
  if (!old || old.status !== 'invalidated') return null
  return createPackage(state, {
    requirementIds: old.requirementIds,
    courseIds: old.courseIds,
    createdBy: input.createdBy,
    supersedesId: old.id,
    now: input.current.now,
    snapshot: {
      contentVersion: input.current.contentVersion,
      revision: input.current.revision,
      createdAt: input.current.now,
      nodes: input.current.nodes,
      mappings: input.current.mappings,
      reviewItems: input.current.reviewItems,
    },
  })
}

export type SnapshotDiff = {
  snapshotVersion: number
  currentVersion: number
  nodes: { added: GraphNode[]; removed: GraphNode[]; changed: Array<{ id: string; before: string; after: string }> }
  mappings: { added: Mapping[]; removed: Mapping[]; changed: Array<{ id: string; before: string; after: string }> }
  reviews: {
    added: ReviewItem[]
    removed: ReviewItem[]
    changed: Array<{ id: string; courseId: string; before: string; after: string }>
  }
}

/** 已交付包与当前图谱/审阅结论的差异追溯（位置 x/y 变动不算内容差异）。 */
export function diffPackage(
  pkg: AccessPackage,
  current: { contentVersion: number; nodes: GraphNode[]; mappings: Mapping[]; reviewItems: ReviewItem[] },
): SnapshotDiff {
  const nodeSignature = (n: GraphNode) => `${n.id}|${n.type}|${n.label}`
  const beforeNodes = new Map(pkg.snapshot.nodes.map((n) => [n.id, n]))
  const afterNodes = new Map(current.nodes.map((n) => [n.id, n]))
  const nodeDiff = {
    added: current.nodes.filter((n) => !beforeNodes.has(n.id)),
    removed: pkg.snapshot.nodes.filter((n) => !afterNodes.has(n.id)),
    changed: [] as Array<{ id: string; before: string; after: string }>,
  }
  for (const [id, before] of beforeNodes) {
    const after = afterNodes.get(id)
    if (after && nodeSignature(before) !== nodeSignature(after)) {
      nodeDiff.changed.push({ id, before: nodeSignature(before), after: nodeSignature(after) })
    }
  }

  const mappingSignature = (m: Mapping) => `${m.source}→${m.target}|${m.relation}|${m.weight}`
  const beforeMappings = new Map(pkg.snapshot.mappings.map((m) => [m.id, m]))
  const afterMappings = new Map(current.mappings.map((m) => [m.id, m]))
  const mappingDiff = {
    added: current.mappings.filter((m) => !beforeMappings.has(m.id)),
    removed: pkg.snapshot.mappings.filter((m) => !afterMappings.has(m.id)),
    changed: [] as Array<{ id: string; before: string; after: string }>,
  }
  for (const [id, before] of beforeMappings) {
    const after = afterMappings.get(id)
    if (after && mappingSignature(before) !== mappingSignature(after)) {
      mappingDiff.changed.push({ id, before: mappingSignature(before), after: mappingSignature(after) })
    }
  }

  const reviewSignature = (r: ReviewItem) => `${r.status}|${r.comment}|${r.evidence}`
  const beforeReviews = new Map(pkg.snapshot.reviewItems.map((r) => [r.id, r]))
  const afterReviews = new Map(current.reviewItems.map((r) => [r.id, r]))
  const reviewDiff = {
    added: current.reviewItems.filter((r) => !beforeReviews.has(r.id)),
    removed: pkg.snapshot.reviewItems.filter((r) => !afterReviews.has(r.id)),
    changed: [] as Array<{ id: string; courseId: string; before: string; after: string }>,
  }
  for (const [id, before] of beforeReviews) {
    const after = afterReviews.get(id)
    if (after && reviewSignature(before) !== reviewSignature(after)) {
      reviewDiff.changed.push({ id, courseId: before.courseId, before: reviewSignature(before), after: reviewSignature(after) })
    }
  }

  return {
    snapshotVersion: pkg.snapshot.contentVersion,
    currentVersion: current.contentVersion,
    nodes: nodeDiff,
    mappings: mappingDiff,
    reviews: reviewDiff,
  }
}

function updatePackage(state: RegistryState, packageId: string, fn: (pkg: AccessPackage) => AccessPackage): RegistryState {
  return { ...state, packages: state.packages.map((pkg) => (pkg.id === packageId ? fn(pkg) : pkg)) }
}
