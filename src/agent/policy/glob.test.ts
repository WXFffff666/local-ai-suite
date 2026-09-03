import { describe, expect, it } from 'vitest'
import { globToRegExp, literalPrefixLength, matchPathLike } from './glob'

describe('mini-glob (documented subset: * single segment, ** any segments, literals)', () => {
  const cases: Array<[pattern: string, value: string, want: boolean]> = [
    // ** as trailing segment
    ['src/**', 'src', true],
    ['src/**', 'src/a.ts', true],
    ['src/**', 'src/a/b/c.ts', true],
    ['src/**', 'lib/a.ts', false],
    ['src/**', 'srcx/a.ts', false],
    // ** as leading segment
    ['**/secrets.env', 'secrets.env', true],
    ['**/secrets.env', 'a/secrets.env', true],
    ['**/secrets.env', 'a/b/secrets.env', true],
    ['**/secrets.env', 'a/secrets.env.bak', false],
    // ** in the middle
    ['a/**/b', 'a/b', true],
    ['a/**/b', 'a/x/b', true],
    ['a/**/b', 'a/x/y/b', true],
    ['a/**/b', 'a/x', false],
    // bare **
    ['**', 'anything/at/all', true],
    // * stays inside one segment
    ['*.ts', 'a.ts', true],
    ['*.ts', 'src/a.ts', false],
    ['src/*.ts', 'src/a.ts', true],
    ['src/*.ts', 'src/a/b.ts', false],
    ['a*/z', 'abc/z', true],
    // literals: regex metacharacters are escaped
    ['a.b', 'axb', false],
    ['a.b', 'a.b', true],
    ['a?b', 'axb', false],
    ['a?b', 'a?b', true],
    ['[x]', '[x]', true],
    // case sensitivity is the contract (net folds itself)
    ['src/**', 'SRC/a.ts', false],
  ]
  it.each(cases)('globToRegExp(%s).test(%s) === %s', (pattern, value, want) => {
    expect(globToRegExp(pattern).test(value)).toBe(want)
  })

  const prefixCases: Array<[pattern: string, value: string, want: boolean]> = [
    // wildcard-free pattern = literal path prefix with segment boundary
    ['src', 'src', true],
    ['src', 'src/a.ts', true],
    ['src', 'src/a/b.ts', true],
    ['src', 'srcx/a.ts', false],
    ['src', 'other/src/a.ts', false],
    ['D:/Works/app', 'D:/Works/app/x.ts', true],
    // with wildcards it defers to the glob engine
    ['src/**', 'src/a.ts', true],
    ['src/**', 'lib/a.ts', false],
  ]
  it.each(prefixCases)('matchPathLike(%s, %s) === %s', (pattern, value, want) => {
    expect(matchPathLike(pattern, value)).toBe(want)
  })

  it('literalPrefixLength scores specificity before the first wildcard', () => {
    expect(literalPrefixLength('src/a/b.ts')).toBe(10)
    expect(literalPrefixLength('npm run test')).toBe(12)
    expect(literalPrefixLength('src/*')).toBe(4)
    expect(literalPrefixLength('**')).toBe(0)
  })
})
