import { describe, expect, it } from 'vitest'
import { formatError, formatMs, normalizeName, stringWidth, truncate } from '../src/format'

describe('formatMs', () => {
  it.each([
    [0, '0ms'],
    [-5, '0ms'],
    [Number.NaN, '0ms'],
    [0.42, '0.42ms'],
    [0.996, '1.0ms'],
    [4.24, '4.2ms'],
    [9.96, '10ms'],
    [412.4, '412ms'],
    [999.6, '1.00s'],
    [1240, '1.24s'],
    [9999, '10.0s'],
    [41_200, '41.2s'],
    [125_000, '2m05s'],
  ])('%s → %s', (input, expected) => {
    expect(formatMs(input)).toBe(expected)
  })
})

describe('normalizeName', () => {
  it.each([
    ['GET api.dev/users/42', 'GET api.dev/users/*'],
    ['getUser 7', 'getUser *'],
    ['GET /orders/3fa85f64-5717-4562-b3fc-2c963f66afa6', 'GET /orders/*'],
    ['find 507f1f77bcf86cd799439011', 'find *'],
    ['s3.getObject', 's3.getObject'],
    ['GET api.dev/v2/items', 'GET api.dev/v2/items'],
    ['price 12.5', 'price *'],
    ['deadbeefcafebabe', 'deadbeefcafebabe'],
  ])('%s → %s', (input, expected) => {
    expect(normalizeName(input)).toBe(expected)
  })
})

describe('formatError', () => {
  it('formats errors, error-like objects and anything else', () => {
    expect(formatError(new TypeError('bad'))).toBe('TypeError: bad')
    expect(formatError({ name: 'AbortError', message: 'stop' })).toBe('AbortError: stop')
    expect(formatError({ message: 'no name' })).toBe('Error: no name')
    expect(formatError('just a string')).toBe('just a string')
    expect(formatError(undefined)).toBe('undefined')
    expect(formatError(new Error('x'.repeat(500)))).toHaveLength(200)
    const hostile = {
      toString() {
        throw new Error('nope')
      },
    }
    expect(formatError(hostile)).toBe('Unknown error')
  })
})

describe('stringWidth and truncate', () => {
  it('measures wide and zero-width characters', () => {
    expect(stringWidth('abc')).toBe(3)
    expect(stringWidth('日本')).toBe(4)
    expect(stringWidth('🚀')).toBe(2)
    expect(stringWidth('é')).toBe(2 - 1) // precomposed
    expect(stringWidth('é')).toBe(1) // combining accent
  })

  it('truncates to a column width with an ellipsis', () => {
    expect(truncate('hello world', 20)).toBe('hello world')
    expect(truncate('hello world', 6)).toBe('hello…')
    expect(truncate('日本語テキスト', 5)).toBe('日本…')
    expect(truncate('abc', 0)).toBe('')
  })
})
