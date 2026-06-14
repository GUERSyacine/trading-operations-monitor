import { TradingAdapter, AdapterConfig } from '../base/TradingAdapter';
import { EventPersistenceService } from '../base/EventPersistenceService';

export class FreqtradeAdapter extends TradingAdapter {
    private activeExchange = 'binance';
    private hasFetchedConfig = false;

    constructor(
        config: AdapterConfig,
        private persistence: EventPersistenceService
    ) {
        super(config, 'freqtrade');
    }

    /**
     * Polling logic called periodically by the base TradingAdapter.
     */
    protected async poll(): Promise<void> {
        // 1. Fetch config once on startup to resolve the active exchange name
        await this.fetchConfigOnce();

        // 2. Poll heartbeat, broker connection, orders, and market data
        await Promise.all([
            this.pollHeartbeat(),
            this.pollBrokerConnection(),
            this.pollOrders(),
            this.pollMarketData()
        ]);
    }

    /**
     * Resolve exchange configuration from Freqtrade REST API.
     */
    private async fetchConfigOnce(): Promise<void> {
        if (this.hasFetchedConfig) return;
        try {
            const configData = await this.apiRequest('/show_config');
            if (configData && configData.exchange) {
                this.activeExchange = configData.exchange;
                this.hasFetchedConfig = true;
                console.log(`[FreqtradeAdapter] Successfully resolved active exchange from Freqtrade API: ${this.activeExchange}`);
            }
        } catch (error: any) {
            console.error(`[FreqtradeAdapter] Failed to resolve Freqtrade config, falling back to 'binance':`, error?.message || error);
        }
    }

    /**
     * Ingest HEARTBEAT events from Freqtrade API health details.
     */
    private async pollHeartbeat(): Promise<void> {
        try {
            const healthData = await this.apiRequest('/health');
            if (healthData && healthData.last_process) {
                const now = Date.now();
                const lastWrite = await this.persistence.getLastEventTime('HEARTBEAT', this.sourceSystem);
                
                // Suppress writes to max 1 per 60 seconds
                if (now - lastWrite >= 60000) {
                    await this.persistence.persistEvent({
                        classification: 'HEARTBEAT',
                        systemRiskState: 'NORMAL',
                        metadata: {
                            adapter: 'freqtrade',
                            adapterVersion: '1.0.0',
                            sourceSystem: this.sourceSystem,
                            last_process: healthData.last_process,
                            last_process_ts: healthData.last_process_ts
                        }
                    });
                    console.log(`[FreqtradeAdapter] Logged HEARTBEAT event.`);
                }
            }
        } catch (error: any) {
            console.error(`[FreqtradeAdapter] Heartbeat poll failed:`, error?.message || error);
        }
    }

    /**
     * Ingest BROKER_CONNECTION events based on balance request success.
     */
    private async pollBrokerConnection(): Promise<void> {
        try {
            // Fetching balance forces Freqtrade to hit the exchange client (validates API keys & connectivity)
            const balanceData = await this.apiRequest('/balance');
            if (balanceData) {
                const now = Date.now();
                const lastWrite = await this.persistence.getLastEventTime('BROKER_CONNECTION', this.sourceSystem);

                // Suppress writes to max 1 per 60 seconds
                if (now - lastWrite >= 60000) {
                    await this.persistence.persistEvent({
                        classification: 'BROKER_CONNECTION',
                        systemRiskState: 'NORMAL',
                        metadata: {
                            adapter: 'freqtrade',
                            adapterVersion: '1.0.0',
                            sourceSystem: this.sourceSystem,
                            connected: true,
                            exchange: this.activeExchange
                        }
                    });
                    console.log(`[FreqtradeAdapter] Logged BROKER_CONNECTION event.`);
                }
            }
        } catch (error: any) {
            console.error(`[FreqtradeAdapter] Broker Connection poll failed:`, error?.message || error);
        }
    }

    /**
     * Ingest trade executions from Freqtrade historical trades endpoint.
     */
    private async pollOrders(): Promise<void> {
        try {
            const tradesData = await this.apiRequest('/trades');
            if (tradesData && Array.isArray(tradesData.trades)) {
                for (const trade of tradesData.trades) {
                    if (Array.isArray(trade.orders)) {
                        for (const order of trade.orders) {
                            if (!order.order_id) continue;
                            
                            // Check if this specific order is already registered
                            const exists = await this.persistence.hasOrderEvent(order.order_id);
                            if (!exists) {
                                const symbol = order.pair.replace('/', '');
                                const orderTimestamp = order.order_filled_timestamp || order.order_timestamp || Date.now();
                                
                                await this.persistence.persistEvent({
                                    classification: 'ORDER',
                                    systemRiskState: 'NORMAL',
                                    createdAt: new Date(orderTimestamp),
                                    metadata: {
                                        adapter: 'freqtrade',
                                        adapterVersion: '1.0.0',
                                        sourceSystem: this.sourceSystem,
                                        orderId: order.order_id,
                                        freqtradeOrderId: order.order_id,
                                        freqtradeTradeId: trade.trade_id,
                                        strategyId: trade.strategy || 'SampleStrategy',
                                        symbol: symbol,
                                        side: order.ft_order_side.toUpperCase(),
                                        price: order.average || order.price,
                                        amount: order.filled || order.amount
                                    }
                                });
                                console.log(`[FreqtradeAdapter] Ingested new execution order: ${order.order_id} (${symbol})`);
                            }
                        }
                    }
                }
            }
        } catch (error: any) {
            console.error(`[FreqtradeAdapter] Orders poll failed:`, error?.message || error);
        }
    }

