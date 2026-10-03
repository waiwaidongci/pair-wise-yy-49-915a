<script lang="ts">
  import { curriculumStore } from '$lib/stores'
  import { packageStore } from '$lib/packages/store'
  import {
    sampleCourses,
    resumePoint,
    completedCount,
    diffPackage,
    linkedRequirements,
    type AccessPackage,
    type CourseShard,
  } from '$lib/packages/engine'

  let selectedRequirements = $state<string[]>(['GR-03', 'GR-06'])
  let sampleCount = $state(2)
  let expert = $state('认证专家组')
  let previewCourses = $state<string[]>([])
  let failNext = $state<Record<string, boolean>>({})
  let materialForms = $state<Record<string, { requirementId: string; content: string; submitter: string; message?: string }>>({})
  let notice = $state<{ kind: 'ok' | 'warn' | 'err'; text: string } | null>(null)

  const requirements = $derived($curriculumStore.nodes.filter((node) => node.type === '毕业要求'))
  const courses = $derived($curriculumStore.nodes.filter((node) => node.type === '课程'))
  const currentVersion = $derived($curriculumStore.contentVersion)

  function nameOf(id: string) {
    return $curriculumStore.nodes.find((node) => node.id === id)?.label.split('\n')[0] ?? id
  }

  function toggleRequirement(id: string, checked: boolean) {
    selectedRequirements = checked ? [...selectedRequirements, id] : selectedRequirements.filter((item) => item !== id)
    previewCourses = []
  }

  function preview() {
    const ids = courses.map((course) => course.id)
    previewCourses = sampleCourses(ids, $curriculumStore.mappings, selectedRequirements, sampleCount)
  }

  function initiate() {
    if (selectedRequirements.length === 0) {
      notice = { kind: 'err', text: '请至少固定一条毕业要求再发起调阅。' }
      return
    }
    const ids = previewCourses.length
      ? previewCourses
      : sampleCourses(courses.map((course) => course.id), $curriculumStore.mappings, selectedRequirements, sampleCount)
    const pkg = packageStore.initiate({ requirementIds: selectedRequirements, courseIds: ids, createdBy: expert })
    previewCourses = ids
    notice = { kind: 'ok', text: `${pkg.id} 已发起并冻结快照（v${pkg.snapshot.contentVersion} / ${pkg.snapshot.revision}），覆盖 ${ids.length} 门课。` }
  }

  function generate(pkg: AccessPackage) {
    const point = resumePoint(pkg)
    if (!point) return
    packageStore.generate(pkg.id, { forceError: failNext[pkg.id] ? '模拟生成失败：材料服务暂时不可用' : undefined })
    if (failNext[pkg.id]) {
      failNext = { ...failNext, [pkg.id]: false }
      notice = { kind: 'warn', text: `${pkg.id} 的《${nameOf(point.courseId)}》分片生成失败，可按原包号从该片续作。` }
    }
  }

  function retryShard(pkg: AccessPackage, shard: CourseShard) {
    packageStore.regenerateShard(pkg.id, shard.courseId)
  }

  function deliver(pkg: AccessPackage) {
    packageStore.deliver(pkg.id)
    notice = { kind: 'ok', text: `${pkg.id} 已交付：快照冻结，之后图谱或审阅结论变化只做差异追溯，不再改包。` }
  }

  function reissue(pkg: AccessPackage) {
    const next = packageStore.reissuePackage(pkg.id, expert)
    if (next) notice = { kind: 'ok', text: `已按当前 v${next.snapshot.contentVersion} 重算为新包 ${next.id}，原包 ${pkg.id} 保留可追溯。` }
  }

  function formKey(pkgId: string, courseId: string) {
    return `${pkgId}:${courseId}`
  }

  const statusBadge: Record<AccessPackage['status'], string> = {
    generating: '生成中',
    ready: '待交付',
    delivered: '已交付',
    invalidated: '已失效',
  }

  // 非完成分片在渲染后准备好补材料表单，避免在模板渲染期间写状态。
  $effect(() => {
    const additions: typeof materialForms = {}
    for (const pkg of $packageStore.packages) {
      if (pkg.status === 'invalidated' || pkg.status === 'delivered') continue
      for (const shard of pkg.shards) {
        if (shard.status === 'done') continue
        const key = formKey(pkg.id, shard.courseId)
        if (!materialForms[key]) {
          const reqs = linkedRequirements(pkg, shard.courseId)
          additions[key] = { requirementId: reqs[0] ?? pkg.requirementIds[0], content: '', submitter: '管理员甲' }
        }
      }
    }
    if (Object.keys(additions).length > 0) materialForms = { ...materialForms, ...additions }
  })

  function submitMaterial(pkg: AccessPackage, shard: CourseShard) {
    const form = materialForms[formKey(pkg.id, shard.courseId)]
    if (!form || !form.content.trim()) return
    const result = packageStore.submit({
      packageId: pkg.id,
      courseId: shard.courseId,
      requirementId: form.requirementId,
      content: form.content,
      submittedBy: form.submitter,
      baseVersion: pkg.snapshot.contentVersion,
    })
    if (result?.accepted) {
      form.message = `已接收（${form.submitter}，基于当前 v${pkg.snapshot.contentVersion}）。`
      form.content = ''
    } else if (result) {
      form.message =
        result.reason === 'stale-version'
          ? `该材料基于旧版本，未覆盖在版材料，已保留为草稿 ${result.draftId}。`
          : `在版材料已由另一位管理员先提交，本次提交保留为草稿 ${result.draftId}。`
    }
  }
