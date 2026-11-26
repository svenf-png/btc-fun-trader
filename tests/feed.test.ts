import { describe, expect, it } from 'vitest';
import { assetById, parseCoinbase, parseKraken, sourcesFor } from '../src/feed';

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

describe('assets', () => {
  it('parses only the selected market', () => {
    const eth = '{"type":"ticker","product_id":"ETH-USD","price":"1694.88"}';
    expect(parseCoinbase(eth, 'ETH-USD')).toBe(1694.88);
    expect(parseCoinbase(eth, 'BTC-USD')).toBeNull();
    expect(parseKraken('{"channel":"ticker","data":[{"symbol":"SOL/USD","last":71.13}]}', 'SOL/USD')).toBe(71.13);
  });
  it('builds Coinbase and Kraken subscriptions per asset', () => {
    const [cb, kr] = sourcesFor(assetById('SOL'));
    expect(JSON.parse(cb.subscribe).product_ids).toEqual(['SOL-USD']);
    expect(JSON.parse(kr.subscribe).params.symbol).toEqual(['SOL/USD']);
    expect(assetById('nope').id).toBe('BTC');
  });
});