    /**
     * HTTP fetch wrapper targeting Freqtrade API with Basic Auth.
     */
    private async apiRequest(endpoint: string): Promise<any> {
        const auth = Buffer.from(`${this.config.username}:${this.config.password}`).toString('base64');
        
        // Remove trailing slash from baseUrl if present
        const base = this.config.baseUrl.endsWith('/') ? this.config.baseUrl.slice(0, -1) : this.config.baseUrl;
        const url = `${base}${endpoint}`;

        const response = await fetch(url, {
            method: 'GET',
            headers: {
                'Authorization': `Basic ${auth}`,
                'Accept': 'application/json'
            }
        });

        if (!response.ok) {
            throw new Error(`Freqtrade API returned status code ${response.status}`);
        }

        return response.json();
    }

    /**
     * Poll and check market data feed freshness across whitelisted pairs.
     * Emits a single aggregated MARKET_DATA event.
     */
    private async pollMarketData(): Promise<void> {
        try {
            const now = Date.now();
            const lastWrite = await this.persistence.getLastEventTime('MARKET_DATA', this.sourceSystem);
            
            // Rate limit to max 1 write every 60 seconds
            if (now - lastWrite >= 60000) {
                const whitelistData = await this.apiRequest('/whitelist');
                if (whitelistData && Array.isArray(whitelistData.whitelist)) {
                    const whitelist = whitelistData.whitelist;
                    const totalSymbols = whitelist.length;
                    
                    // Sample up to 5 pairs from the whitelist to assess freshness
                    const samplePairs = whitelist.slice(0, 5);
                    let freshSymbols = 0;
                    let maxMarketTimestampMs = 0;

                    for (const pair of samplePairs) {
                        try {
                            const encodedPair = encodeURIComponent(pair);
                            const candleData = await this.apiRequest(`/pair_candles?pair=${encodedPair}&timeframe=5m&limit=1`);
                            if (candleData) {
                                let lastAnalyzedTs = 0;

                                if (candleData.last_analyzed_ts) {
                                    lastAnalyzedTs = candleData.last_analyzed_ts * 1000;
                                } else if (Array.isArray(candleData.data) && candleData.data.length > 0) {
                                    const latestCandle = candleData.data[candleData.data.length - 1];
                                    if (Array.isArray(latestCandle) && Array.isArray(candleData.columns)) {
                                        const timestampIndex = candleData.columns.indexOf('__date_ts');
                                        if (timestampIndex < 0) {
                                            console.warn(`[FreqtradeAdapter] __date_ts column missing for ${pair}`);
                                            continue;
                                        }
                                        const rawTs = latestCandle[timestampIndex];
                                        if (typeof rawTs === 'number') {
                                            lastAnalyzedTs = rawTs;
                                        } else if (typeof rawTs === 'string') {
                                            lastAnalyzedTs = new Date(rawTs).getTime();
                                        }
                                    }
                                }

                                if (lastAnalyzedTs > 0) {
                                    // Consider a candle fresh if it has been updated in the last 15 minutes
                                    const fifteenMinutesMs = 15 * 60 * 1000;
                                    if (now - lastAnalyzedTs < fifteenMinutesMs) {
                                        freshSymbols++;
                                    }
                                    if (lastAnalyzedTs > maxMarketTimestampMs) {
                                        maxMarketTimestampMs = lastAnalyzedTs;
                                    }
                                }
                            }
                        } catch (err: any) {
                            console.error(`[FreqtradeAdapter] Failed to fetch candles for ${pair}:`, err.message || err);
                        }
                    }

                    const freshnessRatio = samplePairs.length > 0 ? freshSymbols / samplePairs.length : 1.0;
                    let systemRiskState = 'NORMAL';
                    if (freshnessRatio === 0) {
                        systemRiskState = 'CRITICAL';
                    } else if (freshnessRatio < 0.5) {
                        systemRiskState = 'WARNING';
                    }

                    await this.persistence.persistEvent({
                        classification: 'MARKET_DATA',
                        systemRiskState,
                        metadata: {
                            adapter: 'freqtrade',
                            adapterVersion: '1.0.0',
                            sourceSystem: this.sourceSystem,
                            totalSymbols,
                            observedSymbols: samplePairs.length,
                            freshSymbols,
                            freshnessRatio,
                            timeframe: '5m',
                            lastMarketTimestamp: maxMarketTimestampMs > 0 ? maxMarketTimestampMs : Date.now()
                        }
                    });
                    console.log(`[FreqtradeAdapter] Logged MARKET_DATA heartbeat. Total monitored pairs: ${totalSymbols}, sampled: ${samplePairs.length}, fresh: ${freshSymbols}`);
                }
            }
        } catch (error: any) {
            console.error(`[FreqtradeAdapter] Market Data poll failed:`, error?.message || error);
        }
    }
}
