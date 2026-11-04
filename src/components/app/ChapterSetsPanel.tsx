/**
 * 章节收藏集管理面板（3.4.0 · D）
 *
 * 功能：
 *   · 显示项目内所有收藏集列表（空集显示"暂无收藏集"）
 *   · 创建收藏集（输入名称，校验，提交）
 *   · 收藏集详情：显示成员章节（有效/失效分开）、按叙事顺序排列（失效排到最后并标注"章节不存在"）
 *   · 添加成员：从章节列表选择（排除已在集内的）
 *   · 移除成员按钮
 *   · 重命名、删除收藏集（删集不删章节）
 *   · 点击章节成员进入正文（通过 onNavigate 回调）
 *   · 读取失败时明确提示，不显示空状态
 *
 * 🔴 重要限制：
 *   · 读失败状态不允许写（防止用空数据覆盖真实收藏）
 *   · 显示每个收藏集的"X章/Y章不可用"
 *   · 重名时拒绝并提示（同一项目内名称唯一）
 *
 * 📌 同步/备份边界（明确告知）：
 *   · 收藏元数据随 settingsKV 一并导出/同步（收藏集跨设备同步）
 *   · 删章后历史版本不恢复收藏关系（失效成员显示为"章节不存在"）
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { Plus, X, Trash2, Pencil, BookOpen, AlertTriangle, ChevronRight } from 'lucide-react'
import type { Chapter } from '@/lib/types'
import {
  loadSets, saveSets, createChapterSet, addToSet, removeFromSet, renameSet, setMemberStatus,
  validateSetName, CHAPTER_SET_MAX_COUNT, CHAPTER_SET_MAX_NAME_LEN,
  type ChapterSet,
} from '@/lib/app/chapterSets'
import { Button } from '@/components/common/Button'
import { confirmDialog } from '@/components/dialogs/dialogs'

// ============ 类型 ============

interface Props {
  projectId: string
  chapters: Chapter[]       // 项目内全量章节（按叙事顺序）
  onNavigate: (chapterId: string) => void
  onClose?: () => void
}

// ============ 工具 ============

function ChapterCount({ set, allIds }: { set: ChapterSet; allIds: Set<string> }) {
  const total = set.chapterIds.length
  const missing = set.chapterIds.filter(id => !allIds.has(id)).length
  if (total === 0) return <span className="text-xs text-ink-400">（空集）</span>
  return (
    <span className="text-xs text-ink-400">
      {total} 章{missing > 0 ? <span className="text-amber ml-1">/{missing} 不可用</span> : null}
    </span>
  )
}

// ============ 主组件 ============

export default function ChapterSetsPanel({ projectId, chapters, onNavigate, onClose }: Props) {
  const [sets, setSets] = useState<ChapterSet[]>([])
  const [loadError, setLoadError] = useState(false)
  const [loading, setLoading] = useState(true)
  const [activeSetId, setActiveSetId] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const [nameError, setNameError] = useState('')
  const [renaming, setRenaming] = useState<string | null>(null)   // 正在重命名的 set id
  const [renameVal, setRenameVal] = useState('')
  const [renameError, setRenameError] = useState('')
  const [addingTo, setAddingTo] = useState<string | null>(null)   // 正在添加成员的 set id
  const [saveError, setSaveError] = useState('')
  const [saving, setSaving] = useState(false)
  const savingRef = useRef(false)
  const scopeRef = useRef({ projectId, generation: 0 })
  if (scopeRef.current.projectId !== projectId) scopeRef.current = { projectId, generation: scopeRef.current.generation + 1 }

  // 全量章节 id 集合（用于 setMemberStatus）
  const allChapterIds = new Set(chapters.map(c => c.id))

  // ---- 读取 ----
  useEffect(() => {
    if (!projectId) return
    let alive = true
    const generation = scopeRef.current.generation
    setLoading(true)
    setLoadError(false)
    setSets([])
    setActiveSetId(null)
    loadSets(projectId).then(result => {
      if (!alive || scopeRef.current.generation !== generation) return
      setSets(result)
      setLoading(false)
    }).catch(() => {
      if (!alive || scopeRef.current.generation !== generation) return
      setLoadError(true)
      setLoading(false)
    })
    return () => { alive = false }
  }, [projectId])

  // ---- 保存（读失败状态下不允许写） ----
  const persist = useCallback(async (next: ChapterSet[]) => {
    if (loadError || loading || savingRef.current) return false
    savingRef.current = true
    setSaving(true)
    const generation = scopeRef.current.generation
    setSaveError('')
    const r = await saveSets(projectId, next, sets)
    savingRef.current = false
    setSaving(false)
    if (scopeRef.current.generation !== generation) return false
    if (!r.ok) { setSaveError(r.error ?? '保存失败，请重试'); return false }
    setSets(next)
    setSaveError('')
    return true
  }, [projectId, loadError, loading, sets])

  // ---- 创建收藏集 ----
  const handleCreate = async () => {
    setNameError('')
    const v = validateSetName(newName)
    if (!v.ok) { setNameError(v.reason!); return }
    if (sets.some(s => s.name === newName.trim())) {
      setNameError('同一项目内已存在同名收藏集')
      return
    }
    if (sets.length >= CHAPTER_SET_MAX_COUNT) {
      setNameError(`收藏集数量已达上限（${CHAPTER_SET_MAX_COUNT}）`)
      return
    }
    const next = [...sets, createChapterSet(newName)]
    if (!await persist(next)) return
    setNewName('')
    setCreating(false)
  }

  // ---- 删除收藏集（不删章节） ----
  const handleDelete = async (setId: string) => {
    const generation = scopeRef.current.generation
    if (!await confirmDialog({ title: '删除收藏集', message: '只删除收藏集，不删除其中的章节。确定继续吗？', danger: true })) return
    if (scopeRef.current.generation !== generation) return
    const next = sets.filter(s => s.id !== setId)
    if (await persist(next) && activeSetId === setId) setActiveSetId(null)
  }

  // ---- 重命名 ----
  const handleRename = async (setId: string) => {
    setRenameError('')
    if (sets.some(s => s.id !== setId && s.name === renameVal.trim())) {
      setRenameError('同一项目内已存在同名收藏集')
      return
    }
    const target = sets.find(s => s.id === setId)
    if (!target) return
    const r = renameSet(target, renameVal)
    if (!r.ok) { setRenameError(r.reason ?? '名称无效'); return }
    const next = sets.map(s => s.id === setId ? r.set : s)
    if (!await persist(next)) return
    setRenaming(null)
    setRenameVal('')
  }

  // ---- 添加章节成员 ----
  const handleAddChapter = async (setId: string, chapterId: string) => {
    const target = sets.find(s => s.id === setId)
    if (!target) return
    const { set: updated } = addToSet(target, chapterId)
    const next = sets.map(s => s.id === setId ? updated : s)
    if (!await persist(next)) return
    setAddingTo(null)
  }

  // ---- 移除章节成员 ----
  const handleRemoveChapter = async (setId: string, chapterId: string) => {
    const target = sets.find(s => s.id === setId)
    if (!target) return
    const updated = removeFromSet(target, chapterId)
    const next = sets.map(s => s.id === setId ? updated : s)
    await persist(next)
  }

  // ============ 渲染 ============

  if (loading) {
    return (
      <div className="flex items-center justify-center p-8 text-ink-400 text-sm">
        加载中…
      </div>
    )
  }

  if (loadError) {
    return (
      <div className="p-4 space-y-3">
        <div className="flex items-center gap-2 text-danger">
          <AlertTriangle size={16} />
          <span className="text-sm font-medium">收藏集读取失败，无法显示数据</span>
        </div>
        <p className="text-xs text-ink-400">
          读取失败可能是存储异常，请刷新页面重试。
          当前页面不允许写入操作（防止用空数据覆盖真实收藏）。
        </p>
      </div>
    )
  }

  const activeSet = sets.find(s => s.id === activeSetId) ?? null

  // 计算详情：按叙事顺序（有效章节先，失效章节排到最后）
  function getMembersOrdered(set: ChapterSet) {
    const active: { chapter: Chapter; id: string }[] = []
    const missing: { id: string }[] = []
    // 先按叙事顺序找有效章节
    for (const ch of chapters) {
      if (set.chapterIds.includes(ch.id)) active.push({ chapter: ch, id: ch.id })
    }
    // 再找失效章节（在 set.chapterIds 里但不在 chapters 里）
    for (const id of set.chapterIds) {
      if (setMemberStatus(set, id, allChapterIds) === 'missing') missing.push({ id })
    }
    return { active, missing }
  }

  return (
    <fieldset disabled={saving} className="flex flex-col h-full min-w-0" aria-busy={saving}>
      {/* 顶栏 */}
      <div className="flex items-center justify-between px-4 py-3 border-b">
        <h2 className="font-semibold text-sm">章节收藏集</h2>
        <div className="flex items-center gap-2">
          {!loadError && sets.length < CHAPTER_SET_MAX_COUNT && (
            <Button size="sm" variant="ghost" onClick={() => { setCreating(true); setNameError('') }}>
              <Plus size={14} className="mr-1" />新建
            </Button>
          )}
          {onClose && (
            <button onClick={onClose} className="p-1 rounded hover:bg-ink-700">
              <X size={16} />
            </button>
          )}
        </div>
      </div>

      {/* 读写错误提示 */}
      {saveError && (
        <div className="mx-4 mt-2 p-2 rounded bg-danger/10 text-danger text-xs flex items-center gap-1">
          <AlertTriangle size={12} />
          {saveError}
        </div>
      )}

      {/* 新建表单 */}
      {creating && (
        <div className="px-4 py-3 border-b bg-ink-850 space-y-2">
          <input
            autoFocus
            className="w-full border rounded px-2 py-1 text-sm"
            placeholder={`收藏集名称（最多 ${CHAPTER_SET_MAX_NAME_LEN} 字）`}
            value={newName}
            maxLength={CHAPTER_SET_MAX_NAME_LEN}
            onChange={e => setNewName(e.target.value)}
            onKeyDown={e => { if (e.nativeEvent.isComposing) return; if (e.key === 'Enter') handleCreate(); if (e.key === 'Escape') setCreating(false) }}
          />
          {nameError && <p className="text-xs text-danger">{nameError}</p>}
          <div className="flex gap-2">
            <Button size="sm" onClick={handleCreate}>创建</Button>
            <Button size="sm" variant="ghost" onClick={() => { setCreating(false); setNameError('') }}>取消</Button>
          </div>
        </div>
      )}

      <div className="flex flex-1 overflow-hidden">
        {/* 收藏集列表（左栏） */}
        <div className="w-48 border-r overflow-y-auto flex-shrink-0">
          {sets.length === 0 && (
            <div className="p-4 text-xs text-ink-400 text-center">暂无收藏集</div>
          )}
          {sets.map(set => (
            <button type="button"
              key={set.id}
              className={`w-full text-left group px-3 py-2 hover:bg-ink-800 border-b border-ink-700 ${activeSetId === set.id ? 'bg-ink-800' : ''}`}
              onClick={() => { setActiveSetId(set.id); setAddingTo(null); setRenaming(null) }}
            >
              <div className="flex items-center justify-between gap-1">
                <span className="text-sm truncate flex-1">{set.name}</span>
                <ChevronRight size={12} className="text-ink-300 flex-shrink-0" />
              </div>
              <ChapterCount set={set} allIds={allChapterIds} />
            </button>
          ))}
        </div>

        {/* 收藏集详情（右栏） */}
        <div className="flex-1 overflow-y-auto p-4">
          {!activeSet && (
            <div className="text-xs text-ink-400 text-center pt-8">请选择左侧收藏集</div>
          )}

          {activeSet && (
            <div className="space-y-4">
              {/* 标题行 */}
              <div className="flex items-center gap-2">
                {renaming === activeSet.id ? (
                  <div className="flex-1 space-y-1">
                    <input
                      autoFocus
                      className="w-full border rounded px-2 py-1 text-sm"
                      value={renameVal}
                      maxLength={CHAPTER_SET_MAX_NAME_LEN}
                      onChange={e => setRenameVal(e.target.value)}
                      onKeyDown={e => {
                        if (e.nativeEvent.isComposing) return
                        if (e.key === 'Enter') handleRename(activeSet.id)
                        if (e.key === 'Escape') { setRenaming(null); setRenameError('') }
                      }}
                    />
                    {renameError && <p className="text-xs text-danger">{renameError}</p>}
                    <div className="flex gap-2">
                      <Button size="sm" onClick={() => handleRename(activeSet.id)}>保存</Button>
                      <Button size="sm" variant="ghost" onClick={() => { setRenaming(null); setRenameError('') }}>取消</Button>
                    </div>
                  </div>
                ) : (
                  <>
                    <h3 className="font-medium text-sm flex-1 truncate">{activeSet.name}</h3>
                    <button
                      className="p-1 rounded hover:bg-ink-700 text-ink-400"
                      title="重命名"
                      onClick={() => { setRenaming(activeSet.id); setRenameVal(activeSet.name); setRenameError('') }}
                    >
                      <Pencil size={13} />
                    </button>
                    <button
                      className="p-1 rounded hover:bg-danger/10 text-ink-400 hover:text-danger"
                      title="删除收藏集（不删章节）"
                      onClick={() => handleDelete(activeSet.id)}
                    >
                      <Trash2 size={13} />
                    </button>
                  </>
                )}
              </div>

              {/* 添加成员入口 */}
              {!addingTo && (
                <Button size="sm" variant="ghost" onClick={() => setAddingTo(activeSet.id)}>
                  <Plus size={13} className="mr-1" />添加章节
                </Button>
              )}

              {/* 添加成员选择列表 */}
              {addingTo === activeSet.id && (
                <div className="border rounded p-2 space-y-1 max-h-48 overflow-y-auto">
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-xs text-ink-400">选择要添加的章节</span>
                    <button className="p-0.5 rounded hover:bg-ink-700" onClick={() => setAddingTo(null)}>
                      <X size={12} />
                    </button>
                  </div>
                  {chapters.filter(c => !activeSet.chapterIds.includes(c.id)).length === 0 && (
                    <p className="text-xs text-ink-400">所有章节已在此集中</p>
                  )}
                  {chapters
                    .filter(c => !activeSet.chapterIds.includes(c.id))
                    .map(c => (
                      <button
                        key={c.id}
                        className="w-full text-left px-2 py-1 text-xs hover:bg-ink-800 rounded truncate"
                        onClick={() => handleAddChapter(activeSet.id, c.id)}
                      >
                        {c.title || '（无标题章节）'}
                      </button>
                    ))}
                </div>
              )}

              {/* 成员章节列表 */}
              {activeSet.chapterIds.length === 0 && (
                <div className="text-xs text-ink-400 py-2">暂无成员，点击「添加章节」加入</div>
              )}

              {/* 有效章节（按叙事顺序） */}
              {getMembersOrdered(activeSet).active.map(({ chapter }) => (
                <div
                  key={chapter.id}
                  className="flex items-center gap-2 group px-2 py-1.5 rounded hover:bg-ink-850"
                >
                  <BookOpen size={13} className="text-ink-400 flex-shrink-0" />
                  <button
                    className="flex-1 text-left text-sm truncate hover:text-amber"
                    onClick={() => onNavigate(chapter.id)}
                    title="进入章节正文"
                  >
                    {chapter.title || '（无标题章节）'}
                  </button>
                  <button
                    className="opacity-100 p-0.5 rounded hover:bg-danger/10 text-ink-400 hover:text-danger flex-shrink-0"
                    title="从收藏集移除"
                    onClick={() => handleRemoveChapter(activeSet.id, chapter.id)}
                  >
                    <X size={12} />
                  </button>
                </div>
              ))}

              {/* 失效章节（排到最后，标注"章节不存在"） */}
              {getMembersOrdered(activeSet).missing.length > 0 && (
                <div className="mt-2 space-y-1">
                  <p className="text-xs text-amber font-medium flex items-center gap-1">
                    <AlertTriangle size={11} />
                    以下章节不可用（可能已删除或未包含在导入的作品中）
                  </p>
                  {getMembersOrdered(activeSet).missing.map(({ id }) => (
                    <div key={id} className="flex items-center gap-2 group px-2 py-1.5 rounded bg-amber/10">
                      <span className="flex-1 text-xs text-amber truncate font-mono">{id}</span>
                      <span className="text-xs text-amber mr-1">章节不存在</span>
                      <button
                        className="opacity-100 p-0.5 rounded hover:bg-danger/10 text-amber hover:text-danger"
                        title="从收藏集移除"
                        onClick={() => handleRemoveChapter(activeSet.id, id)}
                      >
                        <X size={12} />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* 底部说明 */}
      <div className="px-4 py-2 border-t text-xs text-ink-400">
        删集不删章节；不可用的章节会保留在列表中。备份及同步的实际范围以相应提示为准。
      </div>
    </fieldset>
  )
}
