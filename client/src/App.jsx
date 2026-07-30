import { useState, useEffect, useCallback } from 'react'
import { io } from 'socket.io-client'
import {
  DndContext,
  DragOverlay,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core'
import {
  SortableContext,
  useSortable,
  arrayMove,
  rectSortingStrategy,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import './App.css'

const API_BASE = '/api'

// 统一的剪贴板复制 helper（卡片路径按钮 + App Info 弹窗的 Copy 按钮共用）。
// 优先用 navigator.clipboard（Electron 渲染进程 contextIsolation=true 下可用），
// 失败降级到 textarea + execCommand——避免某些环境 clipboard API 受限时直接抛错中断点击。
async function copyText(text) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch (e) {
    // 落到下面的降级方案
  }
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.top = '-9999px'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.focus()
    ta.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(ta)
    return ok
  } catch (e) {
    return false
  }
}

// 纯展示的项目卡片（不含拖拽逻辑）。
// 被 SortableProjectCard（网格里、参与排序）和 DragOverlay（拖拽中浮层）共用，
// 保证拖拽浮层与原位卡片视觉完全一致。
// dragHandleProps：拖拽手柄的 attributes+listeners（仅 sortable 版本传入；overlay 不传，浮层不可再拖）。
// innerRef / style：仅 sortable 版本传入 setNodeRef 与 transform 样式；overlay 不传。
// isOverlay：true 时套上 .dragging 阴影样式（浮层视觉强化）。
function ProjectCardView({
  project,
  onRequestDelete,
  onSwitch,
  switching,
  dragHandleProps = {},
  innerRef,
  style,
  isOverlay = false,
}) {
  const [copied, setCopied] = useState(false)

  return (
    <div
      ref={innerRef}
      style={style}
      className={`project-card${isOverlay ? ' dragging' : ''}`}
    >
      <div className="project-header">
        <div className="project-info">
          <h3 className="project-name">{project.name}</h3>
        </div>
        <div className="project-actions">
          <button
            className="btn-drag"
            {...dragHandleProps}
            title="拖动排序"
          >
            ⠿
          </button>
          <button
            type="button"
            className="project-dir-btn"
            title={`项目路径：${project.dir}（点击复制）`}
            onClick={async () => {
              const ok = await copyText(project.dir)
              if (ok) {
                setCopied(true)
                setTimeout(() => setCopied(false), 1200)
              }
            }}
          >
            {copied ? '已复制' : '路径'}
          </button>
          <button
            className="btn-delete"
            onClick={() => onRequestDelete(project.id, project.name)}
            title="删除项目"
          >
            删除
          </button>
        </div>
      </div>

      <div className="env-current">
        <span className="env-label">当前</span>
        <span className="env-pair">
          <span className="env-k">APP_NAME</span>
          <span className="env-value env-badge">{project.appName || <em>未设置</em>}</span>
        </span>
        <span className="env-pair">
          <span className="env-k">APP_ENV</span>
          <span className={`env-value env-badge ${project.appEnv || ''}`}>
            {project.appEnv || <em>未设置</em>}
          </span>
        </span>
      </div>

      {project.envFiles.length > 0 && (
        <div className="env-files">
          <div className="env-file-list">
            {project.envFiles.map(file => {
              const isSwitching = switching[project.id] === file
              return (
                <div key={file} className="env-file-item">
                  <span className="env-file-name">{file}</span>
                  <button
                    className={`btn-switch ${isSwitching ? 'switching' : ''}`}
                    onClick={() => onSwitch(project.id, file)}
                    disabled={!!switching[project.id]}
                    title="切换到该环境"
                  >
                    {isSwitching ? (
                      <span className="switch-dots">…</span>
                    ) : (
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" width="16" height="16">
                        <line x1="5" y1="12" x2="19" y2="12" />
                        <polyline points="12 5 19 12 12 19" />
                      </svg>
                    )}
                  </button>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {project.envFiles.length === 0 && (
        <div className="env-files-empty">
          暂无 .env.xxx 配置文件
        </div>
      )}
    </div>
  )
}

// 可拖拽的项目卡片（网格内、参与排序）。
function SortableProjectCard({ project, onRequestDelete, onSwitch, switching }) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: project.id })

  // 修复：拖动时不再让原位卡片通过 transform 跟随指针（这是横向滚动条的根因——
  // transform 后的元素会被计入文档 scrollable overflow，指针拖到窗口右侧就撑出无限横向滚动条）。
  // 改为交给 DragOverlay 用 fixed 浮层承载拖拽预览，原位只保留半透明占位（让位动画由其它卡片承担）。
  const style = {
    transform: isDragging ? undefined : CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
    zIndex: isDragging ? 10 : 1,
  }

  return (
    <ProjectCardView
      project={project}
      onRequestDelete={onRequestDelete}
      onSwitch={onSwitch}
      switching={switching}
      dragHandleProps={{ ...attributes, ...listeners }}
      innerRef={setNodeRef}
      style={style}
    />
  )
}

function App() {
  const [projects, setProjects] = useState([])
  const [loading, setLoading] = useState(true)
  const [showAddDialog, setShowAddDialog] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState(null)  // 待删除项目 {id, name}，非 null 时显示二次确认弹窗
  const [newDir, setNewDir] = useState('')
  const [error, setError] = useState('')
  const [switching, setSwitching] = useState({})

  // 自动更新相关状态
  const [appVersion, setAppVersion] = useState('')          // 当前版本号
  const [appInfo, setAppInfo] = useState(null)              // App Info 完整信息（关于弹窗展示）
  const [showInfoModal, setShowInfoModal] = useState(false) // 关于弹窗显隐
  const [showUpdateModal, setShowUpdateModal] = useState(false)
  // updateState: idle | checking | available | not-available | downloading | downloaded | error
  const [updateState, setUpdateState] = useState('idle')
  const [updateInfo, setUpdateInfo] = useState({ version: '', releaseNotes: '' })
  const [updateProgress, setUpdateProgress] = useState(0)
  const [updateError, setUpdateError] = useState('')

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 5 },
    })
  )

  // 当前正在拖拽的项目 id（DragOverlay 用）。null 表示没有拖拽进行中。
  const [activeId, setActiveId] = useState(null)
  const activeProject = activeId ? projects.find(p => p.id === activeId) : null

  const loadProjects = useCallback(async () => {
    console.log('[WEB] 加载项目列表 …')
    try {
      const res = await fetch(`${API_BASE}/projects`)
      const data = await res.json()
      console.log('[WEB] 项目列表加载完成，共', data.length, '个')
      setProjects(data)
    } catch (e) {
      console.error('[WEB] 加载项目失败:', e)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    loadProjects()
  }, [loadProjects])

  useEffect(() => {
    const s = io('/', { transports: ['websocket', 'polling'] })

    s.on('env-changed', (data) => {
      console.log('[WEB] 收到 env-changed', data.projectId, 'appName=', data.appName, 'appEnv=', data.appEnv)
      setProjects(prev =>
        prev.map(p =>
          p.id === data.projectId
            ? { ...p, appName: data.appName, appEnv: data.appEnv, envFiles: data.envFiles }
            : p
        )
      )
    })

    return () => s.disconnect()
  }, [])

  // 自动更新：订阅主进程推送的更新事件 + 获取当前版本号
  useEffect(() => {
    const api = window.electronAPI
    if (!api) return

    // 获取应用信息（版本号 + 关于弹窗展示的环境/路径信息）
    if (api.getAppInfo) {
      api.getAppInfo()
        .then(info => {
          if (info && info.version) setAppVersion(info.version)
          if (info) setAppInfo(info)
        })
        .catch(() => {})
    }

    // 订阅 update-event：按类型驱动弹窗状态机
    let unsub = () => {}
    if (api.onUpdateEvent) {
      unsub = api.onUpdateEvent((data) => {
        switch (data.type) {
          case 'checking':
            setUpdateState('checking')
            setUpdateError('')
            break
          case 'available':
            setUpdateState('available')
            setUpdateInfo({ version: data.version, releaseNotes: data.releaseNotes || '' })
            break
          case 'not-available':
            setUpdateState('not-available')
            break
          case 'downloading':
            setUpdateState('downloading')
            setUpdateProgress(Math.min(data.progress || 0, 99))
            break
          case 'downloaded':
            setUpdateState('downloaded')
            setUpdateProgress(100)
            if (data.version) setUpdateInfo(prev => ({ ...prev, version: data.version }))
            break
          case 'error':
            setUpdateState('error')
            setUpdateError(data.message || '未知错误')
            break
          default:
            break
        }
      })
    }

    return () => { if (unsub) unsub() }
  }, [])

  // 点击「检查更新」：打开弹窗并触发检查
  const handleCheckUpdates = () => {
    setShowUpdateModal(true)
    setUpdateError('')
    if (updateState !== 'downloaded') setUpdateState('checking')
    const api = window.electronAPI
    if (api && api.checkForUpdates) {
      api.checkForUpdates().catch(() => {
        setUpdateState('error')
        setUpdateError('Running in dev mode. Auto-update only works in packaged builds.')
      })
    }
  }

  // 点击「下载并更新」：开始下载
  const handleDownloadUpdate = () => {
    if (updateState === 'downloading') return // 防重复点击
    console.log('[WEB] 触发 downloadUpdate')
    setUpdateProgress(0)
    setUpdateState('downloading')
    const api = window.electronAPI
    if (api && api.downloadUpdate) api.downloadUpdate()
  }

  // 点击「重启并更新」：退出并安装
  const handleStartUpdate = () => {
    console.log('[WEB] 触发 startUpdate')
    const api = window.electronAPI
    if (api && api.startUpdate) {
      api.startUpdate().catch((err) => {
        console.error('[WEB] startUpdate failed:', err)
        setUpdateError('重启失败，请手动关闭并重新打开应用。')
        setUpdateState('error')
      })
    }
  }

  const addProject = async () => {
    setError('')
    if (!newDir.trim()) {
      setError('请输入项目目录路径')
      return
    }
    console.log('[WEB] 添加项目', newDir.trim())
    try {
      const res = await fetch(`${API_BASE}/projects`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dir: newDir.trim() })
      })
      const data = await res.json()
      if (res.ok) {
        console.log('[WEB] 项目添加成功', data.id)
        setProjects(prev => [...prev, data])
        setShowAddDialog(false)
        setNewDir('')
      } else {
        console.warn('[WEB] 添加项目失败', data.error)
        setError(data.error || '添加失败')
      }
    } catch (e) {
      setError('请求失败: ' + e.message)
    }
  }

  // 添加项目：调起系统文件夹选择器，把选中的目录路径填进输入框
  const handleBrowse = async () => {
    try {
      if (window.electronAPI?.selectFolder) {
        const dir = await window.electronAPI.selectFolder()
        if (dir) setNewDir(dir)
      }
    } catch (e) {
      console.error('[WEB] 选择文件夹失败', e)
    }
  }

  const deleteProject = async (id) => {
    console.log('[WEB] 删除项目', id)
    try {
      const res = await fetch(`${API_BASE}/projects/${id}`, { method: 'DELETE' })
      if (res.ok) {
        console.log('[WEB] 项目已删除', id)
        setProjects(prev => prev.filter(p => p.id !== id))
      } else {
        console.warn('[WEB] 删除项目失败', id, res.status)
      }
    } catch (e) {
      console.error('[WEB] 删除失败:', e)
    }
  }

  // 删除二次确认：确认弹窗的「删除」按钮触发，先关弹窗再真正删除
  const confirmDelete = async () => {
    if (!deleteTarget) return
    await deleteProject(deleteTarget.id)
    setDeleteTarget(null)
  }

  const switchEnv = async (projectId, envFileName) => {
    console.log('[WEB] 切换环境', projectId, '->', envFileName)
    setSwitching(prev => ({ ...prev, [projectId]: envFileName }))
    try {
      const res = await fetch(`${API_BASE}/projects/${projectId}/switch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ envFileName })
      })
      const data = await res.json()
      if (res.ok) {
        console.log('[WEB] 环境切换成功', projectId, '->', envFileName)
        setProjects(prev =>
          prev.map(p =>
            p.id === projectId
              ? { ...p, appName: data.appName, appEnv: data.appEnv, envFiles: data.envFiles }
              : p
          )
        )
      } else {
        console.warn('[WEB] 环境切换失败', projectId, data.error)
        alert(data.error || '切换失败')
      }
    } catch (e) {
      alert('切换失败: ' + e.message)
    } finally {
      setSwitching(prev => ({ ...prev, [projectId]: null }))
    }
  }

  // 拖拽开始：记录被拖项目 id，供 DragOverlay 渲染浮层预览
  const handleDragStart = (event) => {
    setActiveId(event.active.id)
  }

  const handleDragEnd = (event) => {
    const { active, over } = event
    setActiveId(null)
    if (!over || active.id === over.id) return

    setProjects(prev => {
      const oldIndex = prev.findIndex(p => p.id === active.id)
      const newIndex = prev.findIndex(p => p.id === over.id)
      const newOrder = arrayMove(prev, oldIndex, newIndex)

      // 持久化排序到后端
      const ids = newOrder.map(p => p.id)
      console.log('[WEB] 保存排序', ids)
      fetch(`${API_BASE}/projects/reorder`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids })
      }).catch(e => console.error('[WEB] 保存排序失败:', e))

      return newOrder
    })
  }

  if (loading) {
    return <div className="loading">加载中...</div>
  }

  return (
    <div className="app">
      <header className="app-header">
        <div className="app-header-right">
          <button className="btn-icon" onClick={() => setShowAddDialog(true)} title="添加项目">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="18" height="18">
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
          </button>
          <button className="btn-icon" onClick={handleCheckUpdates} title={updateState === 'downloaded' ? '更新可用，点击下载' : '检查更新'} disabled={updateState === 'checking'}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="18" height="18">
              {/* 刷新 / 检查更新 图标（feather refresh-cw） */}
              <polyline points="23 4 23 10 17 10" />
              <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
            </svg>
            {updateState === 'downloaded' && <span className="update-badge">!</span>}
          </button>
          <button className="btn-icon" onClick={() => setShowInfoModal(true)} title="App info">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="18" height="18">
              <circle cx="12" cy="12" r="10" />
              <line x1="12" y1="16" x2="12" y2="12" />
              <line x1="12" y1="8" x2="12.01" y2="8" />
            </svg>
          </button>
        </div>
      </header>

      {showAddDialog && (
        <div className="dialog-overlay">
          <div className="dialog" onClick={e => e.stopPropagation()}>
            <h2>添加项目</h2>
            <div className="form-group">
              <label>项目根目录路径</label>
              <div className="path-input-row">
                <input
                  type="text"
                  value={newDir}
                  onChange={e => setNewDir(e.target.value)}
                  placeholder="例如: D:\projects\my-app"
                  onKeyDown={e => e.key === 'Enter' && addProject()}
                  autoFocus
                />
                <button type="button" className="btn-browse" onClick={handleBrowse}>浏览…</button>
              </div>
            </div>
            {error && <div className="error-msg">{error}</div>}
            <div className="dialog-actions">
              <button className="btn-cancel" onClick={() => setShowAddDialog(false)}>取消</button>
              <button className="btn-confirm" onClick={addProject}>确定添加</button>
            </div>
          </div>
        </div>
      )}

      {/* 删除二次确认：点卡片「删除」时先弹这个，避免误删。仅移除配置映射，不删磁盘文件 */}
      {deleteTarget && (
        <div className="dialog-overlay">
          <div className="dialog" onClick={e => e.stopPropagation()}>
            <h2>删除项目</h2>
            <p className="confirm-text">
              确定要删除项目 <strong>{deleteTarget.name}</strong> 吗？<br />
              此操作仅从列表中移除该项目的配置映射，<strong>不会</strong>删除磁盘上的实际文件。
            </p>
            <div className="dialog-actions">
              <button className="btn-cancel" onClick={() => setDeleteTarget(null)}>取消</button>
              <button className="btn-danger" onClick={confirmDelete}>删除</button>
            </div>
          </div>
        </div>
      )}

      <div className="project-list">
        {projects.length === 0 ? (
          <div className="empty-state">
            <p>暂无项目，点击 "+ 添加项目" 开始使用</p>
          </div>
        ) : (
            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              onDragStart={handleDragStart}
              onDragEnd={handleDragEnd}
            >
              <SortableContext
                items={projects.map(p => p.id)}
                strategy={rectSortingStrategy}
              >
                {projects.map(project => (
                  <SortableProjectCard
                    key={project.id}
                    project={project}
                    onRequestDelete={(id, name) => setDeleteTarget({ id, name })}
                    onSwitch={switchEnv}
                    switching={switching}
                  />
                ))}
              </SortableContext>

              {/* DragOverlay：用 position:fixed 的独立浮层承载拖拽中的卡片预览。
                  这是修复"拖动时无限横向滚动条"的关键——浮层不参与文档布局、
                  不贡献 scrollable overflow，彻底避免被 translate 出界的卡片撑宽页面。
                  dnd-kit 会自动把浮层尺寸设为被拖元素的尺寸，视觉无缝衔接。 */}
              <DragOverlay>
                {activeProject ? (
                  <ProjectCardView
                    project={activeProject}
                    onSwitch={switchEnv}
                    switching={switching}
                    isOverlay
                  />
                ) : null}
              </DragOverlay>
            </DndContext>
        )}
      </div>

      {showUpdateModal && (
        <div className="dialog-overlay">
          <div className="dialog update-dialog" onClick={e => e.stopPropagation()}>
            <h2>检查更新</h2>
            <div className="update-body">
              {updateState === 'idle' && <p>点击下方按钮检查最新版本。</p>}
              {updateState === 'checking' && <p>正在检查更新…</p>}
              {updateState === 'not-available' && <p>已是最新版本 (v{appVersion})。</p>}
              {updateState === 'available' && (
                <div>
                  <p>发现新版本 <strong>v{updateInfo.version}</strong>。</p>
                  {updateInfo.releaseNotes && (
                    // 渲染 GitHub release notes 的 HTML（p/ul/li/a/strong 等），不是纯文本。
                    // 来源是 electron-updater / 自研 mac 更新器拉的 bynow2code/env-switch 官方 Release notes，
                    // 个人工具、可信源，dangerouslySetInnerHTML 注入风险可接受；子元素样式见 .update-notes *。
                    // electron-updater 偶尔把 releaseNotes 给成对象（含 .default），兜底取 .default 或 JSON。
                    <div
                      className="update-notes"
                      dangerouslySetInnerHTML={{
                        __html: typeof updateInfo.releaseNotes === 'string'
                          ? updateInfo.releaseNotes
                          : (updateInfo.releaseNotes?.default || JSON.stringify(updateInfo.releaseNotes))
                      }}
                    />
                  )}
                  <p className="update-hint">是否下载并安装此更新？</p>
                </div>
              )}
              {updateState === 'downloading' && (
                <div>
                  <p>正在下载更新: {updateProgress}%</p>
                  <div className="update-progress-bar">
                    <div className="update-progress-fill" style={{ width: `${updateProgress}%` }} />
                  </div>
                </div>
              )}
              {updateState === 'downloaded' && (
                <div>
                  <p>更新已下载 (v{updateInfo.version})。</p>
                  <p className="update-hint">重启应用以应用更新。</p>
                </div>
              )}
              {updateState === 'error' && (
                <div>
                  <p className="update-error-text">更新检查失败:</p>
                  {/* 用 <div> 不用 <pre>：<pre> 默认 white-space:pre 会让错误文本溢出产生横向滚动条
                     （截图里"Running in dev mode..."被截断带 ◀▶），错误信息是普通文本，不需要 pre 的预格式语义，
                     改为 div 后 .update-notes 的 word-break:break-word 生效，自然换行。 */}
                  <div className="update-notes">{updateError}</div>
                </div>
              )}
            </div>
            <div className="dialog-actions">
              {updateState === 'downloaded' ? (
                <>
                  <button className="btn-cancel" onClick={() => setShowUpdateModal(false)}>稍后</button>
                  <button className="btn-confirm" onClick={handleStartUpdate}>重启并更新</button>
                </>
              ) : updateState === 'available' ? (
                <>
                  <button className="btn-cancel" onClick={() => setShowUpdateModal(false)}>稍后</button>
                  <button className="btn-confirm" onClick={handleDownloadUpdate}>下载并更新</button>
                </>
              ) : (
                <button className="btn-cancel" onClick={() => setShowUpdateModal(false)}>关闭</button>
              )}
            </div>
          </div>
        </div>
      )}

      {showInfoModal && (
        <div className="dialog-overlay">
          <div className="dialog info-dialog" onClick={e => e.stopPropagation()}>
            <h2>App Info</h2>
            <div className="info-body">
              <div className="info-row">
                <label>Version</label>
                <div className="info-value">v{appInfo?.version || appVersion}</div>
              </div>
              {appInfo?.repoUrl && (
                <div className="info-row">
                  <label>Source</label>
                  <div className="info-value">
                    <a className="info-link" href={appInfo.repoUrl} target="_blank" rel="noreferrer">GitHub</a>
                  </div>
                </div>
              )}
              <div className="info-row">
                <label>Mode</label>
                <div className="info-value">{appInfo?.isDev ? 'Development' : 'Production'}</div>
              </div>
              {appInfo?.dataFilePath && (
                <div className="info-row">
                  <label>Data File</label>
                  <div className="info-path">
                    <span className="info-path-text">{appInfo.dataFilePath}</span>
                    <button className="btn-copy" onClick={() => copyText(appInfo.dataFilePath)}>Copy</button>
                  </div>
                </div>
              )}
              {appInfo?.logFilePath && (
                <div className="info-row">
                  <label>Log File</label>
                  <div className="info-path">
                    <span className="info-path-text">{appInfo.logFilePath}</span>
                    <button className="btn-copy" onClick={() => copyText(appInfo.logFilePath)}>Copy</button>
                  </div>
                </div>
              )}
            </div>
            <div className="dialog-actions">
              <button className="btn-cancel" onClick={() => setShowInfoModal(false)}>Close</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default App