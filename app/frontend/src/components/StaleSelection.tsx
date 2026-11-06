import { useEffect, useState } from 'react'
import { fetchAnalysis, reselectHardware } from '../api'

/** Step 4：Step 3 でワークフローを直したあと、Claudeの仮選定が前の版から作られていることを知らせ、再選定する（勝手に課金しない）。 */
export default function StaleSelection({ onChanged }: { onChanged: () => void }) {
  const [running, setRunning] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  useEffect(() => {
    if (!running) return
    const id = window.setInterval(() => {
      fetchAnalysis().then((j) => {
        if (j.state === 'running') return
        setRunning(false)
        if (j.state === 'error') setErr(j.error)
        else onChanged()
      }).catch(() => undefined)
    }, 3000)
    return () => window.clearInterval(id)
  }, [running, onChanged])
  const start = () => { setErr(null); reselectHardware().then(() => setRunning(true)).catch((e) => setErr(e instanceof Error ? e.message : String(e))) }
  return (
    <div className="ms-alert" data-testid="selection-stale">
      <strong>Step 3 でワークフローを直したため、Claudeの仮選定は前の版のワークフローから作られています。</strong>
      今のワークフローで選び直すには再選定してください（Claude API・約$0.17・約1分）。
      <button onClick={start} disabled={running} data-testid="reselect">{running ? '再選定中…' : '再選定する'}</button>
      {err && <span>{err}</span>}
    </div>
  )
}
