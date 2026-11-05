# ワークフロー・データ契約（正本）

**このファイルだけを、分岐付きワークフローのデータ仕様の正本とする。** 手書きのテスト用ワークフロー例は、Claudeが実際に生成した成果物と区別する。

## ワークフローの単位

1つの荷物について、入力状態を見て処理先を決める**有向グラフ**を使う。MVPは循環なし。荷物群の積む順番・積付パターン・カゴ車の状態は、業務全体（Level 1、本書「ワークフローの3階層」）で扱う。目標は静的フローチャートではなく、**検証・実行・説明可能なワークフロー**。

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

## マスタ（Step 0：全工程の前提）

解析・判断・能力照合・仮想実行の前に、現場のデータをマスタとして登録する（`app/backend/workflow/masters.py`）。初期値は `app/data/masters/`（模擬）。画面から登録した値は `local_media/masters/` に保存して初期値より優先し、リポジトリのデータは書き換えない。

### 荷物マスタ（`item_master.json`）

| 項目 | 内容 | 未登録（`null`）のとき |
|---|---|---|
| `object_id` | 荷物ID（動画のタグ・観測テキストと同じID） | 不可（エラー） |
| `name`・`object_type`・`handling_note` | 名称・種類・取扱メモ（表示用） | 空でよい |
| `material_class` | `rigid`／`soft` | 「不明」として判断（注意） |
| `weight_kg` | 重量 | 重い順・可搬重量の照合ができない（注意） |
| `dims_m` | `[幅, 奥行, 高さ]`（m） | 置き場所を決められず人へ引継ぎ（注意） |
| `fragile_content` | 破損注意（真偽） | 「不明」 |

`batches`（便）は1台のカゴ車に積む荷物の組み合わせと到着順（`batch_id`・`label`・`object_ids`）。実行器へは、荷物マスタの各行を次の「入力の契約」の形（入手元 `mock_metadata`、未登録は `unknown`）に変換して渡す。

### 環境マスタ（`environment_master.json`）

- `carts`・`active_cart_id`：積付先のカゴ車（`inner_width_m`・`inner_depth_m`・`height_limit_m`・`max_load_kg`・`open_side`）。業務定義の `cart` に入り、実行器（内寸・高さ・積載上限）・能力要件（リーチ）が使う。Claudeの抽出への入力（カゴ車の仕様）もここから作る。開口面は前面（`front`）のみ対応。
- `staging`：仮置き場（棚・パレット）。`rows_z_m`（列の位置）・`first_x_m`（先頭の位置）・`pitch_m`（間隔）。荷物は到着順に列へ交互に並び、業務定義の `staging` として実行器が荷物を取る位置になる。
- `work_area`：作業エリアの通路幅・床面。参照情報（現時点の照合・仮想実行では使わない）。

座標はカゴ車の床の中心が原点、x＝幅方向、z＝奥行方向（前面の開口側が＋）、単位m。

### 検証（`validate_masters`、決定的）

- **エラー（保存しない）：** 荷物IDの空・重複、材質が `rigid`／`soft`／未登録以外、重量が負、寸法が3つの正の数でない、便が荷物マスタにないIDや重複を含む、カゴ車の寸法・上限が正でない、開口面が前面以外、使用するカゴ車が未登録、仮置き場の列・間隔が不正、仮置き場がカゴ車と重なる。
- **注意（保存できる）：** 材質・重量・寸法の未登録、カゴ車の内寸に収まらない荷物、高さの上限を超える荷物、1個で最大積載を超える荷物、便の合計重量が最大積載を超える。
- 登録すると、能力要件・仕様照合・業務実行はすべて新しいマスタで計算し直す（画面は実行済みの結果を破棄する）。

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

- 主な属性：`material_class`（`rigid`, `soft`）、`object_type`、`base_area_m2`、`fragile_content`（真偽）、`weight_kg`、`dims_m`（`[幅, 奥行, 高さ]`）。
- 属性がない、`value`が`null`、または`source`が`unknown`の場合は「不明」として扱う。
- 動画だけで重量・壊れ物の中身・正確な座標を認識できる前提にしない。

## 根拠（source_evidence）

