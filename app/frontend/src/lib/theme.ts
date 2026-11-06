// カラーテーマ（styles.css の :root のトークンと同じ値）。SVG の属性やグラフのライブラリなど、CSS変数が効かない所で使う。
// ロゴの「ネイビー＋ティール」。意味の色（成功・警告・エラー）はブランドの強調と混同しないよう別に持つ。
export const THEME = {
  brand: '#061F43',       // ネイビー：ブランド・見出し・主要テキスト
  teal: '#00C6A0',        // ティール：アクセント・選択・進行の強調
  brandStrong: '#007F6D', // 濃いティール：リンク・選択中の枠・強調する経路
  brandSoft: '#E6F8F3',   // 選択項目などの淡い背景
  brandLine: '#7FD9C5',
  bg: '#F5F7FA',
  bg2: '#EEF2F6',
  panel: '#FFFFFF',
  text: '#061F43',
  text2: '#334155',
  muted: '#64748B',
  muted2: '#94A3B8',
  line: '#DCE3EB',
  lineStrong: '#C7D2DE',
  ok: '#2B8A3E',
  warn: '#C2410C',
  err: '#C92A2A',
  info: '#1E5A96',
  infoSoft: '#E8F0F8',
} as const
