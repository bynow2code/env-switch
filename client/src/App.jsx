import { useState, useEffect, useCallback } from 'react'
import { io } from 'socket.io-client'
import './App.css'

const API_BASE = '/api'

function App() {
  const [projects, setProjects] = useState([])
  const [loading, setLoading] = useState(true)
  const [showAddDialog, setShowAddDialog] = useState(false)
  const [newDir, setNewDir] = useState('')
  const [error, setError] = useState('')
  const [switching, setSwitching] = useState({}) // projectId -> envFileName
  const [socket, setSocket] = useState(null)

  // 加载项目列表
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

  // 初始加载
  useEffect(() => {
    loadProjects()
  }, [loadProjects])

  // WebSocket 实时更新
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

  // 添加项目
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

  // 删除项目
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

  // 切换 env 配置
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

  if (loading) {
    return <div className="loading">加载中...</div>
  }

  return (
    <div className="app">
      <header className="app-header">
        <h1>EnvSwitch</h1>
        <span className="subtitle">ENV 配置管理工具</span>
        <button className="btn-add" onClick={() => setShowAddDialog(true)}>
          + 添加项目
        </button>
      </header>

      {/* 添加项目对话框 */}
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

      {/* 项目列表 */}
      <div className="project-list">
        {projects.length === 0 ? (
          <div className="empty-state">
            <p>暂无项目，点击 "+ 添加项目" 开始使用</p>
          </div>
        ) : (
          projects.map(project => (
            <div key={project.id} className="project-card">
              <div className="project-header">
                <div className="project-info">
                  <h3 className="project-name">{project.name}</h3>
                  <span className="project-dir" title={project.dir}>{project.dir}</span>
                </div>
                <button
                  className="btn-delete"
                  onClick={() => deleteProject(project.id)}
                  title="删除项目"
                >
                  删除
                </button>
              </div>

              <div className="env-current">
                <div className="env-label">当前配置</div>
                <div className="env-values">
                  <div className="env-item">
                    <span className="env-key">APP_NAME</span>
                    <span className="env-value">{project.appName || <em>未设置</em>}</span>
                  </div>
                  <div className="env-item">
                    <span className="env-key">APP_ENV</span>
                    <span className={`env-value env-badge ${project.appEnv || ''}`}>
                      {project.appEnv || <em>未设置</em>}
                    </span>
                  </div>
                </div>
              </div>

              {/* .env.xxx 切换列表 */}
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
                            onClick={() => switchEnv(project.id, file)}
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
          ))
        )}
      </div>
    </div>
  )
}

export default App