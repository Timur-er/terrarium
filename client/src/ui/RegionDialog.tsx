import { useEffect } from 'react'
import { useStore } from '../store'

const W = 560, H = 430, PAD = 64

/** The region map: domes as rings, roads between them, rovers on the roads. Click a dome to move the camera there. */
export function RegionDialog() {
  const open = useStore(s => s.regionOpen)
  const setOpen = useStore(s => s.setRegionOpen)
  const view = useStore(s => s.regionView)
  const setDome = useStore(s => s.setDome)
  const mode = useStore(s => s.mode)
  const caravan = useStore(s => s.caravan)
  const player = useStore(s => s.player)

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, setOpen])
  if (!open || !view) return null

  const xs = view.domes.map(d => d.x), ys = view.domes.map(d => d.y)
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys)
  const sx = (W - PAD * 2) / Math.max(1, maxX - minX), sy = (H - PAD * 2) / Math.max(1, maxY - minY)
  const k = Math.min(sx, sy)
  const px = (x: number) => PAD + (x - minX) * k + ((W - PAD * 2) - (maxX - minX) * k) / 2
  const py = (y: number) => PAD + (y - minY) * k + ((H - PAD * 2) - (maxY - minY) * k) / 2
  const pos = (id: string) => { const d = view.domes.find(x => x.id === id)!; return { x: px(d.x), y: py(d.y) } }
  const total = view.domes.reduce((s, d) => s + d.population, 0)
  const me = view.domes.find(d => d.id === view.active)
  const linked = (id: string) => view.links.some(l => (l.a === id && l.b === view.active) || (l.b === id && l.a === view.active))
  const built = view.domes.filter(d => !d.site)
  const reasonWord = (r: string) => r === 'trade' ? 'hauling goods' : r === 'return' ? 'heading home' : r === 'found' ? 'off to found a dome' : 'relocating'

  return (
    <div className="modal-bg" onClick={() => setOpen(false)}>
      <div className="modal region" onClick={e => e.stopPropagation()}>
        <div className="modal-head">
          <h2>Region</h2>
          <p>{view.domes.length} domes, {total} residents, {view.travelers.length} on the road · {mode === 'remote' ? 'the whole region lives on the server' : 'all domes live in this tab'}</p>
          <button className="x" onClick={() => setOpen(false)}>×</button>
        </div>
        <div className="modal-body">
          <svg className="region-map" viewBox={`0 0 ${W} ${H}`} width="100%">
            <defs>
              <pattern id="rg" width="20" height="20" patternUnits="userSpaceOnUse"><path d="M20 0H0V20" fill="none" stroke="currentColor" strokeOpacity="0.08" /></pattern>
              <radialGradient id="dg"><stop offset="0" stopColor="#9fd0ff" stopOpacity="0.28" /><stop offset="1" stopColor="#9fd0ff" stopOpacity="0.02" /></radialGradient>
            </defs>
            <rect width={W} height={H} fill="url(#rg)" />
            {view.links.map(l => { const a = pos(l.a), b = pos(l.b); const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2; return (
              <g key={`${l.a}${l.b}`}>
                <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} className="road" />
                <text x={mx} y={my - 6} className="road-label" textAnchor="middle">{l.hours} h on the road</text>
              </g>
            ) })}
            {view.travelers.map((t, i) => { const a = pos(t.from), b = pos(t.to); const x = a.x + (b.x - a.x) * t.progress, y = a.y + (b.y - a.y) * t.progress; return (
              <g key={i} className={`rover ${t.reason}`}>
                <circle cx={x} cy={y} r={4} />
                <title>{t.name} {reasonWord(t.reason)}: {view.domes.find(d => d.id === t.from)?.name} → {view.domes.find(d => d.id === t.to)?.name}</title>
              </g>
            ) })}
            {view.domes.map(d => { const p = pos(d.id); const r = 14 + Math.sqrt(d.population) * 1.6; const active = d.id === view.active; return (
              <g key={d.id} className={`dome ${active ? 'active' : ''} ${d.site ? 'site' : ''}`} onClick={() => { if (!d.site) { setDome(d.id); setOpen(false) } }} style={{ cursor: active || d.site ? 'default' : 'pointer' }}>
                {!d.site && <circle cx={p.x} cy={p.y} r={r + 10} fill="url(#dg)" />}
                <circle cx={p.x} cy={p.y} r={r} className="hull" />
                {!d.site && <circle cx={p.x} cy={p.y} r={r * 0.55} className="core" />}
                <text x={p.x} y={p.y - r - 9} textAnchor="middle" className="name">{d.name.toUpperCase()}</text>
                <text x={p.x} y={p.y + r + 14} textAnchor="middle" className="meta">{d.site ? `construction site${d.founder ? ` · led by ${d.founder}` : ''}` : `${d.population} res. · ${d.conflicts} quarrels`}</text>
                {!d.site && d.stock && <text x={p.x} y={p.y + r + 26} textAnchor="middle" className="meta stock">{d.stock.food} rations at {d.prices?.food} · {d.stock.parts} parts at {d.prices?.parts}</text>}
                {active && <text x={p.x} y={p.y + 3} textAnchor="middle" className="you">you</text>}
              </g>
            ) })}
          </svg>
          <div className="trade">
            <div className="trade-head">Depots and caravans{me?.stock ? <span> · yours: <b>{me.stock.food}</b> rations at {me.prices?.food}, <b>{me.stock.parts}</b> parts at {me.prices?.parts}</span> : null}</div>
            <div className="trade-rows">
              {built.filter(d => d.id !== view.active).map(d => {
                const s = d.surplus ?? { food: 0, parts: 0 }
                const can = linked(d.id) && (s.food > 0 || s.parts > 0)
                const why = !linked(d.id) ? 'no direct road' : s.food || s.parts ? `will give ${[s.food ? `${s.food} rations` : '', s.parts ? `${s.parts} parts` : ''].filter(Boolean).join(' and ')}` : 'no surplus'
                return (
                  <div className="trade-row" key={d.id}>
                    <span className="trade-name">{d.name}</span>
                    <span className="trade-stock">{d.stock?.food ?? 0} rations at {d.prices?.food ?? '?'} · {d.stock?.parts ?? 0} parts at {d.prices?.parts ?? '?'}</span>
                    <span className="trade-why">{why}</span>
                    <button className="sbtn" disabled={!can} onClick={() => caravan(d.id)} title={mode === 'remote' ? 'costs 3 influence' : ''}>[ caravan here{mode === 'remote' && player ? ' · ◈3' : ''} ]</button>
                  </div>
                )
              })}
            </div>
          </div>
          <p style={{ color: 'var(--ink-3)', fontSize: 11.5, marginTop: 6 }}>
            Domes are linked by roads. Each dome's depot lives its own life: agronomists grow rations, mechanics turn out parts, purchases and construction spend them, prices follow the stock. Every two days the quartermaster loads the surplus and drives to where it sells higher, bringing back what is cheap there. Whoever leaves through the airlock reaches the neighbouring dome and tries to settle there. When the dome gets crowded and gloomy, someone gathers the discontented and leads them off to raise a new dome; you can whisper the same. Click a dome to move the camera there: the others keep living.
          </p>
        </div>
      </div>
    </div>
  )
}
