import { useState, useEffect, useCallback } from 'react'
import { io } from 'socket.io-client'
import {
  DndContext,
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

// 可拖拽的项目卡片
function SortableProjectCard({ project, onDelete, onSwitch, switching }) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: project.id })

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
    zIndex: isDragging ? 10 : 1,
  }

  return (
    <div ref={setNodeRef} style={style} className={`project-card${isDragging ? ' dragging' : ''}`}>
      <div className="project-header">
        <div className="project-info">
          <h3 className="project-name">{project.name}</h3>
          <span className="project-dir" title={project.dir}>{project.dir}</span>
        </div>
        <div className="project-actions">
          <button
            className="btn-drag"
            {...attributes}
            {...listeners}
            title="拖动排序"
          >
            ⠿
          </button>
          <button
            className="btn-delete"
            onClick={() => onDelete(project.id)}
            title="删除项目"
          >
            删除
          </button>
        </div>
      </div>

      <div className="env-current">
        <div className="env-label">当前配置</div>
        <div className="env-values">
          <div className="env-item">
            <span className="env-key">APP_NAME</span>
            <span className="env-value env-badge app">{project.appName || <em>未设置</em>}</span>
          </div>
          <div className="env-item">
            <span className="env-key">APP_ENV</span>
            <span className={`env-value env-badge ${project.appEnv || ''}`}>
              {project.appEnv || <em>未设置</em>}
            </span>
          </div>
        </div>
      </div>

      {project.envFiles.length > 0 && (
        <div className="env-files">
          <div className="env-label">环境配置切换</div>
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
                  >
                    {isSwitching ? '切换中...' : '切换'}
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

function App() {
  const [projects, setProjects] = useState([])
  const [loading, setLoading] = useState(true)
  const [showAddDialog, setShowAddDialog] = useState(false)
  const [newDir, setNewDir] = useState('')
  const [error, setError] = useState('')
  const [switching, setSwitching] = useState({})
  const [socket, setSocket] = useState(null)

  // 自动更新相关状态
  const [appVersion, setAppVersion] = useState('')          // 当前版本号
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

  const loadProjects = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/projects`)
      const data = await res.json()
      setProjects(data)
    } catch (e) {
      console.error('加载项目失败:', e)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    loadProjects()
  }, [loadProjects])

  useEffect(() => {
    const s = io('/', { transports: ['websocket', 'polling'] })
    setSocket(s)

    s.on('env-changed', (data) => {
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

    // 获取当前版本（用于弹窗里显示「已是最新版本 vX.Y.Z」）
    if (api.getAppInfo) {
      api.getAppInfo()
        .then(info => { if (info && info.version) setAppVersion(info.version) })
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
    setUpdateProgress(0)
    setUpdateState('downloading')
    const api = window.electronAPI
    if (api && api.downloadUpdate) api.downloadUpdate()
  }

  // 点击「重启并更新」：退出并安装
  const handleStartUpdate = () => {
    const api = window.electronAPI
    if (api && api.startUpdate) {
      api.startUpdate().catch((err) => {
        console.error('startUpdate failed:', err)
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
    try {
      const res = await fetch(`${API_BASE}/projects`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dir: newDir.trim() })
      })
      const data = await res.json()
      if (res.ok) {
        setProjects(prev => [...prev, data])
        setShowAddDialog(false)
        setNewDir('')
      } else {
        setError(data.error || '添加失败')
      }
    } catch (e) {
      setError('请求失败: ' + e.message)
    }
  }

  const deleteProject = async (id) => {
    try {
      const res = await fetch(`${API_BASE}/projects/${id}`, { method: 'DELETE' })
      if (res.ok) {
        setProjects(prev => prev.filter(p => p.id !== id))
      }
    } catch (e) {
      console.error('删除失败:', e)
    }
  }

  const switchEnv = async (projectId, envFileName) => {
    setSwitching(prev => ({ ...prev, [projectId]: envFileName }))
    try {
      const res = await fetch(`${API_BASE}/projects/${projectId}/switch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ envFileName })
      })
      const data = await res.json()
      if (res.ok) {
        setProjects(prev =>
          prev.map(p =>
            p.id === projectId
              ? { ...p, appName: data.appName, appEnv: data.appEnv, envFiles: data.envFiles }
              : p
          )
        )
      } else {
        alert(data.error || '切换失败')
      }
    } catch (e) {
      alert('切换失败: ' + e.message)
    } finally {
      setSwitching(prev => ({ ...prev, [projectId]: null }))
    }
  }

  const handleDragEnd = (event) => {
    const { active, over } = event
    if (!over || active.id === over.id) return

    setProjects(prev => {
      const oldIndex = prev.findIndex(p => p.id === active.id)
      const newIndex = prev.findIndex(p => p.id === over.id)
      const newOrder = arrayMove(prev, oldIndex, newIndex)

      // 持久化排序到后端
      const ids = newOrder.map(p => p.id)
      fetch(`${API_BASE}/projects/reorder`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids })
      }).catch(e => console.error('保存排序失败:', e))

      return newOrder
    })
  }

  if (loading) {
    return <div className="loading">加载中...</div>
  }

  return (
    <div className="app">
      <header className="app-header">
        <h1>EnvSwitch</h1>
        <span className="subtitle">ENV 配置管理工具</span>
        <button className="btn-update" onClick={handleCheckUpdates} title="检查更新" disabled={updateState === 'checking'}>
          {updateState === 'downloaded' ? '更新可用' : '检查更新'}
        </button>
        {updateState === 'downloaded' && <span className="update-badge">!</span>}
        <button className="btn-add" onClick={() => setShowAddDialog(true)}>
          + 添加项目
        </button>
      </header>

      {showAddDialog && (
        <div className="dialog-overlay" onClick={() => setShowAddDialog(false)}>
          <div className="dialog" onClick={e => e.stopPropagation()}>
            <h2>添加项目</h2>
            <div className="form-group">
              <label>项目根目录路径</label>
              <input
                type="text"
                value={newDir}
                onChange={e => setNewDir(e.target.value)}
                placeholder="例如: D:\projects\my-app"
                onKeyDown={e => e.key === 'Enter' && addProject()}
                autoFocus
              />
            </div>
            {error && <div className="error-msg">{error}</div>}
            <div className="dialog-actions">
              <button className="btn-cancel" onClick={() => setShowAddDialog(false)}>取消</button>
              <button className="btn-confirm" onClick={addProject}>确定添加</button>
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
                  onDelete={deleteProject}
                  onSwitch={switchEnv}
                  switching={switching}
                />
              ))}
            </SortableContext>
          </DndContext>
        )}
      </div>

      {showUpdateModal && (
        <div className="dialog-overlay" onClick={() => setShowUpdateModal(false)}>
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
                    <pre className="update-notes">{typeof updateInfo.releaseNotes === 'string' ? updateInfo.releaseNotes : JSON.stringify(updateInfo.releaseNotes)}</pre>
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
                  <pre className="update-notes">{updateError}</pre>
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
    </div>
  )
}

export default App