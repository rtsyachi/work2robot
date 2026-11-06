import { THEME } from '../lib/theme'
export type StepStatus = 'todo' | 'running' | 'done' | 'warn' | 'failed' | 'stale'
export type StepDef = { id: number; title: string; status: StepStatus; note?: string }

/**
 * 工程メニュー：番号と名称・現在のステップ・移動（状態は出さない）。
 * 初期はピン止め（左に常に表示）。下のピンで外すと、三本線のボタンで開閉する引き出しになる。
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
          {/* 三本線とロゴ：ピン止め中は三本線でメニューをしまう（ピン止めを外す） */}
          <button className="menu-btn" onClick={() => (pinned ? onPin(false) : onClose())} aria-label="工程メニューをしまう"
            title={pinned ? 'メニューをしまう（ピン止めを外す）' : 'メニューを閉じる'} data-testid="nav-menu-btn">
            <span /><span /><span />
          </button>
          <img src="/work2robot_logo.png" alt="Work2Robot" className="logo" data-testid="logo" />
          {!pinned && <button className="drawer-close" onClick={onClose} aria-label="メニューを閉じる">×</button>}
        </div>
        {steps.map((s) => (
          // メニューは番号と名称だけ（状態は出さない）
          <button
            key={s.id}
            className={`step ${s.id === current ? 'is-current' : ''}`}
            onClick={() => { onGo(s.id); if (!pinned) onClose() }}
            data-testid={`step-${s.id}`}
            tabIndex={shown ? 0 : -1}
          >
            <span className="step-no">{s.id + 1}</span>{/* 表示は 1 始まり（id は内部の 0〜5） */}
            <span className="step-text">
              <span className="step-title">{s.title}</span>
            </span>
          </button>
        ))}
        {/* ピン止め（初期は止めた状態）。メニューの下に置く */}
        <button className={`drawer-pin ${pinned ? 'is-on' : ''}`} onClick={() => { onPin(!pinned); if (pinned) onClose() }}
          title={pinned ? 'ピン止めを外す' : 'ピン止めして常に表示'} aria-pressed={pinned} data-testid="nav-pin">
          <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
            <path d="M15 3l6 6-3 1-4 4 1 5-2 2-4-4-5 5-1-1 5-5-4-4 2-2 5 1 4-4z" fill={pinned ? THEME.brand : 'none'} stroke={pinned ? THEME.brand : THEME.muted} strokeWidth="1.6" strokeLinejoin="round" />
          </svg>
        </button>
      </nav>
    </>
  )
}
