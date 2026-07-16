import { describe, expect, it } from 'vitest';
import { ItemSchema, itemCacheKey } from '../src/index.js';

describe('ItemSchema', () => {
  it('coerces the id and trims the name', () => {
    expect(ItemSchema.parse({ id: '3', name: '  hello ' })).toEqual({ id: 3, name: 'hello' });
  });

  it('rejects a non-positive id', () => {
    expect(ItemSchema.safeParse({ id: 0, name: 'x' }).success).toBe(false);
  });

  it('rejects an empty name', () => {
    expect(ItemSchema.safeParse({ id: 1, name: '   ' }).success).toBe(false);
  });
});

describe('itemCacheKey', () => {
  it('builds the items:<id> key', () => {
    expect(itemCacheKey(7)).toBe('items:7');
  });
});
