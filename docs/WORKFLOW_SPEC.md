# ワークフロー・データ契約（正本）

**このファイルだけを、分岐付きワークフローのデータ仕様の正本とする。** 手書きのテスト用ワークフロー例は、Claudeが実際に生成した成果物と区別する。

## ワークフローの単位

1つの荷物について、入力状態を見て処理先を決める**有向グラフ**を使う。MVPは循環なし。荷物群の供給・バッファ順はグラフ外で扱う。目標は静的フローチャートではなく、**検証・実行・説明可能なワークフロー**。

| ノード型 | 目的 | 主なフィールド |
|---|---|---|
| `start` | 開始 | `next` |
| `observe` | 必要な物体属性を観測 | `required_fields`, `next` |
| `decision` | 属性に基づく真偽・不明の分岐 | `field`, `operator`, `value`, `definition_status`, `on_true`, `on_false`, `on_unknown` |
| `skill` | 模擬ロボットスキルを依頼 | `skill_name`, `parameters`, `next` |
| `handoff` | 人間へ確認・引継ぎ | `reason`, `next` |
| `end` | 処理結果を確定 | `result` |

- `workflow_id`, `version`, `start_node_id`, `nodes` をトップレベルの必須キーにする。
- すべてのノードの`id`は一意。参照先は存在すること。循環はMVPではエラー。
- すべての`decision`には**未知値の分岐（`on_unknown`）**を必須にする。
- 分岐式にはホワイトリスト演算子のみ利用する。MVPは `eq`, `ge`, `lt`, `is_known`。**Claudeの生成コードを直接実行しない**。
- 判定は**真・偽・不明の3値論理**。欠損・信頼性未確認の値を安易に真/偽へ補完しない。

## 条件の定義状態と確認事項

- `decision`の`definition_status`は`defined`（基準が根拠付きで明確）または`needs_confirmation`（基準が示されていない・曖昧）。
- `needs_confirmation`の分岐は**確定した分岐として実行しない**。実行器は判定結果を常に「不明」とし、`on_unknown`へ進め、トレースに理由を記録する。`value`（閾値）を推測で埋めない。

## 暫定動作（確認事項を残して作業を完了する）

要確認の条件や不明な属性に当たっても、原則として人への引継ぎで止めず、**暫定動作で積付を完了**し、確認事項を残す。`on_unknown`の行き先には次のどちらかの暫定動作を置く。

| 状況 | 暫定動作の決め方 | 根拠の`type` |
|---|---|---|
| 動画・説明に作業例があるが、判断基準の確認が必要 | 動画で人が行ったのと**同じ結果**になる動作 | `video_observation`・`provided_text`など |
| 動画・説明に作業例がない（全くの未知） | Claudeが付与した**仮説**に基づく動作 | `ai_hypothesis` |

- 暫定動作は`skill`ノードに`"provisional": true`、理由`provisional_note`、根拠`source_evidence`（必須）を持たせる。
- 暫定動作を通っても、要確認の条件を「真／偽」に確定したことにはしない。トレースの`unconfirmed_conditions`・`unknown_fields`・`provisional_actions`が確認事項になる。
- `handoff`（人への引継ぎ）は、安全上ロボットに任せない場合などのためにノード型として残す。
- 判断基準の値は、根拠（例：`provided_text`）がある場合だけ`defined`にできる。Claudeが根拠なく閾値を生成しない。
- 抽出結果はワークフローとは別に**確認事項リスト**（確認すべき内容・理由・関連ノード・根拠）を持つ。不足情報や実機PoCで確かめるべき項目もここに含める。
- 確認事項への回答を入力するUIはMVPの対象外。回答が得られた場合は新しい`version`のワークフローとして扱う。

## ノードの詳細

