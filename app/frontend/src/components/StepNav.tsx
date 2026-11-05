export type StepStatus = 'todo' | 'running' | 'done' | 'warn' | 'failed' | 'stale'
export type StepDef = { id: number; title: string; status: StepStatus; note?: string }

const STATUS_LABEL: Record<StepStatus, string> = {
  todo: '未実行', running: '実行中', done: '完了', warn: '要確認', failed: '失敗', stale: '再実行が必要',
}

/**
 * 工程メニュー（左から出る引き出し）：現在のステップ・状態・移動。
 * 三本線のボタンで開閉する。ピン止めすると左に常に表示し、工程を選んでも閉じない。
 */
export default function StepNav({ steps, current, onGo, open, onClose, pinned, onPin }: {
  steps: StepDef[]; current: number; onGo: (id: number) => void; open: boolean; onClose: () => void
  pinned: boolean; onPin: (p: boolean) => void
}) {
  const shown = open || pinned
  return (
    <>
      {open && !pinned && <div className="drawer-back" onClick={onClose} data-testid="drawer-back" />}
      <nav className={`stepnav drawer ${shown ? 'is-open' : ''} ${pinned ? 'is-pinned' : ''}`} data-testid="stepnav" aria-hidden={!shown}>
        <div className="drawer-head">
          <span>工程</span>
          <span className="drawer-tools">
            <button className={`drawer-pin ${pinned ? 'is-on' : ''}`} onClick={() => { onPin(!pinned); if (pinned) onClose() }}
              title={pinned ? 'ピン止めを外す' : 'ピン止めして常に表示'} aria-pressed={pinned} data-testid="nav-pin">
              <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
                <path d="M15 3l6 6-3 1-4 4 1 5-2 2-4-4-5 5-1-1 5-5-4-4 2-2 5 1 4-4z" fill={pinned ? '#5f3dc4' : 'none'} stroke={pinned ? '#5f3dc4' : '#868e96'} strokeWidth="1.6" strokeLinejoin="round" />
              </svg>
              {pinned ? 'ピン止め中' : 'ピン止め'}
            </button>
            {!pinned && <button className="drawer-close" onClick={onClose} aria-label="メニューを閉じる">×</button>}
          </span>
        </div>
        {steps.map((s) => (
          <button
            key={s.id}
            className={`step st-${s.status} ${s.id === current ? 'is-current' : ''}`}
            onClick={() => { onGo(s.id); if (!pinned) onClose() }}
            data-testid={`step-${s.id}`}
            title={s.note}
            tabIndex={shown ? 0 : -1}
          >
            <span className="step-no">{s.id}</span>
            <span className="step-text">
              <span className="step-title">{s.title}</span>
              <span className={`step-status st-${s.status}`}>{STATUS_LABEL[s.status]}{s.note ? `・${s.note}` : ''}</span>
            </span>
          </button>
        ))}
      </nav>
    </>
  )
}
