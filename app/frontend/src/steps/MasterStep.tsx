import { useEffect, useMemo, useState } from 'react'
import { THEME } from '../lib/theme'
import type { EnvMaster, ItemMaster, ShipmentLine, ShipmentMaster, MasterDef, MasterField, MasterIssue, MasterValidation, Masters, V2State } from '../types'
import { resetMasters, saveMasters, validateMasters } from '../api'

type Table = MasterDef['table']
type Sel = { node: 'issues' | 'map' } | { node: 'table'; table: Table; row: number | null }
type Row = Record<string, unknown>
const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v))
let savedNotice: string | null = null   // 保存の直後に作り直した画面へ渡すメッセージ

// 検証結果の target（item:H1・cart:cart_std・staging など）→ テーブルと行のキー
const TARGET_TABLE: Record<string, Table> = { product: 'products', products: 'products', line: 'batches', batches: 'batches', cart: 'carts', carts: 'carts' }
function targetOf(t: string): { table: Table | null; key: string | null } {
  const [p, k] = t.split(':')
  return { table: TARGET_TABLE[p] ?? null, key: k ?? null }
}
const NEED_LABEL = { required: '必須', nullable: '未登録可', optional: '任意' } as const

/** 一覧のセル表示（未登録は「不明」として目立たせる） */
function fmt(f: MasterField, v: unknown): { text: string; unknown?: boolean } {
  if (v == null || v === '') return f.need === 'optional' ? { text: '' } : { text: '未登録', unknown: true }
  switch (f.type) {
    case 'enum': return { text: f.values?.find((x) => x.value === v)?.label ?? String(v) }
    case 'bool': return { text: v ? 'TRUE' : 'FALSE' }
    case 'dims': return { text: (v as number[]).map((x) => (x == null ? '?' : x)).join('×') }
    case 'ids': return { text: `${(v as string[]).length}個：${(v as string[]).join(' ')}` }
    case 'numbers': return { text: (v as number[]).join(', ') }
    case 'number': return { text: `${v}${f.unit ? ` ${f.unit}` : ''}` }
    default: return { text: String(v) }
  }
}

/** 定義から新しい行を作る（必須の選択肢は先頭、未登録可は null、ほかは空） */
function blankRow(d: MasterDef): Row {
  return Object.fromEntries(d.fields.map((f) => [f.key,
    f.type === 'enum' && f.need === 'required' ? f.values![0].value
      : f.need === 'nullable' ? null
        : f.type === 'ids' || f.type === 'numbers' ? []
          : f.type === 'text' ? '' : null]))
}

/** ⓪ データ確認：入力データを3区分（マスタ／トランザクション／その他）で示し、確認・1件ずつの修正をする。
 *  開くと商品マスタを表示する（全体の概要画面は置かない）。左は区分とデータ名だけ、件数・確認事項は各データのタイトルの横に出す。
 *  - マスタ：商品マスタ（荷姿・ケース入数・ボール入数・1ケースの重量・寸法を含む）・カゴ車マスタ
 *  - トランザクション：出荷予定（ヘッダ）・出荷明細（商品・数量＝ケース）・出荷実績（参照のみ・模擬）
 *  - その他：倉庫内マップ（平面図・参照のみ・模擬）と、その中の仮置き場・作業エリアの設定
 *  作業動画は Step 2 で入力し、解析結果などの成果物は各ステップで扱う（この画面には出さない）。
 *  一括登録（現場データの取り込み）はSEがシステムの外で行う前提で、ファイルの取り込みは置かない。
 *  ツリー・列・入力欄は API の definitions（backend の MASTER_DEFS）から作る。 */
