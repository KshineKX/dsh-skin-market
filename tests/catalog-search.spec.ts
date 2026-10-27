import { describe, expect, it } from 'vitest'
import { matchesCatalogSearch } from '../src/catalog-search.ts'

const skin = {
  name: { zh: '测试皮肤', en: 'Test Skin' },
  author: 'author',
  description: '终末地风格的深色主题',
  tags: ['dark'],
}

describe('catalog search', () => {
  it('matches title, description, author, and tags', () => {
    expect(matchesCatalogSearch(skin, '测试皮肤')).toBe(true)
    expect(matchesCatalogSearch(skin, 'test skin')).toBe(true)
    expect(matchesCatalogSearch(skin, '终末地')).toBe(true)
    expect(matchesCatalogSearch(skin, 'author')).toBe(true)
    expect(matchesCatalogSearch(skin, 'dark')).toBe(true)
  })

  it('finds a skin by its repository, scoped package, or loader row', () => {
    const named = {
      ...skin,
      repo: 'https://github.com/rinDBeans/codex-ui',
      package: '@skin-author/codex-appearance',
      rowId: 'codex-skin-loader',
    }
    expect(matchesCatalogSearch(named, '  RINDBEANS/CODEX-UI  ')).toBe(true)
    expect(matchesCatalogSearch(named, '@skin-author/codex-appearance')).toBe(true)
    expect(matchesCatalogSearch(named, 'codex-skin-loader')).toBe(true)
    expect(matchesCatalogSearch(named, 'another-repository')).toBe(false)
  })

  it('supports entries without optional installation identity', () => {
    expect(matchesCatalogSearch(skin, 'undefined')).toBe(false)
    expect(matchesCatalogSearch(skin, 'another-repository')).toBe(false)
  })

  it('treats a blank query as an unfiltered catalog', () => {
    expect(matchesCatalogSearch(skin, '  ')).toBe(true)
  })
})
