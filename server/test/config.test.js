import { afterAll, describe, expect, it } from 'vitest';
import { cached, closeCache, invalidate } from '../src/cache.js';
import { renderMessage } from '../src/services/messages.js';
import { coerceSetting } from '../src/services/settings.js';
import { pickWeighted } from '../src/services/synthetic.js';

afterAll(() => closeCache());

describe('settings', () => {
  const integer = { key: 'n', valueType: 'integer', min: 1, max: 20 };

  it('accepts values within bounds and normalises numeric strings', () => {
    expect(coerceSetting(integer, 5)).toBe(5);
    expect(coerceSetting(integer, '7')).toBe(7);
    expect(coerceSetting({ key: 'r', valueType: 'number', min: 0, max: 1 }, 0.25)).toBe(0.25);
    expect(coerceSetting({ key: 't', valueType: 'text' }, '  hello ')).toBe('hello');
    expect(coerceSetting({ key: 'b', valueType: 'boolean' }, false)).toBe(false);
  });

  it('rejects out-of-range, fractional and wrongly typed values', () => {
    expect(() => coerceSetting(integer, 0)).toThrow(/at least 1/);
    expect(() => coerceSetting(integer, 21)).toThrow(/at most 20/);
    expect(() => coerceSetting(integer, 2.5)).toThrow(/whole number/);
    expect(() => coerceSetting(integer, 'abc')).toThrow(/number/);
    expect(() => coerceSetting({ key: 'b', valueType: 'boolean' }, 'yes')).toThrow(/true or false/);
  });
});

describe('message templates', () => {
  const centre = { name: 'Test Centre', templates: { hello: 'Hi from {centre} at {time}. {unknown}' } };

  it('fills placeholders, always including the centre name', () => {
    expect(renderMessage(centre, 'hello', { time: '10:30' })).toBe('Hi from Test Centre at 10:30. {unknown}');
  });

  it('fails loudly when a template is missing', () => {
    expect(() => renderMessage(centre, 'missing')).toThrow(/No message template/);
  });
});

describe('weighted demand', () => {
  it('picks in proportion to weight', () => {
    const options = [
      { weight: 1, id: 'a' },
      { weight: 3, id: 'b' },
    ];
    expect(pickWeighted(options, 0).id).toBe('a');
    expect(pickWeighted(options, 0.24).id).toBe('a');
    expect(pickWeighted(options, 0.26).id).toBe('b');
    expect(pickWeighted(options, 0.999).id).toBe('b');
  });
});

describe('cache', () => {
  it('loads once for concurrent readers', async () => {
    const key = `test:single-flight:${Math.random()}`;
    let loads = 0;
    const load = async () => {
      loads++;
      await new Promise((r) => setTimeout(r, 20));
      return { n: loads };
    };
    const [a, b] = await Promise.all([cached(key, 5, load), cached(key, 5, load)]);
    expect(loads).toBe(1);
    expect(a).toEqual(b);
    await invalidate(key);
  });

  it('never stores a value loaded before an invalidation', async () => {
    const key = `test:stale-write:${Math.random()}`;
    let release;
    const slow = cached(key, 5, () => new Promise((r) => (release = () => r({ version: 'old' }))));
    await new Promise((r) => setTimeout(r, 10));
    await invalidate(key);
    release();
    expect(await slow).toEqual({ version: 'old' });
    expect(await cached(key, 5, async () => ({ version: 'new' }))).toEqual({ version: 'new' });
    await invalidate(key);
  });
});
