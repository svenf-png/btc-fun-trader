// Live crypto prices (BTC, ETH, SOL in USD) via public WebSockets (no API key).
// Primary: Coinbase Exchange ticker. Fallback: Kraken WebSocket v2 ticker.

export type FeedStatus = 'connecting' | 'live' | 'offline';

export interface FeedSource {
  name: string;
  url: string;
  subscribe: string;
  parse: (data: string) => number | null;
}

export interface Asset {
  id: 'BTC' | 'ETH' | 'SOL';
  name: string;
  coinbase: string; // Coinbase Exchange product id
  kraken: string; // Kraken v2 symbol
  tick: number; // smallest price step in USD
}

/** Tradable markets. ETH and SOL move about 2x / 4x as much per second as BTC (live sample). */
export const ASSETS: Asset[] = [
  { id: 'BTC', name: 'Bitcoin', coinbase: 'BTC-USD', kraken: 'BTC/USD', tick: 0.01 },
  { id: 'ETH', name: 'Ether', coinbase: 'ETH-USD', kraken: 'ETH/USD', tick: 0.01 },
  { id: 'SOL', name: 'Solana', coinbase: 'SOL-USD', kraken: 'SOL/USD', tick: 0.01 },
];

export const assetById = (id: unknown): Asset => ASSETS.find((a) => a.id === id) ?? ASSETS[0];

export function parseCoinbase(data: string, product = 'BTC-USD'): number | null {
  try {
    const m = JSON.parse(data) as { type?: string; product_id?: string; price?: string };
    if (m.type !== 'ticker' || m.product_id !== product) return null;
    const p = Number(m.price);
    return Number.isFinite(p) && p > 0 ? p : null;
  } catch {
    return null;
  }
}

export function parseKraken(data: string, symbol = 'BTC/USD'): number | null {
  try {
    const m = JSON.parse(data) as { channel?: string; data?: { symbol?: string; last?: number }[] };
    if (m.channel !== 'ticker' || !Array.isArray(m.data)) return null;
    const row = m.data.find((d) => d.symbol === symbol);
    const p = Number(row?.last);
    return Number.isFinite(p) && p > 0 ? p : null;
  } catch {
    return null;
  }
}

/** Primary (Coinbase) and fallback (Kraken) source for one asset. */
export function sourcesFor(asset: Asset): FeedSource[] {
  return [
    {
      name: 'Coinbase',
      url: 'wss://ws-feed.exchange.coinbase.com',
      subscribe: JSON.stringify({ type: 'subscribe', product_ids: [asset.coinbase], channels: ['ticker'] }),
      parse: (d) => parseCoinbase(d, asset.coinbase),
    },
    {
      name: 'Kraken',
      url: 'wss://ws.kraken.com/v2',
      subscribe: JSON.stringify({ method: 'subscribe', params: { channel: 'ticker', symbol: [asset.kraken] } }),
      parse: (d) => parseKraken(d, asset.kraken),
    },
  ];
}

export const SOURCES: FeedSource[] = sourcesFor(ASSETS[0]);

const STALE_MS = 10_000; // no price for this long = connection treated as dead
const FIRST_PRICE_MS = 8_000; // a source must deliver a price this fast after connect
const MAX_BACKOFF_MS = 15_000;

export interface FeedEvents {
  onPrice: (price: number, at: number) => void;
  onStatus: (status: FeedStatus, source: string) => void;
}

export class PriceFeed {
  private ws: WebSocket | null = null;
  private sourceIdx = 0;
  private attempt = 0;
  private lastMsg = 0;
  private gotPrice = false;
  private watchdog = 0;
  private retryTimer = 0;
  private stopped = true;
  status: FeedStatus = 'offline';

  constructor(
    private readonly ev: FeedEvents,
    private sources: FeedSource[] = SOURCES,
  ) {}

  /** Switch to another market: reconnects with the new sources. */
  setSources(sources: FeedSource[]): void {
    this.sources = sources;
    this.sourceIdx = 0;
    this.restart();
  }

  get sourceName(): string {
    return this.sources[this.sourceIdx]?.name ?? '';
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect();
    this.watchdog = window.setInterval(() => this.checkStale(), 1000);
  }

  stop(): void {
    this.stopped = true;
    clearInterval(this.watchdog);
    clearTimeout(this.retryTimer);
    this.teardown();
    this.setStatus('offline');
  }

  /** Force a fresh connection, e.g. when the app returns to the foreground. */
  restart(): void {
    this.stop();
    this.attempt = 0;
    this.start();
  }

  private setStatus(s: FeedStatus): void {
    if (s === this.status) return;
    this.status = s;
    this.ev.onStatus(s, this.sourceName);
  }

  private teardown(): void {
    const ws = this.ws;
    this.ws = null;
    if (!ws) return;
    ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
    try {
      ws.close();
    } catch {
      /* already closed */
    }
  }

  private connect(): void {
    if (this.stopped) return;
    this.teardown();
    const src = this.sources[this.sourceIdx];
    this.setStatus('connecting');
    this.gotPrice = false;
    this.lastMsg = Date.now();
    let ws: WebSocket;
    try {
      ws = new WebSocket(src.url);
    } catch {
      this.scheduleRetry(true);
      return;
    }
    this.ws = ws;
    ws.onopen = () => ws.send(src.subscribe);
    ws.onmessage = (e: MessageEvent) => {
      if (typeof e.data !== 'string') return;
      this.lastMsg = Date.now();
      const p = src.parse(e.data);
      if (p === null) return;
      this.gotPrice = true;
      this.attempt = 0;
      this.setStatus('live');
      this.ev.onPrice(p, Date.now());
    };
    ws.onerror = () => {
      /* onclose follows and handles the retry */
    };
    ws.onclose = () => this.scheduleRetry(!this.gotPrice);
  }

  private scheduleRetry(switchSource: boolean): void {
    this.teardown();
    if (this.stopped) return;
    this.setStatus('offline');
    if (switchSource) this.sourceIdx = (this.sourceIdx + 1) % this.sources.length;
    const delay = Math.min(MAX_BACKOFF_MS, 500 * 2 ** this.attempt);
    this.attempt++;
    clearTimeout(this.retryTimer);
    this.retryTimer = window.setTimeout(() => this.connect(), delay);
  }

  private checkStale(): void {
    if (this.stopped || !this.ws) return;
    const idle = Date.now() - this.lastMsg;
    if (!this.gotPrice && idle > FIRST_PRICE_MS) this.scheduleRetry(true);
    else if (this.gotPrice && idle > STALE_MS) this.scheduleRetry(false);
  }
}