export default function MasterStep({ st, onSaved }: { st: V2State; onSaved: (m: Masters) => void }) {
  const defs = st.masters.definitions
  const [items, setItems] = useState<ItemMaster>(() => clone(st.masters.items))
  const [env, setEnv] = useState<EnvMaster>(() => clone(st.masters.environment))
  const [ship, setShip] = useState<ShipmentMaster>(() => clone(st.masters.shipments))
  const [v, setV] = useState<MasterValidation>(st.masters.validation)
  const [sel, setSel] = useState<Sel>({ node: 'table', table: 'products', row: null })
  const [q, setQ] = useState('')
  const [busy, setBusy] = useState(false)
  // 保存すると画面を作り直す（key が変わる）ので、保存のメッセージは作り直したあとにも出す
  const [msg, setMsg] = useState<string | null>(() => savedNotice)
  useEffect(() => { savedNotice = null }, [])   // 表示したら次の作り直しでは出さない

  const dirty = JSON.stringify(items) !== JSON.stringify(st.masters.items) || JSON.stringify(env) !== JSON.stringify(st.masters.environment)
    || JSON.stringify(ship) !== JSON.stringify(st.masters.shipments)
  // 修正のたびに（少し待って）バックエンドで検証する
  useEffect(() => {
    if (!dirty) { setV(st.masters.validation); return }
    const h = setTimeout(() => { validateMasters(items, env, ship).then(setV).catch((e) => setMsg(String(e))) }, 350)
    return () => clearTimeout(h)
  }, [items, env, ship, dirty, st.masters.validation])

  // 出荷明細から組み立てる荷物の数（配置図の荷物の数に使う）
  const firstCount = useMemo(() => (ship.plan[0] ? labelsOf(ship, ship.plan[0].shipment_id).length : 0), [ship])

  const src = (d: MasterDef) => ({ items, environment: env, shipments: ship, shipment_results: st.masters.shipment_results }[d.file]) as unknown as Record<string, unknown>
  const rowsOf = (d: MasterDef): Row[] => {
    const x = src(d)[d.path]
    return d.kind === 'list' ? ((x as Row[]) ?? []) : x ? [x as Row] : []
  }
  const setRows = (d: MasterDef, f: (rows: Row[]) => Row[]) => {
    const apply = <T,>(m: T): T => {
      const cur = (m as Record<string, unknown>)[d.path]
      const next = d.kind === 'list' ? f(cur as Row[]) : f([cur as Row])[0]
      return { ...m, [d.path]: next }
    }
    if (d.file === 'items') setItems(apply); else if (d.file === 'shipments') setShip(apply); else setEnv(apply)
  }
  const issues = (table: Table | null, key?: string | null) => {
    const pick = (list: MasterIssue[]) => list.filter((e) => {
      const t = targetOf(e.target)
      return t.table === table && (key === undefined || t.key === key)
    })
    return { err: pick(v.errors), warn: pick(v.warnings) }
  }
  const rowKey = (d: MasterDef, r: Row, n: number) => (d.key ? String(r[d.key] || n + 1) : null)
  const cart = env.carts.find((c) => c.cart_id === env.active_cart_id) ?? env.carts[0]
  const def = sel.node === 'table' ? defs.find((d) => d.table === sel.table)! : null

  function goIssue(e: MasterIssue) {
    const t = targetOf(e.target)
    if (!t.table) return setSel({ node: 'issues' })
    const d = defs.find((x) => x.table === t.table)!
    const n = t.key ? rowsOf(d).findIndex((r, i) => rowKey(d, r, i) === t.key) : -1
    setQ('')
    setSel({ node: 'table', table: t.table, row: d.kind === 'single' ? 0 : n >= 0 ? n : null })
  }
  async function save() {
    setBusy(true); setMsg(null)
    try {
      const m = await saveMasters(items, env, ship)
      onSaved(m)
      savedNotice = '保存しました。'
      setMsg('保存しました。')
    } catch (e) { setMsg(String(e)) } finally { setBusy(false) }
  }

  const total = { err: v.errors.length, warn: v.warnings.length }
  const cats = st.masters.categories
  const openTable = (t: Table) => { setQ(''); setSel({ node: 'table', table: t, row: defs.find((d) => d.table === t)!.kind === 'single' ? 0 : null }) }
  const node = (key: string, label: React.ReactNode, on: boolean, onClick: () => void) => (
    <button key={key} className={`ms-node ${on ? 'is-on' : ''}`} onClick={onClick} data-testid={`mnode-${key}`}><span>{label}</span></button>
  )
  // 区分の下に各データ名を並べる（件数・確認事項は各データのタイトルの横に出す）
  const defNodes = (cat: 'master' | 'transaction' | 'other') => (
    <div className="ms-sub">
      {defs.filter((d) => d.category === cat).map((d) => node(d.table, <>{cat === 'other' ? '└ ' : ''}{d.label}</>, def?.table === d.table, () => openTable(d.table)))}
    </div>
  )
  const catHead = (c: 'master' | 'transaction' | 'other') => (
    <div className={`ms-cat is-${c}`} title={cats[c].note}>{cats[c].label}</div>
  )

  return (
    <div className="step-page master" data-testid="page-0">
      {(msg || dirty) && <div className="ms-msg" data-testid="master-msg">{dirty ? <span className="badge badge-warn" data-testid="master-dirty">未保存の修正あり</span> : null}{msg}{total.err > 0 && <span className="hw-ng">　× エラー{total.err}件があるため保存できません</span>}</div>}

      <div className="ms-wrap">
        <nav className="ms-tree" data-testid="master-tree">
          <div className="ms-group">{catHead('master')}{defNodes('master')}</div>
          <div className="ms-group">{catHead('transaction')}{defNodes('transaction')}</div>
          <div className="ms-group">
            {catHead('other')}
            <div className="ms-sub">{node('map', '倉庫内マップ', sel.node === 'map', () => setSel({ node: 'map' }))}</div>
            {defNodes('other')}
          </div>
        </nav>

        <section className="ms-view">
          {sel.node === 'map' && <MapView st={st} env={env} count={firstCount} />}
          {sel.node === 'issues' && (
            <div className="ms-pane" data-testid="master-issues">
              <h3 className="ms-h">確認事項 <span className="small muted">エラーは保存できません。注意は保存できますが、結果に影響します。行をクリックすると該当する箇所を開きます。</span></h3>
              {!total.err && !total.warn && <div className="hw-ok small">○ エラー・注意はありません</div>}
              <ul className="ms-issue-list">
                {v.errors.map((e, i) => <li key={`e${i}`} className="hw-ng" onClick={() => goIssue(e)}>× {e.message}</li>)}
                {v.warnings.map((e, i) => <li key={`w${i}`} className="hw-unknown" onClick={() => goIssue(e)}>！ {e.message}</li>)}
              </ul>
            </div>
          )}
          {def && sel.node === 'table' && (
            <TableView key={def.table} d={def} rows={rowsOf(def)} sel={sel.row} q={q} setQ={setQ} readonly={!!def.readonly}
              saveBtn={<button className="btn-primary ms-save" onClick={save} disabled={busy || !dirty || !v.ok} data-testid="master-save"
                title={!v.ok ? 'エラーがあるため保存できません' : !dirty ? '修正はありません' : ''}>保存</button>}
              onSelect={(n) => setSel({ node: 'table', table: def.table, row: n })}
              issues={issues} rowKey={rowKey}
              setRow={(n, patch) => setRows(def, (rs) => rs.map((r, i) => (i === n ? { ...r, ...patch } : r)))}
              addRow={() => { setRows(def, (rs) => [...rs, blankRow(def)]); setQ(''); setSel({ node: 'table', table: def.table, row: rowsOf(def).length }) }}
              delRow={(n) => { setRows(def, (rs) => rs.filter((_, i) => i !== n)); setSel({ node: 'table', table: def.table, row: null }) }}
              extra={(r) => <RowExtra d={def} r={r} items={items} ship={ship} env={env} cartMax={cart?.max_load_kg}
                onActivate={(id) => setEnv((m) => ({ ...m, active_cart_id: id }))} />}
              mark={(r) => (def.active && r[def.key!] === (env as unknown as Row)[def.active] ? '★' : null)}
              markLabel={def.active ? '使用中' : null}
              // マスタ・トランザクションは表（一覧と1件の詳細）だけ。配置図は「その他」の仮置き場だけに出す
              side={null} />
          )}
        </section>
      </div>
    </div>
  )
}

