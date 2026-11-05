// 画面操作の共通処理：工程メニュー（左の引き出し）からステップへ移動する。ピン止め中はメニューを開かずに選ぶ。
export async function goStep(page, selector) {
  const pinned = !!(await page.$('[data-testid=stepnav].is-pinned'))
  if (!pinned) {
    await page.click('[data-testid=menu-btn]')
    await page.waitForSelector('[data-testid=stepnav].is-open')
  }
  await page.click(selector)
  if (!pinned) await page.waitForSelector('[data-testid=stepnav]:not(.is-open)', { state: 'attached' })
}
