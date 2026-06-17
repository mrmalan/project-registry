import { useState, useEffect, useRef, useCallback } from 'react'

// ── API helpers ──────────────────────────────────────────────
const api = {
  getProjects: () => fetch('/.netlify/functions/sheet').then(r => r.json()),
  saveProject: (p) => fetch('/.netlify/functions/sheet', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(p),
  }).then(r => r.json()),
  saveAllProjects: (projects) => fetch('/.netlify/functions/sheet', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(projects),
  }).then(r => r.json()),
  claude: (messages) => fetch('/.netlify/functions/claude', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages, max_tokens: 1000 }),
  }).then(r => r.json()),
}

// ── Constants ────────────────────────────────────────────────
const TYPE_OPTS = ['Deck', 'Model', 'Code', 'Tool', 'Doc']
const PROJ_COLORS = ['#185fa5','#3b6d11','#854f0b','#a32d2d','#3c3489','#085041','#5f5e5a','#0c447c','#633806','#27500a']
const BADGE = { active: 'badge-active', building: 'badge-building', hold: 'badge-hold', done: 'badge-done' }
const BADGE_LBL = { active: 'Active', building: 'Building', hold: 'On hold', done: 'Done' }

// ── Utils ────────────────────────────────────────────────────
const today = () => { const d = new Date(); return fmtDate(d) }
const fmtDate = d => `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`
const pad = n => n < 10 ? '0'+n : String(n)
const parseDate = s => { if (!s) return null; const p = s.split('-'); return new Date(+p[0], +p[1]-1, +p[2]) }
const displayDate = s => { if (!s) return ''; return parseDate(s).toLocaleDateString('en-ZA', {day:'numeric',month:'short',year:'numeric'}) }
const isOverdue = s => !!s && s < today()
const isDueSoon = s => { if (!s) return false; const t = today(); const f = fmtDate(new Date(Date.now()+7*86400000)); return s >= t && s <= f }
const nowTs = () => new Date().toLocaleString('en-ZA', {dateStyle:'medium',timeStyle:'short'})
const mkTask = v => typeof v === 'string' ? {text:v,dueDate:null,reminderDate:null} : {text:v.text||'',dueDate:v.dueDate||null,reminderDate:v.reminderDate||null}
const taskText = t => typeof t === 'string' ? t : (t.text || '')
const isWeb = u => u && (u.startsWith('http') || u.startsWith('www.'))
const normUrl = u => u && u.startsWith('www.') ? 'https://'+u : u

function projColor(id, projects) {
  const idx = projects.findIndex(p => p.id === id)
  return PROJ_COLORS[idx % PROJ_COLORS.length] || '#888'
}