/** 今の作業動画の解析結果がそろっていないときの警告（Step 3 以降の上部） */
export function AnalysisMismatch({ an, onOpen }: { an: V2State['inputs']['analysis']; onOpen?: () => void }) {
  return (
    <div className="ms-alert" data-testid="analysis-mismatch">
      <strong>今の作業動画（{an.video}）の解析結果がそろっていません。</strong>
      {an.missing.join('・')} がまだありません（別の動画の結果は表示しません）。Step 2 で「解析開始」を押してください。
      {onOpen && <button onClick={onOpen}>Step 2 で解析する</button>}
    </div>
  )
}

/** 各データ画面の上部：タイトル＋件数・確認事項（コンパクト）、目的と使う工程（1〜2行）、補足（登録方法・項目など。閉じて置く） */
function DataHead({ title, count, err, warn, readonly, desc }: {
  title: string; count: string; err: number; warn: number; readonly?: boolean; desc: string; uses?: string[]; more?: React.ReactNode
}) {
  return (
    <div className="ms-dhead" data-testid="data-head">
      <div className="ms-dtitle">
        <h3>{title}</h3>
        <span className="ms-chip">{count}</span>
        {readonly && <span className="ms-chip is-ro">参照のみ（模擬）</span>}
        {err > 0 && <span className="ms-chip is-err">エラー {err}</span>}
        {warn > 0 && <span className="ms-chip is-warn">注意 {warn}</span>}
        {err === 0 && warn === 0 && <span className="ms-chip is-ok">確認事項なし</span>}
      </div>
      {/* 使う工程・補足（登録する人・登録方法・項目）は出さない */}
      <p className="ms-desc">{desc}</p>
    </div>
  )
}

