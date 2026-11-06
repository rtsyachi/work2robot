import { Fragment, useState, type ReactNode } from 'react'
import type { HwConfig, V2Run, V2State } from '../types'
import { evaluateItemTypes, evaluateTasks, humanSeconds, mmss, pct, type TaskEval, type TaskStatus } from '../lib/evaluation'
import ContextBar, { scenarioField, workflowField } from '../components/ContextBar'

const cfgName = (c: HwConfig | undefined) => (c?.source === 'claude' ? 'Claudeの推奨構成' : c?.label ?? '—')
const TASK_STATUS: Record<TaskStatus, { text: string; cls: string }> = {
  done: { text: '達成', cls: 'badge-ok' }, failed: { text: '未達', cls: 'badge-err' }, unevaluated: { text: '未評価', cls: 'badge-none' },
}
/** 値の種類（実測・推定・仮想実行結果・参考値・未評価）を必ず区別して示す */
type Kind = 'sim' | 'estimate' | 'reference' | 'none'
const KIND: Record<Kind, { text: string; cls: string; title: string }> = {
  sim: { text: '仮想実行結果', cls: 'k-sim', title: 'シミュレーション上の結果。実機での成功を示すものではない' },
  estimate: { text: '推定', cls: 'k-est', title: '模擬の仕様から計算した値。実測ではない' },
  reference: { text: '参考値', cls: 'k-ref', title: '模擬作業動画から読み取った値。実測ではない' },
  none: { text: '未評価', cls: 'k-none', title: '評価・算出していない' },
}
const KindTag = ({ k }: { k: Kind }) => <span className={`ev-kind ${KIND[k].cls}`} title={KIND[k].title}>{KIND[k].text}</span>

/** 主要KPIの枠：大きな数値＋値の種類 */
function Kpi({ k, v, sub, kind, cls = '', tid, children }: { k: string; v: ReactNode; sub?: ReactNode; kind: Kind; cls?: string; tid: string; children?: ReactNode }) {
  return (
    <div className={`ev-card ev-kpi ${cls}`} data-testid={tid}>
      <div className="ev-kpi-h"><span className="ev-k">{k}</span><KindTag k={kind} /></div>
      <div className="ev-v">{v}</div>
      {children}
      {sub && <div className="small muted">{sub}</div>}
    </div>
  )
}

/** ⑥ シミュレーション評価（経営層・管理者への報告用）：
 *  総合所見で結論 → 主要KPIで効果 → 詳細評価（定量評価／課題・改善余地）で根拠と次の打ち手。
 *  Step 3 の確定ワークフロー・Step 4 のロボット構成・Step 5 のシミュレーション結果を根拠にする。実機での導入可否・省人化効果は断定しない。 */