// ── Main App ─────────────────────────────────────────────────
export default function App() {
  const [projects, setProjects] = useState([])
  const [loading, setLoading] = useState(true)
  const [saveStatus, setSaveStatus] = useState('')
  const [view, setView] = useState('registry') // registry | detail | calendar
  const [currentId, setCurrentId] = useState(null)
  const [editMode, setEditMode] = useState(false)
  const [filter, setFilter] = useState('all')
  const [calView, setCalView] = useState('month')
  const [calDate, setCalDate] = useState(new Date())
  const [calFilterId, setCalFilterId] = useState('')
  const [importOpen, setImportOpen] = useState(false)
  const [importPreselect, setImportPreselect] = useState(null)
  const [dpOpen, setDpOpen] = useState(null) // {taskIdx, taskType, anchorRect}
  const [toast, setToast] = useState('')
  const toastRef = useRef()

  // Load on mount
  useEffect(() => {
    api.getProjects()
      .then(data => {
        setProjects(data.map(p => ({ ...p, next: (p.next||[]).map(mkTask), openReminders: typeof p.openReminders === 'string' ? JSON.parse(p.openReminders || '{}') : (p.openReminders || {}) })))
        setLoading(false)
        setSaveStatus('Loaded from Google Sheet')
      })
      .catch(() => {
        setSaveStatus('Failed to load — check connection')
        setLoading(false)
      })
  }, [])

  const showToast = useCallback((msg) => {
    setToast(msg)
    clearTimeout(toastRef.current)
    toastRef.current = setTimeout(() => setToast(''), 2200)
  }, [])

  const saveProject = useCallback(async (updated) => {
    setProjects(prev => {
      const idx = prev.findIndex(p => p.id === updated.id)
      if (idx >= 0) { const n = [...prev]; n[idx] = updated; return n; }
      return [...prev, updated]
    })
    try {
      await api.saveProject(updated)
      setSaveStatus('Saved ' + nowTs())
      showToast('Saved')
    } catch { showToast('Save failed — check connection') }
  }, [showToast])

  const deleteProject = useCallback(async (id) => {
    const updated = projects.filter(p => p.id !== id)
    setProjects(updated)
    try { await api.saveAllProjects(updated); showToast('Project deleted') }
    catch { showToast('Delete failed') }
  }, [projects, showToast])

  const currentProject = projects.find(p => p.id === currentId)
  const color = currentId ? projColor(currentId, projects) : '#888'

  if (loading) return <div style={{padding:'40px',textAlign:'center',color:'#64748b'}}>Loading from Google Sheet…</div>

  return (
    <div style={{fontFamily:'-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif',background:'#f4f7fb',minHeight:'100vh',fontSize:14}}>
      <style>{css}</style>

      {/* Nav */}
      <nav className="main-nav">
        <button className={`nav-tab ${view !== 'calendar' ? 'active' : ''}`} onClick={() => { setView('registry'); setCurrentId(null); setEditMode(false) }}>Projects</button>
        <button className={`nav-tab ${view === 'calendar' ? 'active' : ''}`} onClick={() => setView('calendar')}>Calendar</button>
        <span style={{marginLeft:'auto',fontSize:12,color:'#94a3b8',padding:'0 16px',alignSelf:'center'}}>{saveStatus}</span>
      </nav>

      {/* Registry */}
      {view === 'registry' && (
        <div className="page">
          <h1>Project Registry</h1>
          <div className="toolbar">
            {['all','active','building','hold','done'].map(f => (
              <button key={f} className={`filter-btn ${filter===f?'active':''}`} onClick={() => setFilter(f)}>
                {f === 'all' ? 'All' : BADGE_LBL[f]}
              </button>
            ))}
            <span className="count-lbl">{(filter==='all'?projects:projects.filter(p=>p.status===filter)).length} of {projects.length}</span>
            <div style={{marginLeft:'auto',display:'flex',gap:8}}>
              <button className="btn" onClick={() => { setImportPreselect(null); setImportOpen(true) }}>Import session ↑</button>
              <button className="btn" onClick={() => {
                const id = '_new_'+Date.now()
                const p = {id,title:'New project',sub:'',status:'active',lastUpdate:'',next:[],open:[],openReminders:{},docs:[],stack:'',notes:[],updatedAt:''}
                setProjects(prev => [...prev, p])
                setCurrentId(id); setView('detail'); setEditMode(true)
              }}>+ New project</button>
              <button className="btn" onClick={async () => {
                showToast('Syncing…')
                try {
                  // Call Netlify process-notes function directly
                  const res = await fetch('/.netlify/functions/process-notes')
                  // Reload projects after sync regardless of response
                  const fresh = await api.getProjects()
                  setProjects(fresh.map(p => ({ ...p, next: (p.next||[]).map(mkTask) })))
                  setSaveStatus('Synced ' + nowTs())
                  showToast('Sync complete')
                } catch(e) { showToast('Sync failed: ' + e.message) }
              }}>Sync now ↻</button>
              <button className="btn" onClick={() => {
                const blob = new Blob([JSON.stringify(projects,null,2)],{type:'application/json'})
                const a = document.createElement('a'); a.href = URL.createObjectURL(blob)
                a.download = 'project-registry-'+new Date().toISOString().slice(0,10)+'.json'; a.click()
                showToast('Exported')
              }}>Export JSON</button>
            </div>
          </div>

          <QuickNote projects={projects} saveProject={saveProject} showToast={showToast} />

          <div className="grid">
            {(filter==='all'?projects:projects.filter(p=>p.status===filter)).map(p => (
              <ProjectCard key={p.id} project={p} projects={projects} onClick={() => { setCurrentId(p.id); setView('detail'); setEditMode(false) }} />
            ))}
          </div>
        </div>
      )}

      {/* Detail */}
      {view === 'detail' && currentProject && (
        <div className="page">
          <div className="topbar">
            <button className="back-btn" onClick={() => { setView('registry'); setCurrentId(null); setEditMode(false) }}>
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M10 3L5 8l5 5"/></svg>
              All projects
            </button>
            <h2 style={{fontSize:20,fontWeight:500}}>{currentProject.title}</h2>
            <span className={`badge ${BADGE[currentProject.status]||'badge-done'}`}>{BADGE_LBL[currentProject.status]}</span>
            <div style={{marginLeft:'auto',display:'flex',gap:8}}>
              <button className="btn btn-blue" onClick={() => { setImportPreselect(currentId); setImportOpen(true) }}>Import session ↑</button>
              <button className="btn" onClick={() => setEditMode(e => !e)}>{editMode ? 'Cancel' : 'Edit'}</button>
              <button className="btn btn-danger" onClick={() => { if(confirm('Delete this project?')) { deleteProject(currentId); setView('registry'); setCurrentId(null) } }}>Delete</button>
            </div>
          </div>

          {editMode
            ? <EditView project={currentProject} color={color} onSave={async (updated) => { await saveProject(updated); setEditMode(false) }} onCancel={() => setEditMode(false)} />
            : <ReadView project={currentProject} color={color} dpOpen={dpOpen} setDpOpen={setDpOpen} onDateSave={async (taskIdx, taskType, due, rem) => {
                const p = {...currentProject}
                if (taskType === 'next') {
                  const tasks = [...p.next]
                  const t = mkTask(tasks[taskIdx]); t.dueDate = due; t.reminderDate = rem; tasks[taskIdx] = t; p.next = tasks
                } else {
                  const rem2 = {...(p.openReminders||{})}
                  if (rem) rem2[taskIdx] = rem; else delete rem2[taskIdx]
                  p.openReminders = rem2
                }
                p.updatedAt = nowTs()
                await saveProject(p)
                setDpOpen(null)
              }} />
          }
        </div>
      )}

      {/* Calendar */}
      {view === 'calendar' && (
        <div className="page">
          <CalendarView projects={projects} calView={calView} setCalView={setCalView} calDate={calDate} setCalDate={setCalDate} calFilterId={calFilterId} setCalFilterId={setCalFilterId} />
        </div>
      )}

      {/* Import modal */}
      {importOpen && (
        <ImportModal projects={projects} preselectId={importPreselect} onClose={() => setImportOpen(false)}
          onApply={async (proposal) => {
            let proj = projects.find(p => p.id === proposal.projectId)
            if (!proj) {
              proj = {id:'_import_'+Date.now(),title:proposal.projectTitle||'Imported project',sub:'',status:'active',lastUpdate:'',next:[],open:[],openReminders:{},docs:[],stack:'',notes:[],updatedAt:''}
            }
            const updated = {...proj}
            if (proposal.lastUpdate) updated.lastUpdate = proposal.lastUpdate
            if (proposal.statusChange) updated.status = proposal.statusChange
            if (proposal.stackUpdate) updated.stack = proposal.stackUpdate;
            (proposal.nextActionsAdd||[]).forEach(a => { const txt = typeof a==='string'?a:a.text; if (!updated.next.find(x=>taskText(x)===txt)) updated.next = [...updated.next, mkTask(txt)] })
            ;(proposal.nextActionsRemove||[]).forEach(a => { updated.next = updated.next.filter(x=>taskText(x)!==a) })
            ;(proposal.openItemsAdd||[]).forEach(a => { if (!updated.open.includes(a)) updated.open = [...updated.open, a] })
            ;(proposal.openItemsRemove||[]).forEach(a => { updated.open = updated.open.filter(x=>x!==a) })
            ;(proposal.docsAdd||[]).forEach(d => { updated.docs = [...(updated.docs||[]), d] })
            updated.notes = ['['+nowTs()+'] Session import: '+(proposal.summary||'update applied'), ...(updated.notes||[])]
            updated.updatedAt = nowTs()
            await saveProject(updated)
            setImportOpen(false)
            setCurrentId(updated.id)
            setView('detail')
            showToast('Updates applied to '+updated.title)
          }}
          apiCall={(messages) => api.claude(messages)}
        />
      )}

      {/* Date popover */}
      {dpOpen && (
        <DatePopover
          dpOpen={dpOpen}
          project={currentProject}
          onSave={(taskIdx, taskType, due, rem) => {
            const p = {...currentProject}
            if (taskType === 'next') {
              const tasks = [...p.next]; const t = mkTask(tasks[taskIdx]); t.dueDate = due; t.reminderDate = rem; tasks[taskIdx] = t; p.next = tasks
            } else {
              const r2 = {...(p.openReminders||{})}; if (rem) r2[taskIdx] = rem; else delete r2[taskIdx]; p.openReminders = r2
            }
            p.updatedAt = nowTs(); saveProject(p); setDpOpen(null)
          }}
          onClose={() => setDpOpen(null)}
        />
      )}

      {toast && <div className="toast show">{toast}</div>}
    </div>
  )
}

// ── Project Card ─────────────────────────────────────────────
function ProjectCard({ project: p, projects, onClick }) {
  const color = projColor(p.id, projects)
  const topNext = (p.next||[]).slice(0,2)
  const more = (p.next||[]).length - 2
  return (
    <div className="card" style={{borderLeft:`3px solid ${color}`}} onClick={onClick}>
      <div className="card-header">
        <span className="card-title">{p.title}</span>
        <span className={`badge ${BADGE[p.status]||'badge-done'}`}>{BADGE_LBL[p.status]}</span>
      </div>
      <div className="card-sub">{p.sub}</div>
      <div className="next-items">
        {topNext.map((t,i) => {
          const task = mkTask(t)
          const due = task.dueDate ? (isOverdue(task.dueDate) ? <span className="due-chip due-overdue">Overdue</span> : isDueSoon(task.dueDate) ? <span className="due-chip due-soon">Due soon</span> : <span className="due-chip due-ok">Due {displayDate(task.dueDate)}</span>) : null
          return <div key={i} className="next-item"><span className="next-item-text">{task.text}</span>{due}</div>
        })}
        {more > 0 && <div className="next-item" style={{color:'#94a3b8'}}>+{more} more</div>}
      </div>
      <DocChips docs={p.docs||[]} />
      {p.updatedAt && <div className="card-updated">Updated {p.updatedAt}</div>}
    </div>
  )
}