</script>

<svelte:head><title>认证调阅包</title></svelte:head>

<section class="page">
  <div class="page-head">
    <div>
      <p class="eyebrow">ACCREDITATION PACKAGE / 专业认证</p>
      <h1>专家随机抽课调阅包</h1>
      <p class="muted">发起即固定毕业要求、课程、映射与审阅意见；按课程分片生成，列出未审阅与缺失证据，支持断点续作与差异追溯。</p>
    </div>
    <div class="actions"><a class="btn-secondary" href="/review">去处理审阅</a><a class="btn-secondary" href="/matrix">去改图谱</a></div>
  </div>

  {#if notice}
    <div class="notice {notice.kind}">{notice.text}<button onclick={() => (notice = null)}>×</button></div>
  {/if}

  <section class="panel initiate">
    <div class="panel-head"><h3>发起调阅（快照固定）</h3><span class="muted">当前图谱内容版本 v{currentVersion} / {$curriculumStore.revision}</span></div>
    <div class="initiate-body">
      <div class="field">
        <strong>固定毕业要求</strong>
        <div class="chips">
          {#each requirements as requirement}
            <label class="chip">
              <input type="checkbox" checked={selectedRequirements.includes(requirement.id)} onchange={(event) => toggleRequirement(requirement.id, event.currentTarget.checked)} />
              {requirement.label.split('\n')[0]}
            </label>
          {/each}
        </div>
      </div>
      <div class="field inline">
        <label>随机抽课门数
          <input type="number" min="1" max={courses.length} bind:value={sampleCount} oninput={() => (previewCourses = [])} />
        </label>
        <label>发起人
          <input bind:value={expert} placeholder="认证专家姓名" />
        </label>
        <button class="btn-secondary" onclick={preview}>随机抽课预览</button>
        <button class="btn-primary" onclick={initiate}>发起并冻结调阅包</button>
      </div>
      {#if previewCourses.length > 0}
        <div class="preview">抽课结果：
          {#each previewCourses as courseId, i}<span class="pill">{i + 1}. {nameOf(courseId)}（{courseId}）</span>{/each}
        </div>
      {/if}
    </div>
  </section>

  <div class="pkg-layout">
    <div class="pkg-list">
      {#each $packageStore.packages as pkg (pkg.id)}
        {@const point = resumePoint(pkg)}
        {@const done = completedCount(pkg)}
        <article class="panel pkg-card status-{pkg.status}">
          <header class="pkg-cover">
            <div>
              <div class="pkg-id">{pkg.id}<em class:locked={pkg.status === 'delivered'}>{pkg.status === 'delivered' ? '快照已冻结' : `封面版本 v${pkg.snapshot.contentVersion} · ${pkg.snapshot.revision}`}</em></div>
              <small>{pkg.createdBy} 发起于 {pkg.createdAt.slice(0, 16).replace('T', ' ')}</small>
              {#if pkg.supersedesId}<small class="lineage">重算自 <b>{pkg.supersedesId}</b></small>{/if}
              {#if pkg.successorId}<small class="lineage">已被 <b>{pkg.successorId}</b> 接续</small>{/if}
            </div>
            <span class="badge badge-{pkg.status}">{statusBadge[pkg.status]}</span>
          </header>

          <div class="scope">
            范围：{pkg.requirementIds.map(nameOf).join('、')}
            <span class="muted">·</span> 抽中 {pkg.courseIds.length} 门课
            <span class="muted">·</span> 分片进度 {done}/{pkg.shards.length}
          </div>

          {#if pkg.status === 'invalidated'}
            <div class="invalid-reason">⚠ {pkg.invalidReason}<br />失效时间 {pkg.invalidatedAt?.slice(0, 16).replace('T', ' ')}</div>
            <div class="pkg-actions"><button class="btn-primary" onclick={() => reissue(pkg)}>按当前版本重算（另起新包号）</button></div>
          {:else}
            <div class="shards">
              {#each pkg.shards as shard (shard.courseId)}
                <div class="shard shard-{shard.status}">
                  <div class="shard-head">
                    <strong>分片 {shard.order + 1} · {nameOf(shard.courseId)}</strong>
                    <span class="shard-status">{shard.status === 'done' ? `已生成 · 封面 v${shard.coverVersion}` : shard.status === 'failed' ? '生成失败' : '待生成'}</span>
                  </div>

                  {#if shard.status === 'failed'}
                    <p class="shard-error">{shard.error}。已完成的 {done} 门课不会重复生成。</p>
                  {/if}

                  {#if shard.status === 'done'}
                    <ul class="issue-list">
                      {#each shard.issues as issue}
                        <li class="issue-{issue.kind}">{issue.kind === '未审阅' ? '◷ 未审阅' : '✋ 缺失证据'} · {nameOf(issue.requirementId)}：{issue.detail}</li>
                      {:else}
                        <li class="issue-clean">✓ 审阅结论与证据齐备（封面版本一致）。</li>
                      {/each}
                    </ul>
                    {#if shard.materials.length > 0}
                      <div class="materials">已接收当前版本材料：
                        {#each shard.materials as material}<span class="pill">{nameOf(material.requirementId)} · {material.submittedBy}</span>{/each}
                      </div>
                    {/if}
                  {/if}

                  {#if shard.status !== 'done'}
                    {@const form = materialForms[formKey(pkg.id, shard.courseId)]}
                    {@const reqs = linkedRequirements(pkg, shard.courseId)}
                    {#if form}
                      <div class="material-form">
                        <div class="form-row">
                          <select bind:value={form.requirementId}>
                            {#each (reqs.length ? reqs : pkg.requirementIds) as requirementId}
                              <option value={requirementId}>{nameOf(requirementId)}</option>
                            {/each}
                          </select>
                          <select bind:value={form.submitter}>
                            <option>管理员甲</option>
                            <option>管理员乙</option>
                          </select>
                        </div>
                        <textarea rows="2" bind:value={form.content} placeholder="补齐证据：评分记录、达成度分析、考核样例编号……"></textarea>
                        <div class="form-row">
                          <button class="btn-secondary" onclick={() => submitMaterial(pkg, shard)}>提交补材料</button>
                          <small class="muted">仅接收基于 v{pkg.snapshot.contentVersion} 的首次提交，并发晚到者转草稿</small>
                        </div>
                        {#if form.message}<small class="form-message">{form.message}</small>{/if}
                      </div>
                    {/if}
                    {#if shard.status === 'failed'}
                      <button class="btn-primary" onclick={() => retryShard(pkg, shard)}>重跑本片（原包号续作）</button>
                    {/if}
                  {/if}
                </div>
              {/each}
            </div>

            {#if pkg.status === 'generating'}
              <div class="pkg-actions">
                <label class="fail-toggle"><input type="checkbox" checked={!!failNext[pkg.id]} onchange={(event) => (failNext = { ...failNext, [pkg.id]: event.currentTarget.checked })} /> 模拟本片生成失败</label>
                <button class="btn-primary" disabled={!point} onclick={() => generate(pkg)}>
                  {point ? `从断点续作：分片 ${point.index + 1}《${nameOf(point.courseId)}》` : '全部完成'}
                </button>
              </div>
            {:else if pkg.status === 'ready'}
              <div class="pkg-actions"><button class="btn-primary" onclick={() => deliver(pkg)}>交付专家组（冻结快照）</button></div>
            {/if}
          {/if}

          {#if pkg.status === 'delivered'}
            {@const diff = diffPackage(pkg, {
              contentVersion: currentVersion,
              nodes: $curriculumStore.nodes,
              mappings: $curriculumStore.mappings,
              reviewItems: $curriculumStore.reviewItems,
            })}
            <div class="diff">
              <strong>差异追溯（交付快照 v{diff.snapshotVersion} → 当前 v{diff.currentVersion}）</strong>
              {#if diff.currentVersion === diff.snapshotVersion || (diff.nodes.added.length + diff.nodes.removed.length + diff.nodes.changed.length + diff.mappings.added.length + diff.mappings.removed.length + diff.mappings.changed.length + diff.reviews.added.length + diff.reviews.removed.length + diff.reviews.changed.length === 0)}
                <p class="diff-clean">当前图谱与审阅结论与交付时完全一致，封面版本无需调整。</p>
              {:else}
                <ul>
                  {#each diff.mappings.changed as change}<li>映射 {change.id}：{change.before} ⇒ {change.after}</li>{/each}
                  {#each diff.mappings.added as change}<li class="added">新增映射 {change.id}：{change.source} → {change.target}（{change.relation}）</li>{/each}
                  {#each diff.mappings.removed as change}<li class="removed">删除映射 {change.id}：{change.source} → {change.target}</li>{/each}
                  {#each diff.reviews.changed as change}<li>审阅 {change.id}（{change.courseId}）：{change.before} ⇒ {change.after}</li>{/each}
                  {#each diff.reviews.added as change}<li class="added">新增审阅 {change.id}（{change.courseId}，{change.status}）</li>{/each}
                  {#each diff.nodes.changed as change}<li>节点 {change.id} 信息变更（坐标变化不计）</li>{/each}
                  {#each diff.nodes.added as change}<li class="added">新增节点 {change.id}（{nameOf(change.id)}）</li>{/each}
                  {#each diff.nodes.removed as change}<li class="removed">删除节点 {change.id}</li>{/each}
                </ul>
              {/if}
              <small class="muted">已交付包内容不再修改，专家手中材料始终对应交付时的快照版本。</small>
            </div>
          {/if}
        </article>
      {/each}
      {#if $packageStore.packages.length === 0}
        <div class="panel empty-state">还没有调阅包。选择毕业要求并随机抽课后发起，材料会以发起瞬间的版本冻结。</div>
      {/if}
    </div>

    <aside class="panel drafts">
      <div class="panel-head"><h3>晚到草稿箱</h3><span class="muted">{$packageStore.drafts.length} 份</span></div>
      <div class="draft-body">
        {#each $packageStore.drafts as draft (draft.id)}
          <article>
            <div class="draft-head">
              <strong>{draft.id}</strong>
              <span class="draft-reason">{draft.reason === 'stale-version' ? '版本落后' : '已被先提交'}</span>
            </div>
            <p>{draft.packageId} · {nameOf(draft.courseId)} → {nameOf(draft.requirementId)}</p>
            <p class="draft-content">“{draft.content || '（未填写正文）'}”</p>
            <small class="muted">{draft.submittedBy} 基于 v{draft.baseVersion} 起草 · 保存于 {draft.savedAt.slice(5, 16).replace('T', ' ')}</small>
            <div class="draft-actions">
              <button class="btn-secondary" onclick={() => packageStore.applyDraft(draft.id)}>按当前 v{currentVersion} 重新提交</button>
              <button class="btn-danger" onclick={() => packageStore.discardDraft(draft.id)}>放弃</button>
            </div>
          </article>
        {/each}
        {#if $packageStore.drafts.length === 0}<div class="empty-state small">暂无晚到草稿。两名管理员并发提交时，只有首个当前版本的材料会被接收。</div>{/if}
      </div>
    </aside>
  </div>
</section>

<style>
  .actions { display: flex; gap: 8px; flex-wrap: wrap; }
  .actions a { text-decoration: none; }
  .notice { display: flex; justify-content: space-between; align-items: center; gap: 10px; margin-bottom: 12px; padding: 11px 14px; border-left: 3px solid #3f8869; border-radius: 6px; color: #27634d; background: #ebf6f0; font-size: 13px; }
  .notice.warn { border-color: #c18a2e; color: #8a5e17; background: #fdf4e0; }
  .notice.err { border-color: #bd4d35; color: #913c2b; background: #fff1ec; }
  .notice button { border: 0; background: transparent; font-size: 16px; cursor: pointer; color: inherit; }
  .initiate { margin-bottom: 14px; }
  .initiate-body { display: grid; gap: 12px; padding: 14px 16px 16px; }
  .chips { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 8px; }
  .chip { display: flex; align-items: center; gap: 6px; padding: 6px 10px; border: 1px solid #cfdada; border-radius: 999px; background: #f6f9f8; font-size: 12px; font-weight: 600; }
  .chip input { width: auto; }
  .inline { display: flex; align-items: flex-end; gap: 10px; flex-wrap: wrap; }
  .inline label { min-width: 150px; }
  .preview { font-size: 12px; color: #456; }
  .pill { display: inline-block; margin: 2px 4px 2px 0; padding: 3px 9px; border-radius: 999px; background: #e9f1ef; color: #35605f; font-size: 11px; }
  .pkg-layout { display: grid; grid-template-columns: minmax(0,1fr) 330px; gap: 14px; align-items: start; }
  .pkg-card { margin-bottom: 14px; }
  .pkg-card.status-delivered { border-color: #9fc7b2; }
  .pkg-card.status-invalidated { opacity: .92; border-color: #e0b4a6; }
  .pkg-cover { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; padding: 14px 16px 10px; }
  .pkg-id { font-size: 16px; font-weight: 800; color: #23434b; }
  .pkg-id em { margin-left: 10px; padding: 2px 8px; border-radius: 5px; background: #eef4f3; color: #4d7474; font-size: 10px; font-style: normal; font-weight: 700; }
  .pkg-id em.locked { background: #e4f3eb; color: #2e7359; }
  .pkg-cover small { display: block; margin-top: 4px; color: #839096; font-size: 11px; }
  .lineage b { color: #8a5e17; }
  .badge { padding: 4px 10px; border-radius: 6px; font-size: 11px; font-weight: 700; white-space: nowrap; }
  .badge-generating { color: #8a5e17; background: #fdf0da; }
  .badge-ready { color: #2b5f8f; background: #e5f0f9; }
  .badge-delivered { color: #2e7359; background: #e2f3ea; }
  .badge-invalidated { color: #a94331; background: #fdeae5; }
  .scope { padding: 0 16px 10px; color: #55686e; font-size: 12px; }
  .invalid-reason { margin: 4px 16px 12px; padding: 10px 12px; border-radius: 7px; background: #fdf0ec; color: #9c4130; font-size: 12px; line-height: 1.6; }
  .shards { display: grid; gap: 8px; padding: 0 16px; }
  .shard { padding: 11px 12px; border: 1px solid #e1e8e7; border-left-width: 4px; border-radius: 8px; background: #fbfcfc; }
  .shard-pending { border-left-color: #b6c3c4; }
  .shard-failed { border-left-color: #c14932; background: #fdf5f2; }
  .shard-done { border-left-color: #3f8c6b; }
  .shard-head { display: flex; justify-content: space-between; gap: 10px; font-size: 13px; }
  .shard-status { color: #7a888e; font-size: 11px; white-space: nowrap; }
  .shard-failed .shard-status { color: #b1492f; font-weight: 700; }
  .shard-done .shard-status { color: #2e7359; }
  .shard-error { margin: 7px 0 0; color: #a04732; font-size: 12px; }
  .issue-list { margin: 8px 0 0; padding: 0; list-style: none; display: grid; gap: 5px; }
  .issue-list li { padding: 6px 9px; border-radius: 6px; font-size: 11px; line-height: 1.5; }
  .issue-未审阅 { background: #fdf1dd; color: #8a5e17; }
  .issue-缺失证据 { background: #fdece8; color: #a04732; }
  .issue-clean { background: #e9f5ee; color: #2e7359; }
  .materials { margin-top: 7px; font-size: 11px; color: #4f6b6a; }
  .material-form { display: grid; gap: 7px; margin-top: 9px; }
  .form-row { display: flex; gap: 8px; align-items: center; }
  .form-row select { max-width: 48%; }
  .form-row small { font-size: 10px; line-height: 1.4; }
  .form-message { color: #8a5e17; font-size: 11px; }
  .pkg-actions { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 12px 16px 14px; }
  .fail-toggle { display: flex; align-items: center; gap: 6px; font-size: 11px; color: #8a5e17; font-weight: 600; }
  .fail-toggle input { width: auto; }
  .diff { margin: 0 16px 14px; padding: 12px; border-radius: 8px; background: #f4f8f7; border: 1px solid #dce7e5; }
  .diff > strong { display: block; margin-bottom: 8px; font-size: 12px; color: #2f5d55; }
  .diff ul { margin: 0 0 8px; padding-left: 18px; display: grid; gap: 4px; }
  .diff li { font-size: 11px; color: #55686e; word-break: break-all; }
  .diff li.added { color: #2e7359; }
  .diff li.removed { color: #a94331; }
  .diff-clean { margin: 0 0 8px; color: #2e7359; font-size: 12px; }
  .drafts { position: sticky; top: 12px; }
  .draft-body { display: grid; gap: 10px; padding: 14px 16px 16px; max-height: 70vh; overflow: auto; }
  .draft-body article { padding: 10px 11px; border: 1px solid #e6e5df; border-left: 3px solid #c98f3f; border-radius: 7px; background: #fdfaf4; }
  .draft-head { display: flex; justify-content: space-between; align-items: center; font-size: 12px; }
  .draft-reason { padding: 2px 7px; border-radius: 5px; background: #f6e5c6; color: #8a5e17; font-size: 10px; }
  .draft-body p { margin: 5px 0; font-size: 11px; color: #5c6b71; }
  .draft-content { color: #6f6256 !important; }
  .draft-actions { display: flex; gap: 6px; margin-top: 8px; }
  .draft-actions button { padding: 6px 9px; font-size: 11px; }
  .empty-state { padding: 26px 18px; color: #78858b; font-size: 13px; text-align: center; }
  .empty-state.small { padding: 14px; font-size: 11px; }
  @media (max-width: 1080px) { .pkg-layout { grid-template-columns: 1fr; } .drafts { position: static; } }
</style>