- `nodes`はノードの配列。各ノードは`id`と`type`を持つ。`start_node_id`は`start`型のノードを指す。
- `observe`：`required_fields`（属性名の配列）。欠けている属性は「不明」として記録し、補完しない。
- `decision`：
  - `operator`は`eq`（一致）、`ge`（以上）、`lt`（未満）、`is_known`（値が既知か）。`is_known`は`value`を持たず、結果は真か偽（不明にならない）。
  - `ge`・`lt`は数値同士でのみ判定し、型が合わなければ「不明」とする。
  - `definition_status`が`defined`なら`source_evidence`を必須とする。`ge`・`lt`の閾値は`provided_text`・`spoken_instruction`・`human_confirmed`のいずれかを根拠に持つこと。
  - `needs_confirmation`なら`value`は`null`とし、確認すべき内容を`confirmation_note`に書く。
  - `on_true`・`on_false`・`on_unknown`は全て必須。説明に行き先がない場合は`handoff`へ向ける。
- `skill`：`skill_name`はスキル一覧に存在し、`parameters`はその定義に合うこと。暫定動作の場合は`provisional`・`provisional_note`・`source_evidence`を持つ（「暫定動作」参照）。
- `handoff`：`reason`（人へ引き継ぐ理由）。`next`は`end`へ向ける。
- `end`：`result`は`placed`（積付完了）または`handed_off`（人へ引継ぎ）。
- 任意で`label`（画面表示名）と`source_evidence`を持てる。

## 入力の契約（荷物属性）

実行器への入力は荷物1個分。各属性は値と**入手元**を持つ。

```json
{
  "object_id": "A",
  "attributes": {
    "material_class": {"value": "rigid", "source": "mock_metadata"},
    "base_area_m2": {"value": 0.20, "source": "mock_metadata"}
  }
}
```

- 主な属性：`material_class`（`rigid`, `soft`）、`object_type`、`base_area_m2`、`fragile_content`（真偽）、`weight_kg`。
- 属性がない、`value`が`null`、または`source`が`unknown`の場合は「不明」として扱う。
- 動画だけで重量・壊れ物の中身・正確な座標を認識できる前提にしない。

## 根拠（source_evidence）

`source_evidence`は`{"type": ..., "note": ..., "ref": ...}`の配列。`ref`（任意）は根拠にした入力セグメントのID（説明テキスト`E1`…、観測テキスト`O1`…）で、画面で該当する文と時刻を表示するのに使う。`decision`では必須（上記）、他のノードでは任意。`type`の候補値：`video_observation`, `spoken_instruction`, `provided_text`, `mock_metadata`, `ai_hypothesis`, `human_confirmed`, `unknown`。`provided_text`は「提供された説明テキスト」で、音声認識結果（`spoken_instruction`）と区別する。動画・発話の時刻は**実際の素材から得られた場合だけ**付け、提供テキストの時刻は提供者が付けたものとして扱う。

例：「大きい箱」の基準を`base_area_m2 >= 0.15`とする場合、この閾値は**デモ用作業説明で提供したルールの例**（根拠は`provided_text`）であり、物流業界の普遍的な基準ではない。

## 実行とログ

1. ワークフローJSONをスキーマ・参照整合性・分岐の完全性で検証する。
2. 現在の荷物状態を入力し、`start_node_id`から決定的な実行器で遷移する。
3. 実際に通過したノード・辺・分岐時の属性値、発行した`skill`イベント、handoff理由を**実行トレース**に記録する。
4. 3Dシミュレータはそのトレース中のスキルイベントに従ってアニメーションする。グラフは通過した辺を強調表示する。
5. 未検証の物理能力（軟質物の把持、カゴ車開口部の干渉、押込み力、安全性など）は**別の検証待ち項目**とする。

**状態区分：** `workflow_checked`（ワークフローの論理検証）、`needs_information`（情報不足）、`needs_physical_poc`（実機の能力検証待ち）、`requires_human`（人への引継ぎ）。単一の「自動化可能率」に集約しない。状態区分の付与は事前チェックの責務で、実行器は付与しない。

## 抽出結果（Claudeの出力）

抽出モジュール（`backend/ai/extraction.py`）の結果は次の形。ワークフローは検証器を通ったものだけを返す。