// ── Doc Chips ────────────────────────────────────────────────
function DocChips({ docs }) {
  const valid = (docs||[]).filter(d => d.label)
  if (!valid.length) return null
  return (
    <div className="card-docs">
      {valid.slice(0,4).map((d,i) => {
        const url = normUrl(d.url)
        const cls = `doc-chip type-${d.type}`
        if (url && isWeb(url)) return <a key={i} className={cls} href={url} target="_blank" rel="noreferrer" onClick={e=>e.stopPropagation()}>{d.label}</a>
        if (url) return <span key={i} className={`${cls} local`} onClick={e=>{e.stopPropagation();navigator.clipboard.writeText(url)}}>{d.label}</span>
        return <span key={i} className={cls} style={{opacity:.5}}>{d.label}</span>
      })}
      {valid.length > 4 && <span className="doc-chip" style={{opacity:.6}}>+{valid.length-4}</span>}
    </div>
  )
}

// ── Quick Note ───────────────────────────────────────────────
function QuickNote({ projects, saveProject, showToast }) {
  const [val, setVal] = useState('')
  const submit = async () => {
    const colon = val.indexOf(':')
    if (colon > 0) {
      const prefix = val.slice(0,colon).trim().toLowerCase()
      const note = val.slice(colon+1).trim()
      const p = projects.find(x => x.title.toLowerCase().includes(prefix) || x.id.toLowerCase().includes(prefix))
      if (p) {
        const ts = nowTs()
        const updated = {...p, notes:[`[${ts}] ${note}`, ...(p.notes||[])], lastUpdate: `${note} (quick note ${ts})`, updatedAt: ts}
        await saveProject(updated); setVal(''); showToast('Note added to '+p.title); return
      }
    }
    showToast("No project matched — try 'ProjectName: your note'")
  }
  return (
    <div className="quick-bar">
      <input value={val} onChange={e=>setVal(e.target.value)} onKeyDown={e=>e.key==='Enter'&&submit()} placeholder="Quick note — e.g. 'ScreenCred: Supabase wiring done'" />
      <button onClick={submit}>Save note</button>
    </div>
  )
}

// ── Read View ────────────────────────────────────────────────
function ReadView({ project: p, color, setDpOpen }) {
  return (
    <div>
      <div className="detail-grid">
        <div>
          <div className="dc">
            <h3>Last update</h3>
            <p style={{fontSize:13,color:'#64748b',marginBottom:8}}>{p.sub}</p>
            <p style={{fontSize:13,lineHeight:1.65}}>{p.lastUpdate||'—'}</p>
            {p.updatedAt && <p style={{fontSize:11,color:'#94a3b8',marginTop:10}}>Last updated {p.updatedAt}</p>}
          </div>
          <div className="dc">
            <h3>Next actions <span style={{fontSize:10,color:'#94a3b8',fontWeight:400,textTransform:'none',letterSpacing:0}}>— click to set dates</span></h3>
            <ul className="detail-list">
              {(p.next||[]).length ? (p.next||[]).map((t,i) => {
                const task = mkTask(t)
                const overdue = isOverdue(task.dueDate)
                const hasDue = !!task.dueDate
                const liCls = overdue ? 'is-overdue' : hasDue ? 'has-date' : ''
                return (
                  <li key={i} className={liCls} onClick={e => setDpOpen({taskIdx:i,taskType:'next',anchorRect:e.currentTarget.getBoundingClientRect()})}>
                    <span className="li-text">{task.text}</span>
                    <span className="li-dates">
                      {task.dueDate && <span className={`li-due ${overdue?'due-overdue':isDueSoon(task.dueDate)?'due-soon':'due-ok'}`}>Due {displayDate(task.dueDate)}</span>}
                      {task.reminderDate && <span className="li-reminder">🔔 {displayDate(task.reminderDate)}</span>}
                      {!task.dueDate && !task.reminderDate && <span style={{fontSize:10,color:'#94a3b8'}}>+ date</span>}
                    </span>
                  </li>
                )
              }) : <li className="empty">None listed</li>}
            </ul>
          </div>
          <div className="dc">
            <h3>Open items / blockers <span style={{fontSize:10,color:'#94a3b8',fontWeight:400,textTransform:'none',letterSpacing:0}}>— click to set reminder</span></h3>
            <ul className="detail-list open-list">
              {(p.open||[]).length ? (p.open||[]).map((o,i) => {
                const rem = p.openReminders?.[i]
                return (
                  <li key={i} className={rem?'has-date':''} onClick={e => setDpOpen({taskIdx:i,taskType:'open',anchorRect:e.currentTarget.getBoundingClientRect()})}>
                    <span className="li-text">{o}</span>
                    <span className="li-dates">
                      {rem ? <span className="li-reminder">🔔 {displayDate(rem)}</span> : <span style={{fontSize:10,color:'#94a3b8'}}>+ reminder</span>}
                    </span>
                  </li>
                )
              }) : <li className="empty">None listed</li>}
            </ul>
          </div>
          {(p.notes||[]).length > 0 && (
            <div className="dc">
              <h3>Session notes log</h3>
              {(p.notes||[]).map((n,i) => <div key={i} className="note-entry">{n}</div>)}
            </div>
          )}
        </div>
        <div>
          <div className="dc">
            <h3>Documents &amp; links</h3>
            {(p.docs||[]).filter(d=>d.label).length ? (p.docs||[]).filter(d=>d.label).map((d,i) => {
              const url = normUrl(d.url)
              return (
                <div key={i} className="detail-doc-item">
                  <span className={`dt type-${d.type}`}>{d.type}</span>
                  <span className="dl">{d.label}</span>
                  {url && isWeb(url) ? <a href={url} target="_blank" rel="noreferrer">{url.replace(/^https?:\/\//,'')}</a>
                    : url ? <button className="copy-btn" onClick={() => navigator.clipboard.writeText(url)}>Copy path</button>
                    : <span style={{fontSize:12,color:'#94a3b8'}}>No URL</span>}
                </div>
              )
            }) : <p className="empty">No documents yet — click Edit to add links.</p>}
          </div>
          <div className="dc">
            <h3>Stack / contacts</h3>
            <p style={{fontSize:13,color:'#64748b',lineHeight:1.65}}>{p.stack||'—'}</p>
          </div>
        </div>
      </div>
    </div>
  )
}

// ── Edit View ────────────────────────────────────────────────
function EditView({ project: p, color, onSave, onCancel }) {
  const [form, setForm] = useState({
    title: p.title||'', status: p.status||'active', sub: p.sub||'',
    lastUpdate: p.lastUpdate||'', stack: p.stack||'',
    next: (p.next||[]).map(mkTask), open: [...(p.open||[])], docs: [...(p.docs||[])]
  })
  const set = (k, v) => setForm(f => ({...f, [k]: v}))

  const save = async () => {
    const updated = {...p, ...form, updatedAt: nowTs()}
    await onSave(updated)
  }

  return (
    <div>
      <div className="dc">
        <div style={{display:'flex',gap:12,marginBottom:12}}>
          <div style={{flex:1}}><span className="lbl">Title</span><input className="edit-field" value={form.title} onChange={e=>set('title',e.target.value)} /></div>
          <div style={{width:130}}><span className="lbl">Status</span>
            <select className="edit-select" value={form.status} onChange={e=>set('status',e.target.value)}>
              <option value="active">Active</option><option value="building">Building</option>
              <option value="hold">On hold</option><option value="done">Done</option>
            </select>
          </div>
        </div>
        <span className="lbl">Subtitle</span>
        <input className="edit-field" value={form.sub} onChange={e=>set('sub',e.target.value)} style={{marginBottom:12}} />
        <span className="lbl">Last update / what was done</span>
        <textarea className="edit-field" rows={4} value={form.lastUpdate} onChange={e=>set('lastUpdate',e.target.value)} />
      </div>

      <div className="dc">
        <h3>Next actions</h3>
        <TaskEditor tasks={form.next} onChange={v=>set('next',v)} />
      </div>

      <div className="dc">
        <h3>Open items / blockers</h3>
        <OpenEditor items={form.open} onChange={v=>set('open',v)} />
      </div>

      <div className="dc">
        <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:10}}>
          <h3 style={{margin:0}}>Documents &amp; links</h3>
          <button className="btn btn-sm" onClick={() => set('docs', [...form.docs, {type:'Doc',label:'',url:''}])}>+ add</button>
        </div>
        <DocEditor docs={form.docs} onChange={v=>set('docs',v)} />
        <p style={{fontSize:11,color:'#94a3b8',marginTop:6}}>Paste Google Drive links, Netlify URLs, GitHub repos, or local paths</p>
      </div>

      <div className="dc">
        <h3>Stack / contacts</h3>
        <textarea className="edit-field" rows={3} value={form.stack} onChange={e=>set('stack',e.target.value)} />
      </div>

      <div className="edit-footer">
        <button className="btn" onClick={onCancel}>Cancel</button>
        <button className="btn btn-primary" onClick={save}>Save changes</button>
      </div>
    </div>
  )
}