`source_evidence`は`{"type": ..., "note": ..., "ref": ...}`の配列。`ref`（任意）は根拠にした入力セグメントのID（説明テキスト`E1`…、観測テキスト`O1`…）で、画面で該当する文と時刻を表示するのに使う。`decision`では必須（上記）、他のノードでは任意。`type`の候補値：`video_observation`, `spoken_instruction`, `provided_text`, `mock_metadata`, `ai_hypothesis`, `human_confirmed`, `unknown`。`provided_text`は「提供された説明テキスト」で、音声認識結果（`spoken_instruction`）と区別する。動画・発話の時刻は**実際の素材から得られた場合だけ**付け、提供テキストの時刻は提供者が付けたものとして扱う。

例：積載重量の上限150kgは、**模擬のカゴ車の表示（`mock_metadata`）で与えた値**であり、物流業界の普遍的な基準ではない。説明に数値がない基準（例：重心のずれの許容範囲）は推測で決めず、確認事項にする。

## 実行とログ

1. ワークフローJSONをスキーマ・参照整合性・分岐の完全性で検証する。
2. 現在の荷物状態を入力し、`start_node_id`から決定的な実行器で遷移する。
3. 実際に通過したノード・辺・分岐時の属性値、発行した`skill`イベント、handoff理由を**実行トレース**に記録する。
4. 3Dシミュレータはそのトレース中のスキルイベントに従ってアニメーションする。グラフは通過した辺を強調表示する。
5. 未検証の物理能力（軟質物の把持、カゴ車開口部の干渉、押込み力、安全性など）は**別の検証待ち項目**とする。

**状態区分：** `workflow_checked`（ワークフローの論理検証）、`needs_information`（情報不足）、`needs_physical_poc`（実機の能力検証待ち）、`requires_human`（人への引継ぎ）。単一の「自動化可能率」に集約しない。状態区分の付与は事前チェックの責務で、実行器は付与しない。

## 抽出結果（Claudeの出力）

