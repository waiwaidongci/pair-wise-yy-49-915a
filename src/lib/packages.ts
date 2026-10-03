import type { GraphNode, Mapping, ReviewItem } from './seed'
import { seedState } from './seed'

// ---------- Types ----------
export type PackageStatus = 'generating' | 'ready' | 'delivered' | 'invalidated'
export type SliceStatus = 'pending' | 'done' | 'failed'

export type SliceMaterial = {
  submitter: string
  evidence: string
  note: string
  at: string
}

export type PackageSlice = {
  courseId: string
  courseName: string
  requirementIds: string[]
  requirementNames: string[]
  status: SliceStatus
  attempts: number
  evidenceMissing: string[]
  unreviewed: string[]
  materials: SliceMaterial[]
  materialDraft: SliceMaterial | null
  generatedAt: string | null
  lastError: string | null
}

export type PackageSnapshot = {
  revision: string
  fingerprint: string
  takenAt: string
  requirements: GraphNode[]
  courses: GraphNode[]
  mappings: Mapping[]
  reviewItems: ReviewItem[]
}

export type RetrievalPackage = {
  id: string
  version: number
  status: PackageStatus
  expert: string
  createdAt: string
  deliveredAt: string | null
  baseRevision: string
  snapshot: PackageSnapshot
  slices: PackageSlice[]
  selectionSeed: number
  recalcCount: number
  lastConflict: { at: string; by: string; courseId: string; draft: SliceMaterial } | null
}

export type CurriculumLike = {
  nodes: GraphNode[]
  mappings: Mapping[]
  reviewItems: ReviewItem[]
  revision?: string
  locked?: boolean
  draft?: string
}

export type DiffChange = {
  kind: 'mapping' | 'review' | 'node'
  type: 'added' | 'removed' | 'changed'
  label: string
  detail: string
}

// ---------- Fingerprint ----------
// 稳定散列：固定毕业要求、课程、映射与审阅意见的内容，用于判断图谱或审阅结论是否变化。
export function hashString(str: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16).padStart(8, '0')
}

export function fingerprintCurriculum(c: CurriculumLike): string {
  const payload = {
    nodes: c.nodes.map((n) => [n.id, n.type, n.label] as const).sort((a, b) => a[0].localeCompare(b[0])),
    mappings: c.mappings
      .map((m) => [m.id, m.source, m.target, m.relation, m.weight] as const)
      .sort((a, b) => a[0].localeCompare(b[0])),
    reviewItems: c.reviewItems
      .map((r) => [r.id, r.courseId, r.requirementId, r.status, r.comment, r.evidence] as const)
      .sort((a, b) => a[0].localeCompare(b[0])),
  }
  return hashString(JSON.stringify(payload))
}