- `workflow`：上記の形式のワークフロー（`workflow_id`は`claude_extracted`）。
- `confirmation_items`：確認事項`{id, kind, topic, detail, related_node_ids, source_evidence}`。`kind`は`undefined_condition`（基準が未定義）、`missing_information`（不足情報）、`provisional_action`（暫定動作）、`physical_poc`（実機PoCで確認）。
- `summary`：要点（日本語3文以内）。`validation`：検証結果。`meta`：モデル・試行回数・トークン使用量・フォールバックの有無。

Claudeへの構造化出力スキーマはAPIの制約（null・複数型を許す項目は16個まで）のため、ノードを全項目を持つ平坦な形で受け取り、未使用の項目（空文字列・空配列）を除いてから上記の形に変換する。

## スキル一覧

模擬ロボットが受け付ける動作の定義。**実機の能力を表すものではない。**

```json
{
  "catalog_id": "mock_robot_v1",
  "skills": [
    {
      "name": "pick_place",
      "description": "荷物を把持し、カゴ車内の指定区画へ置く（模擬）",
      "parameters": {
        "zone": {"values": ["bottom", "top"], "required": true},
        "press_mode": {"values": ["normal", "no_press"], "required": true}
      },
      "implementation": "MockRobotAdapter",
      "physical_verification": "unverified",
      "poc_checks": ["軟質物・袋物の把持", "カゴ車の柵・開口部との干渉"]
    }
  ]
}
```

- `parameters`の各項目は許可値（`values`）と必須かどうか（`required`）を持つ。定義にない項目はエラー。
- `physical_verification`は`unverified`（未検証）のみをMVPで使う。`poc_checks`は事前チェックで実機PoC項目として表示する。

## 実行トレース

実行器が荷物1個を処理した記録。**時刻など実行ごとに変わる値は含めない**（同じ入力なら同じトレース）。

```json
{
  "trace_version": 1,
  "workflow_id": "cage_loading_fixture",
  "workflow_version": 1,
  "object_id": "B",
  "steps": [
    {"index": 0, "node_id": "start", "node_type": "start"},
    {"index": 1, "node_id": "observe_attrs", "node_type": "observe",
     "observed": {"base_area_m2": {"value": 0.075, "source": "mock_metadata"}},
     "missing_fields": []},
    {"index": 2, "node_id": "is_heavy", "node_type": "decision",
     "field": "weight_kg", "operator": "ge", "value": null,
     "input": {"value": 12.0, "source": "mock_metadata"},
     "definition_status": "needs_confirmation",
     "result": "unknown", "edge": "on_unknown",
     "reason": "判断基準が未定義：「重い」の重量基準が説明に示されていない"}
  ],
  "edges": [{"from": "start", "to": "observe_attrs", "label": "next"}],
  "skill_events": [{"seq": 0, "node_id": "place_heavy_provisional", "skill": "pick_place",
                    "parameters": {"zone": "bottom", "press_mode": "normal"}, "provisional": true}],
  "handoffs": [],
  "unknown_fields": [],
  "unconfirmed_conditions": ["is_heavy"],
  "provisional_actions": [{"node_id": "place_heavy_provisional", "note": "...", "evidence": [{"type": "video_observation"}]}],
  "result": "placed"
}
```

- `steps`：通過した順のノード。`decision`は使った属性値（`input`）、判定結果（`true`/`false`/`unknown`）、進んだ辺（`edge`）、不明の理由（`reason`）、`defined`の場合は根拠（`rule_evidence`）を持つ。
- `edges`：通過した辺（`label`は`next`/`on_true`/`on_false`/`on_unknown`）。グラフのハイライトに使う。
- `skill_events`：`{seq, node_id, skill, parameters, provisional}`。3Dビューはこれだけを再生する。
- `unknown_fields`：判定で「不明」になった属性。`unconfirmed_conditions`：通過した`needs_confirmation`の判断ノード。`provisional_actions`：通過した暫定動作`{node_id, note, evidence}`。
- `result`：到達した`end`の`result`。

## ワークフローの3階層

