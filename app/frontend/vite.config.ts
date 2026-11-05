import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// /api はバックエンド（FastAPI）へ中継する。
// 通常は 127.0.0.1:8000。確認用（npm run dev:verify, --mode verify）は 127.0.0.1:8001 を使い、
// ユーザーが起動中の開発サーバーとぶつからないようにする。
export default defineConfig(({ mode }) => ({
  plugins: [react()],
  server: {
    proxy: { '/api': mode === 'verify' ? 'http://127.0.0.1:8001' : 'http://127.0.0.1:8000' },
  },
}))
