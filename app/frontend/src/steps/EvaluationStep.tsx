import type { HwConfig, V2Run, V2State } from '../types'

const KIND_LABEL: Record<string, string> = {
  order: '作業・積付順序', pattern: '積付パターン', hardware: 'ロボット構成', peripheral: '周辺設備', operation: '運用',
}
const cfgName = (c: HwConfig | undefined) => (c?.source === 'claude' ? 'Claudeの推奨構成' : c?.label ?? '—')

/** ⑤ 導入前評価：結果のサマリー → 詳細（確認できたこと・改善候補・不足情報・実機PoC） */
export default function EvaluationStep({ st, run, config, runs, onGoStep }: {
  st: V2State
  run: V2Run | null
  config: HwConfig | null
  runs: { config: HwConfig; run: V2Run }[]
  onGoStep: (n: number) => void
}) {
  if (!run) {
    return (
      <div className="step-page evaluation" data-testid="page-5">
        <div className="ex-empty static">
          <p>この構成（{cfgName(config ?? undefined)}）・荷物の条件では、まだ仮想実行していません。</p>
          <button className="run big" onClick={() => onGoStep(4)}>④ 仮想ロボット実行へ</button>
        </div>
      </div>
    )
  }
  const { job, readiness: rd } = run
  const batch = st.batches.find((b) => b.object_ids.join() === job.arrival.join())
  const placed = job.items.filter((i) => i.outcome === 'placed')
  const handed = job.items.filter((i) => i.outcome === 'handed_off')
  const capNg = handed.filter((i) => i.capability?.status === 'ng')
  const unverifiedItems = placed.filter((i) => (i.capability?.unverified.length ?? 0) > 0)
  const hw = rd.hardware
  const pocTop = rd.categories.needs_physical_poc.slice(0, 4)

  return (
    <div className="step-page evaluation" data-testid="page-5">
      <section className="ev-summary" data-testid="ev-summary">
        <div className="ev-card">
          <div className="ev-k">対象業務・荷物</div>
          <div className="ev-v">カゴ車1台の積付</div>
          <div className="small">{batch?.label ?? `荷物${job.items.length}個`}</div>
        </div>
        <div className="ev-card">
          <div className="ev-k">ロボット構成</div>
          <div className="ev-v small-v">{cfgName(config ?? undefined)}</div>
          {hw && <div className="small">対応 {hw.counts.ok}・一部対応 {hw.counts.partial ?? 0}・未確認 {hw.counts.unknown}・不足 {hw.counts.ng}</div>}
        </div>
        <div className="ev-card ok">
          <div className="ev-k">仮想環境で配置できた荷物</div>
          <div className="ev-v">{placed.length}<span className="ev-u">/{job.items.length}個</span></div>
          <div className="small">実機での自動化の成功数ではありません</div>
        </div>
        <div className={`ev-card ${handed.length ? 'ng' : ''}`}>
          <div className="ev-k">処理できなかった荷物</div>
          <div className="ev-v">{handed.length}<span className="ev-u">個</span></div>
          <div className="small">{capNg.length ? `うち能力不足 ${capNg.length}個` : '能力不足なし'}</div>
        </div>
        <div className={`ev-card ${unverifiedItems.length || (hw?.counts.unknown ?? 0) ? 'warn' : ''}`}>
          <div className="ev-k">判断・能力が未確認</div>
          <div className="ev-v">{(hw?.counts.unknown ?? 0) + unverifiedItems.length}<span className="ev-u">件</span></div>
          <div className="small">能力 {hw?.counts.unknown ?? 0}件・未確認の印の荷物 {unverifiedItems.length}個</div>
        </div>
      </section>

      <div className="ev-body">
        <div className="ev-col">
          <section className="ev-sec" data-testid="ev-priority">
            <h3>優先して実機PoCで確かめること</h3>
            <ul>{pocTop.map((x) => <li key={x}>{x}</li>)}</ul>
          </section>
          {handed.length > 0 && (
            <section className="ev-sec ng" data-testid="ev-handed">
              <h3>この構成で実行できなかった作業</h3>
              <ul>{handed.map((h) => <li key={h.object_id}><strong>{h.object_id}</strong>：{h.handoff_reason}</li>)}</ul>
            </section>
          )}
          {runs.length > 1 && (
            <section className="ev-sec" data-testid="ev-compare">
              <h3>構成の比較（同じ業務・同じ荷物、仮想環境での結果）</h3>
              <table className="ev-table">
                <thead><tr><th>構成</th><th>配置</th><th>引継ぎ</th><th>仕様の不足</th><th>処理できなかった理由</th></tr></thead>
                <tbody>
                  {runs.map(({ config: c, run: r }) => (
                    <tr key={c.config_id} className={c.config_id === config?.config_id ? 'is-on' : ''}>
                      <td>{cfgName(c)}</td>
                      <td>{r.job.end.placed}</td>
                      <td>{r.job.end.handed_off}</td>
                      <td>{r.check?.results.filter((x) => x.status === 'ng').map((x) => x.label).join('、') || 'なし'}</td>
                      <td className="small">{[...new Set(r.job.items.filter((i) => i.outcome === 'handed_off').map((i) => (i.handoff_reason ?? '').replace(/（.*$/, '')))].join('／') || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}
          <details className="ev-sec" open>
            <summary>② 改善候補（すべて仮説・{rd.improvements?.length ?? 0}件）</summary>
            <ul data-testid="ev-improvements">
              {(rd.improvements ?? []).map((x, i) => (
                <li key={i}>
                  <span className="badge badge-info">{KIND_LABEL[x.kind] ?? x.kind}</span>
                  <span className="badge badge-warn">{x.source === 'claude' ? 'Claudeの仮説' : '実行結果から'}</span> {x.text}
                </li>
              ))}
            </ul>
            <p className="muted small">{rd.improvements_note}</p>
          </details>
        </div>
        <div className="ev-col">
          <details className="ev-sec ok">
            <summary>① 論理的に確認できたこと（{rd.categories.workflow_checked.length}）</summary>
            <ul>{rd.categories.workflow_checked.map((x) => <li key={x}>{x}</li>)}</ul>
          </details>
          <details className="ev-sec info" open>
            <summary>③ 不足情報・確認事項（{rd.categories.needs_information.length + rd.categories.requires_human.length}）</summary>
            <h4>業務ルール・情報の不足</h4>
            <ul>{rd.categories.needs_information.map((x) => <li key={x}>{x}</li>)}</ul>
            <h4>人の確認・引継ぎが必要</h4>
            <ul>{rd.categories.requires_human.map((x) => <li key={x}>{x}</li>)}</ul>
          </details>
          <details className="ev-sec poc">
            <summary>④ 実機PoC検証項目（{rd.categories.needs_physical_poc.length}）</summary>
            <ul>{rd.categories.needs_physical_poc.map((x) => <li key={x}>{x}</li>)}</ul>
          </details>
          <section className="ev-legend" data-testid="ev-legend">
            <h4>表示の意味</h4>
            <dl>
              <dt>ワークフロー検証OK</dt><dd>構造・分岐の形が正しい（業務として正しいかは別）</dd>
              <dt>仮想配置できた</dt><dd>仮想環境で作業ロジックが最後まで進んだ（実機での動作保証ではない）</dd>
              <dt>仕様上対応</dt><dd>模擬の部品一覧の仕様値で要件を満たす</dd>
              <dt>未確認・実機未検証</dt><dd>把持・接触力・干渉・安全性などは実機PoCで確かめる</dd>
            </dl>
          </section>
        </div>
      </div>
    </div>
  )
}