// ── Task Editor ──────────────────────────────────────────────
function TaskEditor({ tasks, onChange }) {
  const update = (i, field, val) => { const t = tasks.map(mkTask); t[i] = {...t[i],[field]:val||null}; onChange(t) }
  const remove = (i) => onChange(tasks.filter((_,j)=>j!==i))
  const add = () => onChange([...tasks, {text:'',dueDate:null,reminderDate:null}])
  return (
    <div className="list-ed">
      {tasks.map((t,i) => {
        const task = mkTask(t)
        return (
          <div key={i} className="task-row">
            <div className="task-row-top">
              <input type="text" value={task.text} onChange={e=>update(i,'text',e.target.value)} placeholder="Action item…" />
              <button className="del-btn" onClick={()=>remove(i)}>×</button>
            </div>
            <div className="task-row-dates">
              <label>Due</label>
              <input type="date" value={task.dueDate||''} onChange={e=>update(i,'dueDate',e.target.value)} />
              <label>Reminder</label>
              <input type="date" value={task.reminderDate||''} onChange={e=>update(i,'reminderDate',e.target.value)} />
            </div>
          </div>
        )
      })}
      <button className="add-btn" onClick={add}>+ add action</button>
    </div>
  )
}

// ── Open Editor ──────────────────────────────────────────────
function OpenEditor({ items, onChange }) {
  const update = (i, val) => { const n = [...items]; n[i] = val; onChange(n) }
  const remove = (i) => onChange(items.filter((_,j)=>j!==i))
  const add = () => onChange([...items, ''])
  return (
    <div className="list-ed">
      {items.map((item,i) => (
        <div key={i} className="open-row">
          <input type="text" value={item} onChange={e=>update(i,e.target.value)} placeholder="Open item or blocker…" />
          <button className="del-btn" onClick={()=>remove(i)}>×</button>
        </div>
      ))}
      <button className="add-btn" onClick={add}>+ add item</button>
    </div>
  )
}

// ── Doc Editor ───────────────────────────────────────────────
function DocEditor({ docs, onChange }) {
  const update = (i, field, val) => { const d = docs.map(x=>({...x})); d[i][field] = val; onChange(d) }
  const remove = (i) => onChange(docs.filter((_,j)=>j!==i))
  return (
    <div className="doc-ed">
      {docs.map((d,i) => (
        <div key={i} className="doc-row">
          <select value={d.type} onChange={e=>update(i,'type',e.target.value)}>
            {TYPE_OPTS.map(t => <option key={t} value={t}>{t}</option>)}
          </select>
          <input type="text" value={d.label} onChange={e=>update(i,'label',e.target.value)} placeholder="Label" />
          <input type="text" value={d.url} onChange={e=>update(i,'url',e.target.value)} placeholder="URL or file path" />
          <button className="del-btn" onClick={()=>remove(i)}>×</button>
        </div>
      ))}
    </div>
  )
}

// ── Date Popover ─────────────────────────────────────────────
function DatePopover({ dpOpen, project: p, onSave, onClose }) {
  const { taskIdx, taskType, anchorRect } = dpOpen
  const task = taskType === 'next' ? mkTask((p.next||[])[taskIdx]) : null
  const [due, setDue] = useState(task?.dueDate||'')
  const [rem, setRem] = useState(taskType==='next' ? task?.reminderDate||'' : (p.openReminders?.[taskIdx]||''))
  const text = taskType === 'next' ? task?.text : (p.open||[])[taskIdx]

  const top = Math.min(anchorRect.bottom + window.scrollY + 6, window.innerHeight + window.scrollY - 180)
  const left = Math.min(anchorRect.left + window.scrollX, window.innerWidth - 310)

  return (
    <div className="date-popover" style={{display:'block',top,left}}>
      <button className="dp-close" onClick={onClose}>×</button>
      <h4>{text}</h4>
      {taskType === 'next' && (
        <div className="dp-row"><label>Due</label><input type="date" value={due} onChange={e=>setDue(e.target.value)} /></div>
      )}
      <div className="dp-row"><label>Reminder</label><input type="date" value={rem} onChange={e=>setRem(e.target.value)} /></div>
      <div className="dp-foot">
        <button className="dp-clear" onClick={() => onSave(taskIdx, taskType, null, null)}>Clear dates</button>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" onClick={() => onSave(taskIdx, taskType, due||null, rem||null)}>Save</button>
      </div>
    </div>
  )
}

// ── Calendar View ────────────────────────────────────────────
function CalendarView({ projects, calView, setCalView, calDate, setCalDate, calFilterId, setCalFilterId }) {
  const [popup, setPopup] = useState(null)

  const getEvents = () => {
    const events = []
    projects.forEach(p => {
      if (calFilterId && p.id !== calFilterId) return
      const color = projColor(p.id, projects)
      ;(p.next||[]).forEach(t => {
        const task = mkTask(t)
        if (task.dueDate) events.push({date:task.dueDate,task:task.text,project:p.title,color,type:'due',overdue:isOverdue(task.dueDate)})
        if (task.reminderDate) events.push({date:task.reminderDate,task:task.text,project:p.title,color,type:'reminder',overdue:false})
      })
      Object.entries(p.openReminders||{}).forEach(([idx,date]) => {
        if (date) events.push({date,task:(p.open||[])[idx]||'Open item',project:p.title,color,type:'reminder',overdue:false})
      })
    })
    return events.sort((a,b) => a.date<b.date?-1:a.date>b.date?1:0)
  }

  const events = getEvents()

  const prevMonth = () => setCalDate(d => new Date(d.getFullYear(), d.getMonth()-1, 1))
  const nextMonth = () => setCalDate(d => new Date(d.getFullYear(), d.getMonth()+1, 1))
  const monthLbl = calDate.toLocaleDateString('en-ZA', {month:'long',year:'numeric'})

  return (
    <div>
      <div className="cal-toolbar">
        <div className="cal-nav">
          <button onClick={prevMonth}>‹</button>
          <span className="cal-month-lbl">{monthLbl}</span>
          <button onClick={nextMonth}>›</button>
        </div>
        <button className="cal-today-btn" onClick={() => setCalDate(new Date())}>Today</button>
        <div className="cal-view-toggle">
          <button className={calView==='month'?'active':''} onClick={()=>setCalView('month')}>Month</button>
          <button className={calView==='list'?'active':''} onClick={()=>setCalView('list')}>List</button>
        </div>
        <select className="cal-filter" value={calFilterId} onChange={e=>setCalFilterId(e.target.value)}>
          <option value="">All projects</option>
          {projects.map(p => <option key={p.id} value={p.id}>{p.title}</option>)}
        </select>
        <div style={{marginLeft:'auto',display:'flex',gap:8,alignItems:'center',fontSize:11,color:'#94a3b8'}}>
          <span style={{display:'flex',alignItems:'center',gap:4}}><span style={{width:10,height:10,borderRadius:'50%',background:'#fcebeb',border:'1px solid #a32d2d',display:'inline-block'}}></span>Overdue</span>
          <span style={{display:'flex',alignItems:'center',gap:4}}><span style={{width:10,height:10,borderRadius:'50%',background:'#e6f1fb',border:'1px solid #185fa5',display:'inline-block'}}></span>Due</span>
          <span style={{display:'flex',alignItems:'center',gap:4}}><span style={{width:10,height:10,borderRadius:'50%',background:'#faeeda',border:'1px solid #854f0b',display:'inline-block'}}></span>Reminder</span>
        </div>
      </div>

      {calView === 'month' ? (
        <MonthView calDate={calDate} events={events} popup={popup} setPopup={setPopup} />
      ) : (
        <ListView events={events} />
      )}
    </div>
  )
}