抽出モジュール（`app/backend/ai/extraction.py`）の結果は次の形。ワークフローは検証器を通ったものだけを返す。

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
      "description": "荷物を把持し、カゴ車内に置く（模擬）",
      "parameters": {
        "zone": {"values": ["bottom", "top", "auto"], "required": true},
        "press_mode": {"values": ["normal", "no_press"], "required": true},
        "stack_above": {"values": ["allowed", "forbidden"], "required": false}
      },
      "implementation": "MockRobotAdapter",
      "physical_verification": "unverified",
      "poc_checks": ["軟質物・袋物の把持", "カゴ車の柵・開口部との干渉"]
    }
  ]
}
```

- `parameters`の各項目は許可値（`values`）と必須かどうか（`required`）を持つ。定義にない項目はエラー。
- `zone`：`bottom`＝床面、`top`＝その時点で最も高い面、`auto`＝業務全体の規則で段を決める。`stack_above`：`forbidden`＝上積み厳禁（その荷物の上には何も置かない。省略時は`allowed`）。
- `physical_verification`は`unverified`（未検証）のみをMVPで使う。`poc_checks`は事前チェックで実機PoC項目として表示する。

## 実行トレース

実行器が荷物1個を処理した記録。**時刻など実行ごとに変わる値は含めない**（同じ入力なら同じトレース）。下の例はv1のテスト用ワークフロー（`app/data/workflow_fixture.json`）のもの。

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
| Level 1：業務全体 | カゴ車1台分の積付開始から終了まで。積む順番、積付パターン、偏荷重、支持、繰り返し、カゴ車の状態、終了前の確認 | 業務定義（`job`）＋業務実行器（`app/backend/workflow/job.py`、`job_rules.py`） |
| Level 2：個別作業 | 荷物1個の属性確認・判断・分岐・配置／引継ぎ | 本書の分岐付きワークフロー＋実行器 |
| Level 3：基本動作 | 認識・Pick・Move・Place・引継ぎ | 業務実行トレースの基本動作イベント |

### 業務定義（Level 1）

業務定義には2つの方式がある。業務実行器（`app/backend/workflow/job.py`）は、`rules`があれば規則の方式、なければ区画順の方式で実行する。

| 方式 | 用途 | 実装 |
|---|---|---|
| **規則の方式（`rules`）** | デモのシナリオv2（荷物17個） | `app/backend/workflow/job_rules.py`、テスト用 `app/data/scenario_v2/job_fixture.json` |
| 区画順の方式（`order_rule`） | v1（荷物4〜5個）の初期検証 | `app/backend/workflow/job.py`、テスト用 `app/data/job_fixture.json` |

```json
{
  "job_id": "cage_cart_loading_v2",
  "cart": {"width_m": 1.0, "depth_m": 0.75, "height_m": 1.2, "max_load_kg": 150},
  "rules": [
    {"type": "order_by_weight_desc", "source_evidence": [{"type": "spoken_instruction", "note": "...", "ref": "E2"}]},
    {"type": "brick_pattern", "source_evidence": [...]}
  ],
  "unsupported_rules": [{"text": "荷崩れがないか確認する（物理的な安定性）", "source_evidence": [...]}],
  "balance_tolerance_m": null,
  "end_condition": "all_items_processed"
}
```

- `end_condition`：MVPは`all_items_processed`（全ての荷物を配置または引継ぎしたら終了）。
- `cart.max_load_kg`・`cart.height_m`・`balance_tolerance_m`は、説明に数値があるときだけ設定する。重心のずれの許容範囲が`null`なら、重心のずれは数値を記録するだけで合否は判定しない。
- 荷物の寸法は属性`dims_m`、重量は`weight_kg`（荷物マスタ）を使う。カゴ車（`cart`）と仮置き場（`staging`）は環境マスタの値を実行時に入れる（業務定義に `staging` がなければ既定の2列）。

### 業務の規則（`rules`の`type`）

実行器が対応する規則は次の一覧だけ。**一覧にない規則は適用したことにせず**、`unsupported_rules`として業務実行トレースの`rule_results`に「未対応」と返す。

| `type` | 規則 | 実行器での反映 |
|---|---|---|
| `order_by_weight_desc` | 重い荷物から先に、下の段から積む | 重量の降順で処理し、低い段から埋める。重量不明の荷物は後ろ。「重い」の閾値は使わない |
| `no_stack_last` | 上積み禁止の荷物は最後に積む | `stack_above: forbidden`または`zone: top`の荷物を最後に処理する |
| `brick_pattern` | 同じ寸法の箱は、同じ段で縦横を組み合わせて置く（レンガ積み） | 同じ寸法の箱が2個以上続き、その寸法で1段を「奥に横向き・手前に縦向き」でちょうど埋められ、その高さに平らな面がそろうときだけ適用。合わなければ理由を`notes`に残し、通常の置き方にする |
| `balance_load` | 偏荷重を避ける | 同じ高さ・同じ列（奥から何番目か）で同じ程度に寄せられる候補の中から、重心の水平方向のずれが最小の位置（反対側）を選ぶ。途中の偏りは許し、最終形の偏りは `balance_check` で確認する |
| `full_support` | 下段で支えられる位置に置く | 底面全体が、同じ高さにある硬い箱の上面で覆われる位置だけに置く（規則がなければ底面の50%以上） |
| `load_limit` | 積載重量の上限 | 合計が`cart.max_load_kg`を超える荷物は積まずに引き継ぐ |
| `height_limit` | 積付高さの上限 | 上面が`cart.height_m`を超える位置には置かない |
| `overhang_check` | はみ出しの確認 | 終了前に、全ての荷物がカゴ車の内側に収まっているか確認する |
| `balance_check` | 偏りの確認 | 終了前に、重心の水平方向のずれを記録する |

- **上積み厳禁は規則の有無に関係なく守る。** `stack_above: forbidden`の荷物の上には何も置かない。
- **物理的な限界：** 箱の耐圧（潰れるか）、摩擦、走行中の揺れは計算しない。支持は幾何学的な確認のみ、重心は荷物の中心に重量があると仮定した概算。

### 業務実行器の動作（規則の方式）

1. 全ての荷物にLevel 2のワークフローを実行し、置き方（`zone`・`press_mode`・`stack_above`）または引継ぎを決める。
2. 規則で積む順番を決める（重い順、上積み禁止の荷物は最後、引継ぎは最後）。
3. 順番に荷物を取り出し、カゴ車の状態から置き場所を探す（作業状態による分岐）。
   - 候補位置は、カゴ車の壁と既に置いた箱の辺に沿った位置（向きは元の向きと90度回転の2通り）。はみ出し・他の箱との重なり・高さの上限・支持の条件を満たすものだけ。
   - 選び方：①低い段から（`zone: top`は最も高い面）、②**奥から**（箱の手前の端が奥にある位置。前面が開口のため手前を先に埋めない）、③左右のどちらかが壁か箱に接する位置（列の途中に置いて空きを分断しない）、④壁や箱に2面以上接する位置（前面の開口は壁に数えない）、⑤重心のずれが小さい位置（`balance_load`）、⑥左から、回転しない向き。
   - 置き場所は1個ずつその場で決め、先読みはしない。そのため荷物の組み合わせによっては、後の荷物の置き場所が残らず人へ引き継ぐことがある（例：`alt_batch` の S2）。
   - 置き場所がない、または積載重量の上限を超える場合は、その荷物を人へ引き継ぐ（理由を記録）。
4. 配置したらカゴ車の状態（個数・重量・重心のずれ）を更新し、残りの荷物があれば3へ戻る（繰り返し）。
5. 終了前の確認（はみ出し・積載重量・高さ・重心のずれ）を記録して終了する。

区画順の方式（v1）は、2で区画の順（`order_rule.zones`）に並べ、3で下段は床面に左から右・奥から手前へ、上段は上に何も載っていない荷物のうち支える面積が最大で底面の50%以上を支えるものの上に置く。

座標はカゴ車の床の中心を原点とする（x：左右、y：高さ、z：奥行。奥の壁が`-depth/2`）。仮置き場は`x < 0`側のカゴ車外で、ロボットの通り道（カゴ車の手前）を挟んで2列（z=0.25 と 1.45）に到着順に交互に並ぶ。

### 業務実行トレース

```json
{
  "job_trace_version": 2,
  "job_id": "cage_cart_loading_v2", "workflow_id": "...", "workflow_version": 1,
  "cart": {"width_m": 1.0, "depth_m": 0.75, "height_m": 1.2, "max_load_kg": 150},
  "arrival": ["L1", "H1", "..."],
  "order": ["H1", "H2", "..."],
  "items": [{"object_id": "M3", "seq": 6, "item_trace": {"...": "Level 2の実行トレース"},
             "outcome": "placed", "dims": [0.5, 0.25, 0.2], "weight_kg": 8.0,
             "zone": "auto", "press_mode": "normal", "stack_above": "allowed", "provisional": false,
             "placement": {"position": [x, y, z], "dims": [w, d, h], "rotated": true,
                           "support": "H1+H4", "supporters": ["H1", "H4"], "base_height": 0.3},
             "applied_rules": ["brick_pattern", "full_support"], "handoff_reason": null,
             "cart_after": {"count": 7, "load_kg": 86.0, "com_offset_m": 0.01}}],
  "level1_steps": [{"seq": 0, "node_id": "l1_take_next", "object_id": "H1", "edge": "next"}],
  "primitives": [{"seq": 0, "object_id": "H1", "kind": "pick", "from": [x, y, z]}],
  "rule_results": [{"type": "brick_pattern", "label": "...", "status": "applied", "detail": "...",
                    "notes": [], "source_evidence": [...]}],
  "checks": {"overhang": {"ok": true}, "load": {"total_kg": 131.0, "max_kg": 150, "ok": true},
             "height": {"max_m": 0.95, "limit_m": 1.2, "ok": true},
             "balance": {"com_offset_m": 0.003, "tolerance_m": null, "ok": null}},
  "end": {"reason": "all_items_processed", "placed": 17, "handed_off": 0, "load_kg": 131.0}
}
```

- `level1_steps`：Level 1の流れ図で通ったノードと辺。`primitives`：Level 3の基本動作（`recognize`／`check`（能力不足で持ち上げない）／`pick`／`move`／`place`／`handoff`）。3Dビューはこれだけを再生する。構成を指定した実行では `robot`・`items[].capability` も持つ（「ハードウェア構成と能力要件」）。
- `rule_results`：規則ごとの`status`は`applied`（適用した）、`not_applicable`（条件が合わず適用しなかった。理由は`notes`）、`unsupported`（実行器が対応していない）。
- 区画順の方式（v1）のトレースは`job_trace_version: 1`で、`rule_results`・`checks`を持たない。
- 業務実行トレースも決定的で、時刻など実行ごとに変わる値を含めない。

## 作業動画のタスク構造（Step 1）

動画の時間軸に沿った「人が今何をしているか」の理解。業務ワークフロー（Level 1・Level 2）とは別物で、繰り返し・分岐は持たない。実装は `app/backend/ai/task_structure.py`、作成は `app/scripts/run_task_structure.py`（課金あり）、保存先は `local_media/task_structures/`。

- 入力：動画の観測（`O…`、時刻・荷物タグ付き）と、音声の文字起こし（`S…`、開始・終了の秒）。どちらも既存の記録をそのまま使う。
- **Claudeは時刻を書かない。** 大タスク・小タスクの範囲は観測ID（`start_obs`〜`end_obs`）で選ぶ。時刻はコードが計算する（開始＝最初の観測の時刻、終了＝範囲の次の観測の時刻、最後の観測を含めば動画の終わり）。範囲の重なり・親の外の小タスク・存在しないID・対応のない発話は検査で弾き、内容を伝えて作り直させる。
- 大タスク：`id`（T1…）、`name`、`purpose`、`obs_ids`、`start`・`end`（秒）、`subtasks`、`rules`。
- 小タスク：`id`（T1.1…）、`name`（「箱H1を床の奥左に置く」程度の粒度）、`objects`、`obs_ids`、`start`・`end`。
- 判断条件・作業ルール（`rules`）：`text`、根拠の種類 `kind`（`spoken`＝作業者の説明／`observed`＝映像から読み取り／`ai_hypothesis`＝Claudeの推定）、映像での実演 `demonstrated`（`observed`／`not_observed`／`unclear`。説明があっても映像で確認できなければ実演済みにしない）、`definition_status`・`confirmation_note`（数値の基準がなければ要確認）、`rule_type`（業務の規則の一覧の type か `other`。Step 2 の規則との対応）、`speech_ids`、`obs_ids`。
- 発話との対応（`speech_links`）：全ての発話を大タスクに対応づける。発話と作業の時刻はずれるため、`relation`（`during`／`before`／`after`／`general`）で区別する。対応しない発話は `task_id` を空にして理由を残す。
- 未確認事項（`unresolved`）：映像から判断できないこと、説明と映像の食い違い。関係する観測ID・発話IDを付ける。
- 画面は、再生位置（秒）と各区間を照合して表示を切り替えるだけ（再生中にClaudeは呼ばない）。Step 2 では、荷物IDで小タスクを引き、人がその荷物を扱った場面へ移動できる。

## ハードウェア構成と能力要件

業務（ワークフロー・業務定義）と、ロボットの能力（ハードウェア構成）は**別のデータ**として持ち、同じ業務を別の構成で評価できるようにする。実装は `app/backend/workflow/hardware.py`（決定的）と `app/backend/ai/hardware_selection.py`（Claude）。

### 仮想メーカーのカタログ（`app/data/hardware_catalog.json`、2026-11-05〜）

**メーカー → 機種 → メーカーが認めるオプション → 構成済みロボット** の階層。実在のメーカー・機種ではなく、名称・仕様値はデモ用の独自の仮定値（PoC用データ）。「仕様上対応」はこのカタログの定義値に対して条件を満たすという意味で、実機での成立を保証しない。

| メーカー（仮想） | 機種 | 固定構造（変更不可） | 選べるオプション | 実行器での扱い |
|---|---|---|---|---|
| A社（固定式） | AW-40F | 固定台座＋高可搬アーム（40kg・1.8m） | 手先：吸着・挟み込み・複合／センサー4種／周辺設備：コンベヤ（移動できないため荷物の供給に必要） | 対応 |
| B社（車輪移動式） | RM-20 | 車輪台車＋中可搬アーム（20kg・1.3m） | 手先：吸着・複合（挟み込みは手首が非対応）／センサー4種 | 対応 |
| 〃 | RM-10 | 車輪台車＋軽可搬アーム（10kg・1.0m） | 手先：吸着のみ／カメラ・深度カメラ | 対応 |
| C社（ヒューマノイド） | HM-1 | 二足＋双腕（両腕で10kg・0.8m） | 手先：人型の手のみ／センサー3種 | **概念プレビュー**（二足・双腕の運搬は表現しない） |

- 構成は `{"product_id", "end_effector", "sensors", "peripherals"}`。`resolve_product_config` が、固定構造の変更・機種が認めないオプション・カタログにない機種をエラーにし、機種の固定部品とオプションから能力プロファイルを作る（以下の部品一覧・照合をそのまま使う）。
- 機種ごとに `verification`（機種固有の実機検証項目）と `execution`（`supported`／`concept`）を持つ。`concept` の機種で実行すると、置けた荷物にも「概念プレビュー」の未確認の印が付き、導入前評価の実機PoC項目の先頭に入る。

### 部品一覧（`app/data/hardware_catalog.json` の `components`、模擬）

- 種類：`base`（移動方式）、`arm`、`end_effector`（手先）、`sensor`、`peripheral`（周辺設備）。**実在の機種ではない一般名と、デモ用の仮の仕様値**。
- 数値：アームの `payload_kg`・`reach_m`、手先の `mass_kg`・`max_object_m`、移動方式の `shoulder_height_m`・`mounts`（載せられるアーム）。
- 能力（`capabilities`）：部品ごとに `supported`（仕様上対応）／`unsupported`（非対応）／`unverified`（未確認：実機PoCで確かめる）。能力の種類：`grasp_box`、`grasp_soft_bag`、`rotate_90`、`place_no_press`、`mobility`、`sense_id`、`sense_dims`、`sense_weight`、`sense_material`。

### 構成（config）と能力プロファイル

```json
{"config_id": "claude_selected", "label": "...", "base": "wheeled_base", "arm": "arm_medium",
 "end_effector": "vacuum_gripper", "sensors": ["rgb_camera", "depth_camera", "wrist_force_sensor"], "peripherals": []}
