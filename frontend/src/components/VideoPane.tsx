import { useEffect, useRef } from 'react'

type Props = {
  src: string
  range: { start: number; end: number } | null   // 仮想ロボットが作業中の荷物を、人が扱っている区間
  follow: boolean                                 // 業務の再生中だけ動画を追従させる
  missingNote: string | null                      // 作業中の荷物が動画に映っていない場合の説明
  seek: { t: number; nonce: number } | null       // 根拠の時刻へ移動する要求
}

export default function VideoPane({ src, range, follow, missingNote, seek }: Props) {
  const ref = useRef<HTMLVideoElement>(null)

  useEffect(() => {
    const v = ref.current
    if (!v || !range || !follow) return
    v.currentTime = range.start
    v.play().catch(() => {})
    const stop = () => { if (v.currentTime >= range.end) v.pause() }
    v.addEventListener('timeupdate', stop)
    return () => v.removeEventListener('timeupdate', stop)
  }, [range?.start, range?.end, follow])

  useEffect(() => {
    const v = ref.current
    if (!v || !follow) return
    if (!range) v.pause()
  }, [range, follow])

  useEffect(() => {
    const v = ref.current
    if (!v || !seek) return
    v.currentTime = seek.t
    v.play().catch(() => {})
  }, [seek?.nonce])

  return (
    <div className="pane-video" data-testid="video-pane">
      <div className="pane-title">人の作業（入力動画：デモ用模擬作業動画）</div>
      <video ref={ref} src={src} muted controls playsInline data-testid="work-video" />
      {missingNote && <div className="video-note" data-testid="video-note">{missingNote}</div>}
    </div>
  )
}