export default function EvaluationStep({ st, run, config, runs, onGoStep }: {
  st: V2State
  run: V2Run | null
  config: HwConfig | null
  runs: { config: HwConfig; run: V2Run }[]
  onGoStep: (n: number) => void
}) {
  const [tab, setTab] = useState<'quant' | 'issues'>('quant')
  const [openStage, setOpenStage] = useState<string | null>(null)
  // 上部の共通の帯（Step 3〜6 と同じ）：評価対象。内部IDは通常表示せず、マウスを合わせたときだけ出す
  const scenarioBar = (
    <ContextBar caption="評価対象" testid="ev-scenarios" fields={[
      scenarioField(st, 'ev-scenario'), workflowField(st),
      { key: 'config', label: 'ロボット構成', value: run?.execution?.robot_config_name ?? cfgName(config ?? undefined), testid: 'ev-config',
        title: run?.execution ? `構成ID ${run.execution.robot_config_id}／実行ID ${run.execution.execution_id}／作業動画 ${run.execution.video_id}` : undefined,
        id: run?.execution?.robot_config_id },
    ]} />
  )
  if (!run) {
    return (
      <div className="step-page evaluation" data-testid="page-5">
        {scenarioBar}
        <div className="ex-empty static">
          <p>この構成（{cfgName(config ?? undefined)}）では、まだシミュレーションを実行していません。</p>
          <button className="run big" onClick={() => onGoStep(4)}>5. シミュレーション実行へ</button>
        </div>
      </div>
    )
  }
  const { job, readiness: rd } = run
  const placed = job.items.filter((i) => i.outcome === 'placed')
  const handed = job.items.filter((i) => i.outcome === 'handed_off')
  const tasks = evaluateTasks(st, job)
  const judged = tasks.filter((t) => t.status !== 'unevaluated')
  const done = tasks.filter((t) => t.status === 'done')
  const failed = tasks.filter((t) => t.status === 'failed')
  const unevaluated = tasks.length - judged.length
  const types = evaluateItemTypes(st, job)
  const okTypes = types.filter((g) => g.placed === g.total)
  const human = humanSeconds(st)
  const robot = run.time_estimate
  const ratio = robot && human ? robot.total_s / human : null
  const checks = run.check?.results ?? []
  const confirms = st.extraction?.confirmation_items ?? []
  const undefinedCriteria = confirms.filter((c) => c.kind === 'undefined_condition')
  const handoffs = summarize(handed.map((h) => h.handoff_reason ?? ''))
  const imp = (kinds: string[]) => (rd.improvements ?? []).filter((x) => kinds.includes(x.kind))
    .map((x) => `${x.source === 'claude' ? '［Claudeの仮説］' : '［実行結果から］'}${x.text}`)

  // ── 課題・改善余地：評価観点ごとに「現状・課題 → 改善案 → 実機PoCでの確認事項」。1つの内容は1か所だけに出す ──
  const capIssue = (c: (typeof checks)[number]): Finding => ({
    st: c.status === 'unknown' ? 'unverified' : 'ng',
    text: c.status === 'ng' ? `仕様の不足：${c.label}` : c.status === 'partial' ? `一部の荷物だけ対応：${c.label}` : `未確認：${c.label}`,
  })
  const ck = job.checks
  const qualityRows: (Finding & { ok?: boolean })[] = ck ? [
    { st: ck.overhang.ok ? 'ok' : 'ng', text: ck.overhang.ok ? 'はみ出しなし' : 'カゴ車からのはみ出しあり' },
    { st: ck.load.ok == null ? 'unverified' : ck.load.ok ? 'ok' : 'ng', text: `積載重量 ${ck.load.total_kg}kg／上限 ${ck.load.max_kg ?? '未設定'}kg` },
    { st: ck.height.ok ? 'ok' : 'ng', text: `積付高さ 最高 ${ck.height.max_m}m／上限 ${ck.height.limit_m}m` },
    { st: ck.balance.ok == null ? 'unverified' : ck.balance.ok ? 'ok' : 'ng',
      text: ck.balance.tolerance_m == null ? `重心の偏り ${ck.balance.com_offset_m}m（許容範囲が未定義のため合否は未判定）` : `重心の偏り ${ck.balance.com_offset_m}m／許容 ${ck.balance.tolerance_m}m` },
  ] : []
  const rulesApplied = (job.rule_results ?? []).filter((r) => r.status === 'applied')
  const pocAll = [...new Set(rd.categories.needs_physical_poc)]
  const pocOf = (re: RegExp) => pocAll.filter((x) => re.test(x))
  const pocQuality = pocOf(/積み重ね|安定|荷崩れ/)
  const pocSafety = pocOf(/安全|人との|干渉/).filter((x) => !pocQuality.includes(x))   // 1つの確認事項は1つの観点にだけ出す
  const pocCap = pocAll.filter((x) => !pocQuality.includes(x) && !pocSafety.includes(x))
  const AREAS: Area[] = [
    { tid: 'issue-business', title: '業務理解（ルール・判断基準）',
      findings: [
        ...undefinedCriteria.map((c): Finding => ({ st: 'unverified', text: `判断基準が未定義：${c.topic}` })),
        ...confirms.filter((c) => c.kind === 'missing_information').map((c): Finding => ({ st: 'unverified', text: `情報の不足：${c.topic}` })),
        ...confirms.filter((c) => c.kind === 'provisional_action').map((c): Finding => ({ st: 'unverified', text: `暫定動作で進めた：${c.topic}` })),
        // 仮想実行で扱えない業務ルール（荷崩れなど）は「積付品質」にだけ出す
      ],
      ok: rulesApplied.length ? `業務ルール ${rulesApplied.length}件は仮想実行で適用を確認：${rulesApplied.map((r) => r.label).join('／')}` : '',
      fixes: imp(['operation', 'order', 'pattern']),
      poc: undefinedCriteria.length || confirms.some((c) => c.kind === 'provisional_action')
        ? [`現場担当者と判断基準・暫定動作の妥当性を確定する（${undefinedCriteria.length + confirms.filter((c) => c.kind === 'provisional_action').length}件）`] : [] },
    { tid: 'issue-hardware', title: 'ロボット能力（把持・可搬・リーチ・センシング）',
      findings: checks.filter((c) => c.status !== 'ok').map(capIssue),
      ok: checks.some((c) => c.status === 'ok') ? `仕様上対応 ${checks.filter((c) => c.status === 'ok').length}件：${checks.filter((c) => c.status === 'ok').map((c) => c.label).join('／')}` : '',
      fixes: imp(['hardware']), poc: pocCap },
    { tid: 'issue-quality', title: '積付品質',
      findings: [...qualityRows.filter((q) => q.st !== 'ok'),
        ...st.job.unsupported_rules.map((u): Finding => ({ st: 'unverified', text: `荷崩れ・物理的な安定性は仮想実行で検証しない：${u.text}` }))],
      ok: qualityRows.filter((q) => q.st === 'ok').map((q) => q.text).join('／'),
      fixes: [], poc: pocQuality },
    { tid: 'issue-efficiency', title: '作業効率',
      findings: [
        ...handoffs.map(([r, n]): Finding => ({ st: 'ng', text: `人への引継ぎ ${n}個：${r}` })),
        ...(ratio != null ? [{ st: 'unverified', text: `作業時間はロボット（推定）が人（参考値）の約${ratio.toFixed(1)}倍。どちらも実測ではない` } as Finding]
          : [{ st: 'na', text: '作業時間の比較は未算出' } as Finding]),
        ...st.masters.validation.warnings.map((w): Finding => ({ st: 'unverified', text: `作業環境：${w.message}` })),
      ],
      ok: handed.length === 0 ? `荷物${job.items.length}個すべてを仮想配置（人への引継ぎなし）` : '',
      fixes: imp(['peripheral']),
      poc: robot ? ['実機でサイクルタイムを測り、人との分担を含めた作業時間を確かめる'] : [] },
    { tid: 'issue-safety', title: '安全性・人との共存',
      findings: [{ st: 'unverified', text: '人との作業エリアの分離・安全対策は仮想実行では検証していない' },
        { st: 'unverified', text: '把持時の落下・周囲との干渉は物理シミュレーションをしていないため未検証' }],
      ok: '', fixes: [], poc: pocSafety.length ? pocSafety : ['安全柵・エリアセンサー・非常停止など、人と同じエリアで動かす条件を現場で確認する'] },
  ]
  // 重要な課題を先に：問題あり → 未検証の多い順
  const rank = (a: Area) => a.findings.filter((f) => f.st === 'ng').length * 100 + a.findings.filter((f) => f.st === 'unverified').length
  const areas = [...AREAS].sort((a, b) => rank(b) - rank(a))
  const ngTotal = AREAS.reduce((n, a) => n + a.findings.filter((f) => f.st === 'ng').length, 0)
  const unverifiedTotal = AREAS.reduce((n, a) => n + a.findings.filter((f) => f.st === 'unverified').length, 0)

  // ── シミュレーションサマリ：主要所見／効果見通し／残存課題（3行。数値の繰り返しは最小限・断定しない） ──
  const unknownCaps = checks.filter((c) => c.status === 'unknown').map((c) => c.label)
  const ngCaps = checks.filter((c) => c.status === 'ng' || c.status === 'partial').map((c) => c.label)
  const findingsLine = handed.length === 0
    ? `対象荷物${job.items.length}件（${types.length}品目）の全量について、仮想環境上で積付処理が完了。現行ワークフローに対する本構成の業務適合性は、シミュレーション上は確認できた。`
    : `対象荷物${job.items.length}件中${placed.length}件の積付処理が完了し、${handed.length}件で人手への引継ぎが発生${ngCaps.length ? `（主因：${ngCaps.slice(0, 2).join('、')}）` : ''}。本構成単独での全量処理は、現時点では成立していない。`
  const effectLine = ratio == null ? '作業時間の比較指標が未算出のため、効果見通しは評価対象外とした。'
    : ratio <= 1 ? `推定サイクルタイムは人手作業（参考値）比で約${Math.round((1 - ratio) * 100)}%の短縮が見込まれる。ただし省人化効果の定量化には、実機での計測が前提となる。`
      : `推定サイクルタイムは人手作業（参考値）の約${ratio.toFixed(1)}倍であり、本構成単独では処理速度面の優位性は見込みにくい。人手との作業分担や供給設備の見直しを含めた運用設計が論点となる。`
  const openItems = [
    unknownCaps.length ? `${unknownCaps.slice(0, 2).join('・')}${unknownCaps.length > 2 ? '等' : ''}の能力` : '',
    undefinedCriteria.length ? `判断基準が未定義の業務ルール${undefinedCriteria.length}件` : '',
    '安全要件',
  ].filter(Boolean)
  const openLine = `${openItems.join('、')}が未検証。導入判断に先立ち、実機PoCおよび現場ヒアリングによる確認が必要。`

  // ── 定量評価：工程（Level 1）ごとに集約 → 選ぶと個別タスク（Level 2） ──
  const stages: { name: string; tasks: TaskEval[] }[] = []
  tasks.forEach((t) => { const s = stages.find((x) => x.name === t.stage); if (s) s.tasks.push(t); else stages.push({ name: t.stage, tasks: [t] }) })
  const n = (ts: TaskEval[], s: TaskStatus) => ts.filter((t) => t.status === s).length

  return (
    <div className="step-page evaluation ev2" data-testid="page-5">
      {scenarioBar}

      {/* ① シミュレーションサマリ（横幅いっぱい）：結論を3行で */}
      <section className="ev-comment" data-testid="ev-summary">
        <div className="ev-comment-h">シミュレーションサマリ</div>
        <dl className="ev-findings" data-testid="ev-comment">
          <dt>主要所見</dt><dd>{findingsLine}</dd>
          <dt>効果見通し</dt><dd>{effectLine}</dd>
          <dt>残存課題</dt><dd>{openLine}</dd>
        </dl>
        <p className="ev-disclaimer">シミュレーション結果に基づく評価です。実機での導入可否・動作の成功・省人化効果を示すものではありません。</p>
      </section>

      {/* ② 主要KPI */}
      <section className="ev-metrics" data-testid="ev-kpis">
        <Kpi tid="m-tasks" k="タスク達成状況" kind="sim" cls={failed.length ? 'ng' : unevaluated ? 'warn' : 'ok'}
          v={<>{done.length}<span className="ev-u">件 達成／全{tasks.length}件</span></>}
          sub={`${failed.length ? `評価対象 ${judged.length}件中 未達 ${failed.length}件` : `評価対象 ${judged.length}件はすべて達成`}。残り ${unevaluated}件は仮想実行の対象外で未評価`}>
          <div className="ev-bar" title={`達成 ${done.length}・未達 ${failed.length}・未評価 ${unevaluated}`}>
            <span className="b-ok" style={{ flex: done.length }} /><span className="b-ng" style={{ flex: failed.length }} /><span className="b-none" style={{ flex: unevaluated }} />
          </div>
        </Kpi>
        <Kpi tid="m-items" k="荷物の仮想処理完了率" kind="sim" cls={handed.length ? 'warn' : 'ok'} v={pct(placed.length, job.items.length)}
          sub={`${placed.length}/${job.items.length}個を仮想配置・人への引継ぎ ${handed.length}個`} />
        <Kpi tid="m-types" k="対応した荷物種類" kind="sim" cls={okTypes.length < types.length ? 'warn' : 'ok'}
          v={<>{okTypes.length}<span className="ev-u">/{types.length}種類</span></>} sub="品名ごとに全数を仮想配置できた種類" />
        <Kpi tid="m-time" k="作業時間（ロボット÷人）" kind={ratio != null ? 'estimate' : 'none'} cls={ratio == null ? 'none' : ratio <= 1 ? 'ok' : 'warn'}
          v={ratio != null ? `${ratio.toFixed(1)}倍` : '未算出'}
          sub={<>人 {human != null ? mmss(human) : '未算出'} <KindTag k={human != null ? 'reference' : 'none'} />／ロボット {robot ? mmss(robot.total_s) : '未算出'} <KindTag k={robot ? 'estimate' : 'none'} /></>} />
      </section>

      {/* ③ 詳細評価 */}
      <div className="ev-tabs" role="tablist">
        <button role="tab" className={tab === 'quant' ? 'is-on' : ''} onClick={() => setTab('quant')} data-testid="tab-quant">定量評価</button>
        <button role="tab" className={tab === 'issues' ? 'is-on' : ''} onClick={() => setTab('issues')} data-testid="tab-issues">
          課題・改善余地{ngTotal + unverifiedTotal > 0 && <span className="ev-tab-n">{ngTotal ? `問題 ${ngTotal}・` : ''}未検証 {unverifiedTotal}</span>}
        </button>
      </div>

      {tab === 'quant' ? (
        <div className="ev-detail" data-testid="ev-quant">
          <section className="ev-sec" data-testid="ev-tasks">
            <h3>工程別の達成状況<span className="muted small">（Step 3 の確定ワークフロー。工程を選ぶと個別タスクを表示）</span></h3>
            <table className="ev-table ev-stages">
              <thead><tr><th>工程</th><th>達成</th><th>未達</th><th>未評価</th><th>状況</th></tr></thead>
              <tbody>{stages.map((s) => {
                const open = openStage === s.name
                const d = n(s.tasks, 'done'), f = n(s.tasks, 'failed'), u = n(s.tasks, 'unevaluated')
                const label = f ? '未達あり' : u === s.tasks.length ? '仮想実行の対象外' : u ? '一部未評価' : 'すべて達成'
                return (
                  <Fragment key={s.name}>
                    <tr className={`ev-stage-row ${open ? 'is-on' : ''}`} onClick={() => setOpenStage(open ? null : s.name)} data-testid="ev-stage">
                      <td><span className="ev-caret">{open ? '▾' : '▸'}</span>{s.name}<span className="muted small">（{s.tasks.length}タスク）</span></td>
                      <td className={d ? 'hw-ok' : 'muted'}>{d}</td><td className={f ? 'hw-ng' : 'muted'}>{f}</td><td className="muted">{u}</td>
                      <td><span className={`badge ${f ? 'badge-err' : u === s.tasks.length ? 'badge-none' : u ? 'badge-warn' : 'badge-ok'}`}>{label}</span></td>
                    </tr>
                    {open && s.tasks.map((t, i) => (
                      <tr key={i} className="ev-task-row" data-testid="ev-task">
                        <td>{t.label}</td><td colSpan={3}><span className={`badge ${TASK_STATUS[t.status].cls}`}>{TASK_STATUS[t.status].text}</span></td><td className="small">{t.note}</td>
                      </tr>
                    ))}
                  </Fragment>
                )
              })}</tbody>
              <tfoot><tr><th>合計</th><th>{done.length}</th><th>{failed.length}</th><th>{unevaluated}</th>
                <th className="small muted">達成率は評価対象 {judged.length}件に対して {pct(done.length, judged.length)}（業務全体の達成率ではない）</th></tr></tfoot>
            </table>
          </section>

          <section className="ev-sec" data-testid="ev-types">
            <h3>荷物種類別の処理状況<KindTag k="sim" /></h3>
            <p className="ev-lead">{okTypes.length === types.length ? `${types.length}種類すべてで全数を仮想配置` : `${types.length}種類中 ${okTypes.length}種類で全数を仮想配置`}・人への引継ぎ {handed.length}個{handoffs.length ? `（${handoffs.map(([r, k]) => `${r} ${k}個`).join('／')}）` : ''}</p>
            <details data-testid="ev-handoff">
              <summary>種類ごとの内訳</summary>
              <table className="ev-table">
                <thead><tr><th>品名</th><th>仮想配置</th><th>荷物</th><th>引継ぎの理由</th></tr></thead>
                <tbody>{types.map((g) => (
                  <tr key={g.name}><td>{g.name}</td><td className={g.placed < g.total ? 'hw-ng' : ''}>{g.placed}/{g.total}</td><td className="small">{g.ids.join('・')}</td><td className="small">{g.reasons.join('／') || '—'}</td></tr>
                ))}</tbody>
              </table>
            </details>
          </section>

          <section className="ev-sec" data-testid="ev-time">
            <h3>作業時間の比較</h3>
            {human != null || robot ? (
              <div className="ev-timebars">
                {[{ who: '人', s: human, kind: 'reference' as Kind, per: human != null ? human / job.items.length : null },
                  { who: 'ロボット', s: robot?.total_s ?? null, kind: 'estimate' as Kind, per: robot && placed.length ? robot.total_s / placed.length : null }].map((r) => (
                  <div key={r.who} className="ev-timebar">
                    <span className="ev-timebar-who">{r.who}</span>
                    <span className="ev-timebar-track"><span className={`ev-timebar-fill ${r.kind}`} style={{ width: r.s != null ? `${(r.s / Math.max(human ?? 0, robot?.total_s ?? 0)) * 100}%` : 0 }} /></span>
                    <span className="ev-timebar-v">{r.s != null ? mmss(r.s) : '未算出'}<span className="muted small">（1個 {r.per != null ? `${r.per.toFixed(1)}秒` : '—'}）</span></span>
                    <KindTag k={r.s != null ? r.kind : 'none'} />
                  </div>
                ))}
              </div>
            ) : <p className="muted">未算出</p>}
            <details>
              <summary>算出の根拠</summary>
              <ul className="ev-list">
                <li>人（参考値）：入力動画上で作業の始めから終わりまで。模擬作業動画のため実測ではない</li>
                <li>ロボット（推定）：{robot ? <>模擬の速度仕様（{Object.entries(robot.params).map(([k, v]) => `${k}=${v}`).join('・')}）× 仮想実行の動作。含まないもの：{robot.excludes.join('、')}。{robot.note}</> : '速度仕様のない構成のため未算出'}</li>
              </ul>
            </details>
          </section>

          {runs.length > 1 && (
            <section className="ev-sec" data-testid="ev-compare">
              <details>
                <summary>ほかの構成との比較（{runs.length}構成・同じ業務と荷物での仮想実行結果）</summary>
                <table className="ev-table">
                  <thead><tr><th>構成</th><th>仮想配置</th><th>引継ぎ</th><th>推定時間</th><th>仕様の不足</th></tr></thead>
                  <tbody>{runs.map(({ config: c, run: r }) => (
                    <tr key={c.config_id} className={c.config_id === config?.config_id ? 'is-on' : ''}>
                      <td>{cfgName(c)}</td><td>{r.job.end.placed}</td><td>{r.job.end.handed_off}</td>
                      <td>{r.time_estimate ? mmss(r.time_estimate.total_s) : '未算出'}</td>
                      <td className="small">{r.check?.results.filter((x) => x.status === 'ng').map((x) => x.label).join('、') || 'なし'}</td>
                    </tr>
                  ))}</tbody>
                </table>
              </details>
            </section>
          )}
        </div>
      ) : (
        <div className="ev-detail" data-testid="ev-issues">
          <section className="ev-sec" data-testid="ev-issue-table">
            <h3>課題・改善余地<span className="muted small">（重要な観点から順に表示。改善案はすべて仮説で、効果は確認していません）</span></h3>
            <table className="ev-table ev-chain">
              <thead><tr><th>評価観点</th><th>現状・課題</th><th>改善案（仮説）</th><th>実機PoCでの確認事項</th></tr></thead>
              <tbody>{areas.map((a) => {
                const ng = a.findings.filter((f) => f.st === 'ng').length, un = a.findings.filter((f) => f.st === 'unverified').length
                return (
                  <tr key={a.tid} className="ev-issue" data-testid={a.tid}>
                    <th>{a.title}<div><span className={`badge ${ng ? 'badge-err' : un ? 'badge-warn' : 'badge-ok'}`}>{ng ? `問題あり ${ng}` : un ? `未検証 ${un}` : '確認済み'}</span></div></th>
                    <td>
                      {a.findings.length ? <ul className="ev-list">{groupFindings(a.findings).map((f) => <li key={f.text} className={`f-${f.st}`}><span className={`badge ${QSTAT[f.st].cls}`}>{QSTAT[f.st].text}</span>{f.text}</li>)}</ul>
                        : <span className="muted small">課題なし</span>}
                      {a.ok && <details className="ev-ok"><summary>確認済みの項目</summary><p className="small">{a.ok}</p></details>}
                    </td>
                    <td><List xs={a.fixes} empty="—" /></td>
                    <td><List xs={a.poc} empty="—" max={3} /></td>
                  </tr>
                )
              })}</tbody>
            </table>
          </section>
        </div>
      )}
    </div>
  )
}

