import { useEffect, useMemo, useState } from 'react'
import type { EnvMaster, ItemMaster, ItemMasterRow, MasterValidation, Masters, V2State } from '../types'
import { resetMasters, saveMasters, validateMasters } from '../api'
import { CSV_HEADER, parseItemCsv, toItemCsv } from '../lib/masterCsv'
import { objectRanges } from '../lib/videoSync'

type Tab = 'items' | 'batches' | 'env'
const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v))
const numOrNull = (s: string): number | null => (s.trim() === '' ? null : Number(s))

/** ⓪ マスタ登録：荷物マスタ・環境マスタ（カゴ車・仮置き場・作業エリア）を登録する。以降のステップはこの値を前提に動く。 */
export default function MasterStep({ st, onSaved }: { st: V2State; onSaved: (m: Masters) => void }) {
  const [items, setItems] = useState<ItemMaster>(() => clone(st.masters.items))
  const [env, setEnv] = useState<EnvMaster>(() => clone(st.masters.environment))
  const [v, setV] = useState<MasterValidation>(st.masters.validation)
  const [tab, setTab] = useState<Tab>('items')
  const [csv, setCsv] = useState<string | null>(null)
  const [csvErr, setCsvErr] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)

  const dirty = JSON.stringify(items) !== JSON.stringify(st.masters.items) || JSON.stringify(env) !== JSON.stringify(st.masters.environment)
  // 入力のたびに（少し待って）バックエンドで検証する
  useEffect(() => {
    if (!dirty) { setV(st.masters.validation); return }
    const h = setTimeout(() => { validateMasters(items, env).then(setV).catch((e) => setMsg(String(e))) }, 350)
    return () => clearTimeout(h)
  }, [items, env, dirty, st.masters.validation])

  // 動画の観測テキストに出てくる荷物ID（Step 1 との照合）
  const inVideo = useMemo(() => new Set(Object.keys(objectRanges(st.extraction?.inputs?.observations.segments ?? []))), [st.extraction])
  const issuesOf = (target: string) => ({
    err: v.errors.filter((e) => e.target === target), warn: v.warnings.filter((e) => e.target === target),
  })
  const cart = env.carts.find((c) => c.cart_id === env.active_cart_id) ?? env.carts[0]
  const weightOf = (id: string) => items.items.find((i) => i.object_id === id)?.weight_kg ?? 0

  const setRow = (n: number, patch: Partial<ItemMasterRow>) =>
    setItems((m) => ({ ...m, items: m.items.map((r, i) => (i === n ? { ...r, ...patch } : r)) }))
  const setDim = (n: number, k: number, s: string) => {
    const r = items.items[n]
    const d = [...(r.dims_m ?? [NaN, NaN, NaN])] as number[]
    d[k] = s.trim() === '' ? NaN : Number(s)
    setRow(n, { dims_m: d.every((x) => Number.isFinite(x)) ? (d as [number, number, number]) : d.every((x) => Number.isNaN(x)) ? null : (d as [number, number, number]) })
  }
  const addRow = () => setItems((m) => ({ ...m, items: [...m.items, { object_id: '', name: '', object_type: '段ボール箱', material_class: 'rigid', weight_kg: null, dims_m: null, fragile_content: false, handling_note: '' }] }))
  const delRow = (n: number) => setItems((m) => ({ ...m, items: m.items.filter((_, i) => i !== n) }))

  function importCsv(mode: 'replace' | 'append') {
    const r = parseItemCsv(csv ?? '')
    setCsvErr(r.errors)
    if (!r.rows.length) return
    setItems((m) => ({ ...m, items: mode === 'replace' ? r.rows : [...m.items, ...r.rows] }))
    setCsv(null)
    setMsg(`CSVから${r.rows.length}行を${mode === 'replace' ? '読み込みました（置き換え）' : '追加しました'}。保存すると反映されます。`)
  }
  async function save() {
    setBusy(true); setMsg(null)
    try {
      const m = await saveMasters(items, env)
      onSaved(m)
      setMsg('マスタを登録しました。Step 1〜5 はこの値で再計算されます（実行済みの結果は破棄しました）。')
    } catch (e) { setMsg(String(e)) } finally { setBusy(false) }
  }
  async function reset() {
    setBusy(true); setMsg(null)
    try {
      const m = await resetMasters()
      setItems(clone(m.items)); setEnv(clone(m.environment))
      onSaved(m)
      setMsg('初期値（模擬のマスタ）に戻しました。')
    } catch (e) { setMsg(String(e)) } finally { setBusy(false) }
  }

  const ids = items.items.map((i) => i.object_id)
  const videoIds = [...inVideo]
  const unregistered = videoIds.filter((id) => !ids.includes(id))

  return (
    <div className="step-page master" data-testid="page-0">
      <section className="ms-head">
        <div className="ms-flow">
          <span className="ms-f is-on">① 荷物・設備をマスタに登録</span><em>→</em>
          <span className="ms-f">② 動画の荷物IDと照合（Step 1）</span><em>→</em>
          <span className="ms-f">③ 属性を荷物ごとの判断に使う（Step 2）</span><em>→</em>
          <span className="ms-f">④ カゴ車・荷物の値で能力照合と仮想実行（Step 3・4）</span>
        </div>
        <div className="ms-status">
          <span className={`badge ${st.masters.source === 'registered' ? 'badge-ok' : 'badge-info'}`} data-testid="master-source">
            {st.masters.source === 'registered' ? `登録済み（${(st.masters.updated_at ?? '').slice(0, 16).replace('T', ' ')}）` : '初期値（模擬のマスタ）'}
          </span>
          {dirty && <span className="badge badge-warn" data-testid="master-dirty">未保存の変更あり</span>}
          <button className="run" onClick={save} disabled={busy || !dirty || !v.ok} data-testid="master-save">保存して以降のステップに反映</button>
          <button className="secondary-btn" onClick={reset} disabled={busy || (st.masters.source === 'default' && !dirty)} data-testid="master-reset">初期値に戻す</button>
        </div>
      </section>
      {msg && <div className="ms-msg" data-testid="master-msg">{msg}</div>}
      <div className="ms-main">
        <section className="ms-body">
          <div className="tabs">
            <button className={tab === 'items' ? 'is-on' : ''} onClick={() => setTab('items')} data-testid="mtab-items">荷物マスタ（{items.items.length}件）</button>
            <button className={tab === 'batches' ? 'is-on' : ''} onClick={() => setTab('batches')} data-testid="mtab-batches">便（荷物の組み合わせ {items.batches.length}件）</button>
            <button className={tab === 'env' ? 'is-on' : ''} onClick={() => setTab('env')} data-testid="mtab-env">環境マスタ（カゴ車・仮置き場・作業エリア）</button>
          </div>

          {tab === 'items' && (
            <div className="ms-items">
              <div className="ms-tools">
                <button onClick={addRow} data-testid="item-add">＋ 荷物を追加</button>
                <button onClick={() => setCsv(csv == null ? toItemCsv(items.items) : null)} data-testid="csv-open">CSVで編集・取り込み</button>
                <span className="small muted">値が分からない項目は空欄（未登録）。ワークフローでは「不明」として扱い、確認事項になります。</span>
              </div>
              {csv != null && (
                <div className="ms-csv">
                  <div className="small muted">1行目は見出し（{CSV_HEADER.join(', ')}）。表計算ソフトから貼り付けできます。</div>
                  <textarea value={csv} onChange={(e) => setCsv(e.target.value)} rows={8} data-testid="csv-text" />
                  <div className="ms-tools">
                    <button onClick={() => importCsv('replace')} data-testid="csv-replace">この内容で置き換え</button>
                    <button onClick={() => importCsv('append')}>末尾に追加</button>
                    {csvErr.map((e) => <span key={e} className="hw-ng small">{e}</span>)}
                  </div>
                </div>
              )}
              <div className="ms-table-wrap">
                <table className="ms-table" data-testid="item-table">
                  <thead>
                    <tr><th>荷物ID</th><th>名称</th><th>種類</th><th>材質</th><th>重量kg</th><th>幅m</th><th>奥行m</th><th>高さm</th><th>破損注意</th><th>取扱メモ</th><th title="Step 1 の動画の観測テキストに出てくるか">動画</th><th /></tr>
                  </thead>
                  <tbody>
                    {items.items.map((r, n) => {
                      const is = issuesOf(`item:${r.object_id || n + 1}`)
                      return (
                        <tr key={n} className={is.err.length ? 'is-err' : is.warn.length ? 'is-warn' : ''} title={[...is.err, ...is.warn].map((e) => e.message).join('\n')} data-testid={`item-row-${r.object_id}`}>
                          <td><input value={r.object_id} onChange={(e) => setRow(n, { object_id: e.target.value.trim() })} className="w-id" /></td>
                          <td><input value={r.name} onChange={(e) => setRow(n, { name: e.target.value })} /></td>
                          <td><input value={r.object_type} onChange={(e) => setRow(n, { object_type: e.target.value })} className="w-type" /></td>
                          <td>
                            <select value={r.material_class ?? ''} onChange={(e) => setRow(n, { material_class: (e.target.value || null) as ItemMasterRow['material_class'] })}>
                              <option value="rigid">硬い</option><option value="soft">柔らかい</option><option value="">未登録</option>
                            </select>
                          </td>
                          <td><input type="number" step="0.1" value={r.weight_kg ?? ''} onChange={(e) => setRow(n, { weight_kg: numOrNull(e.target.value) })} className="w-num" data-testid={`weight-${r.object_id}`} /></td>
                          {[0, 1, 2].map((k) => (
                            <td key={k}><input type="number" step="0.01" value={r.dims_m && Number.isFinite(r.dims_m[k]) ? r.dims_m[k] : ''} onChange={(e) => setDim(n, k, e.target.value)} className="w-num" /></td>
                          ))}
                          <td>
                            <select value={r.fragile_content == null ? '' : String(r.fragile_content)} onChange={(e) => setRow(n, { fragile_content: e.target.value === '' ? null : e.target.value === 'true' })}>
                              <option value="false">いいえ</option><option value="true">はい</option><option value="">未登録</option>
                            </select>
                          </td>
                          <td><input value={r.handling_note} onChange={(e) => setRow(n, { handling_note: e.target.value })} /></td>
                          <td className="c">{inVideo.has(r.object_id) ? <span className="hw-ok">✓</span> : <span className="muted">—</span>}</td>
                          <td><button className="icon-btn" onClick={() => delRow(n)} title="この荷物を削除">×</button></td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {tab === 'batches' && (
            <div className="ms-batches">
              <p className="small muted">便＝1台のカゴ車に積む荷物の組み合わせ（到着順）。画面上部の「荷物の条件」で選びます。</p>
              {items.batches.map((b, n) => {
                const total = b.object_ids.reduce((s, id) => s + (weightOf(id) ?? 0), 0)
                const is = issuesOf(`batch:${b.batch_id}`)
                return (
                  <div key={n} className={`ms-batch ${is.err.length ? 'is-err' : is.warn.length ? 'is-warn' : ''}`} data-testid={`batch-${b.batch_id}`}>
                    <div className="ms-batch-head">
                      <input value={b.label} onChange={(e) => setItems((m) => ({ ...m, batches: m.batches.map((x, i) => (i === n ? { ...x, label: e.target.value } : x)) }))} />
                      <span className="small">{b.object_ids.length}個・合計{total.toFixed(1)}kg／最大積載{cart?.max_load_kg}kg</span>
                    </div>
                    <input className="ms-batch-ids" value={b.object_ids.join(' ')}
                      onChange={(e) => setItems((m) => ({ ...m, batches: m.batches.map((x, i) => (i === n ? { ...x, object_ids: e.target.value.split(/[\s,、]+/).filter(Boolean) } : x)) }))} />
                    {[...is.err, ...is.warn].map((e) => <div key={e.message} className={`small ${is.err.includes(e) ? 'hw-ng' : 'hw-unknown'}`}>{e.message}</div>)}
                  </div>
                )
              })}
            </div>
          )}

          {tab === 'env' && cart && (
            <div className="ms-env">
              <div className="ms-forms">
                <fieldset>
                  <legend>積付先：カゴ車</legend>
                  <label>名称<input value={cart.name} onChange={(e) => setEnv((m) => ({ ...m, carts: m.carts.map((c) => (c.cart_id === cart.cart_id ? { ...c, name: e.target.value } : c)) }))} /></label>
                  {([['inner_width_m', '内寸の幅（m）'], ['inner_depth_m', '内寸の奥行（m）'], ['height_limit_m', '積付高さの上限（m）'], ['max_load_kg', '最大積載（kg）']] as const).map(([k, l]) => (
                    <label key={k}>{l}<input type="number" step="0.01" value={Number.isFinite(cart[k]) ? cart[k] : ''} data-testid={`cart-${k}`}
                      onChange={(e) => setEnv((m) => ({ ...m, carts: m.carts.map((c) => (c.cart_id === cart.cart_id ? { ...c, [k]: e.target.value === '' ? NaN : Number(e.target.value) } : c)) }))} /></label>
                  ))}
                  <label>開口面<select value={cart.open_side} disabled><option value="front">前面（実行器が対応）</option></select></label>
                </fieldset>
                <fieldset>
                  <legend>仮置き場（棚・パレット）</legend>
                  <label>名称<input value={env.staging.name} onChange={(e) => setEnv((m) => ({ ...m, staging: { ...m.staging, name: e.target.value } }))} /></label>
                  <label>列の位置 z（m、空白区切り）<input value={env.staging.rows_z_m.join(' ')} data-testid="staging-rows"
                    onChange={(e) => setEnv((m) => ({ ...m, staging: { ...m.staging, rows_z_m: e.target.value.split(/[\s,]+/).filter(Boolean).map(Number) } }))} /></label>
                  <label>先頭の荷物の位置 x（m）<input type="number" step="0.05" value={env.staging.first_x_m} onChange={(e) => setEnv((m) => ({ ...m, staging: { ...m.staging, first_x_m: Number(e.target.value) } }))} /></label>
                  <label>荷物の間隔（m）<input type="number" step="0.05" value={env.staging.pitch_m} onChange={(e) => setEnv((m) => ({ ...m, staging: { ...m.staging, pitch_m: Number(e.target.value) } }))} /></label>
                </fieldset>
                <fieldset>
                  <legend>作業エリア</legend>
                  <label>通路幅（m）<input type="number" step="0.05" value={env.work_area.aisle_width_m ?? ''} onChange={(e) => setEnv((m) => ({ ...m, work_area: { ...m.work_area, aisle_width_m: numOrNull(e.target.value) } }))} /></label>
                  <label>床面<select value={env.work_area.floor} onChange={(e) => setEnv((m) => ({ ...m, work_area: { ...m.work_area, floor: e.target.value } }))}>
                    <option value="flat">平坦</option><option value="slope">傾斜あり</option><option value="step">段差あり</option></select></label>
                  <div className="small muted">作業エリアは参照情報です（現時点の能力照合・仮想実行では使いません）。</div>
                </fieldset>
              </div>
              <LayoutView env={env} count={items.batches[0]?.object_ids.length ?? 0} />
            </div>
          )}
        </section>

        <aside className="ms-side">
          <div className="ex-card" data-testid="master-validation">
            <div className="sec-title small">登録内容の検証</div>
            {v.ok && !v.warnings.length && <div className="hw-ok small">○ エラー・注意はありません</div>}
            {!v.ok && <div className="hw-ng small"><strong>エラー {v.errors.length}件（保存できません）</strong></div>}
            <ul className="ms-issues">
              {v.errors.map((e, i) => <li key={`e${i}`} className="hw-ng">× {e.message}</li>)}
              {v.warnings.map((e, i) => <li key={`w${i}`} className="hw-unknown">！ {e.message}</li>)}
            </ul>
          </div>
          <div className="ex-card" data-testid="master-video-match">
            <div className="sec-title small">動画の荷物IDとの照合（Step 1）</div>
            {videoIds.length
              ? <div className="small">動画の観測テキストに出てくる荷物 {videoIds.length}個のうち、マスタに登録済み {videoIds.length - unregistered.length}個
                {unregistered.length > 0 && <div className="hw-ng">未登録：{unregistered.join('、')}（属性が分からないため判断できません）</div>}</div>
              : <div className="small muted">観測テキストがまだありません。</div>}
          </div>
          <div className="ex-card">
            <div className="sec-title small">このマスタを使う場所</div>
            <ul className="small ms-uses">
              <li><strong>Step 2</strong>：材質・重量・寸法で荷物ごとの判断（Level 2）を実行</li>
              <li><strong>Step 3</strong>：重量・寸法・カゴ車の内寸から能力要件（可搬重量・つかむ幅・リーチ）を計算</li>
              <li><strong>Step 4</strong>：カゴ車の内寸・高さ上限・最大積載で積付を実行、仮置き場の位置から荷物を取る</li>
              <li><strong>Step 5</strong>：未登録の値・上限超過を確認事項に</li>
            </ul>
          </div>
        </aside>
      </div>
    </div>
  )
}

/** 環境マスタの配置図（上から見た図）：カゴ車・仮置き場の列・荷物の並ぶ位置 */
function LayoutView({ env, count }: { env: EnvMaster; count: number }) {
  const cart = env.carts.find((c) => c.cart_id === env.active_cart_id) ?? env.carts[0]
  const s = env.staging
  const rows = s.rows_z_m.filter((z) => Number.isFinite(z))
  const slots = rows.length ? Array.from({ length: count }, (_, i) => ({ x: s.first_x_m - Math.floor(i / rows.length) * s.pitch_m, z: rows[i % rows.length], n: i + 1 })) : []
  const xs = [...slots.map((p) => p.x), -cart.inner_width_m / 2, cart.inner_width_m / 2]
  const zs = [...rows, -cart.inner_depth_m / 2, cart.inner_depth_m / 2]
  const minX = Math.min(...xs) - 0.5, maxX = Math.max(...xs) + 0.5, minZ = Math.min(...zs) - 0.5, maxZ = Math.max(...zs) + 0.5
  const W = 560, k = W / (maxX - minX), H = (maxZ - minZ) * k
  const px = (x: number) => (x - minX) * k, pz = (z: number) => (z - minZ) * k
  return (
    <div className="ms-layout" data-testid="layout-view">
      <div className="sec-title small">配置図（上から見た図）</div>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%">
        <rect x={0} y={0} width={W} height={H} fill="#f1f3f5" />
        {rows.map((z) => (
          <rect key={z} x={px(Math.min(...slots.map((p) => p.x), s.first_x_m) - 0.3)} y={pz(z - 0.25)} width={(s.first_x_m - Math.min(...slots.map((p) => p.x), s.first_x_m) + 0.6) * k} height={0.5 * k} fill="#d9b98c" stroke="#a07d4d" rx={3} />
        ))}
        {slots.map((p) => (
          <g key={p.n}>
            <circle cx={px(p.x)} cy={pz(p.z)} r={9} fill="#fff" stroke="#8a6a3f" />
            <text x={px(p.x)} y={pz(p.z) + 4} fontSize={10} textAnchor="middle" fill="#5c4325">{p.n}</text>
          </g>
        ))}
        <rect x={px(-cart.inner_width_m / 2)} y={pz(-cart.inner_depth_m / 2)} width={cart.inner_width_m * k} height={cart.inner_depth_m * k} fill="#e7f5ff" stroke="#495057" strokeWidth={2} />
        <line x1={px(-cart.inner_width_m / 2)} y1={pz(cart.inner_depth_m / 2)} x2={px(cart.inner_width_m / 2)} y2={pz(cart.inner_depth_m / 2)} stroke="#e8590c" strokeWidth={4} strokeDasharray="8 5" />
        <text x={px(0)} y={pz(-cart.inner_depth_m / 2) - 22} fontSize={12} textAnchor="middle" fill="#1c7ed6" fontWeight={700}>{cart.name}</text>
        <text x={px(0)} y={pz(-cart.inner_depth_m / 2) - 8} fontSize={10} textAnchor="middle" fill="#495057">内寸{cart.inner_width_m}×{cart.inner_depth_m}m・高さ{cart.height_limit_m}m・{cart.max_load_kg}kg</text>
        <text x={px(0)} y={pz(cart.inner_depth_m / 2) + 16} fontSize={10} textAnchor="middle" fill="#e8590c">開口（前面）</text>
        {rows.length > 0 && <text x={px(Math.min(...slots.map((p) => p.x), s.first_x_m)) - 4} y={pz(Math.min(...rows) - 0.25) - 6} fontSize={11} fill="#5c4325">{s.name}：番号は到着順（列へ交互に並ぶ）</text>}
      </svg>
    </div>
  )
}
