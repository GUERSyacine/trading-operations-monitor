export const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Execution Watchdog — Operations QA Console</title>
    <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;600;700&family=Fira+Code:wght@400;500&display=swap" rel="stylesheet">
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
            background: linear-gradient(to right, #3b82f6, #10b981);
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

        /* Sidebar Navigation folders */
        aside {
            width: 280px;
            background: rgba(15, 23, 42, 0.4);
            border-right: 1px solid var(--border-color);
            padding: 1.5rem 1rem;
            display: flex;
            flex-direction: column;
            gap: 1rem;
        }

        .sidebar-folder {
            display: flex;
            flex-direction: column;
            gap: 0.25rem;
        }

        .sidebar-folder-header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            background: transparent;
            border: none;
            color: var(--text-primary);
            padding: 0.5rem 0.75rem;
            font-size: 0.8rem;
            font-weight: 700;
            text-transform: uppercase;
            letter-spacing: 0.05em;
            text-align: left;
            cursor: pointer;
            outline: none;
            user-select: none;
            border-bottom: 1px solid rgba(255,255,255,0.03);
            margin-bottom: 0.25rem;
        }

        .sidebar-folder-header .folder-arrow {
            transition: transform var(--transition-speed);
            font-size: 0.75rem;
            opacity: 0.5;
        }

        .sidebar-folder.collapsed .sidebar-folder-header .folder-arrow {
            transform: rotate(-90deg);
        }

        .sidebar-folder-items {
            display: flex;
            flex-direction: column;
            gap: 0.25rem;
            padding-left: 0.5rem;
            transition: max-height var(--transition-speed) ease-out, opacity var(--transition-speed);
            overflow: hidden;
        }

        .sidebar-folder.collapsed .sidebar-folder-items {
            max-height: 0 !important;
            opacity: 0;
            padding-top: 0;
            padding-bottom: 0;
            margin: 0;
        }

        /* Themed Accents */
        .folder-internal .sidebar-folder-header {
            color: var(--color-blue);
        }
        .folder-internal .tab-btn.active {
            background: rgba(59, 130, 246, 0.1);
            border-color: rgba(59, 130, 246, 0.2);
            color: var(--color-blue);
        }

        .folder-distributed .sidebar-folder-header {
            color: var(--color-green);
        }
        .folder-distributed .tab-btn.active {
            background: rgba(16, 185, 129, 0.1);
            border-color: rgba(16, 185, 129, 0.2);
            color: var(--color-green);
        }

        .folder-admin .sidebar-folder-header {
            color: var(--color-orange);
        }
        .folder-admin .tab-btn.active {
            background: rgba(245, 158, 11, 0.1);
            border-color: rgba(245, 158, 11, 0.2);
            color: var(--color-orange);
        }

        .tab-btn {
            background: transparent;
            border: 1px solid transparent;
            color: var(--text-secondary);
            padding: 0.6rem 0.75rem;
            border-radius: 8px;
            text-align: left;
            font-size: 0.9rem;
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

        .btn:disabled {
            opacity: 0.5;
            cursor: not-allowed;
        }

        .btn-red { background: var(--color-red); }
        .btn-green { background: var(--color-green); }
        .btn-orange { background: var(--color-orange); }
        .btn-purple { background: var(--color-purple); }
        .btn-secondary { background: rgba(255, 255, 255, 0.08); color: var(--text-primary); }

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
            font-family: 'Fira Code', monospace;
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

        /* Dynamic QA card styling */
        .qa-grid {
            display: grid;
            grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
            gap: 1.5rem;
            margin-bottom: 2rem;
        }

        .qa-card {
            background: var(--bg-surface);
            border: 1px solid var(--border-color);
            border-radius: 12px;
            padding: 1.5rem;
            display: flex;
            flex-direction: column;
            justify-content: space-between;
            transition: transform var(--transition-speed);
        }

        .qa-card:hover {
            transform: translateY(-2px);
            border-color: rgba(16, 185, 129, 0.3);
        }

        .qa-card-header {
            display: flex;
            justify-content: space-between;
            align-items: flex-start;
            margin-bottom: 0.5rem;
        }

        .qa-card-title {
            font-weight: 600;
            font-size: 1.05rem;
            color: var(--text-primary);
        }

        .qa-card-desc {
            font-size: 0.85rem;
            color: var(--text-secondary);
            margin-bottom: 1rem;
            line-height: 1.4;
        }

        .qa-assertions-box {
            background: rgba(0, 0, 0, 0.2);
            border-radius: 6px;
            padding: 0.75rem;
            font-size: 0.8rem;
            font-family: 'Fira Code', monospace;
            margin-bottom: 1rem;
        }

        .qa-assertion-item {
            display: flex;
            align-items: center;
            gap: 0.5rem;
            margin-bottom: 0.25rem;
        }

        .qa-assertion-item:last-child {
            margin-bottom: 0;
        }

        .qa-status-row {
            display: flex;
            justify-content: space-between;
            align-items: center;
            font-size: 0.85rem;
            color: var(--text-secondary);
            margin-top: 1rem;
            border-top: 1px solid var(--border-color);
            padding-top: 1rem;
        }

        .qa-console {
            background: #090d16;
            border: 1px solid rgba(255,255,255,0.05);
            border-radius: 6px;
            padding: 0.75rem;
            margin-top: 0.75rem;
            font-family: 'Fira Code', monospace;
            font-size: 0.75rem;
            max-height: 150px;
            overflow-y: auto;
            white-space: pre-wrap;
            color: #10b981;
            display: none;
        }

        .progress-bar-container {
            width: 100%;
            height: 6px;
            background: rgba(255,255,255,0.05);
            border-radius: 999px;
            overflow: hidden;
            margin-top: 0.25rem;
        }

        .progress-bar-fill {
            height: 100%;
            background: var(--color-green);
            transition: width 0.3s ease;
        }

        /* Pulsing Online Badge */
        .online-dot {
            width: 8px;
            height: 8px;
            background-color: var(--color-green);
            border-radius: 50%;
            box-shadow: 0 0 0 0 rgba(16, 185, 129, 0.7);
            animation: pulse-green 2s infinite;
        }

        @keyframes pulse-green {
            0% {
                transform: scale(0.95);
                box-shadow: 0 0 0 0 rgba(16, 185, 129, 0.7);
            }
            70% {
                transform: scale(1);
                box-shadow: 0 0 0 6px rgba(16, 185, 129, 0);
            }
            100% {
                transform: scale(0.95);
                box-shadow: 0 0 0 0 rgba(16, 185, 129, 0);
            }
        }
    </style>
</head>
<body>
    <header>
        <h1>🛡️ Execution Watchdog <span class="sys-badge" style="color:var(--color-green); background:rgba(16,185,129,0.15); border-color:rgba(16,185,129,0.3);">Operations QA Console</span></h1>
        <div id="read-only-badge" class="sys-badge" style="display:none; background:rgba(239, 68, 68, 0.15); border-color:rgba(239, 68, 68, 0.3); color:var(--color-red);">READ ONLY MODE</div>
    </header>

    <div class="container">
        <!-- Sidebar Navigation -->
        <aside>
            <button class="tab-btn active" style="margin-bottom: 0.5rem;" onclick="switchTab('dashboard')">📊 Dashboard</button>

            <!-- Internal Validation -->
            <div class="sidebar-folder folder-internal" id="folder-internal">
                <button class="sidebar-folder-header" onclick="toggleFolder('internal')">
                    <span>🧠 Internal Validation</span>
                    <span class="folder-arrow">▼</span>
                </button>
                <div class="sidebar-folder-items">
                    <button class="tab-btn" onclick="switchTab('health')">❤️ Health Status</button>
                    <button class="tab-btn" onclick="switchTab('operations')">🔌 Operations Lab</button>
                    <button class="tab-btn" onclick="switchTab('replay')">🔄 Replay & Forensics</button>
                    <button class="tab-btn" onclick="switchTab('infra')">⚙️ Infrastructure</button>
                    <button class="tab-btn" onclick="switchTab('timeline')">📜 Event Timeline</button>
                </div>
            </div>

            <!-- Distributed Validation -->
            <div class="sidebar-folder folder-distributed" id="folder-distributed">
                <button class="sidebar-folder-header" onclick="toggleFolder('distributed')">
                    <span>🌍 Distributed Validation</span>
                    <span class="folder-arrow">▼</span>
                </button>
                <div class="sidebar-folder-items">
                    <button class="tab-btn" onclick="switchTab('dist-status')">🟢 Distributed Status</button>
                    <button class="tab-btn" onclick="switchTab('dist-identity')">🔑 Agent Identity</button>
                    <button class="tab-btn" onclick="switchTab('dist-gateway')">☁️ Cloud Communication</button>
                    <button class="tab-btn" onclick="switchTab('dist-sync')">🔄 Synchronization</button>
                    <button class="tab-btn" onclick="switchTab('dist-smoke')">⚡ Smoke Tests</button>
                </div>
            </div>

            <!-- Administration -->
            <div class="sidebar-folder folder-admin" id="folder-admin">
                <button class="sidebar-folder-header" onclick="toggleFolder('admin')">
                    <span>⚙️ Administration</span>
                    <span class="folder-arrow">▼</span>
                </button>
                <div class="sidebar-folder-items">
                    <button class="tab-btn" onclick="switchTab('runtime')">🎛️ Runtime Controls</button>
                    <button class="tab-btn" onclick="switchTab('failures')">⚠️ Failure Injection</button>
                </div>
            </div>
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

            <!-- Panel: Operations Lab -->
            <div id="panel-operations" class="tab-panel">
                <h2>🔌 Operations Simulation Lab</h2>
                <p style="color:var(--text-secondary); margin-bottom:1.5rem;">
                    Validate order lifecycle sequences, timeout monitors, and FSM transition rules by injecting canonical simulation events.
                </p>

                <div style="margin-bottom: 2rem; display: flex; gap: 1rem; align-items: center; background: rgba(239,68,68,0.05); border: 1px dashed rgba(239,68,68,0.2); border-radius: 8px; padding: 1rem; max-width: 800px;">
                    <button class="btn btn-red" onclick="resetSimulationLab()" style="background: rgba(239,68,68,0.2); border-color: rgba(239, 68, 68, 0.4); color: var(--color-red); font-weight: 600; padding: 0.6rem 1.2rem;">
                        🧹 Reset Simulation Lab
                    </button>
                    <span style="font-size:0.85rem; color:var(--text-secondary); line-height: 1.4;">
                        Clears all simulated telemetry audits, alerts, and incidents from the database and memory. Resets consecutive violation counters.
                    </span>
                </div>

                <!-- Collapsible Advanced Options -->
                <details style="margin-bottom: 2rem; max-width: 800px; background: rgba(30, 41, 59, 0.4); border: 1px solid var(--border-color); border-radius: 8px; padding: 1rem;">
                    <summary style="font-size: 0.95rem; font-weight: 600; color: var(--text-secondary); cursor: pointer; outline: none; user-select: none;">
                        Advanced Simulation Options
                    </summary>
                    <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 1rem; margin-top: 1rem;">
                        <div>
                            <label style="font-size:0.8rem; color:var(--text-secondary); display:block; margin-bottom:0.3rem;">Trade ID Override (Optional)</label>
                            <input type="text" id="sim-trade-id" class="form-control" style="width: 100%; padding: 0.5rem; background: var(--bg-card); border: 1px solid var(--border-color); color: white; border-radius: 4px;" placeholder="Auto-generated if left blank">
                        </div>
                        <div>
                            <label style="font-size:0.8rem; color:var(--text-secondary); display:block; margin-bottom:0.3rem;">Symbol Override</label>
                            <input type="text" id="sim-symbol" class="form-control" style="width: 100%; padding: 0.5rem; background: var(--bg-card); border: 1px solid var(--border-color); color: white; border-radius: 4px;" placeholder="e.g. BTCUSDT" value="BTCUSDT">
                        </div>
                        <div>
                            <label style="font-size:0.8rem; color:var(--text-secondary); display:block; margin-bottom:0.3rem;">Age Seconds (Offset)</label>
                            <input type="number" id="sim-offset-sec" class="form-control" style="width: 100%; padding: 0.5rem; background: var(--bg-card); border: 1px solid var(--border-color); color: white; border-radius: 4px;" placeholder="e.g. 0" value="0">
                        </div>
                    </div>
                </details>

                <!-- Section: Expected Healthy Flows -->
                <div style="margin-bottom: 2.5rem;">
                    <h3 style="font-size: 1.25rem; border-bottom: 1px solid var(--border-color); padding-bottom: 0.5rem; margin-bottom: 1.2rem; color: var(--color-green);">Expected Healthy Flows</h3>
                    <div class="failures-grid">
                        <div class="failure-card">
                            <div>
                                <div class="flex-between" style="margin-bottom:0.5rem;">
                                    <strong style="font-size:0.95rem;">Happy Path (Entry) <span style="font-size:0.8rem; font-weight:normal; opacity:0.6;">(C1)</span></strong>
                                    <span class="sys-badge" style="color:var(--color-green); background:rgba(16,185,129,0.15); border-color:rgba(16,185,129,0.3)">HEALTHY</span>
                                </div>
                                <p style="font-size:0.8rem; color:var(--text-secondary); margin-bottom:0.75rem;">Simulates a standard, successful entry lifecycle flow: ORDER_CREATED &rarr; ORDER_OPEN &rarr; ORDER_FILLED.</p>
                                <div style="font-size:0.75rem; background:rgba(0,0,0,0.2); border-radius:4px; padding:0.5rem; color:var(--text-secondary); font-family:monospace; line-height:1.4;">
                                    <strong style="color:var(--color-green);">Expected Result:</strong><br>
                                    ✓ System remains healthy<br>
                                    ✓ Timeline logs C1 flow<br>
                                    ✓ No incidents triggered
                                </div>
                            </div>
                            <button class="btn btn-green" onclick="runOperationsScenario('ENTRY_EXECUTION')">Run Scenario</button>
                        </div>

                        <div class="failure-card">
                            <div>
                                <div class="flex-between" style="margin-bottom:0.5rem;">
                                    <strong style="font-size:0.95rem;">Cancelled Entry <span style="font-size:0.8rem; font-weight:normal; opacity:0.6;">(C2)</span></strong>
                                    <span class="sys-badge" style="color:var(--color-green); background:rgba(16,185,129,0.15); border-color:rgba(16,185,129,0.3)">HEALTHY</span>
                                </div>
                                <p style="font-size:0.8rem; color:var(--text-secondary); margin-bottom:0.75rem;">Simulates an entry order cancellation before fill execution: ORDER_CREATED &rarr; ORDER_CANCELLED.</p>
                                <div style="font-size:0.75rem; background:rgba(0,0,0,0.2); border-radius:4px; padding:0.5rem; color:var(--text-secondary); font-family:monospace; line-height:1.4;">
                                    <strong style="color:var(--color-green);">Expected Result:</strong><br>
                                    ✓ System remains healthy<br>
                                    ✓ Order state cancelled<br>
                                    ✓ No warning/incident
                                </div>
                            </div>
                            <button class="btn btn-green" onclick="runOperationsScenario('ORDER_CANCEL')">Run Scenario</button>
                        </div>

                        <div class="failure-card">
                            <div>
                                <div class="flex-between" style="margin-bottom:0.5rem;">
                                    <strong style="font-size:0.95rem;">Position Exit <span style="font-size:0.8rem; font-weight:normal; opacity:0.6;">(C3)</span></strong>
                                    <span class="sys-badge" style="color:var(--color-green); background:rgba(16,185,129,0.15); border-color:rgba(16,185,129,0.3)">HEALTHY</span>
                                </div>
                                <p style="font-size:0.8rem; color:var(--text-secondary); margin-bottom:0.75rem;">Simulates standard exit position closure flow: ORDER_CREATED &rarr; ORDER_OPEN &rarr; ORDER_FILLED.</p>
                                <div style="font-size:0.75rem; background:rgba(0,0,0,0.2); border-radius:4px; padding:0.5rem; color:var(--text-secondary); font-family:monospace; line-height:1.4;">
                                    <strong style="color:var(--color-green);">Expected Result:</strong><br>
                                    ✓ System remains healthy<br>
                                    ✓ Timeline logs C3 flow<br>
                                    ✓ No warnings/incidents
                                </div>
                            </div>
                            <button class="btn btn-green" onclick="runOperationsScenario('POSITION_EXIT')">Run Scenario</button>
                        </div>
                    </div>
                </div>

                <!-- Section: Anomaly / Failure Scenarios -->
                <div>
                    <h3 style="font-size: 1.25rem; border-bottom: 1px solid var(--border-color); padding-bottom: 0.5rem; margin-bottom: 1.2rem; color: var(--color-red);">Anomaly / Failure Scenarios</h3>
                    <div class="failures-grid">
                        <div class="failure-card">
                            <div>
                                <div class="flex-between" style="margin-bottom:0.5rem;">
                                    <strong style="font-size:0.95rem;">Open Order Timeout <span style="font-size:0.8rem; font-weight:normal; opacity:0.6;">(C4)</span></strong>
                                    <span class="sys-badge" style="color:var(--color-orange); background:rgba(245,158,11,0.15); border-color:rgba(245,158,11,0.3)">WARNING</span>
                                </div>
                                <p style="font-size:0.8rem; color:var(--text-secondary); margin-bottom:0.75rem;">Injects an ORDER_CREATED event 70 seconds in the past with no resolution, triggering stuck order alerts in the next sweep.</p>
                                <div style="font-size:0.75rem; background:rgba(0,0,0,0.2); border-radius:4px; padding:0.5rem; color:var(--text-secondary); font-family:monospace; line-height:1.4;">
                                    <strong style="color:var(--color-orange);">Expected Result:</strong><br>
                                    ✓ Timeout Warning triggered<br>
                                    ✓ Stuck order incident raised<br>
                                    ✓ Timeline logs warning
                                </div>
                            </div>
                            <button class="btn btn-orange" onclick="runOperationsScenario('OPEN_ORDER_TIMEOUT')">Run Scenario</button>
                        </div>

                        <div class="failure-card">
                            <div>
                                <div class="flex-between" style="margin-bottom:0.5rem;">
                                    <strong style="font-size:0.95rem;">Backward Transition <span style="font-size:0.8rem; font-weight:normal; opacity:0.6;">(C5)</span></strong>
                                    <span class="sys-badge" style="color:var(--color-orange); background:rgba(245,158,11,0.15); border-color:rgba(245,158,11,0.3)">WARNING</span>
                                </div>
                                <p style="font-size:0.8rem; color:var(--text-secondary); margin-bottom:0.75rem;">Simulates regression (CREATED &rarr; CANCELLED &rarr; OPEN) to verify state transition checks capture invalid sequencing.</p>
                                <div style="font-size:0.75rem; background:rgba(0,0,0,0.2); border-radius:4px; padding:0.5rem; color:var(--text-secondary); font-family:monospace; line-height:1.4;">
                                    <strong style="color:var(--color-orange);">Expected Result:</strong><br>
                                    ✓ Transition warning triggered<br>
                                    ✓ Incident raised for FSM anomaly<br>
                                    ✓ Timeline logs violation
                                </div>
                            </div>
                            <button class="btn btn-orange" onclick="runOperationsScenario('BACKWARD_TRANSITION')">Run Scenario</button>
                        </div>

                        <div class="failure-card">
                            <div>
                                <div class="flex-between" style="margin-bottom:0.5rem;">
                                    <strong style="font-size:0.95rem;">Duplicate Fill <span style="font-size:0.8rem; font-weight:normal; opacity:0.6;">(C6)</span></strong>
                                    <span class="sys-badge" style="color:var(--color-blue); background:rgba(59,130,246,0.15); border-color:rgba(59,130,246,0.3)">INFO</span>
                                </div>
                                <p style="font-size:0.8rem; color:var(--text-secondary); margin-bottom:0.75rem;">Injects duplicate ORDER_FILLED events back-to-back to verify warning deduplication filters and log suppression.</p>
                                <div style="font-size:0.75rem; background:rgba(0,0,0,0.2); border-radius:4px; padding:0.5rem; color:var(--text-secondary); font-family:monospace; line-height:1.4;">
                                    <strong style="color:var(--color-blue);">Expected Result:</strong><br>
                                    ✓ Timeline logs duplicate warn<br>
                                    ✓ Deduplication logs normal<br>
                                    ✓ No duplicate alerts raised
                                </div>
                            </div>
                            <button class="btn btn-blue" onclick="runOperationsScenario('DUPLICATE_FILL')">Run Scenario</button>
                        </div>

                        <div class="failure-card">
                            <div>
                                <div class="flex-between" style="margin-bottom:0.5rem;">
                                    <strong style="font-size:0.95rem;">Unexpected Fill <span style="font-size:0.8rem; font-weight:normal; opacity:0.6;">(C8)</span></strong>
                                    <span class="sys-badge" style="color:var(--color-red); background:rgba(239,68,68,0.15); border-color:rgba(239,68,68,0.3)">HIGH</span>
                                </div>
                                <p style="font-size:0.8rem; color:var(--text-secondary); margin-bottom:0.75rem;">Simulates an ORDER_FILLED arriving directly without preceding events, validating stage skipping alarms.</p>
                                <div style="font-size:0.75rem; background:rgba(0,0,0,0.2); border-radius:4px; padding:0.5rem; color:var(--text-secondary); font-family:monospace; line-height:1.4;">
                                    <strong style="color:var(--color-red);">Expected Result:</strong><br>
                                    ✓ Critical incident raised<br>
                                    ✓ Degraded health status<br>
                                    ✓ Timeline alerts sent
                                </div>
                            </div>
                            <button class="btn btn-red" onclick="runOperationsScenario('UNEXPECTED_FILL')">Run Scenario</button>
                        </div>

                        <div class="failure-card">
                            <div>
                                <div class="flex-between" style="margin-bottom:0.5rem;">
                                    <strong style="font-size:0.95rem;">Cancel after Fill <span style="font-size:0.8rem; font-weight:normal; opacity:0.6;">(C9)</span></strong>
                                    <span class="sys-badge" style="color:var(--color-red); background:rgba(239,68,68,0.15); border-color:rgba(239,68,68,0.3)">HIGH</span>
                                </div>
                                <p style="font-size:0.8rem; color:var(--text-secondary); margin-bottom:0.75rem;">Simulates ORDER_FILLED followed by ORDER_CANCELLED to verify Terminal Mutation Guard violation alerts.</p>
                                <div style="font-size:0.75rem; background:rgba(0,0,0,0.2); border-radius:4px; padding:0.5rem; color:var(--text-secondary); font-family:monospace; line-height:1.4;">
                                    <strong style="color:var(--color-red);">Expected Result:</strong><br>
                                    ✓ Critical mutation incident<br>
                                    ✓ Degraded health status<br>
                                    ✓ Timeline alerts sent
                                </div>
                            </div>
                            <button class="btn btn-red" onclick="runOperationsScenario('CANCEL_AFTER_FILL')">Run Scenario</button>
                        </div>
                    </div>
                </div>
            </div>

            <!-- Panel: Replay & Forensics -->
            <div id="panel-replay" class="tab-panel">
                <h2>🔄 Replay Engine & Forensics</h2>
                <p style="color:var(--text-secondary); margin-bottom:1.5rem;">
                    Replay historic events, execute simulation runs, and inspect detailed operational state timelines.
                </p>

                <div class="grid">
                    <div class="card">
                        <h2>Replay Engine Controller</h2>
                        <div class="flex-between" style="margin-bottom: 1rem;">
                            <div>
                                <strong>Replay Subsystem Status</strong>
                                <p style="font-size:0.8rem; color:var(--text-secondary); margin-top:0.25rem;">
                                    When enabled, the daemon allows backtesting and event stream playback overrides.
                                </p>
                            </div>
                            <span id="replay-status-badge" class="sys-badge">LOADING</span>
                        </div>
                        <button id="replay-toggle-btn" class="btn" style="width:100%" onclick="toggleReplayFlag()">Toggle Replay Engine</button>
                    </div>

                    <div class="card">
                        <h2>Simulation Ticks & Playback</h2>
                        <p style="font-size:0.8rem; color:var(--text-secondary); margin-bottom: 1rem;">
                            Step the simulation engine forward or playback a historic event buffer from local database logs.
                        </p>
                        <div style="display:flex; flex-direction:column; gap:0.5rem;">
                            <button class="btn btn-secondary" onclick="triggerPlayback('TICK')">Step Simulation Tick</button>
                            <button class="btn btn-secondary" onclick="triggerPlayback('REPLAY_HISTORY')">Replay Last 24 Hours Audits</button>
                        </div>
                    </div>
                </div>
            </div>

            <!-- Panel: Infrastructure -->
            <div id="panel-infra" class="tab-panel">
                <h2>Docker & Process Container Controls</h2>
                <p style="color:var(--text-secondary); margin-bottom:1.5rem;">Predefined whitelist actions executed via CommandRunner.</p>

                <div class="card" style="max-width: 600px;">
                    <h2>Freqtrade Controls</h2>
                    <div style="display:flex; gap:1rem; margin-top: 1rem;">
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

            <!-- PANEL: Distributed Status -->
            <div id="panel-dist-status" class="tab-panel">
                <h2>🟢 Distributed Status Monitor</h2>
                <p style="color:var(--text-secondary); margin-bottom:1.5rem;">
                    Real-time connectivity, latency, and system resource utilization of registered remote agents.
                </p>
                <div id="agents-status-container" style="display:flex; flex-direction:column; gap:1.5rem;">
                    <!-- Dynamically populated -->
                    <div class="card" style="text-align:center; padding: 3rem; color:var(--text-secondary);">
                        🔍 No registered agents found. Connect an agent to begin monitoring.
                    </div>
                </div>
            </div>

            <!-- PANEL: Agent Identity -->
            <div id="panel-dist-identity" class="tab-panel">
                <h2>🔑 Agent Identity Protocol Validation</h2>
                <p style="color:var(--text-secondary); margin-bottom:1.5rem;">
                    Verify authentication boundaries, token parsing rules, and registration handshakes.
                </p>

                <!-- Version Policy Configuration Card -->
                <div class="card" style="margin-bottom: 2rem; border-color: rgba(59, 130, 246, 0.3); background: rgba(59, 130, 246, 0.02);">
                    <h3 style="margin-bottom: 0.75rem; color: var(--color-blue); font-size: 1.0rem; display: flex; align-items: center; gap: 0.5rem;">
                        <span>⚙️ Version & Compatibility Policy</span>
                    </h3>
                    <div style="display: flex; gap: 1.5rem; flex-wrap: wrap;">
                        <div style="flex: 1; min-width: 200px;">
                            <label style="display: block; font-size: 0.85rem; color: var(--text-secondary); margin-bottom: 0.35rem;">Minimum Supported Version (Rejection)</label>
                            <input id="input-min-version" type="text" class="input" style="width: 100%; padding: 0.4rem; background: var(--bg-surface); border-color: var(--border-color); color: var(--text-primary); border-radius: 4px;" value="1.2.0" onchange="updateVersionPolicy()" placeholder="e.g. 1.2.0">
                        </div>
                        <div style="flex: 1; min-width: 200px;">
                            <label style="display: block; font-size: 0.85rem; color: var(--text-secondary); margin-bottom: 0.35rem;">Deprecation Warning Version (Warning)</label>
                            <input id="input-dep-version" type="text" class="input" style="width: 100%; padding: 0.4rem; background: var(--bg-surface); border-color: var(--border-color); color: var(--text-primary); border-radius: 4px;" value="1.4.0" onchange="updateVersionPolicy()" placeholder="e.g. 1.4.0">
                        </div>
                    </div>
                    <p style="font-size: 0.75rem; color: var(--text-secondary); margin-top: 0.65rem; line-height: 1.4;">
                        Sets the compatibility rule on the gateway. Versions strictly below the minimum will be rejected (HTTP 426). Versions below deprecation but above/equal to minimum will register/heartbeat successfully but return a warning flag.
                    </p>
                </div>

                <!-- Capability Policy Configuration Card -->
                <div class="card" style="margin-bottom: 2rem; border-color: rgba(16, 185, 129, 0.3); background: rgba(16, 185, 129, 0.02);">
                    <h3 style="margin-bottom: 0.75rem; color: var(--color-green); font-size: 1.0rem; display: flex; align-items: center; gap: 0.5rem;">
                        <span>🛡️ Capability Negotiation Policy</span>
                    </h3>
                    <div style="display: flex; gap: 1.5rem; flex-wrap: wrap;">
                        <div style="flex: 1; min-width: 200px;">
                            <label style="display: block; font-size: 0.85rem; color: var(--text-secondary); margin-bottom: 0.35rem;">Required Capabilities (Comma Separated)</label>
                            <input id="input-required-caps" type="text" class="input" style="width: 100%; padding: 0.4rem; background: var(--bg-surface); border-color: var(--border-color); color: var(--text-primary); border-radius: 4px;" value="TELEMETRY" onchange="updateCapabilityPolicy()" placeholder="e.g. TELEMETRY">
                        </div>
                        <div style="flex: 1; min-width: 200px;">
                            <label style="display: block; font-size: 0.85rem; color: var(--text-secondary); margin-bottom: 0.35rem;">Allowed Capabilities (Comma Separated)</label>
                            <input id="input-allowed-caps" type="text" class="input" style="width: 100%; padding: 0.4rem; background: var(--bg-surface); border-color: var(--border-color); color: var(--text-primary); border-radius: 4px;" value="MONITORING, INCIDENTS, TELEMETRY, DOCKER, INCIDENT_SYNC" onchange="updateCapabilityPolicy()" placeholder="e.g. MONITORING, INCIDENTS">
                        </div>
                    </div>
                    <p style="font-size: 0.75rem; color: var(--text-secondary); margin-top: 0.65rem; line-height: 1.4;">
                        Sets the capability negotiation rules on the gateway. Agents requesting capabilities not in the allowed list, or omitting capabilities in the required list, will be rejected (HTTP 400 with details). Successful agents are granted the intersection of their requested set and the allowed set.
                    </p>
                </div>

                <div class="qa-active-agent-banner card" style="margin-bottom: 1.5rem; border-color: rgba(59, 130, 246, 0.3); background: rgba(59, 130, 246, 0.03); display: flex; justify-content: space-between; align-items: center; padding: 0.75rem 1rem;">
                    <div style="display: flex; align-items: center; gap: 0.5rem;">
                        <span style="font-size: 0.85rem; color: var(--text-secondary);">Target Agent:</span>
                        <strong class="active-qa-agent-display" style="font-family: 'Fira Code', monospace; color: var(--color-blue); font-size: 0.9rem;">None (Run Success Registration first or connect VM Agent)</strong>
                    </div>
                    <div style="display: flex; align-items: center; gap: 1rem;">
                        <div class="active-qa-agent-select-container" style="display: none; align-items: center; gap: 0.5rem;">
                            <span style="font-size: 0.85rem; color: var(--text-secondary);">Select Agent:</span>
                            <select class="select-qa-agent input" style="padding: 0.25rem 0.5rem; font-size: 0.8rem; width: auto; background: var(--bg-surface); border-color: var(--border-color); color: var(--text-primary); border-radius: 4px;" onchange="changeQaAgent(this.value)">
                            </select>
                        </div>
                        <button class="btn btn-secondary" style="padding: 0.25rem 0.5rem; font-size: 0.75rem; border-color: rgba(239, 68, 68, 0.3); color: var(--color-red); background: rgba(239, 68, 68, 0.05); cursor: pointer;" onclick="purgeOfflineQaAgents(event)">
                            Purge Offline QA Agents
                        </button>
                    </div>
                </div>
                <div class="qa-grid" id="qa-identity-container"></div>
            </div>

            <!-- PANEL: Cloud Gateway -->
            <div id="panel-dist-gateway" class="tab-panel">
                <h2>☁️ Cloud Communication Protocol Validation</h2>
                <p style="color:var(--text-secondary); margin-bottom:1.5rem;">
                    Verify heartbeat ingestion routes, configuration endpoints, and update polling protocols.
                </p>
                <div class="qa-active-agent-banner card" style="margin-bottom: 1.5rem; border-color: rgba(59, 130, 246, 0.3); background: rgba(59, 130, 246, 0.03); display: flex; justify-content: space-between; align-items: center; padding: 0.75rem 1rem;">
                    <div style="display: flex; align-items: center; gap: 0.5rem;">
                        <span style="font-size: 0.85rem; color: var(--text-secondary);">Target Agent:</span>
                        <strong class="active-qa-agent-display" style="font-family: 'Fira Code', monospace; color: var(--color-blue); font-size: 0.9rem;">None (Run Success Registration first or connect VM Agent)</strong>
                    </div>
                    <div style="display: flex; align-items: center; gap: 1rem;">
                        <div class="active-qa-agent-select-container" style="display: none; align-items: center; gap: 0.5rem;">
                            <span style="font-size: 0.85rem; color: var(--text-secondary);">Select Agent:</span>
                            <select class="select-qa-agent input" style="padding: 0.25rem 0.5rem; font-size: 0.8rem; width: auto; background: var(--bg-surface); border-color: var(--border-color); color: var(--text-primary); border-radius: 4px;" onchange="changeQaAgent(this.value)">
                            </select>
                        </div>
                        <button class="btn btn-secondary" style="padding: 0.25rem 0.5rem; font-size: 0.75rem; border-color: rgba(239, 68, 68, 0.3); color: var(--color-red); background: rgba(239, 68, 68, 0.05); cursor: pointer;" onclick="purgeOfflineQaAgents(event)">
                            Purge Offline QA Agents
                        </button>
                    </div>
                </div>
                <div class="qa-grid" id="qa-gateway-container"></div>
            </div>

            <!-- PANEL: Synchronization -->
            <div id="panel-dist-sync" class="tab-panel">
                <h2>🔄 Synchronization Protocol Validation</h2>
                <p style="color:var(--text-secondary); margin-bottom:1.5rem;">
                    Verify incident / alert ingestion, duplicate payload filters, and network offline resiliency.
                </p>
                <div class="qa-active-agent-banner card" style="margin-bottom: 1.5rem; border-color: rgba(59, 130, 246, 0.3); background: rgba(59, 130, 246, 0.03); display: flex; justify-content: space-between; align-items: center; padding: 0.75rem 1rem;">
                    <div style="display: flex; align-items: center; gap: 0.5rem;">
                        <span style="font-size: 0.85rem; color: var(--text-secondary);">Target Agent:</span>
                        <strong class="active-qa-agent-display" style="font-family: 'Fira Code', monospace; color: var(--color-blue); font-size: 0.9rem;">None (Run Success Registration first or connect VM Agent)</strong>
                    </div>
                    <div style="display: flex; align-items: center; gap: 1rem;">
                        <div class="active-qa-agent-select-container" style="display: none; align-items: center; gap: 0.5rem;">
                            <span style="font-size: 0.85rem; color: var(--text-secondary);">Select Agent:</span>
                            <select class="select-qa-agent input" style="padding: 0.25rem 0.5rem; font-size: 0.8rem; width: auto; background: var(--bg-surface); border-color: var(--border-color); color: var(--text-primary); border-radius: 4px;" onchange="changeQaAgent(this.value)">
                            </select>
                        </div>
                        <button class="btn btn-secondary" style="padding: 0.25rem 0.5rem; font-size: 0.75rem; border-color: rgba(239, 68, 68, 0.3); color: var(--color-red); background: rgba(239, 68, 68, 0.05); cursor: pointer;" onclick="purgeOfflineQaAgents(event)">
                            Purge Offline QA Agents
                        </button>
                    </div>
                </div>

                <!-- Failure injection switch -->
                <div class="card" style="margin-bottom: 2rem; border-color: rgba(245, 158, 11, 0.3); background: rgba(245,158,11,0.05);">
                    <div class="flex-between">
                        <div>
                            <strong style="color: var(--color-orange); font-size: 1.05rem;">Simulate Cloud Gateway Offline (HTTP 500)</strong>
                            <p style="font-size: 0.85rem; color: var(--text-secondary); margin-top: 0.25rem;">
                                Forces incoming telemetry uploads to fail with internal errors. Use to test outbox buffering and recovery behavior.
                            </p>
                        </div>
                        <button id="btn-offline-toggle" class="btn btn-orange" onclick="toggleOfflineSimulation()">
                            Enable Offline Simulation
                        </button>
                    </div>
                </div>

                <div class="qa-grid" id="qa-sync-container"></div>
            </div>

            <!-- PANEL: Smoke Tests -->
            <div id="panel-dist-smoke" class="tab-panel">
                <h2>⚡ Distributed Smoke Tests</h2>
                <p style="color:var(--text-secondary); margin-bottom:1.5rem;">
                    Execute end-to-end integration flows to check overall platform health and protocol correctness.
                </p>
                <div class="qa-active-agent-banner card" style="margin-bottom: 1.5rem; border-color: rgba(59, 130, 246, 0.3); background: rgba(59, 130, 246, 0.03); display: flex; justify-content: space-between; align-items: center; padding: 0.75rem 1rem;">
                    <div style="display: flex; align-items: center; gap: 0.5rem;">
                        <span style="font-size: 0.85rem; color: var(--text-secondary);">Target Agent:</span>
                        <strong class="active-qa-agent-display" style="font-family: 'Fira Code', monospace; color: var(--color-blue); font-size: 0.9rem;">None (Run Success Registration first or connect VM Agent)</strong>
                    </div>
                    <div style="display: flex; align-items: center; gap: 1rem;">
                        <div class="active-qa-agent-select-container" style="display: none; align-items: center; gap: 0.5rem;">
                            <span style="font-size: 0.85rem; color: var(--text-secondary);">Select Agent:</span>
                            <select class="select-qa-agent input" style="padding: 0.25rem 0.5rem; font-size: 0.8rem; width: auto; background: var(--bg-surface); border-color: var(--border-color); color: var(--text-primary); border-radius: 4px;" onchange="changeQaAgent(this.value)">
                            </select>
                        </div>
                        <button class="btn btn-secondary" style="padding: 0.25rem 0.5rem; font-size: 0.75rem; border-color: rgba(239, 68, 68, 0.3); color: var(--color-red); background: rgba(239, 68, 68, 0.05); cursor: pointer;" onclick="purgeOfflineQaAgents(event)">
                            Purge Offline QA Agents
                        </button>
                    </div>
                </div>

                <div class="grid" style="grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); margin-bottom: 2rem;">
                    <div class="card" style="display:flex; flex-direction:column; justify-content:space-between; gap:1rem;">
                        <div>
                            <h3>Identity Suite</h3>
                            <p style="font-size:0.8rem; color:var(--text-secondary); margin-top:0.25rem;">Checks registration and wrong token rejection.</p>
                        </div>
                        <button class="btn btn-green" onclick="runSmokeSuite('identity')">Run Suite</button>
                    </div>
                    <div class="card" style="display:flex; flex-direction:column; justify-content:space-between; gap:1rem;">
                        <div>
                            <h3>Gateway Suite</h3>
                            <p style="font-size:0.8rem; color:var(--text-secondary); margin-top:0.25rem;">Checks config, update, and heartbeats.</p>
                        </div>
                        <button class="btn btn-green" onclick="runSmokeSuite('gateway')">Run Suite</button>
                    </div>
                    <div class="card" style="display:flex; flex-direction:column; justify-content:space-between; gap:1rem;">
                        <div>
                            <h3>Sync Suite</h3>
                            <p style="font-size:0.8rem; color:var(--text-secondary); margin-top:0.25rem;">Checks incident and alert ingestion.</p>
                        </div>
                        <button class="btn btn-green" onclick="runSmokeSuite('sync')">Run Suite</button>
                    </div>
                    <div class="card" style="display:flex; flex-direction:column; justify-content:space-between; gap:1rem; border-color: var(--color-blue);">
                        <div>
                            <h3>Full Platform</h3>
                            <p style="font-size:0.8rem; color:var(--text-secondary); margin-top:0.25rem;">Executes all validation checks in sequence.</p>
                        </div>
                        <button class="btn" style="background: var(--color-blue);" onclick="runSmokeSuite('full')">Run Full Smoke Test</button>
                    </div>
                </div>

                <div class="card">
                    <div class="flex-between" style="margin-bottom: 1rem;">
                        <h2>Test Results Output Log</h2>
                        <button class="btn btn-secondary" onclick="clearSmokeTerminal()">Clear Log</button>
                    </div>
                    <div id="smoke-terminal" class="timeline-container" style="height: 350px; background: #070b12; border-color: rgba(255,255,255,0.05); color:#a7f3d0; font-family:'Fira Code', monospace; font-size:0.8rem; padding: 1.2rem; line-height: 1.5;">
                        <div>Console ready. Select a suite to begin testing.</div>
                    </div>
                </div>
            </div>
        </main>
    </div>

    <script>
        let sseSource = null;
        let isReadOnlyMode = false;

        // Collapsible Folders Toggle
        function toggleFolder(folderId) {
            const folder = document.getElementById('folder-' + folderId);
            if (folder) {
                folder.classList.toggle('collapsed');
            }
        }

        function switchTab(tabId) {
            document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
            document.querySelectorAll('.tab-panel').forEach(panel => panel.classList.remove('active'));

            const activeBtn = Array.from(document.querySelectorAll('.tab-btn')).find(btn => {
                const onClickStr = btn.getAttribute('onclick') || '';
                return onClickStr.includes(tabId);
            });
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
            if (mainTimeline) {
                mainTimeline.insertAdjacentHTML('beforeend', html);
                mainTimeline.scrollTop = mainTimeline.scrollHeight;
            }

            // Append to dashboard brief timeline
            const dashTimeline = document.getElementById('dashboard-timeline');
            if (dashTimeline) {
                dashTimeline.insertAdjacentHTML('beforeend', html);
                dashTimeline.scrollTop = dashTimeline.scrollHeight;
            }
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
            if (!container) return;
            container.innerHTML = '';
            
            for (const [key, meta] of Object.entries(flags)) {
                if (key === 'REPLAY') {
                    // Update Replay panel instead
                    const badge = document.getElementById('replay-status-badge');
                    const btn = document.getElementById('replay-toggle-btn');
                    if (badge && btn) {
                        if (meta.enabled) {
                            badge.innerHTML = '🟢 ENABLED';
                            badge.style.color = 'var(--color-green)';
                            btn.className = 'btn btn-red';
                            btn.textContent = 'Disable Replay Subsystem';
                            btn.onclick = () => setFeatureFlag('REPLAY', false);
                        } else {
                            badge.innerHTML = '🔴 DISABLED';
                            badge.style.color = 'var(--color-red)';
                            btn.className = 'btn btn-green';
                            btn.textContent = 'Enable Replay Subsystem';
                            btn.onclick = () => setFeatureFlag('REPLAY', true);
                        }
                    }
                    continue;
                }

                const statusHtml = meta.enabled 
                    ? \`<span id="badge-flag-\${key}" style="font-weight:600; color:var(--color-green); display:inline-flex; align-items:center;"><span class="indicator ind-green"></span>ENABLED</span>\`
                    : \`<span id="badge-flag-\${key}" style="font-weight:600; color:var(--color-red); display:inline-flex; align-items:center;"><span class="indicator ind-red"></span>DISABLED</span>\`;
                    
                const buttonHtml = meta.enabled
                    ? \`<button id="btn-flag-\${key}" class="btn btn-red" style="padding:0.4rem 0.8rem; font-size:0.85rem;" onclick="setFeatureFlag('\${key}', false)">Disable</button>\`
                    : \`<button id="btn-flag-\${key}" class="btn btn-green" style="padding:0.4rem 0.8rem; font-size:0.85rem;" onclick="setFeatureFlag('\${key}', true)">Enable</button>\`;
                    
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

        async function runOperationsScenario(scenario) {
            const tradeId = document.getElementById('sim-trade-id').value;
            const symbol = document.getElementById('sim-symbol').value;
            const offsetSec = document.getElementById('sim-offset-sec').value;

            const payload = {
                scenario,
                tradeId: tradeId || undefined,
                symbol: symbol || undefined,
                timestampOffset: offsetSec ? parseInt(offsetSec) * 1000 : undefined,
                correlationId: 'sim_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5)
            };

            try {
                const res = await fetch('/api/v1/operations/run', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });
                const json = await res.json();
                if (!json.success) {
                    alert('Simulation failed: ' + json.message);
                } else {
                    alert('Scenario initiated! ' + scenario + ' events are now executing in the pipeline.');
                }
            } catch (err) {
                alert('Request failed: ' + err.message);
            }
        }

        async function resetSimulationLab() {
            if (!confirm('Are you sure you want to delete all simulated telemetry, clear detector state counters, and reset the Incident Manager?')) {
                return;
            }
            try {
                const res = await fetch('/api/v1/qa/reset', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ correlationId: 'reset_' + Date.now() })
                });
                const json = await res.json();
                if (json.success) {
                    alert('Simulation Lab reset successfully!');
                    window.location.reload();
                } else {
                    alert('Failed to reset Simulation Lab: ' + json.message);
                }
            } catch (err) {
                alert('Request failed: ' + err.message);
            }
        }

        async function triggerPlayback(action) {
            alert('Simulation Control trigger: ' + action + '. Staging environment log reconstruction initiated.');
        }

        function toggleReplayFlag() {
            // Managed dynamically by rendering callback binding
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

        // ==========================================
        // DATA-DRIVEN DISTRIBUTED QA TEST SYSTEM
        // ==========================================

        const qaState = {
            registeredAgentId: '',
            registeredAgentSecret: '',
            simulateCloudOffline: false
        };

        const QA_TESTS = [
            // --- AGENT IDENTITY ---
            {
                id: 'register-success',
                category: 'identity',
                title: 'Agent Registration (Success)',
                description: 'Verifies registration using a valid QA active registration token. Acquires Agent ID and Secret.',
                method: 'POST',
                path: '/api/v1/agent/register',
                body: () => ({
                    licenseToken: 'QA-LAB-TOKEN-999',
                    machineId: 'qa-machine-' + Math.floor(Math.random() * 100000),
                    hostname: 'qa-simulated-agent',
                    version: '1.5.0',
                    capabilities: ['TELEMETRY', 'DOCKER']
                }),
                assertions: [
                    { label: 'HTTP Status is 200', check: (res, status) => status === 200 },
                    { label: 'success is true', check: (res) => res.success === true },
                    { label: 'agentId is present', check: (res) => typeof res.agentId === 'string' && res.agentId.length > 0 },
                    { label: 'agentSecret is present', check: (res) => typeof res.agentSecret === 'string' && res.agentSecret.length > 0 }
                ],
                onSuccess: (res) => {
                    qaState.registeredAgentId = res.agentId;
                    qaState.registeredAgentSecret = res.agentSecret;
                    logToSmokeTerminal(\`[STATE] Captured registered agentId: \${res.agentId.substring(0,8)}...\`);
                    pollAgentStatus();
                }
            },
            {
                id: 'register-missing-token',
                category: 'identity',
                title: 'Registration Rejected (Missing Token)',
                description: 'Verifies that registering with an empty license token returns a 403 Forbidden or 400 Bad Request error.',
                method: 'POST',
                path: '/api/v1/agent/register',
                body: () => ({
                    licenseToken: '',
                    machineId: 'qa-machine-' + Math.floor(Math.random() * 100000),
                    hostname: 'qa-simulated-agent',
                    version: '1.5.0',
                    capabilities: ['TELEMETRY']
                }),
                assertions: [
                    { label: 'HTTP Status is 403 or 400', check: (res, status) => status === 403 || status === 400 },
                    { label: 'success is false', check: (res) => res.success === false },
                    { label: 'code is INVALID_TOKEN or BAD_REQUEST', check: (res) => { const c = res.code || (res.error && res.error.code); return c === 'INVALID_TOKEN' || c === 'BAD_REQUEST'; } }
                ]
            },
            {
                id: 'register-invalid-token',
                category: 'identity',
                title: 'Registration Rejected (Invalid Token)',
                description: 'Verifies that registering with an arbitrary invalid license token returns 403 Forbidden (INVALID_TOKEN).',
                method: 'POST',
                path: '/api/v1/agent/register',
                body: () => ({
                    licenseToken: 'INVALID-TOKEN-12345678',
                    machineId: 'qa-machine-' + Math.floor(Math.random() * 100000),
                    hostname: 'qa-simulated-agent',
                    version: '1.5.0',
                    capabilities: ['TELEMETRY']
                }),
                assertions: [
                    { label: 'HTTP Status is 403', check: (res, status) => status === 403 },
                    { label: 'success is false', check: (res) => res.success === false },
                    { label: 'code is INVALID_TOKEN', check: (res) => { const c = res.code || (res.error && res.error.code); return c === 'INVALID_TOKEN'; } }
                ]
            },

            // --- CLOUD GATEWAY ---
            {
                id: 'heartbeat-success',
                category: 'gateway',
                title: 'Agent Heartbeat (Success)',
                description: 'Verifies that a heartbeat request with valid X-Agent-Id/Secret credentials returns 200 OK.',
                method: 'POST',
                path: '/api/v1/agent/heartbeat',
                headers: () => ({
                    'X-Agent-Id': qaState.registeredAgentId || '00000000-0000-0000-0000-000000000000',
                    'X-Agent-Secret': qaState.registeredAgentSecret || 'dummy-secret'
                }),
                body: () => ({
                    agentId: qaState.registeredAgentId || '00000000-0000-0000-0000-000000000000',
                    agentSecret: qaState.registeredAgentSecret || 'dummy-secret',
                    hostname: 'qa-simulated-agent',
                    version: '1.5.0',
                    status: 'ONLINE',
                    uptime: 300,
                    metrics: { cpuPct: 12.5, memoryPct: 44.2, diskPct: 18.0 },
                    health: { outboxPendingCount: 0, databaseHealthy: true, freqtradeHealthy: true }
                }),
                assertions: [
                    { label: 'HTTP Status is 200', check: (res, status) => status === 200 },
                    { label: 'success is true', check: (res) => res.success === true },
                    { label: 'status is SUCCESS', check: (res) => res.status === 'SUCCESS' }
                ]
            },
            {
                id: 'heartbeat-wrong-secret',
                category: 'gateway',
                title: 'Heartbeat Rejected (Wrong Secret)',
                description: 'Verifies that a heartbeat submitted with an invalid/mismatched secret returns 401 Unauthorized.',
                method: 'POST',
                path: '/api/v1/agent/heartbeat',
                headers: () => ({
                    'X-Agent-Id': qaState.registeredAgentId || '00000000-0000-0000-0000-000000000000',
                    'X-Agent-Secret': 'WRONG-SECRET'
                }),
                body: () => ({
                    agentId: qaState.registeredAgentId || '00000000-0000-0000-0000-000000000000',
                    agentSecret: 'WRONG-SECRET',
                    hostname: 'qa-simulated-agent',
                    version: '1.5.0',
                    status: 'ONLINE',
                    uptime: 300,
                    metrics: { cpuPct: 12.5, memoryPct: 44.2, diskPct: 18.0 },
                    health: { outboxPendingCount: 0, databaseHealthy: true, freqtradeHealthy: true }
                }),
                assertions: [
                    { label: 'HTTP Status is 401', check: (res, status) => status === 401 },
                    { label: 'success is false', check: (res) => res.success === false },
                    { label: 'code is UNAUTHORIZED', check: (res) => { const c = res.code || (res.error && res.error.code); return c === 'UNAUTHORIZED'; } }
                ]
            },
            {
                id: 'heartbeat-unknown-agent',
                category: 'gateway',
                title: 'Heartbeat Rejected (Unknown Agent)',
                description: 'Verifies that a heartbeat submitted for a non-existent agent UUID returns 403 Forbidden (INVALID_TOKEN).',
                method: 'POST',
                path: '/api/v1/agent/heartbeat',
                headers: () => ({
                    'X-Agent-Id': '11111111-1111-1111-1111-111111111111',
                    'X-Agent-Secret': 'some-secret'
                }),
                body: () => ({
                    agentId: '11111111-1111-1111-1111-111111111111',
                    agentSecret: 'some-secret',
                    hostname: 'qa-simulated-agent',
                    version: '1.5.0',
                    status: 'ONLINE',
                    uptime: 300,
                    metrics: { cpuPct: 12.5, memoryPct: 44.2, diskPct: 18.0 },
                    health: { outboxPendingCount: 0, databaseHealthy: true, freqtradeHealthy: true }
                }),
                assertions: [
                    { label: 'HTTP Status is 403', check: (res, status) => status === 403 },
                    { label: 'success is false', check: (res) => res.success === false },
                    { label: 'code is INVALID_TOKEN', check: (res) => { const c = res.code || (res.error && res.error.code); return c === 'INVALID_TOKEN'; } }
                ]
            },
            {
                id: 'get-config',
                category: 'gateway',
                title: 'Get Agent Config (Reserved)',
                description: 'Checks GET /api/v1/agent/config to retrieve configuration overrides with valid headers.',
                method: 'GET',
                path: '/api/v1/agent/config',
                headers: () => ({
                    'X-Agent-Id': qaState.registeredAgentId || '00000000-0000-0000-0000-000000000000',
                    'X-Agent-Secret': qaState.registeredAgentSecret || 'dummy-secret'
                }),
                assertions: [
                    { label: 'HTTP Status is 200', check: (res, status) => status === 200 },
                    { label: 'config object is present', check: (res) => res.configuration !== undefined }
                ]
            },
            {
                id: 'get-update',
                category: 'gateway',
                title: 'Get Agent Update (Reserved)',
                description: 'Checks GET /api/v1/agent/update to retrieve update instructions with valid headers.',
                method: 'GET',
                path: '/api/v1/agent/update',
                headers: () => ({
                    'X-Agent-Id': qaState.registeredAgentId || '00000000-0000-0000-0000-000000000000',
                    'X-Agent-Secret': qaState.registeredAgentSecret || 'dummy-secret'
                }),
                assertions: [
                    { label: 'HTTP Status is 200', check: (res, status) => status === 200 },
                    { label: 'updateAvailable field is boolean', check: (res) => typeof res.updateAvailable === 'boolean' }
                ]
            },

            // --- SYNCHRONIZATION ---
            {
                id: 'sync-incident-success',
                category: 'sync',
                title: 'Ingest Incident (Success Path)',
                description: 'Verifies that a valid incident transition enqueued by the agent is successfully received and parsed (201).',
                method: 'POST',
                path: '/api/v1/agent/incidents',
                headers: () => {
                    const headers = {
                        'X-Agent-Id': qaState.registeredAgentId || '00000000-0000-0000-0000-000000000000',
                        'X-Agent-Secret': qaState.registeredAgentSecret || 'dummy-secret'
                    };
                    if (qaState.simulateCloudOffline) {
                        headers['X-Mock-Fail'] = 'true';
                    }
                    return headers;
                },
                body: () => ({
                    schemaVersion: 1,
                    type: 'INCIDENT',
                    event: 'CREATED',
                    incident: {
                        incidentId: 8888,
                        symbol: 'ETHUSDT',
                        level: 'CRITICAL',
                        source: 'WATCHDOG',
                        reason: 'Simulated QA Outbox sync incident',
                        detectedAt: Date.now()
                    },
                    machine: {
                        machineId: 'qa-machine-local',
                        hostname: 'qa-vps-test',
                        arch: 'x64',
                        platform: 'linux',
                        cpuCores: 2
                    }
                }),
                assertions: [
                    { 
                        label: 'HTTP Status matches online state (201) or offline simulation (500)', 
                        check: (res, status) => qaState.simulateCloudOffline ? status === 500 : status === 201 
                    },
                    { 
                        label: 'Response payload matches expectations', 
                        check: (res) => qaState.simulateCloudOffline ? res.error !== undefined : res.received === true 
                    }
                ]
            },
            {
                id: 'sync-alert-success',
                category: 'sync',
                title: 'Ingest Alert Log (Success Path)',
                description: 'Verifies that a warning alert payload enqueued by the agent is successfully received and parsed (201).',
                method: 'POST',
                path: '/api/v1/agent/alerts',
                headers: () => {
                    const headers = {
                        'X-Agent-Id': qaState.registeredAgentId || '00000000-0000-0000-0000-000000000000',
                        'X-Agent-Secret': qaState.registeredAgentSecret || 'dummy-secret'
                    };
                    if (qaState.simulateCloudOffline) {
                        headers['X-Mock-Fail'] = 'true';
                    }
                    return headers;
                },
                body: () => ({
                    schemaVersion: 1,
                    type: 'ALERT',
                    alert: {
                        level: 'WARNING',
                        title: 'Telemetry Delay warning',
                        message: 'Exchange DNS latency resolved, heartbeat delayed 12s.',
                        entityId: 'alert_qa_' + Date.now(),
                        timestamp: new Date().toISOString()
                    },
                    machine: {
                        machineId: 'qa-machine-local',
                        hostname: 'qa-vps-test'
                    }
                }),
                assertions: [
                    { 
                        label: 'HTTP Status matches online state (201) or offline simulation (500)', 
                        check: (res, status) => qaState.simulateCloudOffline ? status === 500 : status === 201 
                    },
                    { 
                        label: 'Response payload matches expectations', 
                        check: (res) => qaState.simulateCloudOffline ? res.error !== undefined : res.received === true 
                    }
                ]
            },
            // --- C4: VERSION NEGOTIATION TESTS ---
            {
                id: 'register-deprecated-version',
                category: 'identity',
                title: 'Agent Registration (Deprecated Version)',
                description: 'Verifies registration succeeds with a warning when version is below deprecation but above/equal to minimum (e.g. 1.3.0).',
                method: 'POST',
                path: '/api/v1/agent/register',
                headers: () => ({
                    'X-Agent-Version': '1.3.0'
                }),
                body: () => ({
                    licenseToken: 'QA-LAB-TOKEN-999',
                    machineId: 'qa-machine-' + Math.floor(Math.random() * 100000),
                    hostname: 'qa-simulated-agent',
                    version: '1.3.0',
                    capabilities: ['TELEMETRY']
                }),
                assertions: [
                    { label: 'HTTP Status is 200', check: (res, status) => status === 200 },
                    { label: 'success is true', check: (res) => res.success === true },
                    { label: 'warning is DEPRECATED_VERSION', check: (res) => res.warning === 'DEPRECATED_VERSION' },
                    { label: 'agentId is present', check: (res) => typeof res.agentId === 'string' && res.agentId.length > 0 }
                ]
            },
            {
                id: 'register-unsupported-version',
                category: 'identity',
                title: 'Registration Rejected (Unsupported Version)',
                description: 'Verifies registration is rejected (HTTP 426) when version is below minimum supported version (e.g. 1.1.0).',
                method: 'POST',
                path: '/api/v1/agent/register',
                headers: () => ({
                    'X-Agent-Version': '1.1.0'
                }),
                body: () => ({
                    licenseToken: 'QA-LAB-TOKEN-999',
                    machineId: 'qa-machine-' + Math.floor(Math.random() * 100000),
                    hostname: 'qa-simulated-agent',
                    version: '1.1.0',
                    capabilities: ['TELEMETRY']
                }),
                assertions: [
                    { label: 'HTTP Status is 426', check: (res, status) => status === 426 },
                    { label: 'success is false', check: (res) => res.success === false },
                    { label: 'code is VERSION_REJECTED', check: (res) => { const c = res.code || (res.error && res.error.code); return c === 'VERSION_REJECTED'; } }
                ]
            },
            {
                id: 'register-missing-version-header',
                category: 'identity',
                title: 'Registration Rejected (Missing Version Header)',
                description: 'Verifies registration is rejected (HTTP 426) when X-Agent-Version header is completely missing.',
                method: 'POST',
                path: '/api/v1/agent/register',
                headers: () => ({
                    'X-Agent-Version': undefined
                }),
                body: () => ({
                    licenseToken: 'QA-LAB-TOKEN-999',
                    machineId: 'qa-machine-' + Math.floor(Math.random() * 100000),
                    hostname: 'qa-simulated-agent',
                    version: '1.5.0',
                    capabilities: ['TELEMETRY']
                }),
                assertions: [
                    { label: 'HTTP Status is 426', check: (res, status) => status === 426 },
                    { label: 'success is false', check: (res) => res.success === false },
                    { label: 'code is VERSION_REJECTED', check: (res) => { const c = res.code || (res.error && res.error.code); return c === 'VERSION_REJECTED'; } }
                ]
            },
            {
                id: 'heartbeat-deprecated-version',
                category: 'gateway',
                title: 'Agent Heartbeat (Deprecated Version)',
                description: 'Verifies heartbeat succeeds with warning (DEPRECATED_VERSION) when X-Agent-Version is 1.3.0.',
                method: 'POST',
                path: '/api/v1/agent/heartbeat',
                headers: () => ({
                    'X-Agent-Id': qaState.registeredAgentId || '00000000-0000-0000-0000-000000000000',
                    'X-Agent-Secret': qaState.registeredAgentSecret || 'dummy-secret',
                    'X-Agent-Version': '1.3.0'
                }),
                body: () => ({
                    agentId: qaState.registeredAgentId || '00000000-0000-0000-0000-000000000000',
                    agentSecret: qaState.registeredAgentSecret || 'dummy-secret',
                    hostname: 'qa-simulated-agent',
                    version: '1.3.0',
                    status: 'ONLINE',
                    uptime: 300,
                    metrics: { cpuPct: 12.5, memoryPct: 44.2, diskPct: 18.0 },
                    health: { outboxPendingCount: 0, databaseHealthy: true, freqtradeHealthy: true }
                }),
                assertions: [
                    { label: 'HTTP Status is 200', check: (res, status) => status === 200 },
                    { label: 'success is true', check: (res) => res.success === true },
                    { label: 'warning is DEPRECATED_VERSION', check: (res) => res.warning === 'DEPRECATED_VERSION' }
                ]
            },
            {
                id: 'heartbeat-unsupported-version',
                category: 'gateway',
                title: 'Heartbeat Rejected (Unsupported Version)',
                description: 'Verifies heartbeat is rejected (HTTP 426) when X-Agent-Version is 1.1.0.',
                method: 'POST',
                path: '/api/v1/agent/heartbeat',
                headers: () => ({
                    'X-Agent-Id': qaState.registeredAgentId || '00000000-0000-0000-0000-000000000000',
                    'X-Agent-Secret': qaState.registeredAgentSecret || 'dummy-secret',
                    'X-Agent-Version': '1.1.0'
                }),
                body: () => ({
                    agentId: qaState.registeredAgentId || '00000000-0000-0000-0000-000000000000',
                    agentSecret: qaState.registeredAgentSecret || 'dummy-secret',
                    hostname: 'qa-simulated-agent',
                    version: '1.1.0',
                    status: 'ONLINE',
                    uptime: 300,
                    metrics: { cpuPct: 12.5, memoryPct: 44.2, diskPct: 18.0 },
                    health: { outboxPendingCount: 0, databaseHealthy: true, freqtradeHealthy: true }
                }),
                assertions: [
                    { label: 'HTTP Status is 426', check: (res, status) => status === 426 },
                    { label: 'success is false', check: (res) => res.success === false },
                    { label: 'code is VERSION_REJECTED', check: (res) => { const c = res.code || (res.error && res.error.code); return c === 'VERSION_REJECTED'; } }
                ]
            },
            {
                id: 'register-missing-required-capabilities',
                category: 'identity',
                title: 'Register Rejected (Missing Required Caps)',
                description: 'Verifies registration is rejected (HTTP 400) if requested capabilities omit required ones (e.g., TELEMETRY).',
                method: 'POST',
                path: '/api/v1/agent/register',
                headers: () => ({
                    'X-Agent-Version': '1.5.0',
                    'X-Agent-Capabilities': 'DOCKER'
                }),
                body: () => ({
                    licenseToken: 'QA-LAB-TOKEN-999',
                    machineId: 'qa-machine-' + Math.floor(Math.random() * 100000),
                    hostname: 'qa-simulated-agent',
                    version: '1.5.0',
                    capabilities: ['DOCKER']
                }),
                assertions: [
                    { label: 'HTTP Status is 400', check: (res, status) => status === 400 },
                    { label: 'success is false', check: (res) => res.success === false },
                    { label: 'code is CAPABILITY_REJECTED', check: (res) => { const c = res.code || (res.error && res.error.code); return c === 'CAPABILITY_REJECTED'; } }
                ]
            },
            {
                id: 'register-forbidden-capabilities',
                category: 'identity',
                title: 'Register Rejected (Forbidden Caps)',
                description: 'Verifies registration is rejected (HTTP 400) if requested capabilities contain forbidden ones (e.g., ROOT_ACCESS).',
                method: 'POST',
                path: '/api/v1/agent/register',
                headers: () => ({
                    'X-Agent-Version': '1.5.0',
                    'X-Agent-Capabilities': 'TELEMETRY, ROOT_ACCESS'
                }),
                body: () => ({
                    licenseToken: 'QA-LAB-TOKEN-999',
                    machineId: 'qa-machine-' + Math.floor(Math.random() * 100000),
                    hostname: 'qa-simulated-agent',
                    version: '1.5.0',
                    capabilities: ['TELEMETRY', 'ROOT_ACCESS']
                }),
                assertions: [
                    { label: 'HTTP Status is 400', check: (res, status) => status === 400 },
                    { label: 'success is false', check: (res) => res.success === false },
                    { label: 'code is CAPABILITY_REJECTED', check: (res) => { const c = res.code || (res.error && res.error.code); return c === 'CAPABILITY_REJECTED'; } }
                ]
            },
            {
                id: 'register-negotiated-capabilities',
                category: 'identity',
                title: 'Register Negotiated (Intersection Caps)',
                description: 'Verifies registration succeeds (HTTP 200) and returns the intersection of allowed capabilities (e.g., requested: TELEMETRY, DOCKER, MONITORING; allowed: TELEMETRY, DOCKER; returns: TELEMETRY, DOCKER).',
                method: 'POST',
                path: '/api/v1/agent/register',
                headers: () => ({
                    'X-Agent-Version': '1.5.0',
                    'X-Agent-Capabilities': 'TELEMETRY, DOCKER, MONITORING'
                }),
                body: () => ({
                    licenseToken: 'QA-LAB-TOKEN-999',
                    machineId: 'qa-machine-' + Math.floor(Math.random() * 100000),
                    hostname: 'qa-simulated-agent',
                    version: '1.5.0',
                    capabilities: ['TELEMETRY', 'DOCKER', 'MONITORING']
                }),
                assertions: [
                    { label: 'HTTP Status is 200', check: (res, status) => status === 200 },
                    { label: 'success is true', check: (res) => res.success === true },
                    { label: 'authorizedCapabilities intersection is correct', check: (res) => {
                        const caps = res.authorizedCapabilities || [];
                        return caps.includes('TELEMETRY') && caps.includes('DOCKER') && !caps.includes('MONITORING');
                    }}
                ],
                onBefore: async () => {
                    await fetch('/api/v1/qa/simulation', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ allowedCapabilities: ['TELEMETRY', 'DOCKER'] })
                    });
                },
                onComplete: async () => {
                    await fetch('/api/v1/qa/simulation', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ allowedCapabilities: ['MONITORING', 'INCIDENTS', 'TELEMETRY', 'DOCKER', 'INCIDENT_SYNC'] })
                    });
                }
            },
            {
                id: 'heartbeat-missing-required-capabilities',
                category: 'gateway',
                title: 'Heartbeat Rejected (Missing Required Caps)',
                description: 'Verifies heartbeat is rejected (HTTP 400) if agent lacks a required capability (e.g. required is TELEMETRY, requested is DOCKER).',
                method: 'POST',
                path: '/api/v1/agent/heartbeat',
                headers: () => ({
                    'X-Agent-Id': qaState.registeredAgentId || '00000000-0000-0000-0000-000000000000',
                    'X-Agent-Secret': qaState.registeredAgentSecret || 'dummy-secret',
                    'X-Agent-Version': '1.5.0',
                    'X-Agent-Capabilities': 'DOCKER'
                }),
                body: () => ({
                    agentId: qaState.registeredAgentId || '00000000-0000-0000-0000-000000000000',
                    agentSecret: qaState.registeredAgentSecret || 'dummy-secret',
                    hostname: 'qa-simulated-agent',
                    version: '1.5.0',
                    status: 'ONLINE',
                    uptime: 300,
                    metrics: { cpuPct: 12.5, memoryPct: 44.2, diskPct: 18.0 },
                    health: { outboxPendingCount: 0, databaseHealthy: true, freqtradeHealthy: true }
                }),
                assertions: [
                    { label: 'HTTP Status is 400', check: (res, status) => status === 400 },
                    { label: 'success is false', check: (res) => res.success === false },
                    { label: 'code is CAPABILITY_REJECTED', check: (res) => { const c = res.code || (res.error && res.error.code); return c === 'CAPABILITY_REJECTED'; } }
                ]
            },
            {
                id: 'heartbeat-forbidden-capabilities',
                category: 'gateway',
                title: 'Heartbeat Rejected (Forbidden Caps)',
                description: 'Verifies heartbeat is rejected (HTTP 400) if agent sends forbidden capabilities (e.g. ROOT_ACCESS).',
                method: 'POST',
                path: '/api/v1/agent/heartbeat',
                headers: () => ({
                    'X-Agent-Id': qaState.registeredAgentId || '00000000-0000-0000-0000-000000000000',
                    'X-Agent-Secret': qaState.registeredAgentSecret || 'dummy-secret',
                    'X-Agent-Version': '1.5.0',
                    'X-Agent-Capabilities': 'TELEMETRY, ROOT_ACCESS'
                }),
                body: () => ({
                    agentId: qaState.registeredAgentId || '00000000-0000-0000-0000-000000000000',
                    agentSecret: qaState.registeredAgentSecret || 'dummy-secret',
                    hostname: 'qa-simulated-agent',
                    version: '1.5.0',
                    status: 'ONLINE',
                    uptime: 300,
                    metrics: { cpuPct: 12.5, memoryPct: 44.2, diskPct: 18.0 },
                    health: { outboxPendingCount: 0, databaseHealthy: true, freqtradeHealthy: true }
                }),
                assertions: [
                    { label: 'HTTP Status is 400', check: (res, status) => status === 400 },
                    { label: 'success is false', check: (res) => res.success === false },
                    { label: 'code is CAPABILITY_REJECTED', check: (res) => { const c = res.code || (res.error && res.error.code); return c === 'CAPABILITY_REJECTED'; } }
                ]
            },
            {
                id: 'heartbeat-negotiate-and-adapt',
                category: 'gateway',
                title: 'Heartbeat Adaptive Negotiation',
                description: 'Verifies heartbeat dynamic capability adaptation: succeeds with HTTP 200.',
                method: 'POST',
                path: '/api/v1/agent/heartbeat',
                headers: () => ({
                    'X-Agent-Id': qaState.registeredAgentId || '00000000-0000-0000-0000-000000000000',
                    'X-Agent-Secret': qaState.registeredAgentSecret || 'dummy-secret',
                    'X-Agent-Version': '1.5.0',
                    'X-Agent-Capabilities': 'TELEMETRY, DOCKER'
                }),
                body: () => ({
                    agentId: qaState.registeredAgentId || '00000000-0000-0000-0000-000000000000',
                    agentSecret: qaState.registeredAgentSecret || 'dummy-secret',
                    hostname: 'qa-simulated-agent',
                    version: '1.5.0',
                    status: 'ONLINE',
                    uptime: 300,
                    metrics: { cpuPct: 12.5, memoryPct: 44.2, diskPct: 18.0 },
                    health: { outboxPendingCount: 0, databaseHealthy: true, freqtradeHealthy: true }
                }),
                assertions: [
                    { label: 'HTTP Status is 200', check: (res, status) => status === 200 },
                    { label: 'success is true', check: (res) => res.success === true }
                ]
            }
        ];

        // Renders all QA cards dynamically
        function renderQaCards() {
            const containers = {
                identity: document.getElementById('qa-identity-container'),
                gateway: document.getElementById('qa-gateway-container'),
                sync: document.getElementById('qa-sync-container')
            };

            for (const key in containers) {
                if (containers[key]) containers[key].innerHTML = '';
            }

            QA_TESTS.forEach(test => {
                const target = containers[test.category];
                if (!target) return;

                const assertionsHtml = test.assertions.map(a => \`
                    <div class="qa-assertion-item">
                        <span class="assert-bullet" style="color:var(--text-secondary);">&#9675;</span>
                        <span>\${a.label}</span>
                    </div>
                \`).join('');

                const cardHtml = \`
                    <div class="qa-card" id="test-card-\${test.id}">
                        <div>
                            <div class="qa-card-header">
                                <span class="qa-card-title">\${test.title}</span>
                                <span class="sys-badge" style="font-size:0.7rem; padding:0.1rem 0.4rem; color:var(--text-secondary); border-color:var(--border-color); background:transparent;">
                                    \${test.method}
                                </span>
                            </div>
                            <p class="qa-card-desc">\${test.description}</p>
                            
                            <div style="font-size:0.75rem; color:var(--text-secondary); margin-bottom:0.4rem; font-weight:600;">Expected Assertions:</div>
                            <div class="qa-assertions-box">
                                \${assertionsHtml}
                            </div>
                        </div>

                        <div>
                            <div class="flex-between">
                                <button class="btn btn-secondary" style="width:100%;" onclick="runSingleQaTest('\${test.id}')">Run Test</button>
                            </div>
                            
                            <div class="qa-status-row" id="test-status-\${test.id}" style="display:none;">
                                <span>Status: <strong class="test-http-status">-</strong></span>
                                <span>Latency: <strong class="test-latency">-</strong></span>
                                <span class="test-result-badge" style="font-weight:700;">-</span>
                            </div>
                            <div class="qa-console" id="test-console-\${test.id}"></div>
                        </div>
                    </div>
                \`;
                target.insertAdjacentHTML('beforeend', cardHtml);
            });
        }

        // Unified Test Runner
        async function runSingleQaTest(testId) {
            const test = QA_TESTS.find(t => t.id === testId);
            if (!test) return null;

            const card = document.getElementById(\`test-card-\${testId}\`);
            const statusRow = document.getElementById(\`test-status-\${testId}\`);
            const consoleBox = document.getElementById(\`test-console-\${testId}\`);

            if (statusRow) statusRow.style.display = 'flex';
            if (consoleBox) {
                consoleBox.style.display = 'block';
                consoleBox.innerHTML = 'Executing request...';
                consoleBox.style.color = 'var(--text-secondary)';
            }

            const isAuthSensitive = (testId === 'heartbeat-success' || test.category === 'sync' || testId.includes('get-'));
            if (isAuthSensitive && !qaState.registeredAgentId) {
                if (consoleBox) {
                    consoleBox.innerHTML = '⚠️ WARNING: No registered agentId found in QA state. Register first or this request may fail due to authentication mismatch.';
                    consoleBox.style.color = 'var(--color-orange)';
                }
            }

            if (test.onBefore) {
                try {
                    await test.onBefore(qaState);
                } catch (err) {
                    console.error('Failed to run test.onBefore hook:', err);
                }
            }

            const startTime = performance.now();
            let status = 0;
            let responseJson = {};

            try {
                const headers = { 
                    'Content-Type': 'application/json',
                    'X-Agent-Version': '1.5.0', // Default to compatible version for QA tests
                    'X-Agent-Capabilities': 'TELEMETRY, DOCKER'
                };
                if (test.headers) {
                    const customHeaders = test.headers(qaState);
                    Object.assign(headers, customHeaders);
                }
                for (const key in headers) {
                    if (headers[key] === undefined || headers[key] === null) {
                        delete headers[key];
                    }
                }

                const options = {
                    method: test.method,
                    headers: headers
                };

                if (test.method === 'POST' || test.method === 'PUT') {
                    options.body = JSON.stringify(test.body ? test.body(qaState) : {});
                }

                const response = await fetch(test.path, options);
                status = response.status;
                responseJson = await response.json().catch(() => ({}));
            } catch (err) {
                status = 0;
                responseJson = { error: err.message || 'Network connectivity error' };
            }

            const latency = Math.round(performance.now() - startTime);

            // Assertions Check
            let allPassed = true;
            const assertionsResults = [];
            test.assertions.forEach(assertion => {
                const passed = assertion.check(responseJson, status);
                if (!passed) allPassed = false;
                assertionsResults.push({ label: assertion.label, passed });
            });

            // Update UI elements
            if (statusRow) {
                const httpStatusEl = statusRow.querySelector('.test-http-status');
                const latencyEl = statusRow.querySelector('.test-latency');
                const resultBadge = statusRow.querySelector('.test-result-badge');

                httpStatusEl.textContent = status === 0 ? 'NETWORK_ERROR' : status;
                latencyEl.textContent = latency + 'ms';
                
                if (allPassed) {
                    resultBadge.textContent = 'PASS';
                    resultBadge.style.color = 'var(--color-green)';
                    card.style.borderColor = 'rgba(16, 185, 129, 0.4)';
                } else {
                    resultBadge.textContent = 'FAIL';
                    resultBadge.style.color = 'var(--color-red)';
                    card.style.borderColor = 'rgba(239, 68, 68, 0.4)';
                }
            }

            if (consoleBox) {
                consoleBox.style.display = 'block';
                consoleBox.style.color = allPassed ? 'var(--color-green)' : 'var(--color-red)';
                
                let assertionLog = assertionsResults.map(a => 
                    \`[\${a.passed ? '✓' : '✗'}] \${a.label}\`
                ).join('\\n');

                consoleBox.innerHTML = \`Assertions:\\n\${assertionLog}\\n\\nResponse:\\n\${JSON.stringify(responseJson, null, 2)}\`;
            }

            // Callback on success to bind state (e.g. register returns secret)
            if (allPassed && test.onSuccess) {
                test.onSuccess(responseJson);
            }

            if (test.onComplete) {
                try {
                    await test.onComplete(qaState);
                } catch (err) {
                    console.error('Failed to run test.onComplete hook:', err);
                }
            }

            return {
                id: testId,
                title: test.title,
                status,
                latency,
                allPassed,
                responseJson
            };
        }

        // Active QA Target Agent selectors and session hydration
        async function purgeOfflineQaAgents(event) {
            if (event) event.preventDefault();
            if (!confirm('Are you sure you want to delete all offline simulated QA agents from the database?')) {
                return;
            }
            try {
                const res = await fetch('/api/v1/qa/purge', { method: 'POST' });
                const json = await res.json();
                if (json.success) {
                    alert(\`Successfully purged \${json.purgedCount} offline QA agents.\`);
                    pollAgentStatus();
                } else {
                    alert('Purge failed: ' + json.message);
                }
            } catch (err) {
                alert('Purge failed: ' + err.message);
            }
        }

        async function changeQaAgent(agentId) {
            if (!agentId) {
                qaState.registeredAgentId = '';
                qaState.registeredAgentSecret = '';
                updateActiveAgentDisplays('None (Select an agent to begin testing)');
                return;
            }
            try {
                const res = await fetch(\`/api/v1/qa/agent-session?id=\${agentId}\`);
                const json = await res.json();
                if (json.success) {
                    qaState.registeredAgentId = json.agentId;
                    qaState.registeredAgentSecret = json.agentSecret;
                    
                    const dropdown = document.querySelector('.select-qa-agent');
                    let agentName = agentId;
                    if (dropdown) {
                        const opt = Array.from(dropdown.options).find(o => o.value === agentId);
                        if (opt) agentName = opt.textContent;
                    }
                    updateActiveAgentDisplays(agentName);
                }
            } catch (err) {
                console.error('Failed to change QA agent:', err);
            }
        }

        function updateActiveAgentDisplays(text) {
            document.querySelectorAll('.active-qa-agent-display').forEach(el => {
                el.textContent = text;
            });
        }

        function updateQaAgentDropdowns(agents) {
            const dropdowns = document.querySelectorAll('.select-qa-agent');
            const selectContainers = document.querySelectorAll('.active-qa-agent-select-container');
            
            if (agents.length === 0) {
                selectContainers.forEach(c => c.style.display = 'none');
                dropdowns.forEach(d => d.innerHTML = '<option value="">No agents found</option>');
                if (qaState.registeredAgentId) {
                    changeQaAgent('');
                }
                return;
            }

            selectContainers.forEach(c => c.style.display = 'flex');

            dropdowns.forEach(d => {
                const currentVal = d.value || qaState.registeredAgentId;
                d.innerHTML = agents.map(agent => 
                    \`<option value="\${agent.id}" \${agent.id === currentVal ? 'selected' : ''}>\${agent.hostname} (\${agent.status})</option>\`
                ).join('');
            });

            const stillExists = agents.some(a => a.id === qaState.registeredAgentId);
            if (!qaState.registeredAgentId || !stillExists) {
                changeQaAgent(agents[0].id);
            } else {
                const currentAgent = agents.find(a => a.id === qaState.registeredAgentId);
                if (currentAgent) {
                    updateActiveAgentDisplays(\`\${currentAgent.hostname} (\${currentAgent.status})\`);
                }
            }
        }

        // Toggle simulation headers & backend state
        async function fetchSimulationState() {
            try {
                const res = await fetch('/api/v1/qa/simulation');
                const json = await res.json();
                if (json.success && json.simulation) {
                    qaState.simulateCloudOffline = json.simulation.cloudOffline;
                    updateOfflineButtonUI(qaState.simulateCloudOffline);

                    // Sync version inputs if they are not actively focused
                    const minInput = document.getElementById('input-min-version');
                    const depInput = document.getElementById('input-dep-version');
                    if (minInput && document.activeElement !== minInput) {
                        minInput.value = json.simulation.minimumVersion || '1.2.0';
                    }
                    if (depInput && document.activeElement !== depInput) {
                        depInput.value = json.simulation.deprecatedVersion || '1.4.0';
                    }

                    // Sync capability inputs if they are not actively focused
                    const reqCapsInput = document.getElementById('input-required-caps');
                    const allCapsInput = document.getElementById('input-allowed-caps');
                    if (reqCapsInput && document.activeElement !== reqCapsInput) {
                        reqCapsInput.value = (json.simulation.requiredCapabilities || []).join(', ');
                    }
                    if (allCapsInput && document.activeElement !== allCapsInput) {
                        allCapsInput.value = (json.simulation.allowedCapabilities || []).join(', ');
                    }
                }
            } catch (err) {
                console.error('Failed to fetch simulation state:', err);
            }
        }

        async function updateVersionPolicy() {
            const minVersion = document.getElementById('input-min-version').value.trim();
            const depVersion = document.getElementById('input-dep-version').value.trim();
            try {
                const res = await fetch('/api/v1/qa/simulation', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        minimumVersion: minVersion,
                        deprecatedVersion: depVersion
                    })
                });
                const json = await res.json();
                if (json.success && json.simulation) {
                    console.log('Version policy updated on backend:', json.simulation);
                }
            } catch (err) {
                console.error('Failed to update version policy:', err);
            }
        }

        async function updateCapabilityPolicy() {
            const reqVal = document.getElementById('input-required-caps').value;
            const allVal = document.getElementById('input-allowed-caps').value;
            const reqCaps = reqVal.split(',').map(s => s.trim()).filter(Boolean);
            const allCaps = allVal.split(',').map(s => s.trim()).filter(Boolean);
            try {
                const res = await fetch('/api/v1/qa/simulation', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        requiredCapabilities: reqCaps,
                        allowedCapabilities: allCaps
                    })
                });
                const json = await res.json();
                if (json.success && json.simulation) {
                    console.log('Capability policy updated on backend:', json.simulation);
                }
            } catch (err) {
                console.error('Failed to update capability policy:', err);
            }
        }

        function updateOfflineButtonUI(offline) {
            const btn = document.getElementById('btn-offline-toggle');
            if (btn) {
                if (offline) {
                    btn.textContent = 'Disable Offline Simulation';
                    btn.className = 'btn btn-red';
                } else {
                    btn.textContent = 'Enable Offline Simulation';
                    btn.className = 'btn btn-orange';
                }
            }
        }

        async function toggleOfflineSimulation() {
            const targetState = !qaState.simulateCloudOffline;
            try {
                const res = await fetch('/api/v1/qa/simulation', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ cloudOffline: targetState })
                });
                const json = await res.json();
                if (json.success && json.simulation) {
                    qaState.simulateCloudOffline = json.simulation.cloudOffline;
                    updateOfflineButtonUI(qaState.simulateCloudOffline);
                    renderQaCards();
                }
            } catch (err) {
                console.error('Failed to toggle offline simulation:', err);
                alert('Failed to update simulation state on backend: ' + err.message);
            }
        }

        // ==========================================
        // SMOKE TESTS SUITE RUNNER
        // ==========================================
        
        function clearSmokeTerminal() {
            const term = document.getElementById('smoke-terminal');
            if (term) term.innerHTML = '<div>Console ready. Select a suite to begin testing.</div>';
        }

        function logToSmokeTerminal(text, type = 'info') {
            const term = document.getElementById('smoke-terminal');
            if (!term) return;

            if (term.innerHTML.includes('Console ready.')) {
                term.innerHTML = '';
            }

            let color = 'var(--text-primary)';
            let prefix = '[INFO]';
            if (type === 'pass') { color = 'var(--color-green)'; prefix = '[PASS]'; }
            if (type === 'fail') { color = 'var(--color-red)'; prefix = '[FAIL]'; }
            if (type === 'run') { color = 'var(--color-blue)'; prefix = '[RUN]'; }
            if (type === 'state') { color = 'var(--color-purple)'; prefix = '[STATE]'; }

            const row = \`<div style="color: \${color}; margin-bottom: 0.25rem;">
                <span style="opacity: 0.5;">\${new Date().toLocaleTimeString()}</span> 
                <strong>\${prefix}</strong> \${text}
            </div>\`;
            term.insertAdjacentHTML('beforeend', row);
            term.scrollTop = term.scrollHeight;
        }

        async function runSmokeSuite(suite) {
            logToSmokeTerminal(\`Initiating \${suite.toUpperCase()} smoke test suite...\`, 'run');
            let testList = [];
            if (suite === 'identity') {
                testList = [
                    'register-success', 'register-missing-token', 'register-invalid-token',
                    'register-missing-required-capabilities', 'register-forbidden-capabilities', 'register-negotiated-capabilities'
                ];
            } else if (suite === 'gateway') {
                testList = [
                    'heartbeat-success', 'heartbeat-wrong-secret', 'heartbeat-unknown-agent', 'get-config', 'get-update',
                    'heartbeat-missing-required-capabilities', 'heartbeat-forbidden-capabilities', 'heartbeat-negotiate-and-adapt'
                ];
            } else if (suite === 'sync') {
                testList = ['sync-incident-success', 'sync-alert-success'];
            } else if (suite === 'full') {
                testList = [
                    'register-success', 'register-missing-token', 'register-invalid-token',
                    'register-missing-required-capabilities', 'register-forbidden-capabilities', 'register-negotiated-capabilities',
                    'heartbeat-success', 'heartbeat-wrong-secret', 'heartbeat-unknown-agent', 'get-config', 'get-update',
                    'heartbeat-missing-required-capabilities', 'heartbeat-forbidden-capabilities', 'heartbeat-negotiate-and-adapt',
                    'sync-incident-success', 'sync-alert-success'
                ];
            }

            let passedCount = 0;
            const startTime = Date.now();

            for (const testId of testList) {
                logToSmokeTerminal(\`Running test case: \${testId}...\`);
                const result = await runSingleQaTest(testId);
                if (result) {
                    if (result.allPassed) {
                        passedCount++;
                        logToSmokeTerminal(\`\${result.title} — PASS (\${result.latency}ms)\`, 'pass');
                    } else {
                        logToSmokeTerminal(\`\${result.title} — FAIL (\${result.latency}ms). HTTP \${result.status}\`, 'fail');
                    }
                }
                // small artificial delay to simulate real client progression
                await new Promise(r => setTimeout(r, 400));
            }

            const duration = ((Date.now() - startTime) / 1000).toFixed(2);
            const overallPassed = passedCount === testList.length;
            
            if (overallPassed) {
                logToSmokeTerminal(\`🎉 SUITE SUCCESSFUL! [\${passedCount}/\${testList.length}] passed in \${duration}s\`, 'pass');
            } else {
                logToSmokeTerminal(\`❌ SUITE FAILURE! [\${passedCount}/\${testList.length}] passed in \${duration}s\`, 'fail');
            }
        }

        // ==========================================
        // DYNAMIC AGENT STATUS POLLER
        // ==========================================

        async function pollAgentStatus() {
            try {
                const res = await fetch('/api/v1/qa/agents');
                const json = await res.json();
                if (json.success && json.data) {
                    renderAgentsStatus(json.data);
                    updateQaAgentDropdowns(json.data);
                }
            } catch (err) {
                console.error('Failed to poll agent status:', err);
            }
        }

        function renderAgentsStatus(agents) {
            const container = document.getElementById('agents-status-container');
            if (!container) return;

            if (agents.length === 0) {
                container.innerHTML = \`
                    <div class="card" style="text-align:center; padding: 3rem; color:var(--text-secondary);">
                        🔍 No registered agents found. Connect an agent to begin monitoring.
                    </div>
                \`;
                return;
            }

            container.innerHTML = '';
            agents.forEach(agent => {
                const hb = agent.latestHeartbeat;
                const statusBadge = agent.status === 'ONLINE' 
                    ? \`<span style="color:var(--color-green); display:inline-flex; align-items:center; gap:0.4rem; font-weight:600;"><span class="online-dot"></span>ONLINE</span>\`
                    : \`<span style="color:var(--color-red); display:inline-flex; align-items:center; gap:0.4rem; font-weight:600;"><span class="indicator ind-red" style="margin:0;"></span>OFFLINE</span>\`;

                const lastHbSec = agent.lastHeartbeatAt 
                    ? Math.round((Date.now() - new Date(agent.lastHeartbeatAt).getTime()) / 1000)
                    : null;
                const hbDisplay = lastHbSec !== null 
                    ? \`\${lastHbSec}s ago\`
                    : 'Never';

                // Format uptime
                let uptimeDisplay = '0h 0m';
                if (hb && hb.uptime) {
                    const totalSec = Number(hb.uptime);
                    const h = Math.floor(totalSec / 3600);
                    const m = Math.floor((totalSec % 3600) / 60);
                    uptimeDisplay = \`\${h}h \${m}m\`;
                }

                // Subsystem healths
                const dbHealth = hb && hb.databaseHealthy
                    ? \`<span style="color:var(--color-green); font-weight:600;">🟢 Healthy</span>\`
                    : \`<span style="color:var(--color-red); font-weight:600;">🔴 Unhealthy</span>\`;
                const ftHealth = hb && hb.freqtradeHealthy
                    ? \`<span style="color:var(--color-green); font-weight:600;">🟢 Healthy</span>\`
                    : \`<span style="color:var(--color-red); font-weight:600;">🔴 Unhealthy</span>\`;

                const cpu = hb ? hb.cpuPct : 0;
                const ram = hb ? hb.memoryPct : 0;
                const disk = hb ? hb.diskPct : 0;
                const outboxPending = hb ? hb.outboxPending : 0;

                const cardHtml = \`
                    <div class="card" style="border-left: 4px solid \${agent.status === 'ONLINE' ? 'var(--color-green)' : 'var(--color-red)'}">
                        <div class="flex-between" style="border-bottom: 1px solid var(--border-color); padding-bottom: 0.75rem; margin-bottom: 1rem;">
                            <div>
                                <span style="font-weight:700; font-size:1.1rem; color:var(--text-primary);">\${agent.hostname}</span>
                                <span style="font-size:0.75rem; font-family:'Fira Code', monospace; color:var(--text-secondary); margin-left:0.5rem;">(\\$\${agent.id})</span>
                            </div>
                            \${statusBadge}
                        </div>

                        <div style="display:grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap:1.5rem;">
                            <!-- Identity Info -->
                            <div>
                                <div style="font-size:0.75rem; color:var(--text-secondary); text-transform:uppercase; font-weight:700; margin-bottom:0.5rem;">Identity & Info</div>
                                <div style="display:flex; flex-direction:column; gap:0.4rem; font-size:0.85rem;">
                                    <div class="flex-between"><span>Version:</span><strong>\${agent.version}</strong></div>
                                    <div class="flex-between"><span>Machine ID:</span><span style="font-family:'Fira Code', monospace; font-size:0.75rem; color:var(--text-secondary);">\${agent.machineId}</span></div>
                                    <div class="flex-between">
                                        <span>Capabilities:</span>
                                        <div style="display:flex; gap:0.25rem; flex-wrap:wrap; justify-content:flex-end; max-width: 60%;">
                                            \${(agent.capabilities || []).map(cap => \`<span class="sys-badge" style="font-size:0.7rem; padding:0.1rem 0.3rem; margin:0; border-color: rgba(59,130,246,0.3); color: var(--color-blue); background: rgba(59,130,246,0.05); font-weight: 600;">\${cap}</span>\`).join('')}
                                        </div>
                                    </div>
                                </div>
                            </div>

                            <!-- Heartbeat & Connection -->
                            <div>
                                <div style="font-size:0.75rem; color:var(--text-secondary); text-transform:uppercase; font-weight:700; margin-bottom:0.5rem;">Telemetry Metrics</div>
                                <div style="display:flex; flex-direction:column; gap:0.4rem; font-size:0.85rem;">
                                    <div class="flex-between"><span>Last Heartbeat:</span><strong>\${hbDisplay}</strong></div>
                                    <div class="flex-between"><span>Uptime:</span><strong>\${uptimeDisplay}</strong></div>
                                    <div class="flex-between"><span>DB Status:</span>\${dbHealth}</div>
                                    <div class="flex-between"><span>Freqtrade:</span>\${ftHealth}</div>
                                </div>
                            </div>

                            <!-- System Load -->
                            <div>
                                <div style="font-size:0.75rem; color:var(--text-secondary); text-transform:uppercase; font-weight:700; margin-bottom:0.5rem;">System Load</div>
                                <div style="display:flex; flex-direction:column; gap:0.6rem; font-size:0.85rem;">
                                    <div>
                                        <div class="flex-between"><span>CPU Usage:</span><strong>\${cpu}%</strong></div>
                                        <div class="progress-bar-container"><div class="progress-bar-fill" style="width: \${cpu}%; background:\${cpu > 80 ? 'var(--color-red)' : (cpu > 50 ? 'var(--color-orange)' : 'var(--color-green)')}"></div></div>
                                    </div>
                                    <div>
                                        <div class="flex-between"><span>RAM Usage:</span><strong>\${ram}%</strong></div>
                                        <div class="progress-bar-container"><div class="progress-bar-fill" style="width: \${ram}%; background:\${ram > 80 ? 'var(--color-red)' : (ram > 50 ? 'var(--color-orange)' : 'var(--color-green)')}"></div></div>
                                    </div>
                                    <div class="flex-between" style="margin-top:0.25rem;">
                                        <span>Outbox Pending Queue:</span>
                                        <span class="sys-badge" style="padding:0.15rem 0.5rem; background:\${outboxPending > 0 ? 'rgba(245,158,11,0.15)' : 'rgba(16,185,129,0.15)'}; border-color:\${outboxPending > 0 ? 'rgba(245,158,11,0.3)' : 'rgba(16,185,129,0.3)'}; color:\${outboxPending > 0 ? 'var(--color-orange)' : 'var(--color-green)'}">
                                            \${outboxPending} Pending
                                        </span>
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>
                \`;
                container.insertAdjacentHTML('beforeend', cardHtml);
            });
        }

        // Initial setup
        fetchHealth();
        fetchFreqtradeStatus();
        fetchRuntimeFlags();
        setupSseStream();
        renderQaCards();
        pollAgentStatus();
        fetchSimulationState();

        // Intervals
        setInterval(fetchHealth, 5000);
        setInterval(fetchFreqtradeStatus, 8000);
        setInterval(pollAgentStatus, 5000);
        setInterval(fetchSimulationState, 5000);

        function setupSseStream() {
            if (sseSource) sseSource.close();
            
            sseSource = new EventSource('/api/v1/events/stream');
            
            sseSource.onmessage = function(event) {
                try {
                    const msg = JSON.parse(event.data);
                    appendEventToTimeline(msg);
                    
                    // Dynamically keep track of ringbuffer size
                    const countEl = document.getElementById('ringbuffer-count');
                    if (countEl) {
                        let currentCount = parseInt(countEl.textContent) || 0;
                        if (currentCount < 100) currentCount++;
                        countEl.textContent = currentCount;
                    }

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
    </script>
</body>
</html>`;