type Finding = { st: 'ok' | 'ng' | 'unverified' | 'na'; text: string }
type Area = { tid: string; title: string; findings: Finding[]; ok: string; fixes: string[]; poc: string[] }
const QSTAT: Record<Finding['st'], { text: string; cls: string }> = {
  ok: { text: '確認済み', cls: 'badge-ok' }, ng: { text: '問題あり', cls: 'badge-err' }, unverified: { text: '未検証', cls: 'badge-warn' }, na: { text: '未評価', cls: 'badge-none' },
}
/** 箇条書き。多いときは先頭だけ出し、残りは「ほかN件」で開く */
function List({ xs, empty, max }: { xs: string[]; empty: string; max?: number }) {
  if (!xs.length) return <span className="muted small">{empty}</span>
  const head = max ? xs.slice(0, max) : xs
  const rest = max ? xs.slice(max) : []
  return (
    <>
      <ul className="ev-list">{head.map((x) => <li key={x}>{x}</li>)}</ul>
      {rest.length > 0 && <details className="ev-more"><summary>ほか{rest.length}件</summary><ul className="ev-list">{rest.map((x) => <li key={x}>{x}</li>)}</ul></details>}
    </>
  )
}
/** 同じ種類の課題（「判断基準が未定義：A」「判断基準が未定義：B」など）を1行にまとめる */
function groupFindings(fs: Finding[]): Finding[] {
  const out: { st: Finding['st']; head: string; tails: string[]; text: string }[] = []
  for (const f of fs) {
    const i = f.text.indexOf('：')
    const head = i > 0 ? f.text.slice(0, i) : f.text
    const g = out.find((x) => x.st === f.st && x.head === head && i > 0)
    const tail = f.text.slice(i + 1).replace(/。$/, '')
    if (g) g.tails.push(tail)
    else out.push({ st: f.st, head, tails: i > 0 ? [tail] : [], text: f.text })
  }
  return out.map((g) => ({ st: g.st, text: g.tails.length > 1 ? `${g.head} ${g.tails.length}件：${g.tails.join('、')}` : g.text }))
}
/** 同じ理由をまとめて数える（引継ぎの理由など） */
function summarize(xs: string[]): [string, number][] {
  const m = new Map<string, number>()
  xs.filter(Boolean).forEach((x) => m.set(x.replace(/（[^）]*kg[^）]*）/, ''), (m.get(x.replace(/（[^）]*kg[^）]*）/, '')) ?? 0) + 1))
  return [...m.entries()]
}
