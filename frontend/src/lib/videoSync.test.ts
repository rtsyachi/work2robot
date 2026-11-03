import { describe, expect, it } from 'vitest'
import { objectRanges, toSeconds } from './videoSync'

describe('objectRanges', () => {
  it('荷物ごとに、その荷物を扱っている観測セグメントの区間をまとめる', () => {
    const segs = [
      { id: 'O1', t: '00:00', text: '初期状態', objects: [] },
      { id: 'O2', t: '00:02', text: 'Aをつかむ', objects: ['A'] },
      { id: 'O3', t: '00:05', text: 'Aを下段に置く', objects: ['A'] },
      { id: 'O4', t: '00:07', text: 'Bをつかむ', objects: ['B'] },
      { id: 'O5', t: '00:10', text: '最終状態', objects: [] },
    ]
    expect(objectRanges(segs)).toEqual({ A: { start: 2, end: 7 }, B: { start: 7, end: 10 } })
    expect(toSeconds('01:05')).toBe(65)
  })
})
