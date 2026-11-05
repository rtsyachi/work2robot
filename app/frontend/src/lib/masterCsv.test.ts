import { describe, expect, it } from 'vitest'
import { parseItemCsv, toItemCsv } from './masterCsv'

describe('荷物マスタのCSV', () => {
  it('見出しの列名で読み、空欄は未登録（null）にする', () => {
    const { rows, errors } = parseItemCsv('object_id,name,material_class,weight_kg,width_m,depth_m,height_m,fragile_content\nX1,箱,rigid,3.5,0.4,0.3,0.2,はい\nX2,袋,,,,,,')
    expect(errors).toEqual([])
    expect(rows[0]).toMatchObject({ object_id: 'X1', material_class: 'rigid', weight_kg: 3.5, dims_m: [0.4, 0.3, 0.2], fragile_content: true })
    expect(rows[1]).toMatchObject({ object_id: 'X2', material_class: null, weight_kg: null, dims_m: null, fragile_content: null })
  })

  it('数値でない値は行番号つきで知らせる', () => {
    const { errors } = parseItemCsv('object_id,weight_kg\nX1,重い')
    expect(errors[0]).toContain('2行目')
  })

  it('書き出したCSVを読み戻すと同じ内容', () => {
    const rows = parseItemCsv('object_id,name,object_type,material_class,weight_kg,width_m,depth_m,height_m,fragile_content,handling_note\nA1,箱,段ボール箱,soft,2,0.4,0.3,0.2,false,天地無用').rows
    expect(parseItemCsv(toItemCsv(rows)).rows).toEqual(rows)
  })
})
