# Work2Robot — Claude Codeへの共通指示

## プロジェクト
- 目的：人間の作業動画と説明から**条件分岐付き業務ワークフロー**を生成し、仮想ロボットで実行・可視化して、実機PoC前に未検証事項を特定する。
- 題材：物流ハブでの異種荷物の積付（積付先はカゴ車）。最新の製品方針は `docs/PRODUCT.md` を正本とする。
- デモの入力動画は**生成・模擬作業動画**で、ユーザーの現場撮影を前提にしない。導入用の実写素材は解析しない。詳細は `docs/DEMO_INPUT.md`。
- 最終目標：2026-11-08 20:00（JST）までに、**3分以内の日本語実演動画**と公開GitHubリポジトリ。動画の正本は `docs/DEMO.md`。
- このプロジェクトは**動画要約ツールでも、積付最適化コンペでも、導入後OJTの管理画面でもない**。

## 回答・文書の言語
- ユーザーへの回答、設計資料、UI表示文言、テスト説明は**日本語を基本**とする。
- API名、識別子、コード、外部ライブラリ名、JSONキーは慣例に従い英語でよい。

## 開発上の共通原則
- **動画・説明（音声または提供テキスト）から作業と分岐を抽出 → 構造化グラフを検証 → グラフを実行 → 実行イベントで3D表示 → PoC前チェック**の一連を実働させる。
- **映像で観測した事実／発話／提供テキスト／模擬属性／AIの仮説／人間の確認**を区別する。未知の情報を確定扱いしない。動画・説明に作業例があればそれに合わせた暫定動作、なければAIの仮説と明示した暫定動作で作業を完了し、確認事項に残す（`docs/WORKFLOW_SPEC.md`「暫定動作」）。
- Claudeはワークフロー案を生成する。**分岐判定・実行・検証は決定的なコードで行う**。生成コードの`eval`は禁止。
- 仮想動作は**作業ロジックの検証**。実機の把持・物理安定性・安全性・稼働率を実証したと表現しない。
- **固定シナリオ用データと本物のClaude解析結果を混同しない**。動画では実際に開発期間中に作成した機能のみ示す。
- NEDOコンペの既存コード・公式配布データ・公式シミュレータは流用しない。秘密情報、無許諾素材、APIキーを公開しない。
- 破壊的Git操作、公開・push、課金を伴う外部操作は事前にユーザーの承認を得る。

## 作業するときの資料
- 要件・利用者・非対象：`docs/PRODUCT.md`
- 動画の絵コンテ・日本語ナレーション：`docs/DEMO.md`
- 入力素材の要件・制作方式・制作タスク：`docs/DEMO_INPUT.md`
- グラフの入出力・分岐と未知値：`docs/WORKFLOW_SPEC.md`
- モジュール境界・優先順：`docs/ARCHITECTURE.md`
- 完成判定：`docs/ACCEPTANCE.md`
- 規約：`docs/EVENT_RULES.md`
- **該当する作業の資料だけ読む。** 大量の`@`インポートで全資料を常時読み込まない。

## 検証と報告
- 環境：`python -m venv .venv` → `.venv\Scripts\python -m pip install -r requirements-dev.txt`
- テスト：`.venv\Scripts\python -m pytest`（リポジトリ直下で実行）、`frontend` で `npm run test`。荷物ごとの経路一覧：`.venv\Scripts\python scripts\run_cases.py`
- 起動：`.venv\Scripts\python -m uvicorn backend.api.app:app --port 8000` と `frontend` で `npm run dev`（http://127.0.0.1:5173）。実画面確認：起動中に `frontend` で `npm run screenshot`
- Claudeの確認用サーバー（ユーザーの8000/5173とぶつけない）：API を 8001（`--reload`）、`frontend` で `npm run dev:verify`（5174）、確認は `npm run screenshot:verify`。環境変数を付けたコマンドは許可確認が出るため使わない。
- 動画→観測テキスト（課金あり）：`.venv\Scripts\python scripts\run_observation.py`
- Claude API 接続確認（少額課金あり）：`.venv\Scripts\python scripts\check_claude_api.py`。キーはリポジトリ直下の `.env` に `ANTHROPIC_API_KEY=...` と書く（Git管理外。ひな形ファイルは置かない）。
- Claude抽出の実行と評価（課金あり）：`.venv\Scripts\python scripts\run_extraction.py`。保存済み結果の評価のみ：`--latest`。正解データは `eval/`（アプリの入力経路から読まない）。
- デモ用データの整合性検証は、アプリ完成の証拠ではない。
- 実装後は必要な実テストコマンドを追加し、実行結果・未実装・未検証を区別して報告する。
- 小さい縦スライス単位で実装・テストし、独立部分のみ並列化する。エージェント同士の同一ファイル同時編集は避ける。
