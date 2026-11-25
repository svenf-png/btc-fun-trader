import { describe, expect, it } from 'vitest';
import { parseCoinbase, parseKraken } from '../src/feed';

describe('parseCoinbase', () => {
  it('reads the ticker price', () => {
    expect(parseCoinbase('{"type":"ticker","product_id":"BTC-USD","price":"58259.04"}')).toBe(58259.04);
  });
  it('ignores other messages and garbage', () => {
    expect(parseCoinbase('{"type":"subscriptions"}')).toBeNull();
    expect(parseCoinbase('{"type":"ticker","product_id":"ETH-USD","price":"1"}')).toBeNull();
    expect(parseCoinbase('{"type":"ticker","product_id":"BTC-USD","price":"x"}')).toBeNull();
    expect(parseCoinbase('not json')).toBeNull();
  });
});

describe('parseKraken', () => {
  it('reads last price from v2 ticker snapshot/update', () => {
    expect(parseKraken('{"channel":"ticker","type":"update","data":[{"symbol":"BTC/USD","last":58265.9}]}')).toBe(58265.9);
  });
  it('ignores status and subscribe acks', () => {
    expect(parseKraken('{"channel":"status","type":"update","data":[{"system":"online"}]}')).toBeNull();
    expect(parseKraken('{"method":"subscribe","success":true}')).toBeNull();
  });
});