/** 補足：登録する人・登録方法・項目の内訳 */
function DefMore({ d, children }: { d: MasterDef; children?: React.ReactNode }) {
  const n = (need: MasterField['need']) => d.fields.filter((f) => f.need === need).length
  return (
    <div className="ms-more-body">
      <dl className="ms-card-dl small">
        <dt>登録する人</dt><dd>{d.who}</dd>
        <dt>登録方法</dt><dd>{d.method}</dd>
        <dt>項目</dt><dd>{d.fields.map((f) => f.label).join('・')}（必須{n('required')}・未登録可{n('nullable')}・任意{n('optional')}）</dd>
      </dl>
      {children}
    </div>
  )
}

const MAP_STYLE: Record<string, { fill: string; stroke: string }> = {
  wall: { fill: THEME.muted, stroke: THEME.text2 }, sign: { fill: '#fff', stroke: THEME.text2 }, shelf: { fill: '#e9c46a', stroke: '#9c6644' },
  desk: { fill: THEME.line, stroke: THEME.muted }, stairs: { fill: THEME.lineStrong, stroke: THEME.muted }, work_area: { fill: THEME.infoSoft, stroke: THEME.info },
  staging: { fill: '#c08552', stroke: '#7f5539' }, cart: { fill: THEME.muted2, stroke: THEME.text }, line: { fill: '#fab005', stroke: '#fab005' },
  aisle: { fill: '#b2d8b2', stroke: '#2f9e44' },
  zone_pallet: { fill: '#fff4e6', stroke: THEME.warn }, zone_cart: { fill: THEME.brandSoft, stroke: THEME.brandStrong }, step: { fill: THEME.text2, stroke: THEME.text },
}
const MAP_ORDER = ['work_area', 'zone_pallet', 'zone_cart', 'aisle', 'line', 'wall', 'sign', 'shelf', 'desk', 'stairs', 'staging', 'cart', 'step']

