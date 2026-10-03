import { json } from '@sveltejs/kit'
import {
  acceptMaterial,
  createPackage,
  deliverPackage,
  generateSlice,
  recalculatePackage,
  resumePackage,
} from '$lib/packages'
import type { CurriculumLike, RetrievalPackage } from '$lib/packages'

export function GET() {
  return json({
    ok: true,
    service: 'retrieval-packages',
    actions: ['initiate', 'generateSlice', 'resume', 'deliver', 'recalculate', 'acceptMaterial'],
  })
}

type Body = {
  action?: string
  curriculum?: CurriculumLike
  pkg?: RetrievalPackage
  expert?: string
  courseCount?: number
  requirementIds?: string[]
  seed?: number
  existing?: RetrievalPackage[]
  forceFail?: boolean
  courseId?: string
  submitter?: string
  evidence?: string
  note?: string
  baseVersion?: number
}

export async function POST({ request }) {
  let body: Body
  try {
    body = (await request.json()) as Body
  } catch {
    return json({ ok: false, error: 'invalid json' }, { status: 400 })
  }
  const action = body.action
  const curriculum = body.curriculum
  if (
    !curriculum ||
    !Array.isArray(curriculum.nodes) ||
    !Array.isArray(curriculum.mappings) ||
    !Array.isArray(curriculum.reviewItems)
  ) {
    return json({ ok: false, error: 'curriculum 缺失或不完整' }, { status: 400 })
  }
  try {
    switch (action) {
      case 'initiate': {
        const pkg = createPackage(
          curriculum,
          {
            expert: body.expert ?? '认证专家组',
            courseCount: Number(body.courseCount) || 3,
            requirementIds: body.requirementIds,
            seed: typeof body.seed === 'number' ? body.seed : undefined,
          },
          body.existing ?? [],
        )
        return json({ ok: true, pkg })
      }
      case 'generateSlice': {
        const res = generateSlice(body.pkg as RetrievalPackage, curriculum, { forceFail: body.forceFail === true })
        return json({ ok: res.ok, pkg: res.pkg, error: res.ok ? null : res.reason })
      }
      case 'resume': {
        const res = resumePackage(body.pkg as RetrievalPackage, curriculum, { forceFail: body.forceFail === true })
        return json({ ok: true, pkg: res.pkg, progressed: res.progressed })
      }
      case 'deliver': {
        const pkg = deliverPackage(body.pkg as RetrievalPackage)
        return json({ ok: pkg.status === 'delivered', pkg })
      }
      case 'recalculate': {
        const pkg = recalculatePackage(body.pkg as RetrievalPackage, curriculum)
        return json({ ok: true, pkg })
      }
      case 'acceptMaterial': {
        const res = acceptMaterial(body.pkg as RetrievalPackage, {
          courseId: body.courseId as string,
          submitter: body.submitter ?? '',
          evidence: body.evidence ?? '',
          note: body.note ?? '',
          baseVersion: Number(body.baseVersion),
        })
        return json({ ok: true, result: res.result, pkg: res.pkg })
      }
      default:
        return json({ ok: false, error: `未知 action: ${action ?? '(空)'}` }, { status: 400 })
    }
  } catch (e) {
    return json({ ok: false, error: String(e) }, { status: 500 })
  }
}
