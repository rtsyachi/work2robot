// 実画面の動作確認（5ステップのUI）：起動中のアプリ（API + Vite）をヘッドレスEdgeで操作し、スクリーンショットを撮る。
//   npm run screenshot   （出力先：<repo>/local_media/ui_check/）
//   --url= で接続先を変えられる（既定 http://127.0.0.1:5173/。確認用は npm run screenshot:verify）。
//   Claude APIは呼ばない（保存済み結果のみ使う）。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'
import { goStep } from './nav.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const outDir = path.resolve(here, '..', '..', '..', 'local_media', 'ui_check')
const urlArg = process.argv.find((a) => a.startsWith('--url='))
const url = urlArg ? urlArg.slice(6) : 'http://127.0.0.1:5173/'
fs.mkdirSync(outDir, { recursive: true })

async function waitForServer() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(new URL('api/health', url))
      if (r.ok) return
    } catch {}
    await new Promise((r) => setTimeout(r, 1000))
  }
  throw new Error(`アプリに接続できません: ${url}`)
}

const checks = []
const check = (name, ok, detail = '') => checks.push({ name, ok, detail })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const shot = (page, name) => page.screenshot({ path: path.join(outDir, name) })

await waitForServer()
const browser = await chromium.launch({
  channel: 'msedge',
  args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'],
})
const errors = []
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } })
  page.on('pageerror', (e) => errors.push(e.message))
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
  await page.goto(url)
  await page.waitForSelector('[data-testid=cur-step]')
  const visited = () => page.$$eval('[data-testid=level2] .wf-node.is-visited', (els) => els.map((e) => e.dataset.testid).sort().join(','))
  const stepText = (n) => page.textContent(`[data-testid=step-${n}]`)

  // ① データ確認（最初に開く。商品マスタを表示）
  await page.waitForSelector('[data-testid=page-0] [data-testid=mview-products]')
  check('ロゴの表示', await page.$eval('[data-testid=logo]', (img) => img.complete && img.naturalWidth > 0))
  check('工程メニューは初期からピン止め（左に常に表示）', !!(await page.$('[data-testid=stepnav].is-pinned.is-open')))
  const pinBelow = await page.evaluate(() => {
    const pin = document.querySelector('[data-testid=nav-pin]').getBoundingClientRect()
    const steps = [...document.querySelectorAll('[data-testid=stepnav] .step')].map((e) => e.getBoundingClientRect().bottom)
    return pin.top >= Math.max(...steps)
  })
  check('ピンのボタンはメニューの下', pinBelow)
  check('ロゴと三本線はピン止めメニューの中（上部のバーには出さない）', (await page.$eval('[data-testid=stepnav]', (e) => e.getBoundingClientRect().width)) === 240
    && !!(await page.$('[data-testid=stepnav] [data-testid=logo]'))
    && !!(await page.$('[data-testid=stepnav] [data-testid=nav-menu-btn]')) && !(await page.$('.topbar [data-testid=logo]')) && !(await page.$('[data-testid=menu-btn]')))
  check('メニューは番号と名称だけ（状態を出さない）', !(await page.$('[data-testid=stepnav] .step-status')))
  await shot(page, '28_menu_pinned.png')
  // 工程を選んでも閉じない
  await page.click('[data-testid=step-1]')
  await sleep(300)
  const pinnedStay = !!(await page.$('[data-testid=stepnav].is-pinned.is-open')) && !!(await page.$('[data-testid=page-1]'))
  await page.click('[data-testid=step-0]')
  check('ピン止め中は工程を選んでもメニューが閉じない', pinnedStay)
  // ピン止めを外すと引き出しになり、再読み込みしても外した状態を覚える。三本線で開く
  await page.click('[data-testid=nav-pin]')
  await page.waitForSelector('[data-testid=stepnav]:not(.is-open)', { state: 'attached' })
  check('ピン止めを外すと引き出しに戻る', !(await page.$('[data-testid=stepnav].is-pinned')) && !(await page.$('[data-testid=drawer-back]')))
  await page.reload()
  await page.waitForSelector('[data-testid=page-0] [data-testid=mview-products]')
  check('外した設定は再読み込み後も残る（ロゴと三本線は上部のバーに出る）', !(await page.$('[data-testid=stepnav].is-open'))
    && !!(await page.$('.topbar [data-testid=logo]')) && !!(await page.$('[data-testid=menu-btn]')))
  await page.click('[data-testid=menu-btn]')
  await page.waitForSelector('[data-testid=stepnav].is-open')
  check('三本線で工程メニュー（Step 1〜6）が左に開く', (await page.$$('[data-testid=stepnav] .step')).length === 6)
  await sleep(300)
  check('開いたメニューも固定したときと同じ幅で、ロゴがある', (await page.$eval('[data-testid=stepnav]', (e) => e.getBoundingClientRect().width)) === 240
    && !!(await page.$('[data-testid=stepnav] [data-testid=logo]')))
  await sleep(400)
  await shot(page, '28_menu_open.png')
  await page.click('[data-testid=drawer-back]')
  await page.waitForSelector('[data-testid=stepnav]:not(.is-open)', { state: 'attached' })
  // データ確認：全体画面は置かず、開くと商品マスタ。左は3区分とデータ名だけ
  check('①：画面名は「データ確認」、番号は1始まり', (await page.textContent('[data-testid=cur-step]')).includes('1データ確認'))
  const navTitles = await page.$$eval('[data-testid=stepnav] .step', (els) => els.map((e) => e.querySelector('.step-no').textContent + e.querySelector('.step-title').textContent))
  check('工程メニューは 1〜6 の番号と統一した名称', navTitles.join(',') === '1データ確認,2シナリオ作成,3ワークフロー確認,4ロボット構成,5シミュレーション実行,6シミュレーション評価', navTitles.join(','))
  check('画面ごとの大きな説明文と「次へ」は出さない（移動は左のメニュー）', !(await page.$('[data-testid=next-step]')) && !(await page.$('.step-purpose')))
  check('画面名の横に、その画面で行うことを一言', (await page.textContent('[data-testid=cur-sub]')).includes('確認・修正'))
  const nodes = await page.$$eval('[data-testid=master-tree] .ms-node', (els) => els.map((e) => e.dataset.testid))
  check('①：開くと商品マスタを表示し、全体画面はない', !!(await page.$('[data-testid=mnode-products].is-on')) && !(await page.$('[data-testid=master-overview]'))
    && !nodes.includes('mnode-overview'))
  check('①：左は区分（マスタ・トランザクション・その他）とデータ名だけ（件数・確認事項・説明文を出さない）',
    ['mnode-products', 'mnode-carts', 'mnode-batches', 'mnode-results', 'mnode-map'].every((t) => nodes.includes(t))
    && !['mnode-lines', 'mnode-staging', 'mnode-work_area'].some((t) => nodes.includes(t))
    && !nodes.includes('mnode-issues') && !(await page.$('[data-testid=master-tree] .ms-dot, [data-testid=master-tree] .ms-count, [data-testid=master-tree] .ms-tree-note')), nodes.join(','))
  check('①：ツリーの区分見出し（マスタ・トランザクション・その他）', (await page.$$eval('[data-testid=master-tree] .ms-cat', (els) => els.map((e) => e.textContent).join(','))) === 'マスタ,トランザクション,その他')
  const head = await page.textContent('[data-testid=mview-products] [data-testid=data-head]')
  check('①：データ画面の上に、件数・確認事項（タイトルの横）と目的。使う工程・補足は出さない', /13件/.test(head) && /確認事項なし|注意|エラー/.test(head)
    && !head.includes('使う工程') && !(await page.$('[data-testid=mview-products] .ms-more')), head.slice(0, 120))
  check('①：上部に初期値・検証の表示と「初期値に戻す」を出さない', !(await page.$('[data-testid=master-source]')) && !(await page.$('[data-testid=master-validation]')) && !(await page.$('[data-testid=master-reset]')))
  check('①：ファイルの取り込みを置かない', !(await page.$('[data-testid=page-0] input[type=file], [data-testid=page-0] textarea, [data-testid=csv-open]')))
  await shot(page, '29_step0_overview.png')
  // 出荷実績（参照のみ・模擬）
  await page.click('[data-testid=mnode-results]')
  await page.waitForSelector('[data-testid=table-results]')
  const resHead = await page.textContent('[data-testid=table-results] thead')
  check('①：出荷実績は出荷予定と同じ形（出荷日・出荷ID・商品ID・数量）で、数量に「個」を付けない', ['出荷日', '出荷ID', '商品ID', '数量'].every((k) => resHead.includes(k))
    && !(await page.textContent('[data-testid=table-results] tbody')).includes('個'), resHead)
  check('①：出荷実績は参照のみ（模擬）で、追加・編集できない', (await page.$$('[data-testid=table-results] tbody tr')).length >= 2
    && !(await page.$('[data-testid=add-results]')) && (await page.textContent('[data-testid=mview-results]')).includes('参照のみ'))
  // 倉庫内マップ：仮置き場・商品棚・カゴ車・作業エリア・通路、動画で確認／推測（模擬）の区別
  await page.click('[data-testid=mnode-map]')
  await page.waitForSelector('[data-testid=warehouse-map]')
  const mapIds = await page.$$eval('[data-testid=warehouse-map] [data-testid^=map-]', (els) => els.map((e) => e.dataset.testid))
  check('①：倉庫内マップ（仮置き場・商品棚・カゴ車・作業エリア・通路）', ['map-pallet_1', 'map-shelf_1', 'map-cart', 'map-work_area', 'map-walkway'].every((t) => mapIds.includes(t)), mapIds.join(','))
  const mapText = await page.textContent('[data-testid=mview-map]')
  check('①：動画で確認した要素と推測（模擬）を区別し、寸法は模擬と明示', mapText.includes('動画で確認') && mapText.includes('推測') && mapText.includes('模擬'))
  check('①：作業エリアの左がパレットゾーン、右がカゴ車ゾーン（仮置き場・作業エリアの設定は出さない）', await page.evaluate(() => {
    const box = (id) => document.querySelector(`[data-testid=map-${id}] rect`)?.getBoundingClientRect()
    const zp = box('zone_pallet'), zc = box('zone_cart'), p1 = box('pallet_1'), c = box('cart')
    return !!(zp && zc && p1 && c) && zp.right <= zc.left && p1.left >= zp.left && p1.right <= zp.right && c.left >= zc.left && c.right <= zc.right
  }) && !(await page.$('[data-testid=open-staging], [data-testid=map-settings]')))
  await shot(page, '29_step0_map.png')
  // 商品マスタ：一覧（13件）→ 行を選ぶと右に1件の詳細（荷姿・含まれる出荷）。動画の列は出さない
  await page.click('[data-testid=mnode-products]')
  await page.waitForSelector('[data-testid=table-products]')
  check('①：マスタの一覧も1列目に行番号', (await page.$eval('[data-testid=table-products] thead th', (x) => x.textContent)) === 'No.'
    && (await page.$eval('[data-testid=table-products] tbody tr td', (x) => x.textContent)) === '1')
  check('①：商品マスタの一覧（13件）、動画の列は出さない', (await page.$$('[data-testid=table-products] tbody tr')).length === 13
    && !(await page.textContent('[data-testid=table-products] thead')).includes('動画'))
  check('①：行を選ぶ前は修正・削除を押せない', await page.$eval('[data-testid=row-edit]', (b) => b.disabled) && await page.$eval('[data-testid=row-delete]', (b) => b.disabled))
  await page.click('[data-testid=row-products-H1]')
  check('①：行を選ぶだけでは入力欄にならない（表示のみ）', !(await page.$('[data-testid=master-detail] input')))
  check('①：一覧の上に 追加・修正・削除・保存', !!(await page.$('.ms-tools [data-testid=add-products] + [data-testid=row-edit] + [data-testid=row-delete] + [data-testid=master-save]')))
  check('①：商品の詳細に含まれる出荷（ケース数）', (await page.textContent('[data-testid=master-detail]')).includes('含まれる出荷') && (await page.textContent('[data-testid=master-detail]')).includes('ケース'))
  await page.fill('[data-testid=master-search]', 'U')
  check('①：一覧の絞り込み', (await page.$$('[data-testid=table-products] tbody tr')).length < 13)
  await page.fill('[data-testid=master-search]', '')
  await shot(page, '29_step0_items.png')
  // 商品マスタに荷姿・ケース入数・ボール入数・重量・寸法。重量を負にするとエラーで保存できない
  const prodHead = await page.textContent('[data-testid=table-products] thead')
  check('①：商品マスタに荷姿・材質・ケース入数・ボール入数・重量・寸法（荷姿マスタは商品マスタに統合）', ['荷姿', '材質', 'ケース入数', 'ボール入数', '重量', '寸法'].every((k) => prodHead.includes(k))
    && !(await page.$('[data-testid=mnode-packagings]')), prodHead)
  check('①：食品卸の商品名（架空）', (await page.textContent('[data-testid=table-products] tbody')).includes('ミネラルウォーター'))
  await page.click('[data-testid=row-edit]')
  await page.waitForSelector('[data-testid=master-detail] [data-testid=field-weight_kg]')
  await page.fill('[data-testid=field-weight_kg]', '-1')
  await page.waitForFunction(() => document.querySelector('[data-testid=master-msg]')?.textContent?.includes('保存できません'))
  check('①：エラーのあるマスタは保存できない', await page.$eval('[data-testid=master-save]', (b) => b.disabled))
  check('①：上部に「以降のステップに反映」はなし', !(await page.textContent('[data-testid=page-0]')).includes('以降のステップに反映'))
  check('①：エラーの行に印', !!(await page.$('[data-testid=row-products-H1].is-err')))
  await page.fill('[data-testid=field-weight_kg]', '18')
  await shot(page, '29_step0_product_edit.png')
  // 出荷予定（1行＝出荷の商品1つ：出荷日・出荷ID・出荷先・商品・数量）。行から荷物IDを振る
  await page.click('[data-testid=mnode-batches]')
  await page.waitForSelector('[data-testid=table-batches]')
  const shipHead = await page.textContent('[data-testid=table-batches] thead')
  check('①：出荷予定（出荷日・出荷ID・出荷先・商品ID・数量）。「行」の列はなく、1列目に行番号', ['出荷日', '出荷ID', '出荷先', '商品ID', '数量'].every((k) => shipHead.includes(k))
    && !(await page.$$eval('[data-testid=table-batches] thead th', (ths) => ths.map((x) => x.textContent))).includes('行')
    && (await page.$$eval('[data-testid=table-batches] tbody tr', (rs) => rs.map((r) => r.querySelector('td')?.textContent))).slice(0, 3).join(',') === '1,2,3'
    && (await page.$$('[data-testid=table-batches] tbody tr')).length === 22, shipHead)
  await page.click('[data-testid=row-batches-video_batch-03]')
  check('①：行から荷物IDを振る（数量6の商品M → M1〜M6）', (await page.textContent('[data-testid=master-detail]')).includes('M1 M2 M3 M4 M5 M6'))
  await shot(page, '29_step0_lines.png')
  // カゴ車マスタ：表（一覧と1件の詳細）だけで、配置図は出さない。最大積載を変えると確認事項に注意
  await page.click('[data-testid=mnode-carts]')
  await page.waitForSelector('[data-testid=table-carts]')
  check('①：マスタは表だけ（カゴ車マスタに配置図を出さない）', !(await page.$('[data-testid=mview-carts] [data-testid=layout-view]')))
  await page.click('[data-testid=row-carts-cart_std]')
  await page.click('[data-testid=row-edit]')
  await page.fill('[data-testid=field-max_load_kg]', '100')
  await page.click('[data-testid=mnode-batches]')
  await page.waitForFunction(() => document.querySelector('[data-testid=mview-batches] [data-testid=data-head]')?.textContent?.includes('注意'))
  await page.click('[data-testid=mnode-carts]')
  await shot(page, '29_step0_env.png')
  await page.click('[data-testid=mnode-batches]')
  check('①：最大積載を超える便の行に注意の印', (await page.textContent('[data-testid=mview-batches] [data-testid=data-head]')).includes('注意')
    && !!(await page.$('[data-testid=mview-batches] tr.is-warn')))
  await page.click('[data-testid=master-save]')
  await page.waitForFunction(() => document.querySelector('[data-testid=master-msg]')?.textContent?.includes('保存しました'))
  await goStep(page, '[data-testid=step-4]')
  await page.click('[data-testid=run-job]')
  await page.waitForSelector('[data-testid=ex-handed]', { state: 'attached' })
  check('①→⑤：登録したカゴ車の最大積載で実行が変わる', (await page.textContent('[data-testid=ex-handed]')).includes('積載重量の上限（100'), (await page.textContent('[data-testid=ex-handed]')).slice(0, 120))
  await goStep(page, '[data-testid=step-0]')
  // 自動確認で登録した値を片付ける（画面の「初期値に戻す」はなくしたので API で戻す）
  await page.evaluate(() => fetch('/api/v2/masters', { method: 'DELETE' }))
  await page.reload()
  await page.waitForSelector('[data-testid=step-0]', { state: 'attached' })
  await goStep(page, '[data-testid=step-1]')

  // ② シナリオ作成：左に シナリオ → マスタ → トランザクション → 作業動画 → ワークフロー生成、右に動画のプレビュー。課金を避けるため生成はしない
  check('②：画面名は「シナリオ作成」', (await page.textContent('[data-testid=cur-step]')).includes('シナリオ作成'))
  check('上部に生成元などのバッジを出さない（保存済みのClaude結果があるとき）', !(await page.$('[data-testid=source-badge]')))
  await page.waitForSelector('[data-testid=sc-workflow]')
  const scOrder = await page.$$eval('[data-testid=analysis-input] .sc-item h3', (els) => els.map((e) => e.textContent))
  check('②：左に シナリオ登録 → マスタ登録 → トランザクション登録 → 作業動画登録 の順', scOrder.join('→') === 'シナリオ登録→マスタ登録→トランザクション登録→作業動画登録', scOrder.join('→'))
  check('②：「作業動画（プレビュー）」は動画に重ねず、動画の左上（外）に出す', !(await page.$('[data-testid=sc-preview] .pane-title'))
    && (await page.textContent('[data-testid=preview-title]')).includes('作業動画（プレビュー）'))
  check('②：シナリオIDを表示', (await page.textContent('[data-testid=scenario-id]')).includes('sc_cage_cart_loading'))
  const left = await page.$eval('[data-testid=analysis-input]', (e) => e.getBoundingClientRect())
  const right = await page.$eval('[data-testid=sc-preview]', (e) => e.getBoundingClientRect())
  check('②：右に作業動画のプレビュー（大きく表示）', right.left >= left.right && right.width > 800 && !!(await page.$('[data-testid=sc-preview] [data-testid=work-video]')), String(right.width))
  const masterRows = await page.$$eval('[data-testid=sc-master] .sc-data-name', (els) => els.map((e) => e.textContent))
  const txRows = await page.$$eval('[data-testid=sc-transaction] .sc-data-name', (els) => els.map((e) => e.textContent))
  check('②：マスタ・トランザクションはデータの定義から並ぶ（件数・紐づけの状態つき）', masterRows.length >= 2 && txRows.length >= 2
    && (await page.textContent('[data-testid=sc-master]')).includes('件') && (await page.textContent('[data-testid=sc-master]')).includes('紐づけ済み'), `${masterRows.join(',')} / ${txRows.join(',')}`)
  check('②：出荷予定はトランザクション登録で選ぶ（上部の出荷予定・シナリオ名は出さない）', (await page.$eval('[data-testid=scenario-batch]', (s) => s.value)) === 'video_batch'
    && !(await page.$('[data-testid=batch]')) && !(await page.$('[data-testid=scenario]')))
  check('②：作業動画のファイル名・再生時間・登録状態', (await page.textContent('[data-testid=sc-video]')).includes('.mp4') && (await page.textContent('[data-testid=sc-video]')).includes('登録済み'))
  const pos = await page.evaluate(() => {
    const r = (s) => document.querySelector(s).getBoundingClientRect()
    const card = r('[data-testid=sc-video]'), gen = r('[data-testid=start-analysis]')
    return { video: card.bottom, left: card.left, genLeft: gen.left, gen: gen.top, go: r('[data-testid=go-workflow]').top }
  })
  check('②：左の作業動画登録の下に「ワークフローを生成」、その下に「ワークフロー確認」とワークフローID', pos.gen >= pos.video && pos.go > pos.gen && pos.genLeft < 700
    && (await page.textContent('[data-testid=workflow-id]')).includes('extraction_'), JSON.stringify(pos))
  await page.click('[data-testid=add-master]')
  check('②：マスタ・トランザクションに「＋ 追加」（今回は追加の処理がないことを明示）', !!(await page.$('[data-testid=add-transaction]'))
    && (await page.textContent('[data-testid=add-master-note]')).includes('今後対応'))
  await page.click('[data-testid=add-master]')
  check('②：タスク・判断条件の詳細は出さない', !(await page.$('[data-testid=cur-major]')) && !(await page.$('[data-testid=major-timeline]')))
  await shot(page, '30_step1_input.png')
  await page.click('[data-testid=start-analysis]')
  check('②：生成ボタンを押しても、まず補足と費用を出す（すぐには課金しない）', !!(await page.$('[data-testid=analysis-note]'))
    && (await page.textContent('[data-testid=start-analysis]')).includes('$1.5'))
  await page.click('[data-testid=gen-cancel]')
  await page.click('[data-testid=scenario-rename]')
  check('②：シナリオ名は「名前を変更」で入力欄が出る', !!(await page.$('[data-testid=scenario-name]')))
  await page.click('[data-testid=sc-scenario] >> text=キャンセル')

  // ③ ワークフロー確認
  await goStep(page, '[data-testid=step-2]')
  // 最初は業務全体（Level 1 の工程）だけを大きく表示し、Level 2 は並べない
  await page.waitForSelector('[data-testid=stage-overview] [data-testid=stage-graph] .stage-row')
  const stageCount = (await page.$$('[data-testid=stage-graph] .stage-row')).length
  const checkBtns = await page.$$('[data-testid^=stage-check-]')
  check('③：工程ごとに「確認」ボタン、下の説明文はなし', checkBtns.length === stageCount && !(await page.$('.wf-foot')))
  check('③：工程に「表示のみ」「補完」などのラベルを出さない', !(await page.$('[data-testid=stage-graph] .tflow-pill')))
  await page.click('[data-testid^=stage-card-] >> nth=0')
  await sleep(200)
  check('③：工程の行をクリックしても移動しない（「確認」ボタンで移動する）', !(await page.$('[data-testid=stage-detail]')))
  const wfSum = await page.textContent('[data-testid=wf-summary]')
  check('③：業務の要約は工程の流れの上に1文で（折りたたみ可）、下に確認事項の件数。修正の依頼欄は出さない',
    wfSum.includes('カゴ車に積む') && wfSum.length < 80 && !!(await page.$('[data-testid=stage-overview] > [data-testid=wf-summary] details'))
    && (await page.textContent('[data-testid=wf-summary-counts]')).includes('確認事項')
    && !(await page.$('[data-testid=stage-overview] ~ [data-testid=wf-detail] [data-testid=teach-instruction]')), wfSum)
  check('③：上部に共通の帯（シナリオ・ワークフロー）と版の表示', !!(await page.$('[data-testid=wf-ctx].ctx-bar [data-testid=ctx-workflow]')) && !!(await page.$('[data-testid=wf-ctx] [data-testid=wf-version]')))
  check('③：最初は業務全体の工程の流れだけを表示（タスクは出さない）', stageCount >= 2 && !(await page.$('[data-testid=stage-detail]')), String(stageCount))
  const ys = await page.$$eval('[data-testid=stage-graph] .stage-row', (els) => els.map((e) => e.getBoundingClientRect().top))
  check('③：工程は上から下へ縦に並ぶ', ys.every((y, i) => i === 0 || y > ys[i - 1]), ys.join(','))
  const cards = await page.textContent('[data-testid=stage-overview]')
  check('③：工程ごとにタスク・条件の数を表示', cards.includes('タスク') && cards.includes('条件'))
  await shot(page, '31_step2_overview.png')
  // 積付以外の工程（表示のみ）を開く：タスクの中に判断条件（優先度順）
  const other = await page.$$eval('[data-testid^=stage-card-]', (els) => els.map((e) => [e.getAttribute('data-testid'), e.textContent]))
  const LOOP_RE = /1個ずつ|荷物の積付/
  const otherCard = other.find(([, t]) => !LOOP_RE.test(t))
  if (otherCard) {
    await page.click(`[data-testid=${otherCard[0].replace('stage-card-', 'stage-check-')}]`)
    await page.waitForSelector('[data-testid=stage-detail] [data-testid=pnode-list] .tflow-card')
    const side = await page.$eval('[data-testid=stage-bar]', (e) => e.getBoundingClientRect())
    const main = await page.$eval('[data-testid=stage-detail]', (e) => e.getBoundingClientRect())
    check('③：工程を選ぶと、工程の一覧は左に小さく（現在位置つき）、中央にその工程のタスク', side.right <= main.left + 1 && side.width < main.width
      && !!(await page.$('[data-testid=stage-bar] .is-selected')) && !!(await page.$('[data-testid=back-overview]')))
    const otherLabels = await page.$$eval('[data-testid=pnode-list] .tflow-card strong', (els) => els.map((e) => e.textContent))
    check('③：Claudeの抽出した工程の詳細もタスク名だけ（判断「〜か」や基準を含まない）', otherLabels.length > 0
      && !otherLabels.some((l) => /か$|重い|柔らか|の場合/.test(l)), otherLabels.join('／'))
    // 各タスクを順に開いても画面が落ちない
    for (const el of await page.$$('[data-testid=pnode-list] .tflow-card')) { await el.click(); await sleep(120) }
    check('③：工程の詳細のタスクを順に開いても表示が保たれる', !!(await page.$('[data-testid=pnode-detail]')) && !!(await page.$('[data-testid=stage-detail]')))
    // 判断条件のあるタスク：条件ごとに修正・削除・↑↓が出て、入力欄は「修正」を押したときだけ開く（保存はしない）
    const withConds = await page.$('[data-testid=pnode-list] [data-testid=criterion]')
    if (withConds) {
      await withConds.click()
      await sleep(150)
      const visible = async (sel) => (await withConds.$eval(sel, (b) => getComputedStyle(b).visibility !== 'hidden' && b.offsetParent !== null).catch(() => false))
      const opsShown = await visible('[data-testid=cond-edit]') && await visible('[data-testid=cond-del]') && await visible('[data-testid=cond-up]')
      const noFormYet = !(await page.$('[data-testid=cond-editor]')) && !(await page.$('[data-testid=teach-instruction]'))
      await shot(page, '32_step2_cond_ops.png')
      await (await withConds.$('[data-testid=cond-edit]')).click()
      await page.waitForSelector('[data-testid=cond-editor]')
      check('③：判断条件の「修正」「削除」「↑↓」は常に表示。「修正」を押したときだけ右の修正欄（入力欄・Claudeへの修正依頼）が出る',
        opsShown && noFormYet && !!(await page.$('[data-testid=wf-detail] [data-testid=cond-side] [data-testid=cond-name]'))
        && !!(await page.$('[data-testid=wf-detail] [data-testid=teach-instruction]')) && !!(await page.$('[data-testid=cond-add]')))
      await shot(page, '32_step2_cond_edit.png')
      await (await withConds.$('[data-testid=cond-del]')).click()
      check('③：「削除」は確認してから実行する（押しただけでは消さない）', !!(await withConds.$('[data-testid=cond-del-ok]')) && !(await page.$('[data-testid=cond-editor]')))
      await page.click('text=やめる')
    } else {
      check('③：表示のみの工程に判断条件がある', false)
    }
    await page.click('[data-testid=pnode-list] .tflow-card')
    await page.waitForSelector('[data-testid=pnode-detail]')
    check('③：タスクを選ぶと、右に根拠・確認事項（修正欄は「修正」を押すまで出さない）',
      (await page.textContent('[data-testid=pnode-detail]')).includes('根拠') && !(await page.$('[data-testid=teach-instruction]'))
      && !(await page.$('[data-testid=wf-detail] [data-testid=criterion]')))
    // 確認事項の消込：消込 → 対応済み（打ち消し線・日時）→ 戻す（自動確認の状態は残さない）
    const resolveBtn = await page.$('[data-testid=pnode-detail] [data-testid=confirm-resolve]')
    if (resolveBtn) {
      await resolveBtn.click()
      await page.waitForSelector('[data-testid=pnode-detail] [data-testid=confirm-undo]')
      check('③：タスクの確認事項を消込できる（対応済みの表示・件数が減る）', (await page.textContent('[data-testid=pnode-detail] .is-resolved')).includes('対応済み')
        && /対応済み|未対応 0/.test(await page.textContent('[data-testid=pnode-detail] [data-testid=confirm-left]')))
      await shot(page, '32_step2_confirm_resolved.png')
      await page.click('[data-testid=pnode-detail] [data-testid=confirm-undo]')
      await page.waitForSelector('[data-testid=pnode-detail] [data-testid=confirm-resolve]')
      check('③：消込を戻せる', !(await page.$('[data-testid=pnode-detail] .is-resolved')))
    } else {
      check('③：タスクの確認事項に消込ボタン', false)
    }
    await shot(page, '32_step2_stage.png')
    await page.click('[data-testid=back-overview]')
  } else {
    check('③：積付以外の工程（表示のみ）がある', false, other.map(([, t]) => t.slice(0, 20)).join(' / '))
  }
  // 積付の工程を開く：タスクの流れ＋荷物1個の判断
  const loopCard = (await page.$$eval('[data-testid^=stage-card-]', (els) => els.map((e) => [e.getAttribute('data-testid'), e.textContent])))
    .find(([, t]) => LOOP_RE.test(t))
  await page.click(`[data-testid=${loopCard[0].replace('stage-card-', 'stage-check-')}]`)
  await page.waitForSelector('[data-testid=level1-graph] .tflow-card')
  const loopLabels = await page.$$eval('[data-testid=level1-graph] .tflow-card strong', (els) => els.map((e) => e.textContent))
  check('③：積付の工程はタスク（何をするか）だけで並ぶ（判断「〜か」をノードにしない）',
    loopLabels.includes('次に積む荷物を決定する') && loopLabels.includes('荷物の配置位置・置き方を決定する') && !loopLabels.some((l) => /か$/.test(l)), loopLabels.join('／'))
  check('③：繰り返しと分岐はタスクの流れとして表示（↻ 戻る・置き場所がないとき → 人へ引き継ぐ）', !!(await page.$('[data-testid=loop-t_update]'))
    && (await page.textContent('[data-testid=level1-graph]')).includes('置き場所がない'))
  const decideNames = await page.$$eval('[data-testid=conds-t_decide] .cond-name', (els) => els.map((e) => e.textContent))
  check('③：判断条件は優先度順（必須の制約 → 優先する条件）で、1つの規則を複数のタスクで使う（上積みの可否は荷物の決定と配置）',
    decideNames.indexOf('積載重量') < decideNames.indexOf('重さの偏り') && decideNames.indexOf('上積みの可否') >= 0
    && (await page.textContent('[data-testid=conds-t_select]')).includes('上積みの可否') && (await page.textContent('[data-testid=conds-t_select]')).includes('重量'),
    decideNames.join('→'))
  await shot(page, '31_step2_loop.png')
  await page.click('[data-testid=tcard-t_decide]')
  await page.waitForSelector('[data-testid=chip-H1]')
  check('③：荷物1個の判断へ進む', !!(await page.$('[data-testid=level2]')))
  await page.click('[data-testid=chip-H1]')
  await sleep(300)
  check('③：Step 2 の作業（小タスク）への引き継ぎ', (await page.textContent('[data-testid=step1-link]')).includes('H1'))
  const pathH = await visited()
  await page.click('[data-testid=chip-S1]')
  await sleep(300)
  const pathS = await visited()
  check('③：荷物を切り替えると経路が切り替わる', pathH && pathS && pathH !== pathS, `${pathH} / ${pathS}`)
  await page.click('[data-testid=level2] .wf-decision')
  await page.waitForSelector('[data-testid=node-detail]')
  const seekBtn = await page.$('[data-testid=node-detail] [data-testid^=seek-]')
  check('③：判断ノードの根拠（発話・観測）', !!seekBtn, (await page.textContent('[data-testid=node-detail]')).slice(0, 200))
  if (seekBtn) {
    await seekBtn.click()
    await sleep(800)
    const t2 = await page.$eval('.wf-side [data-testid=work-video]', (v) => v.currentTime)
    check('③：根拠から元動画の場面へ移動', t2 > 0, String(t2))
  }
  check('③：S1 を選ぶと繰り返しの流れでも結果のタスク（配置）が光る', !!(await page.$('[data-testid=tcard-t_place].is-active')))
  check('③：判断ノードを選んでも修正欄は出さず、「この判断を修正」を押すと出る', !(await page.$('[data-testid=decision-editor]')) && !!(await page.$('[data-testid=node-edit]')))
  await page.click('[data-testid=node-edit]')
  await page.waitForSelector('[data-testid=wf-detail] [data-testid=decision-editor]')
  check('③：判断ノードの詳細に確認・直接編集', !!(await page.$('[data-testid=wf-detail] [data-testid=decision-editor]'))
    && (await page.textContent('[data-testid=wf-version]')).includes('版'))
  await shot(page, '31_step2_level2.png')
  // 判断条件「寸法の揃い（レンガ積み）」の「修正」：規則の使い方を直す入力欄が開く（並び順は固定なので↑↓は出さない）
  const brick = await page.$$eval('[data-testid=conds-t_decide] .cond-name', (els) => els.findIndex((e) => e.textContent === '寸法の揃い'))
  await page.click(`[data-testid=conds-t_decide] [data-testid=cond-${brick}] [data-testid=cond-edit]`)
  await page.waitForSelector('[data-testid=cond-editor]')
  check('③：積付の判断条件は「修正」で規則（レンガ積み）の使い方を直し、「削除」で規則から外せる（↑↓は出さない）',
    !!(await page.$('[data-testid=cond-editor] [data-testid=cond-how]')) && (await page.textContent('[data-testid=cond-editor]')).includes('レンガ積み')
    && !!(await page.$(`[data-testid=conds-t_decide] [data-testid=cond-${brick}] [data-testid=cond-del]`))
    && !(await page.$('[data-testid=conds-t_decide] [data-testid=cond-up]')))
  await shot(page, '32_step2_level1.png')
  // 保存はしない（自動確認で版を増やさない）。直接編集・修正案・戻すはバックエンドのテストで確かめる

  // ④ 既定の現場条件（作業エリアに段差）：車輪移動式は移動が対応不可、Claudeの推奨は HM-2
  await goStep(page, '[data-testid=step-3]')
  await page.waitForSelector('[data-testid=counts] .h6-count')
  await page.click('[data-testid=product-rm_20]')
  await page.click('[data-testid=eval-toggle]')
  await page.waitForFunction(() => document.querySelector('[data-testid=req-mobility] .req-st')?.textContent?.includes('対応不可'))
  check('④：段差のある作業エリアでは、車輪移動式（RM-20）の移動が対応不可', (await page.textContent('[data-testid=req-mobility]')).includes('段差'))
  check('④：Claudeの推奨は HM-2（段差を越えて移動できる唯一の候補）', !!(await page.$('[data-testid=makers] [data-testid=product-hm_2] .star, [data-testid=product-hm_2]:has-text("★")')))
  await page.click('[data-testid=eval-toggle]')
  await shot(page, '33_step3_step_floor.png')
  // 以降は車輪移動式（RM-20）での操作を確かめるため、自動確認の間だけ床を平坦にする（最後に既定へ戻す）
  await page.evaluate(async () => {
    const m = await (await fetch('/api/v2/masters')).json()
    m.environment.work_area.floor = 'flat'
    await fetch('/api/v2/masters', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ items: m.items, environment: m.environment, shipments: m.shipments }) })
  })
  await page.reload()
  await page.waitForSelector('[data-testid=step-3]', { state: 'attached' })

  // ④ ロボット構成の仮選定
  await goStep(page, '[data-testid=step-3]')
  await page.waitForSelector('[data-testid=counts] .h6-count')
  const reqStatus = (id) => page.textContent(`[data-testid=req-${id}] .req-st`)
  const waitReq = (id, text) => page.waitForFunction(([i, t]) => document.querySelector(`[data-testid=req-${i}] .req-st`)?.textContent?.includes(t), [id, text])
  const counts = await page.textContent('[data-testid=counts]')
  check('④：業務要求の対応は上に3区分の件数だけ（対応可能・対応不可・判断不可）、詳細は閉じている',
    /対応不可[\s\S]*判断不可[\s\S]*対応可能/.test(counts) && !(await page.$('[data-testid=hw-check]')), counts.slice(0, 80))
  await page.click('[data-testid=eval-toggle]')
  await page.waitForSelector('[data-testid=req-payload] .hb')
  check('④：押すと詳細を展開（3区分の意味・要求ごとの判断）', /対応可能[\s\S]*対応不可[\s\S]*判断不可/.test(await page.textContent('[data-testid=legend]')))
  check('④：仮想メーカー3社・機種（左に細く）', (await page.$$('[data-testid=makers] .maker')).length === 3 && (await page.$$('[data-testid=makers] .prod-card')).length >= 3)
  check('④：中央にロボット、右に部品パネル', !!(await page.$('[data-testid=hero] canvas')) && !!(await page.$('[data-testid=product-col]')) && !!(await page.$('[data-testid=parts-panel]')))
  // Claudeの仮選定（機種は実行ごとに変わりうる）が初期表示。以降のカタログ操作の確認は RM-20 を例に選んで行う
  const claudeProduct = await page.evaluate(async () => {
    const s = await (await fetch('/api/v2/state')).json()
    const id = s.selection?.config?.product_id
    return (s.hw_catalog.products.find((p) => p.id === id)?.name ?? id ?? '').split(' ')[0]  // 例：AW-40F
  })
  check('④：Claudeの仮選定が初期表示', !!claudeProduct && (await page.textContent('[data-testid=product-col]')).includes(claudeProduct), claudeProduct)
  // 例の構成：RM-20＋複合ハンド＋力覚センサー・計量台（前の版でClaudeが選んだ構成と同じ。標準構成からの変更あり）
  const pickRm20 = async () => {
    await page.click('[data-testid=product-rm_20]')
    await page.click('[data-testid=hot-end_effector]')
    await page.click('[data-testid=card-vacuum_gripper]')
    await page.click('[data-testid=hot-sensor]')
    await page.click('[data-testid=card-wrist_force_sensor]')
    await page.click('[data-testid=card-scale_station]')
    await waitReq('grasp_soft_bag', '判断不可')
  }
  await pickRm20()
  // モデル上の吹き出し：変更できる部位（手先・センサー）は●、アーム・移動方式は🔒で押せない
  await page.waitForSelector('[data-testid=hot-end_effector]')
  check('④：変更できる部位にだけ●の吹き出し、固定の部位は🔒', !!(await page.$('[data-testid=hot-sensor]')) && !!(await page.$('[data-testid=lock-arm]'))
    && !(await page.$('[data-testid=hot-arm]')) && !(await page.$('[data-testid=hot-base]')))
  await page.click('[data-testid=hot-end_effector]')
  await page.waitForSelector('[data-testid=catalog-end_effector]')
  check('④：吹き出しを押すと右にその部位の交換候補', !!(await page.$('[data-testid=parts-panel] [data-testid=card-vacuum]')))
  const eeText = await page.textContent('[data-testid=catalog-end_effector]')
  check('④：機種が認めるハンドだけを表示（RM-20に2指グリッパーは出ない）', eeText.includes('サクションハンド') && !(await page.$('[data-testid=card-parallel_gripper]')))
  check('④：選べない部品と理由', (await page.textContent('[data-testid=not-offered]')).includes('2指グリッパー'))
  check('④：部品は画像の左にスペックの表（関わる要求の対応を含む）と「選択」ボタン', (await page.textContent('[data-testid=part-vacuum] .part-spec')).includes('軟包装物ハンドリング')
    && (await page.textContent('[data-testid=part-vacuum] .part-spec')).includes('最大把持サイズ') && (await page.textContent('[data-testid=card-vacuum]')).includes('選択')
    && (await page.$eval('[data-testid=part-vacuum] .part-spec', (e) => e.getBoundingClientRect().right)) <= (await page.$eval('[data-testid=part-vacuum] svg', (e) => e.getBoundingClientRect().left)) + 1)
  const specRow = await page.$eval('[data-testid=spec-strip] tr', (tr) => { const [a, b] = tr.children; return Math.abs(a.getBoundingClientRect().top - b.getBoundingClientRect().top) < 2 })
  check('④：ロボットのスペック表は枠線つきで、項目名と値が同じ行', specRow && (await page.$eval('[data-testid=spec-strip] td', (e) => getComputedStyle(e).borderTopStyle)) === 'solid')
  check('④：RM-20＋複合ハンドでは袋の把持が「判断不可」', (await reqStatus('grasp_soft_bag')).includes('判断不可'))
  await shot(page, '33_step3.png')
  // 固定構造は変えられない
  await page.click('[data-testid=parts-back]')
  check('④：移動方式・アームは機種に固定（変更できるように見せない：ボタンにしない）', !!(await page.$('[data-testid=fixed-base]')) && !(await page.$('[data-testid=tab-base]'))
    && !!(await page.$('[data-testid=lock-base]')) && !(await page.$('[data-testid=hot-base]')))
  check('④：部位のタブを重ねて出さない（部位はモデル上の ● から選ぶ）', !(await page.$('[data-testid=parts-panel] .cat-tabs')))
  // 逆引き：要求を選ぶと関係する機種を強調
  await page.click('[data-testid=focus-req-grasp_soft_bag]')
  check('④：要求から機種を逆引き', (await page.$$('[data-testid^=focus-]')).length >= 4 && (await page.textContent('[data-testid=focus-rm_10]')).includes('対応不可'))
  await page.click('[data-testid=focus-req-grasp_soft_bag]')
  // 3社の切替：固定式（周辺設備はなし＝移動できない）／ヒューマノイド（HM-1 軽量・HM-2 高可搬。どちらも概念プレビューではない）
  await page.click('[data-testid=product-aw_40f]')
  await waitReq('payload', '対応可能')
  const fixedText = await page.textContent('[data-testid=product-col]')
  check('④：機種を切り替えると構造・能力が変わる（固定式は周辺設備がなく、移動が対応不可）', fixedText.includes('AW-40F') && fixedText.includes('固定')
    && (await reqStatus('mobility')).includes('対応不可'))
  await shot(page, '33_step3_fixed.png')
  await page.click('[data-testid=product-hm_1]')
  await waitReq('payload', '判断不可')
  check('④：HM-1 は概念プレビューの注意を出さず、可搬・リーチの不足を照合で示す', !(await page.$('[data-testid=concept-note]'))
    && (await reqStatus('reach')).includes('対応不可') && !(await page.textContent('[data-testid=makers]')).includes('概念プレビュー'))
  await shot(page, '33_step3_humanoid.png')
  await page.click('[data-testid=product-hm_2]')
  await waitReq('payload', '対応可能')
  check('④：高可搬ヒューマノイド HM-2 は対応不可なし（把持・歩行は判断不可のまま）', (await page.textContent('[data-testid=count-cannot]')).trim().startsWith('0')
    && (await reqStatus('mobility')).includes('判断不可') && !(await page.$('[data-testid=concept-note]')))
  await pickRm20()
  // 手先を吸着パッドへ着せ替え → 袋の把持が不足、Step 5 で S1・S2 が引継ぎの見込み
  await page.click('[data-testid=hot-end_effector]')
  await page.click('[data-testid=card-vacuum]')
  await page.waitForFunction(() => document.querySelector('[data-testid=req-grasp_soft_bag] .req-st')?.textContent?.includes('対応不可'))
  check('④：手先を変えると要求の状態が変わる（判断不可 → 対応不可）', (await reqStatus('grasp_soft_bag')).includes('対応不可'))
  check('④：モデルの下に標準構成からの変更・分かっていること・詳細スペック・選定理由・他の候補を出さない',
    !(await page.$('[data-testid=diff], [data-testid=impact], [data-testid=spec-more], [data-testid=claude-why], [data-testid=hw-alternatives]')))
  // 深度カメラを外す → 寸法・位置の計測が「対応」から「不足」へ
  check('④：RM-20 では寸法・位置の計測が「対応可能」', (await reqStatus('sense_dims')).includes('対応可能'))
  await page.click('[data-testid=hot-sensor]')
  await page.click('[data-testid=card-depth_camera]')
  await page.waitForFunction(() => document.querySelector('[data-testid=req-sense_dims] .req-st')?.textContent?.includes('対応不可'))
  check('④：センサーを変えると要求の状態が変わる', (await reqStatus('sense_dims')).includes('対応不可'), await reqStatus('sense_dims'))
  await shot(page, '33_step3_swapped.png')
  // 例の RM-20 構成に戻し、名前を付けて保存する（Step 5 はこの保存した構成を選んで使う）
  await page.click('[data-testid=product-aw_40f]')
  await pickRm20()
  const saveAs = async (name) => {
    await page.fill('[data-testid=config-name]', name)
    await page.click('[data-testid=config-save-btn]')
    await page.waitForFunction((n) => document.querySelector('[data-testid=config-save-msg]')?.textContent?.includes(n), name)
  }
  const target = await page.textContent('[data-testid=hw-basis]')
  check('④：上部の帯に「選定対象の業務」（シナリオ・ワークフロー）と、それぞれのIDを薄く添える',
    target.includes('選定対象の業務') && target.includes('カゴ車への混載荷物積付') && target.includes('ワークフロー') && !target.includes('出荷予定')
    && (await page.textContent('[data-testid=ctx-scenario-id]')) === 'sc_cage_cart_loading'
    && (await page.textContent('[data-testid=ctx-workflow-id]')).startsWith('extraction_'), target.slice(0, 160))
  if (!(await page.$('[data-testid=hw-ids]'))) await page.click('[data-testid=eval-toggle]')
  check('④：IDと注記は「詳細を見る」の中', (await page.textContent('[data-testid=hw-ids]')).includes('sc_cage_cart_loading')
    && (await page.textContent('[data-testid=hw-ids]')).includes('extraction_'))
  const specPos = await page.evaluate(() => ({ spec: document.querySelector('[data-testid=spec-strip]').getBoundingClientRect(), hero: document.querySelector('[data-testid=hero]').getBoundingClientRect() }))
  check('④：主要スペック（実効可搬・リーチ・移動・手先）はモデルの左横に表で表示', specPos.spec.right <= specPos.hero.left + 1 && specPos.spec.top < specPos.hero.bottom
    && /実効可搬質量[\s\S]*最大リーチ[\s\S]*移動方式[\s\S]*エンドエフェクタ/.test(await page.textContent('[data-testid=spec-strip]')))
  check('④：構成名と「構成を確定」はロボットの下（読み込みは置かない・幅いっぱいにしない）',
    (await page.$eval('[data-testid=config-save-btn]', (b) => b.getBoundingClientRect().width)) < 200 && !(await page.$('[data-testid=config-load]'))
    && (await page.$eval('[data-testid=config-save]', (e) => e.getBoundingClientRect().top)) >= (await page.$eval('[data-testid=hero]', (e) => e.getBoundingClientRect().bottom))
    && (await page.textContent('[data-testid=config-save-btn]')).includes('構成を確定'))
  await saveAs('自動確認 RM-20 複合ハンド')
  check('④：構成に名前を付けて保存できる（選定時のワークフローの版・出荷予定を記録）', (await page.textContent('[data-testid=config-save-msg]')).includes('保存しました'))
  check('Step 3 以降：シナリオは上部の帯だけに出し、右上には出さない（出荷予定の選択も出さない）', (await page.textContent('.ctx-bar')).includes('カゴ車への混載荷物積付')
    && !(await page.$('[data-testid=scenario]')) && !(await page.$('[data-testid=batch]')))
  await shot(page, '33_step3_saved.png')

  // ⑤ シミュレーション実行：シナリオと保存した構成を選ぶ → 判定 → 実行可能なら動画生成
  await goStep(page, '[data-testid=step-4]')
  check('⑤：シナリオは積付のみ選べる（ほかは未評価）', (await page.$$eval('[data-testid=ex-scenario] option', (os) => os.filter((o) => o.disabled).length)) === 3)
  check('⑤：保存した構成が選ばれている（Claudeの仮選定も一覧にある）', (await page.$eval('[data-testid=ex-config]', (s) => s.selectedOptions[0].textContent)).includes('自動確認 RM-20')
    && (await page.textContent('[data-testid=ex-config]')).includes('Claudeの仮選定'))
  check('⑤：実行条件はシナリオ・ワークフロー・ロボット構成を別々に選び、出荷予定も表示。ボタンは「シミュレーション実行」1つ',
    !!(await page.$('[data-testid=ex-workflow]')) && (await page.textContent('[data-testid=ex-workflow]')).includes('確認済みの版')
    && (await page.textContent('[data-testid=run-job]')).includes('シミュレーション実行') && !(await page.$('[data-testid=generate-video]')) && !(await page.$('[data-testid=ex-summary]')))
  await page.waitForSelector('[data-testid=ex-fit]')
  check('⑤：判定の前に、選んだ構成の業務要件との適合（Step 4 と同じ照合）と対象のワークフロー・出荷予定を表示',
    (await page.textContent('[data-testid=ex-fit]')).includes('対応可能') && !!(await page.$('[data-testid=ex-setup] .ctx-bar [data-testid=ex-workflow]')))
  await page.click('[data-testid=run-job]')
  await page.waitForSelector('[data-testid=ex-running]')
  await sleep(700)
  check('⑤：実行を押すと、しばらく進み具合を表示してからプレビューに切り替わる', !(await page.$('[data-testid=ex-summary]'))
    && (await page.textContent('[data-testid=ex-running]')).includes('シミュレーションを実行しています'))
  await shot(page, '34_step4_running.png')
  await page.waitForSelector('[data-testid=ex-verdict-badge]')
  check('⑤：実行が終わると進み具合の表示は消え、プレビューを再生', !(await page.$('[data-testid=ex-running]')) && !!(await page.$('[data-testid=caption-3d]')))
  await page.waitForSelector('[data-testid=ex-execution]', { state: 'attached' })
  check('⑤：実行結果を保存し、実行IDを表示', (await page.textContent('[data-testid=ex-execution]')).includes('exec_'))
  check('⑤：実行可否を判定（実行可能）し、実行できる荷物・理由・未検証事項を表示', (await page.textContent('[data-testid=ex-verdict-badge]')).includes('実行可能')
    && (await page.textContent('[data-testid=ex-unverified]')).includes('未確認'))
  const exSum = await page.textContent('[data-testid=ex-summary]')
  check('⑤：実行後は右に結果サマリー（総合判定・対象荷物・仮想処理完了・引継ぎ・未処理・未検証事項）', ['対象荷物', '仮想処理完了', '人への引継ぎ', '未処理', '未検証事項'].every((k) => exSum.includes(k)), exSum.slice(0, 120))
  check('⑤：詳細結果は折りたたみ（初期は閉じている）', !(await page.$eval('[data-testid=ex-details]', (d) => d.open)))
  await shot(page, '34_step4_verdict.png')
  await page.waitForSelector('[data-testid=caption-3d]')
  await sleep(4000)
  const box = await page.$eval('[data-testid=robot-3d]', (e) => e.getBoundingClientRect().width)
  check('⑤：3Dを大きく表示', box > 900, String(box))
  check('⑤：業務の進捗（Level 1 を5工程に要約）で現在の工程', (await page.$$('[data-testid=l1-progress] .exp-chip.is-active')).length === 1)
  check('⑤：簡略化した判断経路（Level 2）', (await page.$$('[data-testid=l2-path] li')).length > 0)
  check('⑤：現在の作業・判断・動作・判定', (await page.textContent('[data-testid=ex-current]')).includes('荷物')
    && !!(await page.$('[data-testid=ex-decision]')) && !!(await page.$('[data-testid=ex-motion]')) && (await page.textContent('[data-testid=ex-judge]')).includes('未検証'))
  await shot(page, '34_step4_run.png')
  await page.click('[data-testid=ex-now-more] > summary')
  await page.click('[data-testid=open-l2]')
  await page.waitForSelector('[data-testid=l2-modal] .wf-node.is-visited')
  check('⑤：詳細ワークフロー（Level 2 全体）を大きく表示', (await page.$$('[data-testid=l2-modal] .wf-node.is-visited')).length > 0)
  await shot(page, '34_step4_l2.png')
  await page.mouse.click(10, 10)
  // 途中の積付状態（荷物が積み上がる）を数か所で撮る
  for (const [n, name] of [[5, '34_step4_mid1.png'], [5, '34_step4_mid2.png']]) {
    for (let i = 0; i < n; i++) await page.click('[data-testid=next-item]')
    await sleep(2600)
    await shot(page, name)
  }
  await page.click('[data-testid=cam-cart]')
  await page.click('[data-testid=to-end]')
  await sleep(1500)
  check('⑤：最後まで再生すると全て配置（RM-20）', (await page.textContent('[data-testid=caption-3d]')).includes('配置 17個'), await page.textContent('[data-testid=caption-3d]'))
  await shot(page, '34_step4_end.png')
  await page.click('[data-testid=cam-follow]')
  await page.click('[data-testid=compare]')
  await sleep(1500)
  check('⑤：人間と比較モード', !!(await page.$('[data-testid=compare-human]')))
  await shot(page, '35_step4_compare.png')
  await page.click('[data-testid=compare]')
  await page.click('[data-testid=to-end]')
  await sleep(600)
  check('⑤：RM-20 は全て仮想配置（引継ぎ0個）', (await page.textContent('[data-testid=ex-sum-handed]')).includes('0個'))

  // 業務要件を満たさない構成（対応不可あり）はシミュレーションを実行できない：手先をサクションハンドへ → 袋の把持が対応不可
  await goStep(page, '[data-testid=step-3]')
  await page.click('[data-testid=hot-end_effector]')
  await page.click('[data-testid=card-vacuum]')
  check('④：対応不可のある構成は「Step 5 で実行できない」と確定前に示す', (await page.textContent('[data-testid=config-save-warn]')).includes('実行できません'))
  await saveAs('自動確認 RM-20 サクションハンド')
  await goStep(page, '[data-testid=step-4]')
  await page.waitForSelector('[data-testid=ex-invalid]')
  const invalid = await page.textContent('[data-testid=ex-invalid]')
  check('⑤：業務要件を満たさない構成ではエラーを出し、シミュレーション実行を押せない（以前の結果も出さない）',
    invalid.includes('業務要件を満たしていません') && invalid.includes('柔らかいバッグ') && await page.$eval('[data-testid=run-job]', (b) => b.disabled)
    && !(await page.$('[data-testid=ex-summary]')), invalid.slice(0, 160))
  check('⑤：エラーから Step 4 へ戻れる', !!(await page.$('[data-testid=go-step4]')))
  await shot(page, '36_step4_invalid.png')
  // 機種を軽量のRM-10へ → 可搬重量は一部の荷物だけ（判断不可）、袋は対応不可 → 実行できない
  await goStep(page, '[data-testid=step-3]')
  await page.click('[data-testid=product-rm_10]')
  await page.click('[data-testid=eval-toggle]')
  await page.waitForFunction(() => document.querySelector('[data-testid=req-payload] .req-st')?.textContent?.includes('判断不可'))
  const payloadRow = await page.textContent('[data-testid=req-payload]')
  check('④：軽量構成では可搬重量が一部の荷物だけ満たす＝「判断不可」（扱えない荷物を表示）', payloadRow.includes('判断不可') && payloadRow.includes('H1') && payloadRow.includes('一部'), payloadRow)
  // ヒューマノイド：対応不可があるため実行できない
  await page.click('[data-testid=product-hm_1]')
  await waitReq('reach', '対応不可')
  await saveAs('自動確認 HM-1')
  await goStep(page, '[data-testid=step-4]')
  await page.waitForSelector('[data-testid=ex-invalid]')
  check('⑤：ヒューマノイド（対応不可あり）も実行できない', await page.$eval('[data-testid=run-job]', (b) => b.disabled))
  // Claudeの仮選定（B社 HM-2・二足歩行）を Step 5 で選ぶ
  const claudeOpt = await page.$$eval('[data-testid=ex-config] option', (os) => os.find((o) => o.textContent.includes('Claudeの仮選定'))?.value)
  check('⑤：Claudeの仮選定は固有のID（仮選定の保存ファイル名）で識別', (claudeOpt ?? '').startsWith('hardware_'), claudeOpt)
  await page.selectOption('[data-testid=ex-config]', claudeOpt)
  await page.click('[data-testid=run-job]')
  await page.waitForFunction(() => document.querySelector('[data-testid=ex-verdict-badge]')?.textContent?.trim() === '実行可能')
  await page.waitForFunction(() => document.querySelector('[data-testid=robot-label]')?.textContent?.includes('HM-2'))
  await sleep(5000)
  check('⑤：Claudeの仮選定（HM-2）は二足歩行で再生する（処理対象外の要約を出さない）', !(await page.$('[data-testid=ex-blocked]')))
  await shot(page, '36_step4_fixed.png')
  await page.click('[data-testid=to-end]')
  await sleep(1200)
  await shot(page, '36_step4_fixed_end.png')

  // ⑥ シミュレーション評価（報告用）：総合所見 → 主要KPI → 詳細（定量評価／課題・改善余地）
  await goStep(page, '[data-testid=step-5]')
  await page.waitForSelector('[data-testid=ev-summary]')
  const scn = await page.$$eval('[data-testid=ev-scenario] option', (os) => os.map((o) => [o.disabled, o.textContent]))
  check('⑥：シナリオは積付のみ評価、ほか3つは「未評価」で選べない', scn.length === 4 && scn.filter(([d, t]) => d && t.includes('未評価')).length === 3 && !scn[0][0])
  const basisText = await page.textContent('[data-testid=ev-scenarios]')
  check('⑥：上部の帯に評価対象（シナリオ・ワークフロー・ロボット構成）。内部ID・出荷予定は通常表示しない', basisText.includes('ワークフロー') && basisText.includes('ロボット構成')
    && !basisText.includes('出荷予定') && !basisText.includes('exec_'), basisText.slice(0, 120))
  check('Step 3〜6 の上部の帯は同じ部品（ctx-bar）', !!(await page.$('[data-testid=ev-scenarios].ctx-bar')))
  check('⑥：画面名は「シミュレーション評価」', (await page.textContent('[data-testid=cur-step]')).includes('シミュレーション評価'))
  const order = await page.$$eval('[data-testid=page-5] > *', (els) => els.map((e) => e.getAttribute('data-testid') || e.className))
  check('⑥：総合所見がKPIの上（評価対象 → 総合所見 → KPI → タブ）', order.indexOf('ev-summary') < order.indexOf('ev-kpis') && order.indexOf('ev-kpis') < order.findIndex((x) => String(x).includes('ev-tabs')), order.join(','))
  const cm = await page.textContent('[data-testid=ev-comment]')
  check('⑥：サマリーは「主要所見・効果見通し・残存課題」の3行', cm.includes('主要所見') && cm.includes('効果見通し') && cm.includes('残存課題'), cm.slice(0, 200))
  check('⑥：実機での導入可否・省人化効果を示さないと明示', (await page.textContent('[data-testid=ev-summary]')).includes('省人化効果を示すものではありません'))
  check('⑥：主要KPIは4つ', (await page.$$('[data-testid=ev-kpis] .ev-kpi')).length === 4)
  const mt = await page.textContent('[data-testid=m-tasks]')
  check('⑥：タスク達成は「全体の100%」に見せない（達成件数／全件・未評価の件数）', !mt.includes('100%') && mt.includes('全16件') && mt.includes('未評価'), mt)
  check('⑥：値の種類（仮想実行結果・推定・参考値）を区別', (await page.textContent('[data-testid=m-items]')).includes('仮想実行結果')
    && (await page.textContent('[data-testid=m-time]')).includes('参考値') && (await page.textContent('[data-testid=m-time]')).includes('推定'))
  check('⑥：定量評価は工程（Level 1）単位で集約（個別タスクは初期非表示）', (await page.$$('[data-testid=ev-stage]')).length === 4 && (await page.$$('[data-testid=ev-task]')).length === 0)
  await page.click('[data-testid=ev-stage] >> nth=1')
  check('⑥：工程を選ぶと Level 2 の個別タスクを表示', (await page.$$('[data-testid=ev-task]')).length >= 3)
  check('⑥：合計行で達成率が評価対象だけのものと明示', (await page.textContent('[data-testid=ev-tasks]')).includes('業務全体の達成率ではない'))
  check('⑥：荷物種類は概要 → 内訳（折りたたみ）', (await page.textContent('[data-testid=ev-types] .ev-lead')).includes('種類') && (await page.$$('[data-testid=ev-types] tbody tr')).length >= 4)
  check('⑥：作業時間は棒で比較し、根拠は折りたたみ', (await page.$$('[data-testid=ev-time] .ev-timebar')).length === 2 && (await page.textContent('[data-testid=ev-time]')).includes('模擬の速度仕様'))
  check('⑥：構成の比較（折りたたみ・実行した構成）', (await page.$$('[data-testid=ev-compare] tbody tr')).length >= 2)
  await shot(page, '37_step5.png')
  await page.click('[data-testid=tab-issues]')
  await page.waitForSelector('[data-testid=ev-issues]')
  const ev = await page.textContent('[data-testid=page-5]')
  check('⑥：タブを切り替えても評価対象と総合所見・KPIは表示したまま', !!(await page.$('[data-testid=ev-scenarios]')) && !!(await page.$('[data-testid=ev-summary]')) && !!(await page.$('[data-testid=ev-kpis]')))
  check('⑥：課題・改善余地は「評価観点・現状・課題・改善案・実機PoCでの確認事項」の1表', ev.includes('評価観点') && ev.includes('現状・課題') && ev.includes('改善案（仮説）') && ev.includes('実機PoCでの確認事項')
    && !(await page.$('[data-testid=ev-qual]')) && !(await page.$('[data-testid=ev-poc]')))
  const areaIds = await page.$$eval('[data-testid=ev-issues] .ev-issue', (rs) => rs.map((r) => r.getAttribute('data-testid')))
  check('⑥：観点は業務理解・ロボット能力・積付品質・作業効率・安全性の5つ', ['issue-business', 'issue-hardware', 'issue-quality', 'issue-efficiency', 'issue-safety'].every((x) => areaIds.includes(x)), areaIds.join(','))
  check('⑥：構成の未確認の能力はロボット能力の課題に入る', (await page.textContent('[data-testid=issue-hardware]')).includes('未確認'))
  check('⑥：機種固有の検証（HM-2 の二足歩行・転倒時の安全）がPoC確認事項に入る', (await page.textContent('[data-testid=ev-issues]')).includes('歩行'))
  const lis = await page.$$eval('[data-testid=ev-issue-table] li', (ls) => ls.map((l) => l.textContent))
  check('⑥：同じ内容を重複して出さない', new Set(lis).size === lis.length, lis.filter((x, i) => lis.indexOf(x) !== i).join(' / '))
  await shot(page, '37_step5_issues.png')
  // 保存済みの実行結果があっても、Step 5 を開いた時点ではプレビューを出さない（押してから出す）
  await page.reload()
  await page.waitForSelector('[data-testid=step-4]', { state: 'attached' })
  await goStep(page, '[data-testid=step-4]')
  await page.waitForSelector('[data-testid=ex-setup]')
  await sleep(800)
  check('⑤：開いた時点では動画プレビューを出さない（実行を押してから出す）', !(await page.$('[data-testid=caption-3d]')) && !(await page.$('[data-testid=ex-summary]'))
    && !!(await page.$('[data-testid=ex-verdict] .ex-empty')))
  // 自動確認で変えた現場条件（床を平坦）を既定に戻す
  await page.evaluate(() => fetch('/api/v2/masters', { method: 'DELETE' }))
  // 自動確認で保存した構成は消す（利用者の保存した構成は残す）
  const removed = await page.evaluate(async () => {
    const list = await (await fetch('/api/v2/robot-configs')).json()
    const mine = list.filter((c) => c.name.startsWith('自動確認 '))
    for (const c of mine) await fetch(`/api/v2/robot-configs/${c.id}`, { method: 'DELETE' })
    return mine.length
  })
  check('自動確認で保存した構成を片付けた', removed >= 3, String(removed))
} finally {
  await browser.close()
}

for (const c of checks) console.log(`${c.ok ? 'OK ' : 'NG '} ${c.name}${c.ok ? '' : `  → ${c.detail}`}`)
if (errors.length) console.log('ブラウザのエラー:\n' + errors.join('\n'))
console.log(`スクリーンショット: ${outDir}`)
process.exit(checks.every((c) => c.ok) && errors.length === 0 ? 0 : 1)