```

`resolve_config` が部品一覧と突き合わせ、能力プロファイルにする：実効可搬（アームの可搬 − 手先の重さ）、リーチ、肩の高さ、つかめる大きさ、能力ごとの最良の状態（複数の部品が持つ能力は supported ＞ unverified ＞ unsupported）。一覧にない部品や、載せられない組み合わせはエラー。

### 能力要件（`compute_requirements`、決定的）

業務定義・ワークフロー・荷物マスタ（カゴ車は環境マスタ）から計算する：可搬重量（最も重い荷物）、つかむ大きさ（最も長い辺）、リーチ（カゴ車の奥行・積付高さの上限。前面の開口から置く）、および業務で必要な能力（硬い箱・柔らかいバッグの把持、レンガ積みなら90度回転、押し込まない置き方、移動、識別・寸法・重さ・材質の計測）。Claudeは数値を作らない。

### 仕様照合（`check_config`、決定的）

要件ごとに `ok`／`ng`／`unknown`（未確認）と比較の内容を返す。リーチは、カゴ車の前に立った肩から、奥・上段の位置までの距離で比べる（台車は左右に動ける）。**仕様上の照合**であり、把持力・関節の可動域・動的な安定性・干渉・安全性は検証しない。

### Claudeによる仮選定（`select_hardware`）

入力：抽出済みの業務（規則・ワークフロー・確認事項）、計算済みの能力要件、仮想メーカーのカタログ。出力：必要な能力と根拠（`capability_requirements`）、構成（**機種IDは出力形式でカタログの機種に制限し、オプションがその機種で認められるかはコードで検査**。固定構造は選ばせない）、選定理由、選ばなかった候補と理由、実機PoCで確かめる点、改善の仮説（`order`／`pattern`／`hardware`／`peripheral`／`operation`）。照合でNGがあれば内容を伝えて1回選び直させ、それでもNGなら隠さずに返す。結果は `local_media/hardware_selections/` に保存する。

### 業務実行への反映

`run_job(job, workflow, objects, catalog, robot=プロファイル)`：
- 持ち上げる前に荷物ごとに判定（`item_check`）。重さが実効可搬を超える、手先がその材質に非対応、つかめない大きさ → **持ち上げずに**人へ引継ぎ（基本動作は `check` → `handoff`。理由を記録）。把持が未確認 → 実行するが `capability.unverified` と `place` の `unverified` に印を付ける。
- 置き場所の候補から、リーチの外の位置を除く。
- トレースに `robot`（構成の要約）、各荷物の `capability`、`pick`・`place` の `end_effector` を残す。`robot` を渡さなければ能力の制約なし（論理だけの実行。`robot: null`）。

### 導入前評価への反映

`assess(..., hardware={check, label, unverified_points, improvement_hypotheses})`：照合のNG・未確認を区分に振り分け、**改善余地**（`improvements`：実行結果から作る候補 `source: computed` と、Claudeの仮説 `source: claude`）を返す。改善余地はすべて仮説として表示し、効果を確認済みとして扱わない。

## バッチ処理に関する重要な前提

MVPは**1便分の荷物（15〜20個）を事前に把握できるまとまり**として扱う。「重い順に積む」「柔らかいバッグは最後」は、まとまりが分かっていて仮置き場があるときに適用できる。1個ずつ突然到着する完全オンライン運用では、後回しにするためのバッファや人間への引継ぎが必要であり、未来の荷物を知っている前提にしてはいけない。

## 実機連携について

VLAはモデル・メーカーごとに利用可能なAPIが異なる。`skill`ノードは概念上の動作（MVPでは`pick_place`）を表し、MVPの実体は`MockRobotAdapter`。**特定のVLAに直接接続できると断言しない**。