function MonthView({ calDate, events, popup, setPopup }) {
  const year = calDate.getFullYear(), month = calDate.getMonth()
  const firstDay = new Date(year, month, 1)
  const lastDay = new Date(year, month+1, 0)
  const startDow = (firstDay.getDay()+6)%7
  const todayStr = today()

  const byDate = {}
  events.forEach(ev => { if (!byDate[ev.date]) byDate[ev.date]=[]; byDate[ev.date].push(ev) })

  const days = []
  for (let i=0;i<startDow;i++) { const d=new Date(year,month,-startDow+1+i); days.push({date:fmtDate(d),otherMonth:true}) }
  for (let d=1;d<=lastDay.getDate();d++) { days.push({date:`${year}-${pad(month+1)}-${pad(d)}`,otherMonth:false}) }
  const endPad = (7-days.length%7)%7
  for (let i=0;i<endPad;i++) { const d=new Date(year,month+1,i+1); days.push({date:fmtDate(d),otherMonth:true}) }

  return (
    <div className="cal-grid-wrap">
      <div className="cal-dow-row">
        {['Mon','Tue','Wed','Thu','Fri','Sat','Sun'].map(d=><div key={d} className="cal-dow">{d}</div>)}
      </div>
      <div className="cal-days">
        {days.map(({date,otherMonth},i) => {
          const isToday = date === todayStr
          const dayEvents = byDate[date]||[]
          const num = parseInt(date.split('-')[2])
          return (
            <div key={i} className={`cal-day${otherMonth?' other-month':''}${isToday?' today':''}`} onClick={()=>setPopup(null)}>
              <div className="cal-day-num">{num}{isToday&&<span className="today-dot"/>}</div>
              {dayEvents.slice(0,3).map((ev,k) => (
                <div key={k} className={`cal-event ${ev.overdue?'overdue':ev.type==='reminder'?'reminder':'due'}`}
                  style={{borderLeft:`2px solid ${ev.color}`}}
                  onClick={e=>{e.stopPropagation();setPopup({ev,rect:e.currentTarget.getBoundingClientRect()})}}
                >{ev.task}</div>
              ))}
              {dayEvents.length>3 && <div className="cal-more">+{dayEvents.length-3} more</div>}
            </div>
          )
        })}
      </div>
      {popup && (
        <div className="cal-popup" style={{display:'block',top:popup.rect.bottom+window.scrollY+4,left:Math.min(popup.rect.left,window.innerWidth-290)}}>
          <button className="cp-close" onClick={()=>setPopup(null)}>×</button>
          <h4>{popup.ev.task}</h4>
          <div className="cp-project" style={{color:popup.ev.color}}>{popup.ev.project}</div>
          <div className="cp-row">{popup.ev.type==='due'?'Due: '+displayDate(popup.ev.date):'Reminder: '+displayDate(popup.ev.date)}</div>
        </div>
      )}
    </div>
  )
}