/** その他：倉庫内マップ（平面図・参照のみ・模擬）。仮置き場・作業エリアの設定へのリンクと、仮想実行の仮置き場の配置 */
function MapView({ st }: { st: V2State; env: EnvMaster; count: number }) {
  const wm = st.masters.warehouse_map
  const [W, H] = wm.size
  const [hover, setHover] = useState<string | null>(null)
  const els = [...wm.elements].sort((a, b) => MAP_ORDER.indexOf(a.kind) - MAP_ORDER.indexOf(b.kind))
  const cur = wm.elements.find((e) => e.id === hover)
  return (
    <div className="ms-pane" data-testid="mview-map">
      <DataHead title="倉庫内マップ" count={`${wm.elements.length}要素`} err={0} warn={0} readonly
        desc={`${wm.name}の平面図。作業エリア（左：パレットゾーン、右：カゴ車ゾーン）・商品棚・通路の位置関係を示す。`}
        uses={['Step 5：仮置き場の位置で仮想実行', '（将来）Step 5 の床・設備の表示']}
        more={<div className="ms-more-body small">
          <dl className="ms-card-dl">
            <dt>登録する人</dt><dd>SE（現場の配置・作業動画から作る）</dd>
            <dt>登録方法</dt><dd>平面図は参照のみ（app/data/other/warehouse_map.json・模擬）。仮置き場・作業エリアの設定は画面で確認と修正</dd>
            <dt>出典</dt><dd>{wm.source}</dd>
          </dl>
          <p>{wm.note}</p>
          <p className="hw-unknown">{wm.relation_to_masters}</p>
        </div>} />
      <div className="ms-map-wrap">
        <svg className="ms-map" viewBox={`-0.3 -0.3 ${W + 0.6} ${H + 0.9}`} data-testid="warehouse-map">
          <rect x={0} y={0} width={W} height={H} fill={THEME.bg} stroke={THEME.muted2} strokeWidth={0.04} />
          {Array.from({ length: Math.floor(W) + 1 }, (_, i) => <line key={`gx${i}`} x1={i} y1={0} x2={i} y2={H} stroke={THEME.line} strokeWidth={0.02} />)}
          {Array.from({ length: Math.floor(H) + 1 }, (_, i) => <line key={`gy${i}`} x1={0} y1={i} x2={W} y2={i} stroke={THEME.line} strokeWidth={0.02} />)}
          {els.map((e) => {
            const [x, y, w, h] = e.rect
            const s = MAP_STYLE[e.kind] ?? { fill: '#fff', stroke: THEME.muted }
            return (
              <g key={e.id} onMouseEnter={() => setHover(e.id)} onMouseLeave={() => setHover(null)} data-testid={`map-${e.id}`} className="ms-map-el">
                <rect x={x} y={y} width={w} height={h} fill={s.fill} fillOpacity={e.kind === 'work_area' || e.kind.startsWith('zone_') ? 0.5 : 0.9} stroke={s.stroke}
                  strokeWidth={hover === e.id ? 0.08 : 0.04} strokeDasharray={e.basis === 'mock' ? '0.15 0.1' : undefined} />
                {e.kind === 'step' && <text x={x + w / 2} y={y + h + 0.3} fontSize={0.22} textAnchor="middle" fill={THEME.text}>段差（模擬）</text>}
                {h >= 0.3 && w >= 0.3 && e.kind !== 'work_area' && !e.kind.startsWith('zone_') && <text x={x + w / 2} y={y + h / 2} fontSize={0.26} textAnchor="middle" dominantBaseline="middle" fill={THEME.text}>{e.label.replace(/（.*$/, '').replace('仮置き場：', '')}</text>}
                {e.kind === 'work_area' && <text x={x + 0.1} y={y + 0.3} fontSize={0.26} fill={THEME.info}>{e.label}（推測）</text>}
                {e.kind.startsWith('zone_') && <text x={x + 0.1} y={y + 0.3} fontSize={0.24} fill={s.stroke}>{e.label}</text>}
              </g>
            )
          })}
          {/* 縮尺（1m）と原点 */}
          <line x1={0} y1={H + 0.45} x2={1} y2={H + 0.45} stroke={THEME.text} strokeWidth={0.05} />
          <text x={1.15} y={H + 0.5} fontSize={0.24} fill={THEME.text2}>1m（寸法は模擬）</text>
        </svg>
        <div className="ms-map-side small">
          <div className="ms-map-legend">
            <div><span className="lg solid" />実線：動画で存在と位置関係を確認</div>
            <div><span className="lg dashed" />破線：推測による模擬（動画にない）</div>
            <div className="muted">寸法・座標はすべて模擬（実在の現場の採寸ではない）。{wm.origin}。</div>
          </div>
          <div className="ms-map-info" data-testid="map-info">
            {cur ? <><strong>{cur.label}</strong><div>{cur.basis === 'observed' ? '動画で確認' : '推測（模擬）'}・寸法：{cur.dims === 'master' ? 'カゴ車マスタ' : '模擬'}</div>{cur.note && <div className="muted">{cur.note}</div>}</>
              : <span className="muted">要素にマウスを合わせると説明を表示します。</span>}
          </div>
          <ul className="ms-map-list">
            {wm.elements.filter((e) => e.kind !== 'line' && e.kind !== 'wall').map((e) => (
              <li key={e.id}>{e.label}<span className={`badge ${e.basis === 'observed' ? 'badge-ok' : 'badge-warn'}`}>{e.basis === 'observed' ? '動画で確認' : '推測'}</span></li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  )
}

/** テーブルのビュー：一覧（読み取り）＋選んだ1件の詳細（修正） */
function TableView({ d, rows, sel, q, setQ, onSelect, issues, rowKey, setRow, addRow, delRow, extra, mark, markLabel, side, more, alert, saveBtn, readonly = false }: {
  d: MasterDef; rows: Row[]; sel: number | null; q: string; setQ: (s: string) => void; onSelect: (n: number) => void; readonly?: boolean
  saveBtn?: React.ReactNode   // 保存（「＋ 追加」の横。設定1件のデータは詳細の見出しの横）
  more?: React.ReactNode; alert?: React.ReactNode
  issues: (t: Table | null, key?: string | null) => { err: MasterIssue[]; warn: MasterIssue[] }   // key 省略＝そのテーブルのすべて、null＝テーブル全体の分だけ
  rowKey: (d: MasterDef, r: Row, n: number) => string | null
  setRow: (n: number, patch: Row) => void; addRow: () => void; delRow: (n: number) => void
  extra: (r: Row) => React.ReactNode; mark: (r: Row) => string | null; markLabel: string | null; side: React.ReactNode
}) {
  const cols = d.fields.filter((f) => f.key !== 'note')
  const shown = rows.map((r, n) => ({ r, n })).filter(({ r }) => !q || d.fields.some((f) => f.type === 'text' && String(r[f.key] ?? '').toLowerCase().includes(q.toLowerCase())))
  const tableIssues = issues(d.table, null)
  const cur = sel != null ? rows[sel] : null
  // 行は選ぶだけ。「修正」を押したときだけ入力欄にする（追加した行はすぐ入力）。選ぶ行が変わったら閉じる
  const [editing, setEditing] = useState(false)
  const [lastSel, setLastSel] = useState(sel)
  if (lastSel !== sel) { setLastSel(sel); setEditing(false) }
  const edit = editing && !readonly
  return (
    <div className="ms-pane ms-table-view" data-testid={`mview-${d.table}`}>
      <DataHead title={d.label} count={d.kind === 'list' ? `${rows.length}件` : '設定'} err={issues(d.table).err.length} warn={issues(d.table).warn.length}
        readonly={readonly} desc={d.purpose} uses={d.used_in} more={more} />
      {alert}
      {[...tableIssues.err, ...tableIssues.warn].map((e) => (
        <div key={e.message} className={`small ${tableIssues.err.includes(e) ? 'hw-ng' : 'hw-unknown'}`}>{tableIssues.err.includes(e) ? '× ' : '！ '}{e.message}</div>
      ))}
      <div className={`ms-split ${d.kind === 'single' ? 'is-single' : ''}`}>
        {d.kind === 'list' && (
          <div className="ms-list">
            <div className="ms-tools">
              <input className="ms-search" placeholder="IDや名称で絞り込み" value={q} onChange={(e) => setQ(e.target.value)} data-testid="master-search" />
              <span className="small muted">{shown.length}/{rows.length}件</span>
              {!readonly && (
                <span className="ms-tools-r">
                  <button onClick={() => { addRow(); setTimeout(() => setEditing(true)) }} data-testid={`add-${d.table}`}>＋ 追加</button>
                  <button onClick={() => setEditing(!editing)} disabled={sel == null} className={editing ? 'is-on' : ''} data-testid="row-edit" title={sel == null ? '一覧で行を選んでください' : ''}>{editing ? '修正を終える' : '修正'}</button>
                  <button onClick={() => sel != null && delRow(sel)} disabled={sel == null} data-testid="row-delete" title={sel == null ? '一覧で行を選んでください' : ''}>削除</button>
                  {saveBtn}
                </span>
              )}
            </div>
            <div className="ms-table-wrap">
              <table className="ms-table" data-testid={`table-${d.table}`}>
                <thead><tr><th className="ms-rowno">No.</th><th />{cols.map((f) => <th key={f.key}>{f.label}{f.unit && f.type !== 'number' ? `（${f.unit}）` : ''}</th>)}{markLabel && <th>{markLabel}</th>}</tr></thead>
                <tbody>
                  {shown.map(({ r, n }) => {
                    const is = issues(d.table, rowKey(d, r, n))
                    return (
                      <tr key={n} className={`${sel === n ? 'is-sel' : ''} ${is.err.length ? 'is-err' : is.warn.length ? 'is-warn' : ''}`}
                        onClick={() => onSelect(n)} data-testid={`row-${d.table}-${rowKey(d, r, n)}`}>
                        <td className="ms-rowno" data-testid="rowno">{n + 1}</td>
                        <td className="c">{is.err.length ? <span className="hw-ng">×</span> : is.warn.length ? <span className="hw-unknown">！</span> : ''}</td>
                        {cols.map((f) => {
                          const c = fmt(f, r[f.key])
                          return <td key={f.key} className={c.unknown ? 'is-unknown' : ''}>{c.text}</td>
                        })}
                        {markLabel && <td className="c">{mark(r)}</td>}
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}
        <div className="ms-detail" data-testid="master-detail">
          {cur ? (
            <>
              <div className="ms-detail-head">
                <strong>{d.kind === 'list' ? `${d.label}：${String(cur[d.key!] || '（ID未入力）')}` : d.label}</strong>
                {d.kind === 'single' && !readonly && <span className="ms-tools-r"><button onClick={() => setEditing(!editing)} data-testid="row-edit">{editing ? '修正を終える' : '修正'}</button>{saveBtn}</span>}
              </div>
              {[...issues(d.table, rowKey(d, cur, sel!)).err, ...issues(d.table, rowKey(d, cur, sel!)).warn].filter((e) => d.kind === 'list').map((e) => (
                <div key={e.message} className="small hw-unknown">！ {e.message}</div>
              ))}
              <div className="ms-form">
                {d.fields.map((f) => (
                  <label key={f.key} title={f.note}>
                    <span>{f.label}{f.unit ? `（${f.unit}）` : ''}<em className={`ms-need is-${f.need}`}>{NEED_LABEL[f.need]}</em></span>
                    {!edit ? <span className="ms-ro">{fmt(f, cur[f.key]).text || '—'}</span>
                      : <FieldInput f={f} value={cur[f.key]} onChange={(val) => setRow(sel!, { [f.key]: val })} />}
                    {f.note && <small className="muted">{f.note}</small>}
                  </label>
                ))}
              </div>
              {extra(cur)}
            </>
          ) : <div className="small muted ms-empty">一覧の行を選ぶと、ここに1件の内容を表示します。「修正」で入力欄になります。</div>}
        </div>
        {side && <div className="ms-side-view">{side}</div>}
      </div>
    </div>
  )
}

/** 定義の型に合わせた入力欄（空欄は未登録＝null） */
function FieldInput({ f, value, onChange }: { f: MasterField; value: unknown; onChange: (v: unknown) => void }) {
  const tid = `field-${f.key}`
  const num = (s: string) => (s.trim() === '' ? null : Number(s))
  switch (f.type) {
    case 'number':
      return <input type="number" step="0.01" value={value == null || Number.isNaN(value) ? '' : String(value)} onChange={(e) => onChange(num(e.target.value))} data-testid={tid} />
    case 'enum':
      return (
        <select value={value == null ? '' : String(value)} onChange={(e) => onChange(e.target.value === '' ? null : e.target.value)} data-testid={tid}>
          {f.values!.map((x) => <option key={x.value} value={x.value}>{x.label}</option>)}
          {f.need !== 'required' && <option value="">未登録</option>}
        </select>
      )
    case 'bool':
      return (
        <select value={value == null ? '' : String(value)} onChange={(e) => onChange(e.target.value === '' ? null : e.target.value === 'true')} data-testid={tid}>
          <option value="true">TRUE</option><option value="false">FALSE</option>{f.need !== 'required' && <option value="">未登録</option>}
        </select>
      )
    case 'dims': {
      const d = (value as (number | null)[] | null) ?? [null, null, null]
      const set = (k: number, s: string) => {
        const next = [...d]; next[k] = num(s)
        onChange(next.every((x) => x == null) ? null : next)
      }
      return (
        <span className="ms-dims" data-testid={tid}>
          {['幅', '奥行', '高さ'].map((l, k) => <input key={l} type="number" step="0.01" placeholder={l} value={d[k] ?? ''} onChange={(e) => set(k, e.target.value)} />)}
        </span>
      )
    }
    case 'ids':
      return <input value={((value as string[]) ?? []).join(' ')} onChange={(e) => onChange(e.target.value.split(/[\s,、]+/).filter(Boolean))} placeholder="空白区切り" data-testid={tid} />
    case 'numbers':
      return <input value={((value as number[]) ?? []).join(' ')} onChange={(e) => onChange(e.target.value.split(/[\s,]+/).filter(Boolean).map(Number))} placeholder="空白区切り" data-testid={tid} />
    default:
      return <input value={value == null ? '' : String(value)} onChange={(e) => onChange(f.key.endsWith('_id') ? e.target.value.trim() : e.target.value)} data-testid={tid} />
  }
}

/** 出荷の荷物ID（到着順）：数量の合計が1の商品は商品ID、2以上は商品ID＋連番（backend の masters.labels_of と同じ規則） */
function labelsOf(ship: ShipmentMaster, sid: string): { id: string; line: ShipmentLine }[] {
  const lines = ship.plan.filter((l) => l.shipment_id === sid)   // 並び順＝到着順
  const total: Record<string, number> = {}
  lines.forEach((l) => (total[l.product_id] = (total[l.product_id] ?? 0) + (Number(l.quantity) || 0)))
  const seen: Record<string, number> = {}
  return lines.flatMap((l) => Array.from({ length: Math.max(0, Number(l.quantity) || 0) }, () => {
    seen[l.product_id] = (seen[l.product_id] ?? 0) + 1
    return { id: total[l.product_id] === 1 ? l.product_id : `${l.product_id}${seen[l.product_id]}`, line: l }
  }))
}

/** 1件の詳細の補足（商品：含まれる出荷、出荷：明細から振った荷物と合計重量、明細：振られる荷物ID、カゴ車：使用中にする） */
function RowExtra({ d, r, items, ship, env, cartMax, onActivate }: {
  d: MasterDef; r: Row; items: ItemMaster; ship: ShipmentMaster; env: EnvMaster; cartMax?: number; onActivate: (id: string) => void
}) {
  const prod = new Map(items.products.map((k) => [k.product_id, k]))
  if (d.table === 'products') {
    const id = String(r.product_id)
    const rows = ship.plan.filter((l) => l.product_id === id)
    return (
      <div className="ms-extra small">
        <div>含まれる出荷：{rows.length ? rows.map((l) => `${l.shipment_id}（${l.shipped_on}・${l.quantity}ケース）`).join('、') : <span className="muted">なし</span>}</div>
      </div>
    )
  }
  if (d.table === 'batches') {
    const ps = labelsOf(ship, String(r.shipment_id))
    const ids = ps.filter((p) => p.line.line_id === r.line_id).map((p) => p.id)
    const total = ps.reduce((s, p) => s + (prod.get(p.line.product_id)?.weight_kg ?? 0), 0)
    return (
      <div className="ms-extra small">
        <div>振られる荷物ID：{ids.join(' ') || '—'}</div>
        <div className="muted">出荷 {String(r.shipment_id)} 全体：{ps.length}ケース・合計 {total.toFixed(1)}kg／カゴ車の最大積載 {cartMax}kg</div>
      </div>
    )
  }
  if (d.table === 'carts') {
    const on = r.cart_id === env.active_cart_id
    return (
      <div className="ms-extra small">
        {on ? <span className="hw-ok">★ 使用中のカゴ車（業務定義・実行器・能力要件が使う）</span>
          : <button onClick={() => onActivate(String(r.cart_id))} data-testid="cart-activate">このカゴ車を使用中にする</button>}
      </div>
    )
  }
  return null
}

/** 環境マスタの配置図（上から見た図）：カゴ車・仮置き場の列・荷物の並ぶ位置 */
function LayoutView({ env, count }: { env: EnvMaster; count: number }) {
  const cart = env.carts.find((c) => c.cart_id === env.active_cart_id) ?? env.carts[0]
  const s = env.staging
  if (!cart || !s || [cart.inner_width_m, cart.inner_depth_m, s.first_x_m, s.pitch_m].some((x) => typeof x !== 'number' || !Number.isFinite(x))) {
    return <div className="ms-layout small muted" data-testid="layout-view">値が足りないため配置図を描けません。</div>
  }
  const rows = (s.rows_z_m ?? []).filter((z) => Number.isFinite(z))
  const slots = rows.length ? Array.from({ length: count }, (_, i) => ({ x: s.first_x_m - Math.floor(i / rows.length) * s.pitch_m, z: rows[i % rows.length], n: i + 1 })) : []
  const xs = [...slots.map((p) => p.x), -cart.inner_width_m / 2, cart.inner_width_m / 2]
  const zs = [...rows, -cart.inner_depth_m / 2, cart.inner_depth_m / 2]
  const minX = Math.min(...xs) - 0.5, maxX = Math.max(...xs) + 0.5, minZ = Math.min(...zs) - 0.5, maxZ = Math.max(...zs) + 0.5
  const W = 560, k = W / (maxX - minX), H = (maxZ - minZ) * k
  const px = (x: number) => (x - minX) * k, pz = (z: number) => (z - minZ) * k
  const left = Math.min(...slots.map((p) => p.x), s.first_x_m)
  return (
    <div className="ms-layout" data-testid="layout-view">
      <div className="sec-title small">配置図（上から見た図）</div>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%">
        <rect x={0} y={0} width={W} height={H} fill={THEME.bg2} />
        {rows.map((z) => (
          <rect key={z} x={px(left - 0.3)} y={pz(z - 0.25)} width={(s.first_x_m - left + 0.6) * k} height={0.5 * k} fill="#d9b98c" stroke="#a07d4d" rx={3} />
        ))}
        {slots.map((p) => (
          <g key={p.n}>
            <circle cx={px(p.x)} cy={pz(p.z)} r={9} fill="#fff" stroke="#8a6a3f" />
            <text x={px(p.x)} y={pz(p.z) + 4} fontSize={10} textAnchor="middle" fill="#5c4325">{p.n}</text>
          </g>
        ))}
        <rect x={px(-cart.inner_width_m / 2)} y={pz(-cart.inner_depth_m / 2)} width={cart.inner_width_m * k} height={cart.inner_depth_m * k} fill={THEME.infoSoft} stroke={THEME.text2} strokeWidth={2} />
        <line x1={px(-cart.inner_width_m / 2)} y1={pz(cart.inner_depth_m / 2)} x2={px(cart.inner_width_m / 2)} y2={pz(cart.inner_depth_m / 2)} stroke={THEME.warn} strokeWidth={4} strokeDasharray="8 5" />
        <text x={px(0)} y={pz(-cart.inner_depth_m / 2) - 22} fontSize={12} textAnchor="middle" fill={THEME.info} fontWeight={700}>{cart.name}</text>
        <text x={px(0)} y={pz(-cart.inner_depth_m / 2) - 8} fontSize={10} textAnchor="middle" fill={THEME.text2}>内寸{cart.inner_width_m}×{cart.inner_depth_m}m・高さ{cart.height_limit_m}m・{cart.max_load_kg}kg</text>
        <text x={px(0)} y={pz(cart.inner_depth_m / 2) + 16} fontSize={10} textAnchor="middle" fill={THEME.warn}>開口（前面）</text>
        {rows.length > 0 && <text x={px(left) - 4} y={pz(Math.min(...rows) - 0.25) - 6} fontSize={11} fill="#5c4325">{s.name}：番号は到着順（列へ交互に並ぶ）</text>}
      </svg>
    </div>
  )
}
