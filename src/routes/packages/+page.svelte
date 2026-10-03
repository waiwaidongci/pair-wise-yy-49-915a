<script lang="ts">
  import { curriculumStore } from '$lib/stores'
  import { packageStore } from '$lib/packageStore'
  import { diffPackage, invalidationState } from '$lib/packages'
  import type { RetrievalPackage } from '$lib/packages'

  let expert = $state('顾明 / 认证专家组')
  let courseCount = $state(3)
  let seed = $state(20261003)
  let forceFail = $state(false)
  let busy = $state<string | null>(null)
  let error = $state<string | null>(null)
  let notice = $state<string | null>(null)
  let diffFor = $state<string | null>(null)
  let forms = $state<Record<string, { submitter: string; evidence: string; note: string }>>({})

  const curriculum = $derived($curriculumStore)
  const packages = $derived($packageStore.packages)

  const statusMeta: Record<RetrievalPackage['status'], { label: string; cls: string }> = {
    generating: { label: '生成中', cls: 'gen' },
    ready: { label: '待交付', cls: 'ready' },
    delivered: { label: '已交付', cls: 'delivered' },
    invalidated: { label: '已失效', cls: 'invalid' },
  }
  const sliceMeta: Record<RetrievalPackage['slices'][number]['status'], { label: string; cls: string }> = {
    pending: { label: '待生成', cls: 'pending' },
    done: { label: '已完成', cls: 'done' },
    failed: { label: '失败', cls: 'failed' },
  }

  async function callApi(body: Record<string, unknown>) {
    const res = await fetch('/api/packages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const data = await res.json()
    if (!data.ok) throw new Error(data.error || '操作失败')
    return data
  }

  async function initiate() {
    busy = 'initiate'
    error = null
    notice = null
    try {
      const data = await callApi({
        action: 'initiate',
        curriculum,
        expert,
        courseCount: Number(courseCount) || 3,
        seed: Number(seed),
        existing: packages,
      })
      packageStore.upsert(data.pkg)
      notice = `已发起调阅包 ${data.pkg.id}，固定毕业要求 ${data.pkg.snapshot.requirements.length} 项、课程 ${data.pkg.snapshot.courses.length} 门、映射 ${data.pkg.snapshot.mappings.length} 条、审阅意见 ${data.pkg.snapshot.reviewItems.length} 条。`
    } catch (e) {
      error = String(e)
    } finally {
      busy = null
    }
  }

  async function act(pkg: RetrievalPackage, action: string, extra: Record<string, unknown> = {}) {
    busy = `${pkg.id}-${action}`
    error = null
    notice = null
    try {
      const data = await callApi({ action, pkg, curriculum, forceFail, ...extra })
      packageStore.upsert(data.pkg)
      if (action === 'deliver') notice = `${pkg.id} 已交付，快照锁定，可随时追溯与当前差异。`
      if (action === 'recalculate') notice = `${pkg.id} 已按当前图谱与审阅结论重算（第 ${data.pkg.recalcCount} 次）。`
      if (action === 'resume') notice = `${pkg.id} 续作完成，推进 ${data.progressed} 个分片。`
    } catch (e) {
      error = `${pkg.id}：${String(e)}`
    } finally {
      busy = null
    }
  }

  async function accept(pkg: RetrievalPackage, courseId: string, stale: boolean) {
    const f = forms[courseId] ?? { submitter: '', evidence: '', note: '' }
    busy = `${pkg.id}-${courseId}`
    error = null
    notice = null
    try {
      const data = await callApi({
        action: 'acceptMaterial',
        pkg,
        curriculum,
        courseId,
        submitter: f.submitter,
        evidence: f.evidence,
        note: f.note,
        baseVersion: stale ? pkg.version - 1 : pkg.version,
      })
      packageStore.upsert(data.pkg)
      if (data.result === 'conflict') {
        notice = `${pkg.id} · ${courseId}：晚到者版本 v${pkg.version - 1} 已过期，材料保留为草稿，未覆盖当前版本 v${data.pkg.version}。`
      } else {
        notice = `${pkg.id} · ${courseId}：材料已接收，版本推进到 v${data.pkg.version}。`
      }
    } catch (e) {
      error = `${pkg.id}：${String(e)}`
    } finally {
      busy = null
    }
  }

  function setForm(courseId: string, field: 'submitter' | 'evidence' | 'note', value: string) {
    const prev = forms[courseId] ?? { submitter: '', evidence: '', note: '' }
    forms = { ...forms, [courseId]: { ...prev, [field]: value } }
  }

  function progress(pkg: RetrievalPackage) {
    const done = pkg.slices.filter((s) => s.status === 'done').length
    const total = pkg.slices.length
    return { done, total, pct: total ? Math.round((done / total) * 100) : 0 }
  }

  function inv(pkg: RetrievalPackage) {
    return invalidationState(pkg, curriculum)
  }

  function diff(pkg: RetrievalPackage) {
    return diffPackage(pkg, curriculum)
  }

  function fmt(iso: string | null) {
    if (!iso) return '—'
    const d = new Date(iso)
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  }
</script>

<svelte:head><title>调阅包与续作生成</title></svelte:head>

<section class="page">
  <div class="page-head">
    <div>
      <p class="eyebrow">RETRIEVAL PACKAGE / 调阅包</p>
      <h1>专家调阅包与续作生成</h1>
      <p class="muted">专家发起后固定毕业要求、课程、映射与审阅意见，按课程分片生成；未审阅或缺失证据逐条列出，支持失败续作与版本冲突保留草稿。</p>
    </div>
    <div class="actions">
      <button class="btn-secondary" onclick={() => packageStore.reset()}>清空调阅包</button>
    </div>
  </div>

  {#if error}<div class="notice error">{error}</div>{/if}
  {#if notice}<div class="notice success">{notice}</div>{/if}

  <section class="panel initiate-panel">
    <div class="panel-head"><h3>发起调阅包</h3><span class="muted">按毕业要求随机抽课 · 固定快照</span></div>
    <div class="initiate-form">
      <label>专家 / 发起人<input bind:value={expert} /></label>
      <label>抽课数量<input type="number" min="1" max="12" bind:value={courseCount} /></label>
      <label>随机种子<input type="number" bind:value={seed} /></label>
      <label class="check"><input type="checkbox" bind:checked={forceFail} /> 强制模拟分片生成失败</label>
      <button class="btn-primary" disabled={busy === 'initiate'} onclick={initiate}>{busy === 'initiate' ? '发起中…' : '发起调阅包'}</button>
    </div>
  </section>

  {#if packages.length === 0}
    <div class="empty panel">
      <strong>暂无调阅包</strong>
      <p>填写上方表单发起第一个调阅包。发起后将固定当前毕业要求、课程、映射与审阅意见，并按课程分片生成。</p>
    </div>
  {/if}

  <div class="pkg-list">
    {#each packages as pkg}
      {@const p = progress(pkg)}
      {@const invalid = inv(pkg).invalidated}
      {@const d = diff(pkg)}
      <article class="panel pkg-card" class:delivered={pkg.status === 'delivered'} class:invalid={invalid}>
        <div class="pkg-head">
          <div class="pkg-title">
            <strong>{pkg.id}</strong>
            <span class="badge {statusMeta[pkg.status].cls}">{statusMeta[pkg.status].label}</span>
            {#if invalid}<span class="badge invalid">已失效</span>{/if}
            <span class="muted">v{pkg.version}</span>
          </div>
          <div class="pkg-meta">
            <span>发起人 {pkg.expert}</span>
            <span>发起 {fmt(pkg.createdAt)}</span>
            <span>基础版本 {pkg.baseRevision}</span>
            <span>种子 {pkg.selectionSeed}</span>
            {#if pkg.recalcCount > 0}<span>重算 {pkg.recalcCount} 次</span>{/if}
            {#if pkg.deliveredAt}<span>交付 {fmt(pkg.deliveredAt)}</span>{/if}
          </div>
        </div>

        <div class="snapshot-bar">
          <span>固定快照：毕业要求 {pkg.snapshot.requirements.length} · 课程 {pkg.snapshot.courses.length} · 映射 {pkg.snapshot.mappings.length} · 审阅意见 {pkg.snapshot.reviewItems.length}</span>
          <span class="muted">指纹 {pkg.snapshot.fingerprint}</span>
        </div>

        {#if invalid}
          <div class="banner invalid-banner">
            <div><strong>图谱或审阅结论已变更</strong><p>本调阅包尚未交付，原快照与当前图谱不一致。失效后需按当前毕业要求、课程、映射与审阅意见重算，已完成分片不保留。</p></div>
            <button class="btn-danger" disabled={busy === `${pkg.id}-recalculate`} onclick={() => act(pkg, 'recalculate')}>
              {busy === `${pkg.id}-recalculate` ? '重算中…' : '失效重算'}
            </button>
          </div>
        {/if}

        {#if pkg.status === 'delivered'}
          <div class="banner delivered-banner">
            <div><strong>已交付 · 快照锁定</strong><p>交付包保留原快照，不因图谱或审阅结论变更而失效；可随时追溯与当前版本的差异。</p></div>
            <button class="btn-secondary" onclick={() => (diffFor = diffFor === pkg.id ? null : pkg.id)}>
              {diffFor === pkg.id ? '收起差异' : '查看与当前差异'}
            </button>
          </div>
          {#if diffFor === pkg.id}
            <div class="diff-box">
              <div class="diff-counts">
                <span class="chip added">新增 {d.counts.added}</span>
                <span class="chip removed">移除 {d.counts.removed}</span>
                <span class="chip changed">变更 {d.counts.changed}</span>
              </div>
              {#if d.changes.length === 0}<p class="muted">交付快照与当前图谱、审阅结论完全一致。</p>{/if}
              <ul>
                {#each d.changes as change}
                  <li class={change.type}>
                    <span class="tag {change.type}">{change.type === 'added' ? '新增' : change.type === 'removed' ? '移除' : '变更'}</span>
                    <strong>{change.label}</strong>
                    <span class="muted">{change.detail}</span>
                  </li>
                {/each}
              </ul>
            </div>
          {/if}
        {/if}

        <div class="progress">
          <div class="progress-head"><span>分片进度 {p.done}/{p.total}</span><span>{p.pct}%</span></div>
          <div class="progress-track"><div class="progress-fill" style="width:{p.pct}%"></div></div>
        </div>

        <div class="slice-list">
          {#each pkg.slices as slice}
            <div class="slice" class:done={slice.status === 'done'} class:failed={slice.status === 'failed'}>
              <div class="slice-head">
                <strong>{slice.courseName}</strong>
                <span class="muted">{slice.courseId}</span>
                <span class="badge {sliceMeta[slice.status].cls}">{sliceMeta[slice.status].label}</span>
                {#if slice.attempts > 1}<span class="muted">尝试 {slice.attempts} 次</span>{/if}
                {#if slice.generatedAt}<span class="muted">生成 {fmt(slice.generatedAt)}</span>{/if}
              </div>
              <div class="slice-req">
                {#each slice.requirementNames as name}<span class="req-chip">{name}</span>{/each}
              </div>

              {#if slice.evidenceMissing.length > 0}
                <div class="ev missing"><strong>缺失证据</strong><ul>{#each slice.evidenceMissing as item}<li>{item}</li>{/each}</ul></div>
              {/if}
              {#if slice.unreviewed.length > 0}
                <div class="ev unreviewed"><strong>未审阅</strong><ul>{#each slice.unreviewed as item}<li>{item}</li>{/each}</ul></div>
              {/if}
              {#if slice.status === 'failed' && slice.lastError}<div class="ev error-msg">{slice.lastError}</div>{/if}

              {#if slice.materials.length > 0}
                <div class="materials">
                  <strong>已接收材料</strong>
                  {#each slice.materials as m}<div class="material-item"><span>{m.submitter}</span><p>{m.evidence}</p>{#if m.note}<small>{m.note}</small>{/if}<small class="muted">{fmt(m.at)}</small></div>{/each}
                </div>
              {/if}
              {#if slice.materialDraft}
                <div class="materials draft">
                  <strong>晚到者草稿（未覆盖当前版本）</strong>
                  <div class="material-item"><span>{slice.materialDraft.submitter}</span><p>{slice.materialDraft.evidence}</p>{#if slice.materialDraft.note}<small>{slice.materialDraft.note}</small>{/if}<small class="muted">{fmt(slice.materialDraft.at)}</small></div>
                </div>
              {/if}

              {#if pkg.status !== 'delivered'}
                <div class="material-form">
                  <input placeholder="提交人" value={forms[slice.courseId]?.submitter ?? ''} oninput={(e) => setForm(slice.courseId, 'submitter', e.currentTarget.value)} />
                  <input placeholder="证据说明" value={forms[slice.courseId]?.evidence ?? ''} oninput={(e) => setForm(slice.courseId, 'evidence', e.currentTarget.value)} />
                  <input placeholder="备注" value={forms[slice.courseId]?.note ?? ''} oninput={(e) => setForm(slice.courseId, 'note', e.currentTarget.value)} />
                  <button class="btn-primary" disabled={busy === `${pkg.id}-${slice.courseId}`} onclick={() => accept(pkg, slice.courseId, false)}>补齐材料（当前版本 v{pkg.version}）</button>
                  <button class="btn-secondary" disabled={busy === `${pkg.id}-${slice.courseId}`} onclick={() => accept(pkg, slice.courseId, true)}>模拟晚到者提交（旧版本 v{pkg.version - 1}）</button>
                </div>
              {/if}
            </div>
          {/each}
        </div>

        {#if pkg.status !== 'delivered'}
          <div class="pkg-actions">
            <button class="btn-secondary" disabled={busy !== null || p.done === p.total} onclick={() => act(pkg, 'generateSlice')}>
              {busy === `${pkg.id}-generateSlice` ? '生成中…' : '生成下一片段'}
            </button>
            <button class="btn-secondary" disabled={busy !== null || p.done === p.total} onclick={() => act(pkg, 'resume')}>
              {busy === `${pkg.id}-resume` ? '续作中…' : '失败后续作（跳过已完成）'}
            </button>
            <button class="btn-primary" disabled={busy !== null || pkg.status !== 'ready'} onclick={() => act(pkg, 'deliver')}>
              {busy === `${pkg.id}-deliver` ? '交付中…' : '交付调阅包'}
            </button>
          </div>
        {/if}
      </article>
    {/each}
  </div>
</section>

<style>
  .actions { display: flex; gap: 8px; }
  .notice { margin-bottom: 12px; padding: 12px 14px; border-left: 3px solid #3f8869; color: #27634d; background: #ebf6f0; }
  .notice.error { border-color: #bd4d35; color: #913c2b; background: #fff1ec; }
  .initiate-panel { margin-bottom: 16px; }
  .initiate-form { display: flex; flex-wrap: wrap; align-items: flex-end; gap: 12px; padding: 16px; }
  .initiate-form label { flex: 1; min-width: 160px; }
  .initiate-form label.check { flex: 0 0 auto; display: flex; flex-direction: row; align-items: center; gap: 6px; }
  .initiate-form label.check input { width: auto; }
  .initiate-form button { flex: 0 0 auto; }
  .empty { padding: 28px; text-align: center; color: #6f7d83; }
  .empty strong { display: block; margin-bottom: 6px; color: #3d5a61; }
  .pkg-list { display: grid; gap: 16px; }
  .pkg-card { padding: 0; overflow: hidden; }
  .pkg-card.delivered { border-color: #9fd3c4; }
  .pkg-card.invalid { border-color: #e0a48f; }
  .pkg-head { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 10px; padding: 14px 16px; border-bottom: 1px solid #e7ebeb; }
  .pkg-title { display: flex; align-items: center; gap: 10px; }
  .pkg-title strong { font-size: 15px; }
  .pkg-meta { display: flex; flex-wrap: wrap; gap: 12px; color: #748289; font-size: 11px; }
  .badge { padding: 3px 8px; border-radius: 999px; font-size: 10px; font-weight: 700; }
  .badge.gen { color: #8a6a2f; background: #fdf0d9; }
  .badge.ready { color: #2b6a86; background: #e2f2f8; }
  .badge.delivered { color: #2e7359; background: #e7f4ec; }
  .badge.invalid { color: #a94331; background: #ffebe6; }
  .badge.pending { color: #748289; background: #eef1f1; }
  .badge.done { color: #2e7359; background: #e7f4ec; }
  .badge.failed { color: #a94331; background: #ffebe6; }
  .snapshot-bar { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 8px; padding: 10px 16px; color: #5f6e74; font-size: 11px; background: #f6f8f7; }
  .banner { display: flex; align-items: center; justify-content: space-between; gap: 14px; margin: 14px 16px 0; padding: 12px 14px; border-radius: 8px; }
  .banner p { margin: 4px 0 0; font-size: 11px; line-height: 1.5; }
  .invalid-banner { color: #913c2b; background: #fff1ec; }
  .invalid-banner p { color: #a55a48; }
  .delivered-banner { color: #27634d; background: #ebf6f0; }
  .delivered-banner p { color: #4d7a68; }
  .diff-box { margin: 14px 16px 0; padding: 12px 14px; border: 1px solid #dbe3e3; border-radius: 8px; background: #fafcfc; }
  .diff-counts { display: flex; gap: 8px; margin-bottom: 8px; }
  .chip { padding: 3px 8px; border-radius: 999px; font-size: 10px; font-weight: 700; }
  .chip.added { color: #2e7359; background: #e7f4ec; }
  .chip.removed { color: #a94331; background: #ffebe6; }
  .chip.changed { color: #8a6a2f; background: #fdf0d9; }
  .diff-box ul { margin: 0; padding: 0; list-style: none; }
  .diff-box li { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 6px 0; border-bottom: 1px solid #edf0f0; font-size: 11px; }
  .diff-box li:last-child { border-bottom: 0; }
  .tag { padding: 2px 6px; border-radius: 4px; font-size: 9px; font-weight: 700; }
  .tag.added { color: #2e7359; background: #e7f4ec; }
  .tag.removed { color: #a94331; background: #ffebe6; }
  .tag.changed { color: #8a6a2f; background: #fdf0d9; }
  .progress { padding: 14px 16px 4px; }
  .progress-head { display: flex; justify-content: space-between; color: #5f6e74; font-size: 11px; }
  .progress-track { height: 8px; margin-top: 6px; border-radius: 999px; background: #e8eded; overflow: hidden; }
  .progress-fill { height: 100%; border-radius: 999px; background: #3f8c8a; transition: width .2s ease; }
  .slice-list { display: grid; gap: 10px; padding: 14px 16px; }
  .slice { border: 1px solid #e4eaea; border-radius: 8px; padding: 12px 14px; }
  .slice.done { border-color: #bfe0d4; background: #f7fbf9; }
  .slice.failed { border-color: #e6b3a4; background: #fdf6f4; }
  .slice-head { display: flex; flex-wrap: wrap; align-items: center; gap: 9px; }
  .slice-head strong { font-size: 13px; }
  .slice-req { display: flex; flex-wrap: wrap; gap: 6px; margin: 8px 0; }
  .req-chip { padding: 2px 8px; border-radius: 999px; color: #50758a; background: #eaf1f4; font-size: 10px; }
  .ev { margin-top: 8px; padding: 8px 10px; border-radius: 6px; font-size: 11px; }
  .ev strong { display: block; margin-bottom: 4px; }
  .ev ul { margin: 0; padding-left: 18px; }
  .ev.missing { color: #913c2b; background: #fff1ec; }
  .ev.unreviewed { color: #8a6a2f; background: #fdf0d9; }
  .ev.error-msg { color: #a94331; background: #ffebe6; }
  .materials { margin-top: 8px; padding: 8px 10px; border-radius: 6px; background: #f1f5f5; font-size: 11px; }
  .materials.draft { background: #fff6e9; }
  .materials strong { display: block; margin-bottom: 6px; color: #537579; }
  .material-item { display: grid; gap: 2px; padding: 6px 0; border-bottom: 1px solid #e4eaea; }
  .material-item:last-child { border-bottom: 0; }
  .material-item span { color: #2f6f72; font-weight: 700; }
  .material-item p { margin: 0; color: #5f6e74; }
  .material-item small { color: #839096; }
  .material-form { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-top: 10px; }
  .material-form input { grid-column: span 1; }
  .material-form button { grid-column: span 1; }
  .pkg-actions { display: flex; flex-wrap: wrap; gap: 8px; padding: 4px 16px 16px; }
  @media (max-width: 760px) {
    .material-form { grid-template-columns: 1fr; }
    .material-form input, .material-form button { grid-column: span 1; }
  }
</style>