function ListView({ events }) {
  if (!events.length) return <div className="cal-empty">No upcoming tasks with dates.</div>
  const groups = {}; const order = []
  events.forEach(ev => { const k=ev.date.slice(0,7); if(!groups[k]){groups[k]=[];order.push(k)} groups[k].push(ev) })
  return (
    <div className="cal-list">
      {order.map(k => (
        <div key={k} className="cal-list-group">
          <div className="cal-list-header">{new Date(k+'-01').toLocaleDateString('en-ZA',{month:'long',year:'numeric'})}</div>
          {groups[k].map((ev,i) => (
            <div key={i} className="cal-list-item">
              <span className="cal-list-dot" style={{background:ev.color}}/>
              <div style={{flex:1}}>
                <div className="cal-list-task">{ev.task}</div>
                <div className="cal-list-project">{ev.project}</div>
              </div>
              <span className={`cal-list-date li-due ${ev.overdue?'due-overdue':ev.type==='reminder'?'due-soon':'due-ok'}`}>{displayDate(ev.date)}</span>
              <span className="cal-list-type">{ev.type==='reminder'?'Reminder':'Due'}</span>
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}

// ── Import Modal ─────────────────────────────────────────────
function ImportModal({ projects, preselectId, onClose, onApply, apiCall }) {
  const [selId, setSelId] = useState(preselectId||'')
  const [text, setText] = useState('')
  const [status, setStatus] = useState('')
  const [proposal, setProposal] = useState(null)
  const [loading, setLoading] = useState(false)

  const analyse = async () => {
    if (!text.trim()) return
    setLoading(true); setStatus('Analysing…'); setProposal(null)
    const selProj = selId ? projects.find(p=>p.id===selId) : null
    const plist = projects.map(p=>`- ${p.title} (id: ${p.id})`).join('\n')
    const ctx = selProj ? `Pre-selected: "${selProj.title}". Next: ${(selProj.next||[]).map(taskText).join('; ')}` : `Known projects:\n${plist}`
    const prompt = `Analyse this session text and extract project registry updates.\n\n${ctx}\n\nText:\n"""\n${text}\n"""\n\nReturn ONLY valid JSON:\n{"projectId":"id or null","projectTitle":"title","confidence":"high|medium|low","isNewProject":false,"summary":"1-2 sentences","statusChange":null,"lastUpdate":"what was done","nextActionsAdd":[],"nextActionsRemove":[],"openItemsAdd":[],"openItemsRemove":[],"docsAdd":[],"stackUpdate":null}`
    try {
      const data = await apiCall([{role:'user',content:prompt}])
      const raw = (data.content||[]).find(b=>b.type==='text')?.text||''
      setProposal(JSON.parse(raw.replace(/```json|```/g,'').trim()))
      setStatus('')
    } catch(e) { setStatus('Analysis failed: '+e.message) }
    setLoading(false)
  }

  return (
    <div className="overlay open" onClick={e=>e.target===e.currentTarget&&onClose()}>
      <div className="modal">
        <div className="modal-head">
          <h2>Import session note</h2>
          <button className="modal-close" onClick={onClose}>×</button>
        </div>
        <div className="modal-body">
          <div className="m-sec">
            <label>Project (leave blank to auto-detect)</label>
            <select value={selId} onChange={e=>setSelId(e.target.value)}>
              <option value="">Auto-detect from text</option>
              {projects.map(p=><option key={p.id} value={p.id}>{p.title}</option>)}
            </select>
          </div>
          <div className="m-sec">
            <label>Paste session text</label>
            <textarea rows={8} value={text} onChange={e=>setText(e.target.value)} placeholder="Paste any text here — conversation, summary, handoff note, or anything…" />
          </div>
          {status && <div className="status-msg">{loading&&<span className="spinner"/>}{status}</div>}
          {proposal && <ProposalView proposal={proposal} projects={projects} />}
        </div>
        <div className="modal-foot">
          <button className="btn" onClick={onClose}>Cancel</button>
          {!proposal && <button className="btn btn-blue" onClick={analyse} disabled={loading}>{loading?'Analysing…':'Analyse ↑'}</button>}
          {proposal && <button className="btn btn-primary" onClick={()=>onApply({...proposal,projectId:proposal.projectId})}>Apply updates</button>}
        </div>
      </div>
    </div>
  )
}

function ProposalView({ proposal: p, projects }) {
  const matched = p.projectId ? projects.find(x=>x.id===p.projectId) : null
  return (
    <div>
      <p style={{fontSize:13,fontWeight:500,marginBottom:10}}>Proposed updates — review before applying:</p>
      <div className="proposal-block">
        <h4>Project</h4>
        <p>{p.projectTitle||'Unknown'} {matched ? <span style={{color:'#3b6d11',fontSize:12}}>✓ matched</span> : <span style={{color:'#854f0b',fontSize:12}}>⚠ will create new</span>}</p>
        <p style={{fontSize:12,color:'#94a3b8',marginTop:4}}>Confidence: {p.confidence||'?'} · {p.summary||''}</p>
      </div>
      {p.lastUpdate && <div className="proposal-block"><h4>Last update</h4><p>{p.lastUpdate}</p></div>}
      {((p.nextActionsAdd?.length)||(p.nextActionsRemove?.length)) && (
        <div className="proposal-block"><h4>Next actions</h4><ul>
          {(p.nextActionsAdd||[]).map((a,i)=><li key={i}>{a} <span className="tag-add">add</span></li>)}
          {(p.nextActionsRemove||[]).map((a,i)=><li key={i}>{a} <span className="tag-rem">remove</span></li>)}
        </ul></div>
      )}
      {((p.openItemsAdd?.length)||(p.openItemsRemove?.length)) && (
        <div className="proposal-block"><h4>Open items</h4><ul>
          {(p.openItemsAdd||[]).map((a,i)=><li key={i}>{a} <span className="tag-add">add</span></li>)}
          {(p.openItemsRemove||[]).map((a,i)=><li key={i}>{a} <span className="tag-rem">remove</span></li>)}
        </ul></div>
      )}
    </div>
  )
}

// ── CSS ───────────────────────────────────────────────────────
const css = `
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{--bg:#f4f7fb;--surface:#fff;--surface2:#f1f4f8;--border:#e2e8f0;--border2:#cbd5e1;--text:#1a2332;--text2:#64748b;--text3:#94a3b8;--blue:#185fa5;--blue-bg:#e6f1fb;--blue-text:#0c447c;--green:#3b6d11;--green-bg:#eaf3de;--green-text:#27500a;--amber:#854f0b;--amber-bg:#faeeda;--amber-text:#633806;--gray:#5f5e5a;--gray-bg:#f1efe8;--gray-text:#444441;--red:#a32d2d;--red-bg:#fcebeb;--red-text:#791f1f;--purple-bg:#eeedfe;--purple-text:#3c3489;--teal-bg:#e1f5ee;--teal-text:#085041;--r:8px;--rl:12px;--shadow:0 1px 3px rgba(0,0,0,.07)}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:var(--bg)}
.page{padding:24px;max-width:1100px;margin:0 auto}
.btn{font-size:12px;padding:5px 13px;border-radius:var(--r);border:1px solid var(--border2);background:var(--surface);color:var(--text);cursor:pointer;white-space:nowrap}
.btn:hover{background:var(--surface2)}.btn-primary{background:var(--text);color:var(--surface);border-color:var(--text)}.btn-primary:hover{opacity:.85}.btn-sm{font-size:11px;padding:3px 10px}.btn-danger{color:var(--red);border-color:var(--red)}.btn-blue{color:var(--blue);border-color:var(--blue)}
.badge{font-size:11px;padding:2px 9px;border-radius:var(--r);white-space:nowrap;font-weight:500}.badge-active{background:var(--green-bg);color:var(--green-text)}.badge-building{background:var(--blue-bg);color:var(--blue-text)}.badge-hold{background:var(--amber-bg);color:var(--amber-text)}.badge-done{background:var(--gray-bg);color:var(--gray-text)}
.main-nav{display:flex;gap:0;border-bottom:1px solid var(--border);background:var(--surface);padding:0 24px}
.nav-tab{font-size:13px;padding:12px 16px;color:var(--text2);cursor:pointer;border:none;background:none;border-bottom:2px solid transparent;margin-bottom:-1px}.nav-tab:hover{color:var(--text)}.nav-tab.active{color:var(--text);border-bottom-color:var(--text);font-weight:500}
.page h1{font-size:18px;font-weight:500;margin-bottom:4px}
.toolbar{display:flex;gap:8px;margin-bottom:16px;flex-wrap:wrap;align-items:center}.filter-btn{font-size:12px;padding:5px 13px;border-radius:var(--r);border:1px solid var(--border2);background:var(--surface);color:var(--text2);cursor:pointer}.filter-btn.active,.filter-btn:hover{background:var(--surface2);color:var(--text)}.filter-btn.active{font-weight:500}.count-lbl{font-size:12px;color:var(--text3);margin-left:auto;align-self:center}
.quick-bar{display:flex;gap:8px;margin-bottom:20px}.quick-bar input{flex:1;font-size:13px;padding:7px 12px;border-radius:var(--r);border:1px solid var(--border2);background:var(--surface);color:var(--text);outline:none}.quick-bar input:focus{border-color:var(--blue)}.quick-bar button{font-size:13px;padding:7px 16px;border-radius:var(--r);border:1px solid var(--border2);background:var(--surface);color:var(--text);cursor:pointer}.quick-bar button:hover{background:var(--surface2)}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:12px}
.card{background:var(--surface);border:1px solid var(--border);border-radius:var(--rl);padding:14px 16px 12px;cursor:pointer;transition:border-color .15s,box-shadow .15s,transform .15s;box-shadow:var(--shadow)}.card:hover{border-color:var(--border2);box-shadow:0 2px 8px rgba(0,0,0,.1);transform:translateY(-1px)}.card-header{display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:4px;gap:8px}.card-title{font-size:14px;font-weight:500}.card-sub{font-size:12px;color:var(--text2);margin-bottom:10px}.next-items{border-top:1px solid var(--border);padding-top:8px}.next-item{font-size:12px;color:var(--text2);display:flex;gap:6px;line-height:1.5;margin-bottom:3px;align-items:flex-start}.next-item::before{content:"›";color:var(--text3);flex-shrink:0;margin-top:1px}.next-item-text{flex:1}.card-updated{font-size:11px;color:var(--text3);margin-top:8px}
.card-docs{display:flex;gap:5px;flex-wrap:wrap;margin-top:8px;padding-top:8px;border-top:1px solid var(--border)}.doc-chip{font-size:11px;padding:2px 8px;border-radius:20px;border:1px solid var(--border2);color:var(--text2);background:var(--surface2);white-space:nowrap;text-decoration:none;display:inline-flex;align-items:center;max-width:150px;overflow:hidden;text-overflow:ellipsis}.doc-chip:hover{border-color:var(--blue);color:var(--blue)}.doc-chip.local{border-style:dashed;cursor:pointer}.type-Deck{background:var(--purple-bg);color:var(--purple-text);border-color:#afa9ec}.type-Model{background:var(--green-bg);color:var(--green-text);border-color:#9fe1cb}.type-Code{background:var(--gray-bg);color:var(--gray-text);border-color:#b4b2a9}.type-Tool{background:var(--blue-bg);color:var(--blue-text);border-color:#85b7eb}.type-Doc{background:var(--teal-bg);color:var(--teal-text);border-color:#5dcaa5}
.due-chip{font-size:10px;padding:1px 6px;border-radius:20px;white-space:nowrap;flex-shrink:0;margin-top:1px}.due-ok{background:var(--blue-bg);color:var(--blue-text)}.due-soon{background:var(--amber-bg);color:var(--amber-text)}.due-overdue{background:var(--red-bg);color:var(--red-text);font-weight:600}
.topbar{display:flex;align-items:center;gap:12px;margin-bottom:20px;flex-wrap:wrap}.back-btn{display:flex;align-items:center;gap:5px;font-size:13px;color:var(--text2);cursor:pointer;background:none;border:none;padding:0;flex-shrink:0}.back-btn:hover{color:var(--text)}.topbar-right{margin-left:auto;display:flex;gap:8px}
.detail-grid{display:grid;grid-template-columns:1fr 340px;gap:16px}@media(max-width:720px){.detail-grid{grid-template-columns:1fr}}
.dc{background:var(--surface);border:1px solid var(--border);border-radius:var(--rl);padding:16px 18px;margin-bottom:14px;box-shadow:var(--shadow)}.dc h3{font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.05em;color:var(--text3);margin-bottom:10px}
.detail-list{list-style:none;display:flex;flex-direction:column;gap:6px}.detail-list li{font-size:13px;display:flex;gap:8px;align-items:flex-start;line-height:1.5;cursor:pointer;border-radius:var(--r);padding:3px 6px;margin:-3px -6px;transition:background .1s}.detail-list li:hover{background:var(--surface2)}.detail-list li.has-date{background:var(--blue-bg)}.detail-list li.has-date:hover{background:#d4e8f7}.detail-list li.is-overdue{background:var(--red-bg)}.detail-list li.is-overdue:hover{background:#f5c4c4}.detail-list li::before{content:"›";color:var(--text3);flex-shrink:0;margin-top:1px}.open-list li::before{content:"⚠";font-size:11px;margin-top:2px;color:var(--amber)}.li-text{flex:1}.li-dates{display:flex;flex-direction:column;gap:2px;align-items:flex-end;flex-shrink:0}.li-due{font-size:11px;padding:1px 7px;border-radius:20px;white-space:nowrap}.li-reminder{font-size:10px;color:var(--text3);white-space:nowrap}
.detail-doc-list{display:flex;flex-direction:column;gap:6px}.detail-doc-item{display:flex;align-items:center;gap:8px;padding:8px 10px;border:1px solid var(--border);border-radius:var(--r);background:var(--surface2)}.detail-doc-item .dt{font-size:10px;font-weight:600;padding:2px 7px;border-radius:20px;min-width:44px;text-align:center;flex-shrink:0}.detail-doc-item .dl{flex:1;font-size:13px;font-weight:500}.detail-doc-item a{font-size:12px;color:var(--blue);text-decoration:none;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:180px}.detail-doc-item a:hover{text-decoration:underline}.copy-btn{font-size:11px;background:var(--amber-bg);color:var(--amber-text);border:none;border-radius:var(--r);padding:3px 9px;cursor:pointer}
.note-entry{font-size:12px;color:var(--text2);padding:6px 0;border-bottom:1px solid var(--border);line-height:1.5}.note-entry:last-child{border-bottom:none}.empty{font-size:13px;color:var(--text3);font-style:italic}
.lbl{font-size:11px;color:var(--text3);font-weight:600;text-transform:uppercase;letter-spacing:.05em;display:block;margin-bottom:4px}
.edit-field{width:100%;font-size:13px;padding:6px 9px;border-radius:var(--r);border:1px solid var(--border2);background:var(--surface);color:var(--text);font-family:inherit;outline:none}.edit-field:focus{border-color:var(--blue)}textarea.edit-field{resize:vertical;line-height:1.55}.edit-select{font-size:13px;padding:5px 9px;border-radius:var(--r);border:1px solid var(--border2);background:var(--surface);color:var(--text);outline:none;cursor:pointer}
.list-ed{display:flex;flex-direction:column;gap:6px}.task-row{display:flex;flex-direction:column;gap:4px;padding:8px 10px;border:1px solid var(--border);border-radius:var(--r);background:var(--surface2)}.task-row-top{display:flex;gap:6px;align-items:flex-start}.task-row-top input[type=text]{flex:1;font-size:13px;padding:5px 8px;border-radius:var(--r);border:1px solid var(--border2);background:var(--surface);color:var(--text);font-family:inherit;outline:none}.task-row-top input[type=text]:focus{border-color:var(--blue)}.task-row-dates{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.task-row-dates label{font-size:11px;color:var(--text3);white-space:nowrap}.task-row-dates input[type=date]{font-size:12px;padding:3px 6px;border-radius:var(--r);border:1px solid var(--border2);background:var(--surface);color:var(--text);outline:none;cursor:pointer}
.open-row{display:flex;gap:6px}.open-row input{flex:1;font-size:13px;padding:6px 9px;border-radius:var(--r);border:1px solid var(--border2);background:var(--surface);color:var(--text);font-family:inherit;outline:none}.open-row input:focus{border-color:var(--blue)}
.doc-ed{display:flex;flex-direction:column;gap:6px}.doc-row{display:grid;grid-template-columns:80px 1fr 1fr 28px;gap:5px;align-items:center}.doc-row select,.doc-row input{font-size:12px;padding:5px 7px;border-radius:var(--r);border:1px solid var(--border2);background:var(--surface);color:var(--text);font-family:inherit;outline:none;width:100%}.doc-row select:focus,.doc-row input:focus{border-color:var(--blue)}
.del-btn{background:none;border:1px solid var(--border);border-radius:var(--r);padding:5px 9px;cursor:pointer;color:var(--text3);font-size:14px;line-height:1;flex-shrink:0}.del-btn:hover{color:var(--red);border-color:var(--red)}.add-btn{font-size:12px;color:var(--blue);background:none;border:none;cursor:pointer;padding:2px 0;text-align:left;margin-top:2px}.add-btn:hover{text-decoration:underline}.edit-footer{display:flex;gap:8px;justify-content:flex-end;margin-top:14px;padding-top:12px;border-top:1px solid var(--border)}
.cal-toolbar{display:flex;gap:10px;align-items:center;margin-bottom:18px;flex-wrap:wrap}.cal-nav{display:flex;align-items:center;gap:8px}.cal-nav button{font-size:16px;background:none;border:1px solid var(--border2);border-radius:var(--r);padding:3px 10px;cursor:pointer;color:var(--text2)}.cal-nav button:hover{background:var(--surface2)}.cal-month-lbl{font-size:15px;font-weight:500;min-width:160px;text-align:center}.cal-view-toggle{display:flex;gap:0;border:1px solid var(--border2);border-radius:var(--r);overflow:hidden}.cal-view-toggle button{font-size:12px;padding:5px 14px;border:none;background:var(--surface);color:var(--text2);cursor:pointer;border-right:1px solid var(--border2)}.cal-view-toggle button:last-child{border-right:none}.cal-view-toggle button.active{background:var(--text);color:var(--surface)}.cal-filter{font-size:12px;padding:5px 9px;border-radius:var(--r);border:1px solid var(--border2);background:var(--surface);color:var(--text);outline:none;cursor:pointer}.cal-today-btn{font-size:12px;padding:5px 13px;border-radius:var(--r);border:1px solid var(--border2);background:var(--surface);color:var(--text2);cursor:pointer}.cal-today-btn:hover{background:var(--surface2)}
.cal-grid-wrap{background:var(--surface);border:1px solid var(--border);border-radius:var(--rl);overflow:hidden;box-shadow:var(--shadow);position:relative}.cal-dow-row{display:grid;grid-template-columns:repeat(7,1fr);border-bottom:1px solid var(--border)}.cal-dow{font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.05em;color:var(--text3);text-align:center;padding:8px 0}.cal-days{display:grid;grid-template-columns:repeat(7,1fr)}.cal-day{min-height:90px;border-right:1px solid var(--border);border-bottom:1px solid var(--border);padding:6px 6px 4px}.cal-day:nth-child(7n){border-right:none}.cal-day.other-month{background:var(--surface2)}.cal-day.today{background:#fffbf0}.cal-day-num{font-size:12px;font-weight:500;color:var(--text2);margin-bottom:4px;display:flex;align-items:center;gap:4px}.cal-day.today .cal-day-num{color:var(--blue);font-weight:700}.today-dot{width:6px;height:6px;border-radius:50%;background:var(--blue);display:inline-block}.cal-event{font-size:11px;padding:2px 5px;border-radius:4px;margin-bottom:2px;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;line-height:1.4}.cal-event:hover{opacity:.85}.cal-event.overdue{background:var(--red-bg);color:var(--red-text);font-weight:600}.cal-event.reminder{background:var(--amber-bg);color:var(--amber-text)}.cal-event.due{background:var(--blue-bg);color:var(--blue-text)}.cal-more{font-size:10px;color:var(--text3);cursor:pointer;padding:1px 4px}
.cal-list{display:flex;flex-direction:column;gap:8px}.cal-list-group{background:var(--surface);border:1px solid var(--border);border-radius:var(--rl);overflow:hidden;box-shadow:var(--shadow)}.cal-list-header{font-size:12px;font-weight:600;color:var(--text2);padding:8px 14px;background:var(--surface2);border-bottom:1px solid var(--border)}.cal-list-item{display:flex;align-items:center;gap:10px;padding:9px 14px;border-bottom:1px solid var(--border)}.cal-list-item:last-child{border-bottom:none}.cal-list-dot{width:10px;height:10px;border-radius:50%;flex-shrink:0}.cal-list-task{flex:1;font-size:13px}.cal-list-project{font-size:11px;color:var(--text2)}.cal-list-date{font-size:11px;white-space:nowrap;padding:2px 7px;border-radius:20px}.cal-list-type{font-size:10px;color:var(--text3);padding:1px 6px;border:1px solid var(--border);border-radius:20px;white-space:nowrap}.cal-empty{text-align:center;color:var(--text2);padding:3rem 0;font-size:14px}
.cal-popup{position:absolute;z-index:500;background:var(--surface);border:1px solid var(--border2);border-radius:var(--rl);padding:12px 14px;box-shadow:0 4px 20px rgba(0,0,0,.15);max-width:280px}.cal-popup h4{font-size:13px;font-weight:500;margin-bottom:4px}.cp-project{font-size:11px;margin-bottom:8px}.cp-row{font-size:12px;color:var(--text2);margin-bottom:3px}.cp-close{position:absolute;top:8px;right:10px;background:none;border:none;font-size:16px;cursor:pointer;color:var(--text3);line-height:1}
.date-popover{position:fixed;z-index:400;background:var(--surface);border:1px solid var(--border2);border-radius:var(--rl);padding:14px 16px;box-shadow:0 4px 24px rgba(0,0,0,.18);width:300px}.date-popover h4{font-size:13px;font-weight:500;margin-bottom:10px;color:var(--text);line-height:1.4}.dp-row{display:flex;align-items:center;gap:8px;margin-bottom:8px}.dp-row label{font-size:11px;color:var(--text3);font-weight:600;text-transform:uppercase;letter-spacing:.04em;width:72px;flex-shrink:0}.dp-row input[type=date]{flex:1;font-size:12px;padding:4px 7px;border-radius:var(--r);border:1px solid var(--border2);background:var(--surface);color:var(--text);outline:none;cursor:pointer}.dp-foot{display:flex;gap:6px;justify-content:flex-end;margin-top:10px;padding-top:10px;border-top:1px solid var(--border)}.dp-close{position:absolute;top:8px;right:10px;background:none;border:none;font-size:16px;cursor:pointer;color:var(--text3);line-height:1}.dp-clear{font-size:11px;color:var(--red);background:none;border:none;cursor:pointer;margin-right:auto;padding:0}.dp-clear:hover{text-decoration:underline}
.overlay{position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:300;align-items:center;justify-content:center;padding:20px;display:none}.overlay.open{display:flex}.modal{background:var(--surface);border:1px solid var(--border);border-radius:var(--rl);width:640px;max-width:100%;max-height:92vh;overflow-y:auto;box-shadow:0 8px 32px rgba(0,0,0,.2);display:flex;flex-direction:column}.modal-head{display:flex;align-items:center;justify-content:space-between;padding:16px 20px 12px;border-bottom:1px solid var(--border);flex-shrink:0}.modal-head h2{font-size:15px;font-weight:500}.modal-close{background:none;border:none;font-size:22px;cursor:pointer;color:var(--text3);line-height:1;padding:0 4px}.modal-body{padding:16px 20px;overflow-y:auto;flex:1}.modal-foot{padding:12px 20px;border-top:1px solid var(--border);display:flex;gap:8px;justify-content:flex-end;flex-shrink:0}
.m-sec{margin-bottom:16px}.m-sec label{font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.05em;color:var(--text3);display:block;margin-bottom:6px}.m-sec select,.m-sec textarea{width:100%;font-size:13px;padding:7px 9px;border-radius:var(--r);border:1px solid var(--border2);background:var(--surface);color:var(--text);font-family:inherit;outline:none}.m-sec textarea{resize:vertical;line-height:1.55}
.proposal-block{background:var(--surface2);border:1px solid var(--border);border-radius:var(--r);padding:12px 14px;margin-bottom:10px}.proposal-block h4{font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.04em;color:var(--text3);margin-bottom:6px}.proposal-block p,.proposal-block li{font-size:13px;line-height:1.6}.proposal-block ul{padding-left:14px}
.tag-add{font-size:10px;background:var(--green-bg);color:var(--green-text);padding:1px 6px;border-radius:20px;margin-left:6px}.tag-rem{font-size:10px;background:var(--red-bg);color:var(--red-text);padding:1px 6px;border-radius:20px;margin-left:6px}
.spinner{display:inline-block;width:14px;height:14px;border:2px solid var(--border2);border-top-color:var(--blue);border-radius:50%;animation:spin .7s linear infinite;vertical-align:middle;margin-right:6px}@keyframes spin{to{transform:rotate(360deg)}}.status-msg{font-size:13px;color:var(--text2);padding:8px 0}
.toast{position:fixed;bottom:24px;right:24px;background:var(--text);color:var(--surface);font-size:13px;padding:10px 18px;border-radius:var(--r);opacity:0;transform:translateY(8px);transition:all .2s;pointer-events:none;z-index:999}.toast.show{opacity:1;transform:translateY(0)}
`
