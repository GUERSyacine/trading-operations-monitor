export const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Execution Watchdog — Test Lab & Developer Console</title>
    <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;600;700&display=swap" rel="stylesheet">
    <style>
        :root {
            --bg-base: #0f172a;
            --bg-surface: rgba(30, 41, 59, 0.7);
            --bg-card: rgba(15, 23, 42, 0.6);
            --border-color: rgba(255, 255, 255, 0.08);
            --text-primary: #f8fafc;
            --text-secondary: #94a3b8;
            
            --color-blue: #3b82f6;
            --color-red: #ef4444;
            --color-orange: #f59e0b;
            --color-green: #10b981;
            --color-purple: #8b5cf6;
            
            --transition-speed: 0.2s;
        }

        * {
            box-sizing: border-box;
            margin: 0;
            padding: 0;
        }

        body {
            font-family: 'Outfit', sans-serif;
            background: linear-gradient(135deg, #090d16 0%, #0f172a 100%);
            color: var(--text-primary);
            min-height: 100vh;
            display: flex;
            flex-direction: column;
            overflow-x: hidden;
        }

        /* Glassmorphism Header */
        header {
            background: rgba(15, 23, 42, 0.8);
            backdrop-filter: blur(12px);
            border-bottom: 1px solid var(--border-color);
            padding: 1rem 2rem;
            display: flex;
            justify-content: space-between;
            align-items: center;
            position: sticky;
            top: 0;
            z-index: 100;
        }

        header h1 {
            font-size: 1.25rem;
            font-weight: 700;
            display: flex;
            align-items: center;
            gap: 0.5rem;
            background: linear-gradient(to right, #3b82f6, #8b5cf6);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
        }

        .sys-badge {
            background: rgba(59, 130, 246, 0.15);
            border: 1px solid rgba(59, 130, 246, 0.3);
            color: var(--color-blue);
            padding: 0.25rem 0.75rem;
            border-radius: 9999px;
            font-size: 0.8rem;
            font-weight: 600;
        }

        .container {
            display: flex;
            flex: 1;
            max-width: 1600px;
            width: 100%;
            margin: 0 auto;
            position: relative;
        }

        /* Sidebar Navigation */
        aside {
            width: 260px;
            background: rgba(15, 23, 42, 0.4);
            border-right: 1px solid var(--border-color);
            padding: 2rem 1rem;
            display: flex;
            flex-direction: column;
            gap: 0.5rem;
        }

        .tab-btn {
            background: transparent;
            border: 1px solid transparent;
            color: var(--text-secondary);
            padding: 0.75rem 1rem;
            border-radius: 8px;
            text-align: left;
            font-size: 0.95rem;
            font-weight: 500;
            cursor: pointer;
            display: flex;
            align-items: center;
            gap: 0.75rem;
            transition: all var(--transition-speed);
        }

        .tab-btn:hover {
            background: rgba(255, 255, 255, 0.03);
            color: var(--text-primary);
        }

        .tab-btn.active {
            background: rgba(59, 130, 246, 0.1);
            border-color: rgba(59, 130, 246, 0.2);
            color: var(--color-blue);
        }

        /* Main Workspace */
        main {
            flex: 1;
            padding: 2rem;
            overflow-y: auto;
        }

        .tab-panel {
            display: none;
            animation: fadeIn 0.3s ease;
        }

        .tab-panel.active {
            display: block;
        }

        @keyframes fadeIn {
            from { opacity: 0; transform: translateY(10px); }
            to { opacity: 1; transform: translateY(0); }
        }

        /* Cards & Grid Layouts */
        .grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
            gap: 1.5rem;
            margin-bottom: 2rem;
        }

        .card {
            background: var(--bg-surface);
            backdrop-filter: blur(10px);
            border: 1px solid var(--border-color);
            border-radius: 12px;
            padding: 1.5rem;
            transition: transform var(--transition-speed);
        }

        .card:hover {
            transform: translateY(-2px);
        }

        .card h2 {
            font-size: 1.1rem;
            font-weight: 600;
            margin-bottom: 1rem;
            color: var(--text-primary);
            display: flex;
            justify-content: space-between;
            align-items: center;
        }

        /* Controls & Form inputs */
        .btn {
            background: var(--color-blue);
            color: #fff;
            border: none;
            padding: 0.6rem 1.2rem;
            border-radius: 6px;
            font-weight: 600;
            cursor: pointer;
            transition: background var(--transition-speed);
            display: inline-flex;
            align-items: center;
            justify-content: center;
            gap: 0.5rem;
        }

        .btn:hover {
            filter: brightness(1.1);
        }

        .btn-red { background: var(--color-red); }
        .btn-green { background: var(--color-green); }
        .btn-orange { background: var(--color-orange); }
        .btn-purple { background: var(--color-purple); }
        .btn-secondary { background: rgba(255, 255, 255, 0.08); color: var(--text-primary); }

        .btn:disabled {
            opacity: 0.5;
            cursor: not-allowed;
        }

        .form-group {
            margin-bottom: 1rem;
        }

        .form-group label {
            display: block;
            font-size: 0.85rem;
            color: var(--text-secondary);
            margin-bottom: 0.4rem;
        }

        .form-control {
            width: 100%;
            background: rgba(15, 23, 42, 0.8);
            border: 1px solid var(--border-color);
            border-radius: 6px;
            color: var(--text-primary);
            padding: 0.5rem 0.75rem;
            font-family: inherit;
        }

        /* Status indicators */
        .indicator {
            display: inline-block;
            width: 10px;
            height: 10px;
            border-radius: 50%;
            margin-right: 0.5rem;
        }
        .ind-green { background-color: var(--color-green); box-shadow: 0 0 8px var(--color-green); }
        .ind-red { background-color: var(--color-red); box-shadow: 0 0 8px var(--color-red); }
        .ind-orange { background-color: var(--color-orange); box-shadow: 0 0 8px var(--color-orange); }

        /* Timeline Log Stream */
        .timeline-container {
            background: rgba(15, 23, 42, 0.4);
            border: 1px solid var(--border-color);
            border-radius: 12px;
            height: 500px;
            overflow-y: auto;
            padding: 1rem;
            font-family: 'Courier New', Courier, monospace;
            font-size: 0.85rem;
            display: flex;
            flex-direction: column;
            gap: 0.5rem;
        }

        .timeline-row {
            padding: 0.6rem 0.8rem;
            border-radius: 6px;
            background: rgba(255, 255, 255, 0.02);
            border-left: 3px solid var(--color-blue);
            display: flex;
            flex-direction: column;
            gap: 0.25rem;
            animation: slideIn 0.2s ease;
        }

        @keyframes slideIn {
            from { opacity: 0; transform: translateX(-10px); }
            to { opacity: 1; transform: translateX(0); }
        }

        .timeline-meta {
            display: flex;
            justify-content: space-between;
            color: var(--text-secondary);
            font-size: 0.75rem;
        }

        .timeline-msg {
            color: var(--text-primary);
            word-break: break-all;
        }

        /* Grid specific to Failure injections */
        .failures-grid {
            display: grid;
            grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
            gap: 1rem;
        }

        .failure-card {
            background: var(--bg-card);
            border: 1px solid var(--border-color);
            border-radius: 8px;
            padding: 1rem;
            display: flex;
            flex-direction: column;
            justify-content: space-between;
            gap: 1rem;
        }
        
        .flex-between {
            display: flex;
            justify-content: space-between;
            align-items: center;
        }
    </style>
</head>
<body>
    <header>
        <h1>🛡️ Execution Watchdog <span class="sys-badge">Test Control Lab</span></h1>
        <div id="read-only-badge" class="sys-badge" style="display:none; background:rgba(239, 68, 68, 0.15); border-color:rgba(239, 68, 68, 0.3); color:var(--color-red);">READ ONLY MODE</div>
    </header>

    <div class="container">
        <!-- Sidebar Navigation -->
        <aside>
            <button class="tab-btn active" onclick="switchTab('dashboard')">📊 Dashboard</button>
            <button class="tab-btn" onclick="switchTab('health')">❤️ Health Status</button>
            <button class="tab-btn" onclick="switchTab('failures')">⚠️ Failure Injection</button>
            <button class="tab-btn" onclick="switchTab('runtime')">🎛️ Runtime Controls</button>
            <button class="tab-btn" onclick="switchTab('infra')">⚙️ Infrastructure</button>
            <button class="tab-btn" onclick="switchTab('timeline')">📜 Event Timeline</button>
        </aside>

        <!-- Main Content -->
        <main>
            <!-- Panel: Dashboard -->
            <div id="panel-dashboard" class="tab-panel active">
                <div class="grid">
                    <div class="card">
                        <h2>System Metrics</h2>
                        <div class="form-group flex-between">
                            <span style="color:var(--text-secondary)">Uptime</span>
                            <span id="uptime-display">0s</span>
                        </div>
                        <div class="form-group flex-between">
                            <span style="color:var(--text-secondary)">API Version</span>
                            <span>1.0.0</span>
                        </div>
                    </div>
                    <div class="card">
                        <h2>Simulation State</h2>
                        <div class="form-group flex-between">
                            <span style="color:var(--text-secondary)">Active Injected Failures</span>
                            <span id="active-failures-count" style="font-weight:700">0</span>
                        </div>
                        <div class="form-group flex-between">
                            <span style="color:var(--text-secondary)">RingBuffer Queue Size</span>
                            <span id="ringbuffer-count">0</span>
                        </div>
                    </div>
                </div>

                <div class="card">
                    <h2>Live Activity Stream</h2>
                    <div id="dashboard-timeline" class="timeline-container" style="height: 300px;"></div>
                </div>
            </div>

            <!-- Panel: Health -->
            <div id="panel-health" class="tab-panel">
                <div class="grid">
                    <div class="card">
                        <h2>Infrastructure Health</h2>
                        <div style="display:flex; flex-direction:column; gap:1rem;">
                            <div class="flex-between">
                                <span>Freqtrade Container</span>
                                <span id="health-freqtrade-badge"><span class="indicator ind-orange"></span>Loading</span>
                            </div>
                            <div class="flex-between">
                                <span>Database Connection</span>
                                <span id="health-postgres-badge"><span class="indicator ind-green"></span>Healthy</span>
                            </div>
                        </div>
                    </div>
                </div>
            </div>

            <!-- Panel: Failure Injection -->
            <div id="panel-failures" class="tab-panel">
                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:1.5rem;">
                    <h2>Simulate System Anomalies</h2>
                    <button class="btn btn-red" onclick="clearAllFailures()">🧹 Clear All Failures</button>
                </div>
                
                <div class="failures-grid">
                    <!-- Failure Card: DNS FAILURE -->
                    <div class="failure-card">
                        <div>
                            <div class="flex-between" style="margin-bottom:0.5rem;">
                                <strong style="font-size:0.95rem;">DNS Failure</strong>
                                <span class="sys-badge">INFRA</span>
                            </div>
                            <p style="font-size:0.8rem; color:var(--text-secondary)">Causes host lookup checks for exchange endpoints to fail.</p>
                        </div>
                        <div class="flex-between">
                            <input type="number" id="dns-ttl" placeholder="TTL (sec)" class="form-control" style="width:100px; padding:0.3rem;" value="30">
                            <button class="btn btn-orange" onclick="injectFailure('DNS_FAILURE', 'INFRASTRUCTURE', 'dns-ttl')">Inject</button>
                        </div>
                    </div>

                    <!-- Failure Card: NETWORK TIMEOUT -->
                    <div class="failure-card">
                        <div>
                            <div class="flex-between" style="margin-bottom:0.5rem;">
                                <strong style="font-size:0.95rem;">Network Timeout</strong>
                                <span class="sys-badge">INFRA</span>
                            </div>
                            <p style="font-size:0.8rem; color:var(--text-secondary)">Simulates drop packets on API HTTP validation checks.</p>
                        </div>
                        <div class="flex-between">
                            <input type="number" id="net-ttl" placeholder="TTL (sec)" class="form-control" style="width:100px; padding:0.3rem;" value="30">
                            <button class="btn btn-orange" onclick="injectFailure('NETWORK_TIMEOUT', 'INFRASTRUCTURE', 'net-ttl')">Inject</button>
                        </div>
                    </div>

                    <!-- Failure Card: HEARTBEAT LOSS -->
                    <div class="failure-card">
                        <div>
                            <div class="flex-between" style="margin-bottom:0.5rem;">
                                <strong style="font-size:0.95rem;">Heartbeat Loss</strong>
                                <span class="sys-badge">OPERATIONS</span>
                            </div>
                            <p style="font-size:0.8rem; color:var(--text-secondary)">Stops heartbeat ticks to simulate daemon silence.</p>
                        </div>
                        <div class="flex-between">
                            <input type="number" id="heart-ttl" placeholder="TTL (sec)" class="form-control" style="width:100px; padding:0.3rem;" value="30">
                            <button class="btn btn-orange" onclick="injectFailure('HEARTBEAT_LOSS', 'OPERATIONS', 'heart-ttl')">Inject</button>
                        </div>
                    </div>
                </div>
            </div>

            <!-- Panel: Runtime Controls -->
            <div id="panel-runtime" class="tab-panel">
                <h2>Subsystem Runtime Controls</h2>
                <p style="color:var(--text-secondary); margin-bottom:1.5rem;">Enable or disable internal monitoring adapters and capabilities at runtime.</p>
                
                <div class="grid" id="runtime-controls-container">
                    <!-- Loaded dynamically -->
                </div>
            </div>

            <!-- Panel: Infrastructure -->
            <div id="panel-infra" class="tab-panel">
                <h2>Docker & Process Container Controls</h2>
                <p style="color:var(--text-secondary); margin-bottom:1.5rem;">Predefined whitelist actions executed via CommandRunner.</p>

                <div class="card" style="max-width: 600px;">
                    <h2>Freqtrade Controls</h2>
                    <div style="display:flex; gap:1rem;">
                        <button class="btn btn-secondary" onclick="executeCommand('START_FREQTRADE')">▶️ Start Container</button>
                        <button class="btn btn-red" onclick="executeCommand('STOP_FREQTRADE')">🛑 Stop Container</button>
                        <button class="btn btn-orange" onclick="executeCommand('RESTART_FREQTRADE')">🔄 Restart Container</button>
                    </div>
                </div>
            </div>

            <!-- Panel: Event Timeline -->
            <div id="panel-timeline" class="tab-panel">
                <h2>Historical Event Timeline</h2>
                <p style="color:var(--text-secondary); margin-bottom:1.5rem;">Real-time feed maps internal events with severity color highlights.</p>
                <div id="main-timeline" class="timeline-container"></div>
            </div>
        </main>
    </div>

    <script>
        let sseSource = null;
        let isReadOnlyMode = false;

        function switchTab(tabId) {
            document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
            document.querySelectorAll('.tab-panel').forEach(panel => panel.classList.remove('active'));

            const activeBtn = Array.from(document.querySelectorAll('.tab-btn')).find(btn => btn.textContent.toLowerCase().includes(tabId));
            if (activeBtn) activeBtn.classList.add('active');

            const activePanel = document.getElementById('panel-' + tabId);
            if (activePanel) activePanel.classList.add('active');
        }

        async function fetchHealth() {
            try {
                const res = await fetch('/health');
                const json = await res.json();
                if (json.success) {
                    document.getElementById('uptime-display').textContent = Math.round(json.data.uptime) + 's';
                    isReadOnlyMode = json.data.readOnly;
                    document.getElementById('read-only-badge').style.display = isReadOnlyMode ? 'block' : 'none';
                }
            } catch (err) {
                console.error('Failed to fetch health status:', err);
            }
        }

        async function fetchFreqtradeStatus() {
            try {
                const res = await fetch('/api/v1/infra/status');
                const json = await res.json();
                const badge = document.getElementById('health-freqtrade-badge');
                if (json.success) {
                    const status = json.data.status;
                    if (status === 'running') {
                        badge.innerHTML = '<span class="indicator ind-green"></span>Running';
                    } else if (status === 'exited' || status === 'stopped') {
                        badge.innerHTML = '<span class="indicator ind-red"></span>Stopped';
                    } else {
                        badge.innerHTML = '<span class="indicator ind-orange"></span>' + status;
                    }
                }
            } catch (err) {
                console.error('Failed to fetch container status:', err);
            }
        }

        async function injectFailure(type, scope, ttlInputId) {
            const ttlVal = document.getElementById(ttlInputId).value;
            const payload = {
                type,
                scope,
                ttlSeconds: ttlVal ? parseInt(ttlVal) : undefined,
                correlationId: 'req_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5)
            };

            try {
                const res = await fetch('/api/v1/failures/inject', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });
                const json = await res.json();
                if (!json.success) alert(json.message);
            } catch (err) {
                alert('Request failed: ' + err.message);
            }
        }

        async function clearAllFailures() {
            try {
                const res = await fetch('/api/v1/failures/clear-all', { method: 'POST' });
                const json = await res.json();
                if (!json.success) alert(json.message);
            } catch (err) {
                alert('Request failed: ' + err.message);
            }
        }

        async function executeCommand(command) {
            const payload = {
                command,
                correlationId: 'req_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5)
            };

            try {
                const res = await fetch('/api/v1/infra/command', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });
                const json = await res.json();
                if (!json.success) {
                    alert(json.message);
                } else {
                    setTimeout(fetchFreqtradeStatus, 1500); // refresh status indicator
                }
            } catch (err) {
                alert('Execution failed: ' + err.message);
            }
        }

        function appendEventToTimeline(msg) {
            const timeStr = new Date(msg.timestamp).toLocaleTimeString();
            const borderStyle = 'border-left-color: ' + msg.color;
            
            const html = \`<div class="timeline-row" style="\${borderStyle}">
                <div class="timeline-meta">
                    <span>\${msg.icon} \${msg.title}</span>
                    <span>\${timeStr}</span>
                </div>
                <div class="timeline-msg">\${msg.description}</div>
                \${msg.correlationId ? \`<div class="timeline-meta" style="font-size:0.7rem;">Correlation ID: \${msg.correlationId}</div>\` : ''}
            </div>\`;

            // Append to main timeline
            const mainTimeline = document.getElementById('main-timeline');
            mainTimeline.insertAdjacentHTML('beforeend', html);
            mainTimeline.scrollTop = mainTimeline.scrollHeight;

            // Append to dashboard brief timeline
            const dashTimeline = document.getElementById('dashboard-timeline');
            dashTimeline.insertAdjacentHTML('beforeend', html);
            dashTimeline.scrollTop = dashTimeline.scrollHeight;
        }

        async function fetchRuntimeFlags() {
            try {
                const res = await fetch('/api/v1/flags');
                const json = await res.json();
                if (json.success) {
                    renderRuntimeFlags(json.data);
                }
            } catch (err) {
                console.error('Failed to fetch runtime flags:', err);
            }
        }

        function renderRuntimeFlags(flags) {
            const container = document.getElementById('runtime-controls-container');
            container.innerHTML = '';
            
            for (const [key, meta] of Object.entries(flags)) {
                const statusHtml = meta.enabled 
                    ? \`\<span id="badge-flag-\${key}" style="font-weight:600; color:var(--color-green); display:inline-flex; align-items:center;"><span class="indicator ind-green"></span>ENABLED</span>\`
                    : \`\<span id="badge-flag-\${key}" style="font-weight:600; color:var(--color-red); display:inline-flex; align-items:center;"><span class="indicator ind-red"></span>DISABLED</span>\`;
                    
                const buttonHtml = meta.enabled
                    ? \`\<button id="btn-flag-\${key}" class="btn btn-red" style="padding:0.4rem 0.8rem; font-size:0.85rem;" onclick="setFeatureFlag('\${key}', false)">Disable</button>\`
                    : \`\<button id="btn-flag-\${key}" class="btn btn-green" style="padding:0.4rem 0.8rem; font-size:0.85rem;" onclick="setFeatureFlag('\${key}', true)">Enable</button>\`;
                    
                const cardHtml = \`
                    <div class="card" style="padding:1.5rem; display:flex; flex-direction:column; justify-content:space-between; gap:1rem;">
                        <div>
                            <h3 style="font-size:1.1rem; margin-bottom:0.3rem;">\${meta.name}</h3>
                            <p style="font-size:0.85rem; color:var(--text-secondary); line-height:1.4;">\${meta.description}</p>
                        </div>
                        <div class="flex-between">
                            <div style="font-size:0.9rem;">
                                <span style="color:var(--text-secondary);">Status:</span>
                                \${statusHtml}
                            </div>
                            \${buttonHtml}
                        </div>
                    </div>
                \`;
                container.insertAdjacentHTML('beforeend', cardHtml);
            }
        }

        async function setFeatureFlag(flag, enabled) {
            const promptRes = prompt(\`Enter reason for updating feature flag \${flag}:\`, 'Developer Console');
            if (promptRes === null) return;
            const reason = promptRes || 'Developer Console';
            const payload = {
                enabled,
                reason,
                correlationId: 'req_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5)
            };

            try {
                const res = await fetch(\`/api/v1/flags/\${flag}\`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });
                const json = await res.json();
                if (!json.success) alert(json.message);
            } catch (err) {
                alert('Request failed: ' + err.message);
            }
        }

        function setupSseStream() {
            if (sseSource) sseSource.close();
            
            sseSource = new EventSource('/api/v1/events/stream');
            
            sseSource.onmessage = function(event) {
                try {
                    const msg = JSON.parse(event.data);
                    appendEventToTimeline(msg);
                    
                    // Dynamically keep track of ringbuffer size
                    const countEl = document.getElementById('ringbuffer-count');
                    let currentCount = parseInt(countEl.textContent) || 0;
                    if (currentCount < 100) currentCount++;
                    countEl.textContent = currentCount;

                    // Dynamically inspect failure count
                    if (msg.type === 'FAILURE_INJECTED') {
                        let activeCount = parseInt(document.getElementById('active-failures-count').textContent) || 0;
                        document.getElementById('active-failures-count').textContent = activeCount + 1;
                    } else if (msg.type === 'FAILURE_CLEARED') {
                        let activeCount = parseInt(document.getElementById('active-failures-count').textContent) || 0;
                        if (activeCount > 0) document.getElementById('active-failures-count').textContent = activeCount - 1;
                    } else if (msg.type === 'FEATURE_FLAG_CHANGED') {
                        fetchRuntimeFlags();
                    }
                } catch (e) {
                    console.error('Error parsing SSE event data:', e);
                }
            };

            sseSource.onerror = function(err) {
                console.error('SSE Connection error, reconnecting...', err);
            };
        }

        // Initial setup
        fetchHealth();
        fetchFreqtradeStatus();
        fetchRuntimeFlags();
        setupSseStream();

        // Intervals
        setInterval(fetchHealth, 5000);
        setInterval(fetchFreqtradeStatus, 8000);
    </script>
</body>
</html>`;