// ---------- Seeded RNG ----------
export function mulberry32(seed: number) {
  let a = seed >>> 0
  return function () {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// ---------- Course selection by graduation requirements ----------
export function selectCourses(
  c: CurriculumLike,
  opts: { requirementIds?: string[]; courseCount: number; seed: number },
): string[] {
  const requirements = c.nodes.filter((n) => n.type === '毕业要求')
  const reqIds = opts.requirementIds?.length ? opts.requirementIds : requirements.map((r) => r.id)
  const rng = mulberry32(opts.seed)
  const candidateSet = new Set<string>()
  c.mappings.forEach((m) => {
    if (m.relation !== '支撑') return
    if (!reqIds.includes(m.source)) return
    const node = c.nodes.find((n) => n.id === m.target)
    if (node?.type === '课程') candidateSet.add(m.target)
  })
  const candidates = [...candidateSet]
  if (candidates.length === 0) {
    c.nodes.filter((n) => n.type === '课程').forEach((n) => candidates.push(n.id))
  }
  for (let i = candidates.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    ;[candidates[i], candidates[j]] = [candidates[j], candidates[i]]
  }
  return candidates.slice(0, Math.max(1, Math.min(opts.courseCount, candidates.length)))
}

// ---------- Slice evidence (missing / unreviewed) ----------
export function computeSliceEvidence(
  snap: { requirements: GraphNode[]; courses: GraphNode[]; mappings: Mapping[]; reviewItems: ReviewItem[] },
  courseId: string,
  requirementIds: string[],
) {
  const evidenceMissing: string[] = []
  const unreviewed: string[] = []
  requirementIds.forEach((reqId) => {
    const req = snap.requirements.find((r) => r.id === reqId)
    const reqName = req?.label.split('\n')[0] ?? reqId
    const item = snap.reviewItems.find((r) => r.courseId === courseId && r.requirementId === reqId)
    if (!item) {
      evidenceMissing.push(`${reqName}：无审阅记录`)
    } else if (item.evidence.trim() === '') {
      evidenceMissing.push(`${item.id}：证据为空`)
    } else if (item.status === '待审阅') {
      unreviewed.push(`${item.id} · ${reqName} 待审阅`)
    } else if (item.status === '已退回') {
      evidenceMissing.push(`${item.id} · ${reqName} 已退回${item.comment ? `：${item.comment}` : ''}`)
    }
  })
  return { evidenceMissing, unreviewed }
}

// ---------- Package id ----------
export function nextPackageId(existing: RetrievalPackage[], now = new Date()): string {
  const y = now.getFullYear()
  let max = 0
  existing.forEach((p) => {
    const m = /PKG-\d{4}-(\d+)/.exec(p.id)
    if (m) max = Math.max(max, parseInt(m[1], 10))
  })
  return `PKG-${y}-${String(max + 1).padStart(4, '0')}`
}

// ---------- Initiate ----------
export function createPackage(
  c: CurriculumLike,
  opts: { expert: string; courseCount: number; requirementIds?: string[]; seed?: number },
  existing: RetrievalPackage[] = [],
): RetrievalPackage {
  const seed = opts.seed ?? Date.now() % 100000
  const courseIds = selectCourses(c, { requirementIds: opts.requirementIds, courseCount: opts.courseCount, seed })
  const requirements = c.nodes.filter((n) => n.type === '毕业要求')
  const courses = c.nodes.filter((n) => n.type === '课程' && courseIds.includes(n.id))
  const snapshot: PackageSnapshot = {
    revision: c.revision ?? 'R1',
    fingerprint: fingerprintCurriculum(c),
    takenAt: new Date().toISOString(),
    requirements: structuredClone(requirements),
    courses: structuredClone(courses),
    mappings: structuredClone(c.mappings),
    reviewItems: structuredClone(c.reviewItems),
  }
  const slices: PackageSlice[] = courseIds.map((courseId) => {
    const course = c.nodes.find((n) => n.id === courseId)
    const mappedReqIds = c.mappings
      .filter((m) => m.relation === '支撑' && m.target === courseId && c.nodes.some((n) => n.id === m.source && n.type === '毕业要求'))
      .map((m) => m.source)
    const requirementIds = mappedReqIds.length ? [...new Set(mappedReqIds)] : requirements.map((r) => r.id)
    const requirementNames = requirementIds.map((id) => c.nodes.find((n) => n.id === id)?.label.split('\n')[0] ?? id)
    const ev = computeSliceEvidence(snapshot, courseId, requirementIds)
    return {
      courseId,
      courseName: course?.label.split('\n')[0] ?? courseId,
      requirementIds,
      requirementNames,
      status: 'pending',
      attempts: 0,
      evidenceMissing: ev.evidenceMissing,
      unreviewed: ev.unreviewed,
      materials: [],
      materialDraft: null,
      generatedAt: null,
      lastError: null,
    }
  })
  return {
    id: nextPackageId(existing),
    version: 1,
    status: 'generating',
    expert: opts.expert || '认证专家组',
    createdAt: new Date().toISOString(),
    deliveredAt: null,
    baseRevision: c.revision ?? 'R1',
    snapshot,
    slices,
    selectionSeed: seed,
    recalcCount: 0,
    lastConflict: null,
  }
}

// ---------- Resumable per-slice generation ----------
// 从第一个未完成（pending）或失败（failed）的分片继续；已完成（done）分片不重复生成。
export function generateSlice(
  pkg: RetrievalPackage,
  c: CurriculumLike,
  opts: { forceFail?: boolean; now?: Date } = {},
): { pkg: RetrievalPackage; slice: PackageSlice | null; ok: boolean; reason?: string } {
  if (pkg.status === 'delivered') return { pkg, slice: null, ok: false, reason: '已交付包锁定' }
  const idx = pkg.slices.findIndex((s) => s.status === 'pending' || s.status === 'failed')
  if (idx === -1) return { pkg, slice: null, ok: true, reason: 'no-op' }
  const now = opts.now ?? new Date()
  const slices = pkg.slices.map((s) => ({ ...s }))
  const target = slices[idx]
  // 自动演示：第 2 个分片首次生成中断，续作时从该分片继续且不重复已完成分片。
  const autoFail = opts.forceFail === true || (target.attempts === 0 && idx === 1)
  if (autoFail) {
    target.status = 'failed'
    target.attempts += 1
    target.lastError = opts.forceFail ? '模拟失败：证据分片校验未通过' : '自动演示失败：第 2 分片首次生成中断'
  } else {
    target.status = 'done'
    target.attempts += 1
    target.generatedAt = now.toISOString()
    target.lastError = null
  }
  const next: RetrievalPackage = { ...pkg, slices }
  next.status = slices.every((s) => s.status === 'done') ? 'ready' : 'generating'
  return { pkg: next, slice: target, ok: !autoFail }
}

export function resumePackage(
  pkg: RetrievalPackage,
  c: CurriculumLike,
  opts: { forceFail?: boolean } = {},
): { pkg: RetrievalPackage; progressed: number } {
  let current = pkg
  let progressed = 0
  for (let i = 0; i < current.slices.length + 1; i++) {
    const res = generateSlice(current, c, opts)
    if (res.pkg === current) break
    current = res.pkg
    progressed += 1
    if (current.slices.every((s) => s.status === 'done')) break
  }
  return { pkg: current, progressed }
}

// ---------- Optimistic concurrency: two admins ----------
// baseVersion 为管理员补齐材料时看到的版本；仅当前版本被接收，晚到者材料保留为草稿。
export function acceptMaterial(
  pkg: RetrievalPackage,
  input: { courseId: string; submitter: string; evidence: string; note: string; baseVersion: number; now?: Date },
): { pkg: RetrievalPackage; result: 'accepted' | 'conflict' } {
  const now = input.now ?? new Date()
  const slices = pkg.slices.map((s) => ({ ...s }))
  const target = slices.find((s) => s.courseId === input.courseId)
  if (!target) return { pkg, result: 'conflict' }
  const material: SliceMaterial = {
    submitter: input.submitter || '管理员',
    evidence: input.evidence,
    note: input.note,
    at: now.toISOString(),
  }
  if (input.baseVersion !== pkg.version) {
    target.materialDraft = material
    const next: RetrievalPackage = {
      ...pkg,
      slices,
      lastConflict: { at: material.at, by: material.submitter, courseId: input.courseId, draft: material },
    }
    return { pkg: next, result: 'conflict' }
  }
  target.materials = [...target.materials, material]
  const next: RetrievalPackage = { ...pkg, slices, version: pkg.version + 1 }
  return { pkg: next, result: 'accepted' }
}

// ---------- Deliver ----------
export function deliverPackage(pkg: RetrievalPackage, now = new Date()): RetrievalPackage {
  if (pkg.status !== 'ready') return pkg
  return { ...pkg, status: 'delivered', deliveredAt: now.toISOString() }
}

// ---------- Invalidation ----------
export function invalidationState(
  pkg: RetrievalPackage,
  c: CurriculumLike,
): { invalidated: boolean; currentFingerprint: string; snapshotFingerprint: string } {
  const currentFingerprint = fingerprintCurriculum(c)
  return {
    invalidated: pkg.status !== 'delivered' && currentFingerprint !== pkg.snapshot.fingerprint,
    currentFingerprint,
    snapshotFingerprint: pkg.snapshot.fingerprint,
  }
}

// ---------- Recalculate (undelivered only) ----------
export function recalculatePackage(
  pkg: RetrievalPackage,
  c: CurriculumLike,
  now = new Date(),
): RetrievalPackage {
  if (pkg.status === 'delivered') return pkg
  const requirements = c.nodes.filter((n) => n.type === '毕业要求')
  const courseIds = pkg.slices.map((s) => s.courseId)
  const courses = c.nodes.filter((n) => n.type === '课程' && courseIds.includes(n.id))
  const snapshot: PackageSnapshot = {
    revision: c.revision ?? pkg.snapshot.revision,
    fingerprint: fingerprintCurriculum(c),
    takenAt: now.toISOString(),
    requirements: structuredClone(requirements),
    courses: structuredClone(courses),
    mappings: structuredClone(c.mappings),
    reviewItems: structuredClone(c.reviewItems),
  }
  const slices = pkg.slices.map((s) => {
    const ev = computeSliceEvidence(snapshot, s.courseId, s.requirementIds)
    return {
      ...s,
      status: 'pending' as SliceStatus,
      attempts: 0,
      evidenceMissing: ev.evidenceMissing,
      unreviewed: ev.unreviewed,
      materials: [],
      materialDraft: null,
      generatedAt: null,
      lastError: null,
    }
  })
  return {
    ...pkg,
    snapshot,
    slices,
    version: pkg.version + 1,
    status: 'generating',
    recalcCount: pkg.recalcCount + 1,
    lastConflict: null,
  }
}

// ---------- Diff (delivered snapshot vs current) ----------
export function diffPackage(
  pkg: RetrievalPackage,
  c: CurriculumLike,
): { changes: DiffChange[]; counts: { added: number; removed: number; changed: number } } {
  const changes: DiffChange[] = []
  const snap = pkg.snapshot

  const snapM = new Map(snap.mappings.map((m) => [m.id, m]))
  const curM = new Map(c.mappings.map((m) => [m.id, m]))
  curM.forEach((m, id) => {
    const old = snapM.get(id)
    if (!old) {
      changes.push({ kind: 'mapping', type: 'added', label: `${m.source} → ${m.target}`, detail: `${m.relation} 权重 ${m.weight}` })
    } else if (old.source !== m.source || old.target !== m.target || old.relation !== m.relation || old.weight !== m.weight) {
      changes.push({ kind: 'mapping', type: 'changed', label: `${m.source} → ${m.target}`, detail: `${old.relation} ${old.weight} → ${m.relation} ${m.weight}` })
    }
  })
  snapM.forEach((m, id) => {
    if (!curM.has(id)) changes.push({ kind: 'mapping', type: 'removed', label: `${m.source} → ${m.target}`, detail: `${m.relation} 权重 ${m.weight}` })
  })

  const snapR = new Map(snap.reviewItems.map((r) => [r.id, r]))
  const curR = new Map(c.reviewItems.map((r) => [r.id, r]))
  curR.forEach((r, id) => {
    const old = snapR.get(id)
    if (!old) {
      changes.push({ kind: 'review', type: 'added', label: r.id, detail: `${r.courseId} ${r.status}` })
    } else if (old.status !== r.status || old.comment !== r.comment || old.evidence !== r.evidence) {
      changes.push({ kind: 'review', type: 'changed', label: r.id, detail: `${old.status} → ${r.status}` })
    }
  })
  snapR.forEach((r, id) => {
    if (!curR.has(id)) changes.push({ kind: 'review', type: 'removed', label: r.id, detail: `${r.courseId} ${r.status}` })
  })

  const snapNodes = new Map(
    [...snap.requirements, ...snap.courses].map((n) => [n.id, n.label] as const),
  )
  c.nodes
    .filter((n) => snapNodes.has(n.id))
    .forEach((n) => {
      const oldLabel = snapNodes.get(n.id)
      if (oldLabel !== n.label) changes.push({ kind: 'node', type: 'changed', label: n.id, detail: `${oldLabel?.split('\n')[0]} → ${n.label.split('\n')[0]}` })
    })

  const counts = {
    added: changes.filter((x) => x.type === 'added').length,
    removed: changes.filter((x) => x.type === 'removed').length,
    changed: changes.filter((x) => x.type === 'changed').length,
  }
  return { changes, counts }
}

// ---------- Compatible migration ----------
// 已有数据缺少版本号时先兼容升级：补齐 revision、分片 status、包 version 等字段。
export function migrateCurriculum(raw: unknown): CurriculumLike {
  if (!raw || typeof raw !== 'object') return structuredClone(seedState)
  const r = raw as Record<string, unknown>
  return {
    nodes: Array.isArray(r.nodes) ? (r.nodes as GraphNode[]) : structuredClone(seedState.nodes),
    mappings: Array.isArray(r.mappings) ? (r.mappings as Mapping[]) : structuredClone(seedState.mappings),
    reviewItems: Array.isArray(r.reviewItems) ? (r.reviewItems as ReviewItem[]) : structuredClone(seedState.reviewItems),
    revision: typeof r.revision === 'string' && r.revision ? r.revision : 'R1',
    locked: Boolean(r.locked),
    draft: typeof r.draft === 'string' ? r.draft : '',
  }
}

export function migratePackages(raw: unknown): { schemaVersion: number; packages: RetrievalPackage[] } {
  if (!raw || typeof raw !== 'object') return { schemaVersion: 1, packages: [] }
  const r = raw as Record<string, unknown>
  if (!Array.isArray(r.packages)) return { schemaVersion: 1, packages: [] }
  const packages = (r.packages as unknown[]).map((p) => migratePackage(p)).filter((p): p is RetrievalPackage => p !== null)
  return { schemaVersion: 1, packages }
}

function migratePackage(p: unknown): RetrievalPackage | null {
  if (!p || typeof p !== 'object') return null
  const pkg = p as Record<string, unknown>
  if (typeof pkg.id !== 'string' || !pkg.id) return null
  const snapshot = (pkg.snapshot ?? {}) as Record<string, unknown>
  const slices = Array.isArray(pkg.slices)
    ? (pkg.slices as unknown[]).map((s) => migrateSlice(s)).filter((s): s is PackageSlice => s !== null)
    : []
  return {
    id: pkg.id,
    version: typeof pkg.version === 'number' ? pkg.version : 1,
    status: (['generating', 'ready', 'delivered', 'invalidated'].includes(pkg.status as string)
      ? pkg.status
      : 'generating') as PackageStatus,
    expert: typeof pkg.expert === 'string' ? pkg.expert : '认证专家组',
    createdAt: typeof pkg.createdAt === 'string' ? pkg.createdAt : new Date(0).toISOString(),
    deliveredAt: typeof pkg.deliveredAt === 'string' ? pkg.deliveredAt : null,
    baseRevision: typeof pkg.baseRevision === 'string' ? pkg.baseRevision : (snapshot.revision as string) ?? 'R1',
    snapshot: {
      revision: (snapshot.revision as string) ?? 'R1',
      fingerprint: typeof snapshot.fingerprint === 'string' ? snapshot.fingerprint : '',
      takenAt: typeof snapshot.takenAt === 'string' ? snapshot.takenAt : (pkg.createdAt as string) ?? new Date(0).toISOString(),
      requirements: Array.isArray(snapshot.requirements) ? (snapshot.requirements as GraphNode[]) : [],
      courses: Array.isArray(snapshot.courses) ? (snapshot.courses as GraphNode[]) : [],
      mappings: Array.isArray(snapshot.mappings) ? (snapshot.mappings as Mapping[]) : [],
      reviewItems: Array.isArray(snapshot.reviewItems) ? (snapshot.reviewItems as ReviewItem[]) : [],
    },
    slices,
    selectionSeed: typeof pkg.selectionSeed === 'number' ? pkg.selectionSeed : 0,
    recalcCount: typeof pkg.recalcCount === 'number' ? pkg.recalcCount : 0,
    lastConflict: (pkg.lastConflict as RetrievalPackage['lastConflict']) ?? null,
  }
}

function migrateSlice(s: unknown): PackageSlice | null {
  if (!s || typeof s !== 'object') return null
  const sl = s as Record<string, unknown>
  if (typeof sl.courseId !== 'string' || !sl.courseId) return null
  return {
    courseId: sl.courseId,
    courseName: typeof sl.courseName === 'string' ? sl.courseName : sl.courseId,
    requirementIds: Array.isArray(sl.requirementIds) ? (sl.requirementIds as string[]) : [],
    requirementNames: Array.isArray(sl.requirementNames) ? (sl.requirementNames as string[]) : [],
    status: (['pending', 'done', 'failed'].includes(sl.status as string) ? sl.status : 'pending') as SliceStatus,
    attempts: typeof sl.attempts === 'number' ? sl.attempts : 0,
    evidenceMissing: Array.isArray(sl.evidenceMissing) ? (sl.evidenceMissing as string[]) : [],
    unreviewed: Array.isArray(sl.unreviewed) ? (sl.unreviewed as string[]) : [],
    materials: Array.isArray(sl.materials) ? (sl.materials as SliceMaterial[]) : [],
    materialDraft: (sl.materialDraft as SliceMaterial) ?? null,
    generatedAt: typeof sl.generatedAt === 'string' ? sl.generatedAt : null,
    lastError: typeof sl.lastError === 'string' ? sl.lastError : null,
  }
}
