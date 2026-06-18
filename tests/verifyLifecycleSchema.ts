import {
    LifecycleEvent,
    LifecycleEventType,
    LifecycleSource,
    PipelineVisibilityLevel,
    SOURCE_CAPABILITIES
} from '../layer-A(observation)/types';

function runValidationSuite() {
    console.log('🧪 Starting Schema Validation Suite (Phase A)...');

    // 1. Verify Sample Event Compilation & Instantiation
    const sampleEvent: LifecycleEvent = {
        schemaVersion: 1,
        eventId: 'evt_test_123',
        tradeId: 'trade_456',
        orderId: 'order_789',
        correlationId: 'corr_abc',
        eventType: 'ORDER_OPEN',
        source: 'FREQTRADE',
        captureMethod: 'POLLING',
        eventTimestamp: Date.now(),
        observedAt: Date.now(),
        symbol: 'BTCUSDT',
        side: 'BUY',
        price: 50000.0,
        amount: 0.1
    };


    console.log('✅ A1: Valid LifecycleEvent compiles & instantiates correctly.');
    console.log(`      Sample Shape: ${JSON.stringify(sampleEvent, null, 2)}`);

    // 2. Define expected sources and visibility levels for checks
    const expectedSources: LifecycleSource[] = ['FREQTRADE', 'SIMULATOR', 'BINANCE', 'BYBIT'];
    const validVisibilityLevels: PipelineVisibilityLevel[] = ['NONE', 'PARTIAL', 'FULL'];
    const validEventTypes: LifecycleEventType[] = [
        'SIGNAL',
        'ORDER_CREATED',
        'ORDER_SUBMITTED',
        'ORDER_ACKNOWLEDGED',
        'ORDER_OPEN',
        'ORDER_PARTIALLY_FILLED',
        'ORDER_FILLED',
        'ORDER_CANCELLED',
        'EXCHANGE_REJECTED',
        'ORDER_FAILED'
    ];

    for (const source of expectedSources) {
        const caps = SOURCE_CAPABILITIES[source];

        // A2: Check existence and visibility presence
        if (!caps) {
            throw new Error(`Assertion Failed: Source '${source}' is missing from SOURCE_CAPABILITIES.`);
        }
        if (!caps.visibility || !validVisibilityLevels.includes(caps.visibility)) {
            throw new Error(`Assertion Failed: Source '${source}' has invalid visibility level '${caps.visibility}'.`);
        }
        console.log(`✅ A2: Source '${source}' exists with valid visibility '${caps.visibility}'.`);

        // A3: Check for duplicate event types
        const seenEvents = new Set<LifecycleEventType>();
        for (const evt of caps.supportedEvents) {
            if (seenEvents.has(evt)) {
                throw new Error(`Assertion Failed: Source '${source}' has duplicate supportedEvent '${evt}'.`);
            }
            seenEvents.add(evt);

            // A4: Check event type is defined in LifecycleEventType
            if (!validEventTypes.includes(evt)) {
                throw new Error(`Assertion Failed: Event type '${evt}' in source '${source}' is not a valid LifecycleEventType.`);
            }
        }
        console.log(`✅ A3/A4: Source '${source}' event capabilities list has no duplicates and contains only valid types.`);
    }

    // A5: Verify visibility level configuration values
    console.log('✅ A5: Checked all visibility levels are valid.');
    
    console.log('\n📊 MAPPED CAPABILITY MATRIX:');
    console.dir(SOURCE_CAPABILITIES, { depth: null });
    
    console.log('\n🎉 ALL PHASE A SCHEMA ASSERTIONS PASSED SUCCESSFULLY!');
}

try {
    runValidationSuite();
    process.exit(0);
} catch (error: any) {
    console.error('❌ Schema Validation Suite Failed:', error.message || error);
    process.exit(1);
}
