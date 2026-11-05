# Work2Robot — Claude Code用スターター（日本語版）

**これは初期設定と仕様のひな形であり、完成アプリではありません。** まず `CLAUDE.md` と `docs/START_PROMPT.md` を確認してください。

## 使い方

1. リポジトリのルートで `claude` を起動し、`docs/START_PROMPT.md` の指示を入力します。
2. 最初はワークフローを実行して**条件によって異なる分岐が実際に通る**最小実装を完成させます。動画解析などはその後に接続します。
3. 各機能ごとにテスト結果を残し、3分の通し実演で確認します。`.env` と秘密情報はコミットしません。

## ファイルの責務（同じ内容を複数箇所に書かない）

| ファイル | ここだけに書く内容 |
|---|---|
| `CLAUDE.md` | 常時適用する短い開発指示・資料への道案内 |
| `docs/PRODUCT.md` | 解決する課題、利用者、提供価値、対象外 |
| `docs/DEMO.md` | 180秒の映像・操作・日本語ナレーション |
| `docs/DEMO_INPUT.md` | 導入用実写素材と入力用模擬作業動画の区別、要件、制作方式、制作タスク |
| `docs/WORKFLOW_SPEC.md` | ワークフローの構造、判定、実行ログ、根拠の表現 |
| `docs/ARCHITECTURE.md` | モジュール分担と実装順序 |
| `docs/ACCEPTANCE.md` | テスト・受入基準、実測結果の記録方法 |
| `docs/EVENT_RULES.md` | 提出条件と禁止事項の原文由来の要約 |
| `docs/START_PROMPT.md` | Claude Codeに最初の1回だけ渡す依頼 |
| `app/data/*.json` | **手書きの架空データ**（テスト用ワークフロー・模擬荷物マスタ・模擬スキル一覧）。直下はシナリオv1、`app/data/scenario_v2/` はシナリオv2。Claudeの生成物・動画の解析結果ではない |
| `materials/` | 提出動画・README向けの説明素材（システムの流れの図など）。正本は `docs/` |
| `.claude/rules/` | 特定コードを編集するときだけ有効な技術ルール |
| `.claude/skills/demo-audit/SKILL.md` | `/demo-audit` で手動実行する検証手順 |

## 資料・出典

Claude Code公式ガイド（説明書の作り方）：
- https://code.claude.com/docs/en/best-practices
- https://code.claude.com/docs/en/memory
- https://code.claude.com/docs/en/skills
- https://code.claude.com/docs/en/agent-teams

イベント参加者ガイド：https://cerebralvalley.ai/e/built-with-claude-japan2026/details
