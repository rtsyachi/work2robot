---
paths:
  - "backend/extraction/**/*.py"
  - "backend/ai/**/*.py"
  - "tests/test_extraction*.py"
---
# AI抽出モジュールの実装ルール

- 入力動画のフレーム・音声に**実在する時刻**だけ付与する。荷物の質量・中身の破損性を映像から確定しない。
- 提供された説明テキストを音声認識結果として扱わない。動画生成用の台本・正解データを入力や抽出結果に使わない（`docs/DEMO_INPUT.md`）。
- Claude出力は**未検証の草案**として扱い、`docs/WORKFLOW_SPEC.md`の構造検証を通してから利用する。
- APIキーはバックエンドの環境変数から取得する。ブラウザへ返さず、サンプルデータへも含めない。
- 基準が示されていない判定条件は`needs_confirmation`の確認事項として返し、閾値を捏造しない（`docs/WORKFLOW_SPEC.md`）。
- `on_unknown`の暫定動作は、動画・説明に作業例があればそれと同じ結果にし、なければ`ai_hypothesis`と明示した仮説にする。