| 階層 | 内容 | 実体 |
|---|---|---|
| Level 1：業務全体 | カゴ車1台分の積付開始から終了まで。積む順番、繰り返し、カゴ車の状態、終了条件 | 業務定義（`job`）＋業務実行器（`backend/workflow/job.py`） |
| Level 2：個別作業 | 荷物1個の属性確認・判断・分岐・配置／引継ぎ | 本書の分岐付きワークフロー＋実行器 |
| Level 3：基本動作 | 認識・Pick・Move・Place・引継ぎ | 業務実行トレースの基本動作イベント |

### 業務定義（Level 1）

```json
{
  "job_id": "cage_cart_loading",
  "label": "カゴ車1台の積付",
  "order_rule": {"type": "zone_priority", "zones": ["bottom", "top"], "note": "...", "source_evidence": [...]},
  "end_condition": "all_items_processed",
  "cart": {"width_m": 0.8, "depth_m": 0.6, "height_m": 1.6}
}
```

- `order_rule`：荷物ごとのLevel 2の結果（置く区画）で積む順番を決める。`zones`の順に処理し、同じ区画内は到着順。人へ引き継ぐ荷物は最後。
- `end_condition`：MVPは`all_items_processed`（全ての荷物を配置または引継ぎしたら終了）。
- 荷物の寸法は属性`dims_m`（`[幅, 奥行, 高さ]`、模擬荷物マスタ）を使う。

### 業務実行器の動作

1. 全ての荷物にLevel 2のワークフローを実行し、置く区画（または引継ぎ）を決める。
2. `order_rule`で積む順番を決める。
3. 順番に荷物を取り出し、カゴ車の状態から置き場所を探す（作業状態による分岐）。
   - 下段：床面に、到着順に左から右・奥から手前へ並べる（必要なら90度回転）。
   - 上段：既に置いた荷物のうち、上に何も載っていないものの上に載せる。支えられる面積が荷物の底面の50%以上あるものの中で、支える面積が最大のもの。
   - 置き場所がなければ、その荷物は人へ引き継ぐ（理由：カゴ車に置き場所がない）。
4. 配置したらカゴ車の状態を更新し、残りの荷物があれば3へ戻る（繰り返し）。
5. 終了条件を満たしたら終了する。

座標はカゴ車の床の中心を原点とする（x：左右、y：高さ、z：奥行。奥の壁が`-depth/2`）。仮置き台は`x < 0`側のカゴ車外。

### 業務実行トレース

```json
{
  "job_trace_version": 1,
  "job_id": "cage_cart_loading", "workflow_id": "...", "workflow_version": 1,
  "order": ["A", "B", "C", "D"],
  "items": [{"object_id": "A", "seq": 0, "item_trace": {"...": "Level 2の実行トレース"},
             "outcome": "placed", "zone": "bottom", "press_mode": "normal", "provisional": false,
             "placement": {"position": [x, y, z], "dims": [w, d, h], "rotated": false, "support": null},
             "handoff_reason": null}],
  "level1_steps": [{"seq": 0, "node_id": "l1_take_next", "object_id": "A", "edge": "next"}],
  "primitives": [{"seq": 0, "object_id": "A", "kind": "pick", "from": [x, y, z]}],
  "end": {"reason": "all_items_processed", "placed": 4, "handed_off": 0}
}
```

- `level1_steps`：Level 1の流れ図で通ったノードと辺。`primitives`：Level 3の基本動作（`recognize`／`pick`／`move`／`place`／`handoff`）。3Dビューはこれだけを再生する。
- 業務実行トレースも決定的で、時刻など実行ごとに変わる値を含めない。

## バッチ処理に関する重要な前提

今回のMVPは**3〜4個の荷物を事前に把握できる小さなバッチ**として扱う。「ソフトバッグを後で積む」は、このバッチまたは待避領域があるときのみ適用可能。1個ずつ突然到着する完全オンライン運用では、後回しにするためのバッファや人間への引継ぎが必要であり、未来の荷物を知っている前提にしてはいけない。

## 実機連携について

VLAはモデル・メーカーごとに利用可能なAPIが異なる。`skill`ノードは概念上の動作（MVPでは`pick_place`）を表し、MVPの実体は`MockRobotAdapter`。**特定のVLAに直接接続できると断言しない**。
