// Azure Monitor Cost Optimizer - Static Site Version
// Uses Device Code Flow for authentication (no redirect URIs needed)

// Azure AD Configuration
// Using a well-known public client ID
const CLIENT_ID = '04b07795-8ddb-461a-bbee-02f9e1bf7b46'; // Azure CLI public client ID
const TENANT = 'organizations'; // Multi-tenant

// App state
let accessToken = null;
let allSubscriptions = [];
let currentWorkspaces = [];
let selectedWorkspaces = [];

// KQL Queries for cost analysis
const analysisQueries = {
    dataVolumeByTable: `
        _LogAnalyticsUsage
        | where TimeGenerated > ago(30d)
        | summarize TotalGB = sum(BillableDataGB) by DataType
        | order by TotalGB desc
        | take 20
    `,
    dailyIngestionTrend: `
        _LogAnalyticsUsage
        | where TimeGenerated > ago(30d)
        | summarize DailyGB = sum(BillableDataGB) by bin(TimeGenerated, 1d)
        | order by TimeGenerated asc
    `,
    dataByComputer: `
        _LogAnalyticsUsage
        | where TimeGenerated > ago(7d)
        | summarize TotalGB = sum(BillableDataGB) by Computer
        | order by TotalGB desc
        | take 10
    `,
    heartbeatAnalysis: `
        Heartbeat
        | where TimeGenerated > ago(1h)
        | summarize HeartbeatsPerHour = count() by Computer
        | where HeartbeatsPerHour > 60
        | order by HeartbeatsPerHour desc
    `
};

// Initialize on page load
document.addEventListener('DOMContentLoaded', () => {
    // Check for saved token
    const saved = localStorage.getItem('azureToken');
    if (saved) {
        try {
            const data = JSON.parse(saved);
            if (data.expiresAt > Date.now()) {
                accessToken = data.token;
                onSignedIn(data.username);
            } else {
                localStorage.removeItem('azureToken');
            }
        } catch (e) {
            localStorage.removeItem('azureToken');
        }
    }
});

// Sign In using Device Code Flow
async function signIn() {
    const btn = document.getElementById('signInBtn');
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> Starting sign in...';
    
    try {
        // Step 1: Get device code
        const deviceCodeResponse = await fetch(
            `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/devicecode`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({
                    client_id: CLIENT_ID,
                    scope: 'https://management.azure.com/user_impersonation https://api.loganalytics.io/Data.Read offline_access'
                })
            }
        );
        
        if (!deviceCodeResponse.ok) {
            throw new Error('Failed to get device code');
        }
        
        const deviceCode = await deviceCodeResponse.json();
        
        // Show device code UI
        showDeviceCodeUI(deviceCode);
        
        // Step 2: Poll for token
        await pollForToken(deviceCode);
        
    } catch (error) {
        console.error('Sign in error:', error);
        showError('Sign in failed', error.message);
        btn.disabled = false;
        btn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"></path>
            <polyline points="10 17 15 12 10 7"></polyline>
            <line x1="15" y1="12" x2="3" y2="12"></line>
        </svg> Sign In`;
    }
}

// Show device code UI
function showDeviceCodeUI(deviceCode) {
    document.getElementById('welcomeSection').innerHTML = `
        <div class="device-code-container">
            <h2>🔐 Sign In Required</h2>
            <p>To authenticate with your Microsoft account:</p>
            
            <div class="device-code-steps">
                <div class="step">
                    <span class="step-number">1</span>
                    <span>Go to <a href="${deviceCode.verification_uri}" target="_blank" class="device-link">${deviceCode.verification_uri}</a></span>
                </div>
                <div class="step">
                    <span class="step-number">2</span>
                    <span>Enter this code:</span>
                </div>
            </div>
            
            <div class="device-code-display">
                <code id="userCode">${deviceCode.user_code}</code>
                <button class="copy-btn" onclick="copyCode()">📋 Copy</button>
            </div>
            
            <p class="waiting-message">
                <span class="spinner"></span>
                Waiting for you to complete sign in...
            </p>
            
            <button class="cancel-btn" onclick="cancelSignIn()">Cancel</button>
        </div>
    `;
}

// Copy code to clipboard
function copyCode() {
    const code = document.getElementById('userCode').textContent;
    navigator.clipboard.writeText(code);
    const btn = document.querySelector('.copy-btn');
    btn.textContent = '✓ Copied!';
    setTimeout(() => btn.textContent = '📋 Copy', 2000);
}

// Poll for token
let pollController = null;

async function pollForToken(deviceCode) {
    const interval = deviceCode.interval * 1000 || 5000;
    const expiresAt = Date.now() + (deviceCode.expires_in * 1000);
    
    pollController = new AbortController();
    
    while (Date.now() < expiresAt) {
        if (pollController.signal.aborted) {
            throw new Error('Sign in cancelled');
        }
        
        await new Promise(resolve => setTimeout(resolve, interval));
        
        try {
            const tokenResponse = await fetch(
                `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                    body: new URLSearchParams({
                        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
                        client_id: CLIENT_ID,
                        device_code: deviceCode.device_code
                    })
                }
            );
            
            const tokenData = await tokenResponse.json();
            
            if (tokenData.access_token) {
                // Success!
                accessToken = tokenData.access_token;
                
                // Decode token to get username
                const payload = JSON.parse(atob(tokenData.access_token.split('.')[1]));
                const username = payload.upn || payload.preferred_username || payload.email || 'User';
                
                // Save token
                localStorage.setItem('azureToken', JSON.stringify({
                    token: tokenData.access_token,
                    username: username,
                    expiresAt: Date.now() + (tokenData.expires_in * 1000)
                }));
                
                onSignedIn(username);
                return;
            } else if (tokenData.error === 'authorization_pending') {
                // Still waiting, continue polling
                continue;
            } else if (tokenData.error === 'authorization_declined') {
                throw new Error('Sign in was declined');
            } else if (tokenData.error === 'expired_token') {
                throw new Error('Sign in code expired');
            } else if (tokenData.error) {
                // Check for admin consent required
                if (tokenData.error_description?.includes('AADSTS65001') || 
                    tokenData.error_description?.includes('admin')) {
                    showAdminConsentError();
                    return;
                }
                throw new Error(tokenData.error_description || tokenData.error);
            }
        } catch (e) {
            if (e.message !== 'Sign in cancelled') {
                console.error('Token poll error:', e);
            }
            throw e;
        }
    }
    
    throw new Error('Sign in timed out');
}

// Cancel sign in
function cancelSignIn() {
    if (pollController) {
        pollController.abort();
    }
    location.reload();
}

// Sign Out
function signOut() {
    accessToken = null;
    localStorage.removeItem('azureToken');
    location.reload();
}

// Called when user is signed in
function onSignedIn(username) {
    updateStatus('connected', username);
    
    // Reset welcome section
    document.getElementById('welcomeSection').hidden = true;
    document.getElementById('mainApp').hidden = false;
    document.getElementById('signInBtn').hidden = true;
    document.getElementById('signOutBtn').hidden = false;
    
    loadSubscriptions();
}

// Update status indicator
function updateStatus(status, text) {
    const indicator = document.getElementById('statusIndicator');
    const statusText = document.getElementById('statusText');
    indicator.className = `status-indicator ${status}`;
    statusText.textContent = text;
}

// Load subscriptions
async function loadSubscriptions() {
    const select = document.getElementById('subscriptionSelect');
    select.innerHTML = '<option value="">Loading subscriptions...</option>';
    select.disabled = true;
    
    try {
        const response = await fetch('https://management.azure.com/subscriptions?api-version=2022-01-01', {
            headers: { 'Authorization': `Bearer ${accessToken}` }
        });
        
        if (!response.ok) {
            if (response.status === 401) {
                signOut();
                return;
            }
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }
        
        const data = await response.json();
        allSubscriptions = data.value.map(sub => ({
            id: sub.subscriptionId,
            name: sub.displayName,
            state: sub.state
        }));
        
        renderSubscriptions(allSubscriptions);
        select.disabled = false;
        document.getElementById('subscriptionFilter').disabled = false;
        
    } catch (error) {
        console.error('Error loading subscriptions:', error);
        select.innerHTML = '<option value="">Error loading subscriptions</option>';
        showError('Failed to load subscriptions', error.message);
    }
}

// Render subscriptions dropdown
function renderSubscriptions(subscriptions) {
    const select = document.getElementById('subscriptionSelect');
    select.innerHTML = '<option value="">Select a subscription...</option>';
    
    subscriptions.forEach(sub => {
        const option = document.createElement('option');
        option.value = sub.id;
        option.textContent = sub.name;
        select.appendChild(option);
    });
}

// Filter subscriptions
function filterSubscriptions(searchText) {
    const filtered = allSubscriptions.filter(sub =>
        sub.name.toLowerCase().includes(searchText.toLowerCase())
    );
    renderSubscriptions(filtered);
}

// Load workspaces
async function loadWorkspaces(subscriptionId) {
    if (!subscriptionId) {
        document.getElementById('workspaceList').innerHTML = 
            '<div class="workspace-placeholder">Select a subscription to see workspaces</div>';
        return;
    }
    
    document.getElementById('workspaceList').innerHTML = 
        '<div class="workspace-placeholder">Loading workspaces...</div>';
    
    try {
        const response = await fetch(
            `https://management.azure.com/subscriptions/${subscriptionId}/providers/Microsoft.OperationalInsights/workspaces?api-version=2021-12-01-preview`,
            { headers: { 'Authorization': `Bearer ${accessToken}` } }
        );
        
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }
        
        const data = await response.json();
        currentWorkspaces = data.value.map(ws => ({
            id: ws.properties.customerId,
            name: ws.name,
            resourceId: ws.id,
            location: ws.location,
            resourceGroup: extractResourceGroup(ws.id)
        }));
        
        if (currentWorkspaces.length === 0) {
            document.getElementById('workspaceList').innerHTML = 
                '<div class="workspace-placeholder">No workspaces found in this subscription</div>';
            return;
        }
        
        renderWorkspaces();
        updateAnalyzeButton();
        
    } catch (error) {
        console.error('Error loading workspaces:', error);
        document.getElementById('workspaceList').innerHTML = 
            '<div class="workspace-placeholder">Error loading workspaces</div>';
    }
}

// Extract resource group from resource ID
function extractResourceGroup(resourceId) {
    const match = resourceId.match(/resourceGroups\/([^\/]+)/i);
    return match ? match[1] : 'Unknown';
}

// Render workspaces grouped by resource group
function renderWorkspaces() {
    const container = document.getElementById('workspaceList');
    container.innerHTML = '';
    
    // Group by resource group
    const groups = {};
    currentWorkspaces.forEach(ws => {
        if (!groups[ws.resourceGroup]) {
            groups[ws.resourceGroup] = [];
        }
        groups[ws.resourceGroup].push(ws);
    });
    
    Object.keys(groups).sort().forEach(rgName => {
        const rgDiv = document.createElement('div');
        rgDiv.className = 'resource-group';
        
        const header = document.createElement('div');
        header.className = 'resource-group-header';
        header.innerHTML = `
            <input type="checkbox" class="rg-checkbox" data-rg="${rgName}" onchange="toggleResourceGroup('${rgName}', this.checked)">
            <span class="rg-name">${rgName}</span>
            <span class="rg-count">(${groups[rgName].length})</span>
        `;
        
        const workspacesDiv = document.createElement('div');
        workspacesDiv.className = 'resource-group-workspaces';
        
        groups[rgName].forEach((ws, idx) => {
            const item = document.createElement('div');
            item.className = 'workspace-item';
            item.innerHTML = `
                <input type="checkbox" class="ws-checkbox" id="ws_${rgName}_${idx}" 
                       value="${ws.id}" data-name="${ws.name}" data-rg="${ws.resourceGroup}"
                       onchange="updateAnalyzeButton()">
                <label for="ws_${rgName}_${idx}">${ws.name}</label>
            `;
            workspacesDiv.appendChild(item);
        });
        
        rgDiv.appendChild(header);
        rgDiv.appendChild(workspacesDiv);
        container.appendChild(rgDiv);
    });
}

// Toggle resource group selection
function toggleResourceGroup(rgName, checked) {
    const checkboxes = document.querySelectorAll(`.ws-checkbox[data-rg="${rgName}"]`);
    checkboxes.forEach(cb => cb.checked = checked);
    updateAnalyzeButton();
}

// Select/Deselect all
function selectAllWorkspaces() {
    document.querySelectorAll('.ws-checkbox').forEach(cb => cb.checked = true);
    document.querySelectorAll('.rg-checkbox').forEach(cb => cb.checked = true);
    updateAnalyzeButton();
}

function deselectAllWorkspaces() {
    document.querySelectorAll('.ws-checkbox').forEach(cb => cb.checked = false);
    document.querySelectorAll('.rg-checkbox').forEach(cb => cb.checked = false);
    updateAnalyzeButton();
}

// Filter workspaces
function filterWorkspaces(searchText) {
    const items = document.querySelectorAll('.workspace-item');
    const rgs = document.querySelectorAll('.resource-group');
    
    items.forEach(item => {
        const name = item.querySelector('label').textContent.toLowerCase();
        item.style.display = name.includes(searchText.toLowerCase()) ? '' : 'none';
    });
    
    // Hide empty resource groups
    rgs.forEach(rg => {
        const visibleItems = rg.querySelectorAll('.workspace-item:not([style*="display: none"])');
        rg.style.display = visibleItems.length > 0 ? '' : 'none';
    });
}

// Update analyze button state
function updateAnalyzeButton() {
    const checked = document.querySelectorAll('.ws-checkbox:checked');
    const btn = document.getElementById('analyzeBtn');
    btn.disabled = checked.length === 0;
    btn.textContent = checked.length > 0 
        ? `Analyze ${checked.length} Workspace${checked.length > 1 ? 's' : ''}`
        : 'Select workspaces to analyze';
}

// Run analysis
async function runAnalysis() {
    const selectedCheckboxes = document.querySelectorAll('.ws-checkbox:checked');
    if (selectedCheckboxes.length === 0) return;
    
    const workspaces = Array.from(selectedCheckboxes).map(cb => {
        const ws = currentWorkspaces.find(w => w.id === cb.value);
        return ws;
    });
    
    // Show progress
    document.getElementById('mainApp').hidden = true;
    document.getElementById('progressSection').hidden = false;
    document.getElementById('resultsSection').hidden = true;
    
    try {
        updateProgress('progressAuth', 'complete', 'Authenticated');
        
        updateProgress('progressQueries', 'running', 'Running queries...');
        
        const allResults = {};
        for (const ws of workspaces) {
            allResults[ws.name] = await queryWorkspace(ws.id, accessToken);
        }
        
        updateProgress('progressQueries', 'complete', `Queried ${workspaces.length} workspace(s)`);
        
        updateProgress('progressAnalysis', 'running', 'Analyzing data...');
        const analysis = analyzeResults(allResults, workspaces);
        updateProgress('progressAnalysis', 'complete', 'Analysis complete');
        
        // Check for AI
        const openaiKey = document.getElementById('openaiKey').value;
        let aiRecommendations = null;
        
        if (openaiKey) {
            updateProgress('progressAnalysis', 'running', 'Getting AI recommendations...');
            aiRecommendations = await getAIRecommendations(analysis, openaiKey);
            updateProgress('progressAnalysis', 'complete', 'AI recommendations ready');
        }
        
        // Show results
        setTimeout(() => {
            document.getElementById('progressSection').hidden = true;
            showResults(analysis, aiRecommendations);
        }, 500);
        
    } catch (error) {
        console.error('Analysis error:', error);
        document.getElementById('progressSection').hidden = true;
        document.getElementById('mainApp').hidden = false;
        showError('Analysis failed', error.message);
    }
}

// Query a workspace
async function queryWorkspace(workspaceId, token) {
    const results = {};
    
    for (const [name, query] of Object.entries(analysisQueries)) {
        try {
            const response = await fetch(
                `https://api.loganalytics.io/v1/workspaces/${workspaceId}/query`,
                {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${token}`,
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({ query })
                }
            );
            
            if (response.ok) {
                const data = await response.json();
                results[name] = {
                    columns: data.tables[0]?.columns.map(c => c.name) || [],
                    rows: data.tables[0]?.rows || []
                };
            } else {
                results[name] = { error: `HTTP ${response.status}` };
            }
        } catch (e) {
            results[name] = { error: e.message };
        }
    }
    
    return results;
}

// Analyze results
function analyzeResults(allResults, workspaces) {
    const analysis = {
        workspaces: workspaces.length,
        totalIngestionGB: 0,
        estimatedMonthlyCost: 0,
        tableBreakdown: {},
        topComputers: [],
        excessiveHeartbeats: [],
        recommendations: []
    };
    
    for (const [wsName, results] of Object.entries(allResults)) {
        // Data volume by table
        if (results.dataVolumeByTable?.rows) {
            results.dataVolumeByTable.rows.forEach(row => {
                const [table, gb] = row;
                const gbNum = parseFloat(gb) || 0;
                analysis.totalIngestionGB += gbNum;
                analysis.tableBreakdown[table] = (analysis.tableBreakdown[table] || 0) + gbNum;
            });
        }
        
        // Excessive heartbeats
        if (results.heartbeatAnalysis?.rows) {
            results.heartbeatAnalysis.rows.forEach(row => {
                analysis.excessiveHeartbeats.push({
                    computer: row[0],
                    heartbeatsPerHour: row[1]
                });
            });
        }
    }
    
    // Calculate cost estimate
    analysis.estimatedMonthlyCost = analysis.totalIngestionGB * 2.76;
    
    // Generate recommendations
    const sortedTables = Object.entries(analysis.tableBreakdown)
        .sort((a, b) => b[1] - a[1]);
    
    // Basic Logs candidates
    const basicLogsCandidates = ['Perf', 'ContainerInventory', 'Syslog', 'ContainerLog', 'SecurityEvent'];
    const eligibleTables = sortedTables.filter(([table]) => basicLogsCandidates.includes(table));
    
    if (eligibleTables.length > 0) {
        const potentialSavings = eligibleTables.reduce((sum, [, gb]) => sum + (gb * 2.26), 0);
        analysis.recommendations.push({
            type: 'savings',
            title: 'Move Tables to Basic Logs',
            impact: `$${potentialSavings.toFixed(2)}/month`,
            tables: eligibleTables,
            action: 'Go to Log Analytics workspace > Tables > Select table > Change plan to Basic Logs'
        });
    }
    
    // Excessive heartbeat recommendation
    if (analysis.excessiveHeartbeats.length > 0) {
        analysis.recommendations.push({
            type: 'warning',
            title: 'Excessive Heartbeat Frequency',
            computers: analysis.excessiveHeartbeats,
            action: 'Adjust agent heartbeat frequency to reduce ingestion'
        });
    }
    
    return analysis;
}

// Get AI recommendations (optional)
async function getAIRecommendations(analysis, apiKey) {
    const endpoint = document.getElementById('openaiEndpoint').value;
    const isAzure = endpoint && endpoint.includes('openai.azure.com');
    
    const prompt = `Analyze this Azure Monitor data and provide cost optimization recommendations:
    
Total Ingestion: ${analysis.totalIngestionGB.toFixed(2)} GB/month
Estimated Cost: $${analysis.estimatedMonthlyCost.toFixed(2)}/month
Top Tables: ${JSON.stringify(Object.entries(analysis.tableBreakdown).slice(0, 5))}
Excessive Heartbeats: ${analysis.excessiveHeartbeats.length} computers

Provide specific, actionable recommendations.`;

    try {
        let response;
        if (isAzure) {
            response = await fetch(`${endpoint}/openai/deployments/gpt-4/chat/completions?api-version=2024-02-15-preview`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'api-key': apiKey
                },
                body: JSON.stringify({
                    messages: [{ role: 'user', content: prompt }],
                    max_tokens: 1000
                })
            });
        } else {
            response = await fetch('https://api.openai.com/v1/chat/completions', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${apiKey}`
                },
                body: JSON.stringify({
                    model: 'gpt-4',
                    messages: [{ role: 'user', content: prompt }],
                    max_tokens: 1000
                })
            });
        }
        
        const data = await response.json();
        return data.choices?.[0]?.message?.content || null;
    } catch (e) {
        console.error('AI error:', e);
        return null;
    }
}

// Update progress indicator
function updateProgress(id, status, text) {
    const item = document.getElementById(id);
    item.className = `progress-item ${status}`;
    const statusEl = item.querySelector('.progress-status');
    const labelEl = item.querySelector('.progress-label');
    
    statusEl.textContent = status === 'complete' ? '✅' : status === 'error' ? '❌' : '🔄';
    labelEl.textContent = text;
}

// Show results
function showResults(analysis, aiRecommendations) {
    document.getElementById('resultsSection').hidden = false;
    const content = document.getElementById('resultsContent');
    
    let html = `
        <div class="summary-grid">
            <div class="summary-card">
                <div class="value">${analysis.workspaces}</div>
                <div class="label">Workspaces Analyzed</div>
            </div>
            <div class="summary-card">
                <div class="value">${analysis.totalIngestionGB.toFixed(2)} GB</div>
                <div class="label">Total Ingestion (30 days)</div>
            </div>
            <div class="summary-card">
                <div class="value">$${analysis.estimatedMonthlyCost.toFixed(2)}</div>
                <div class="label">Estimated Monthly Cost</div>
            </div>
            <div class="summary-card">
                <div class="value">${analysis.recommendations.length}</div>
                <div class="label">Recommendations</div>
            </div>
        </div>
    `;
    
    // Table breakdown
    html += `<h3>📊 Data Volume by Table</h3>`;
    html += `<table class="data-table">
        <thead><tr><th>Table</th><th>Size (GB)</th><th>Est. Cost</th></tr></thead>
        <tbody>`;
    
    Object.entries(analysis.tableBreakdown)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .forEach(([table, gb]) => {
            html += `<tr><td>${table}</td><td>${gb.toFixed(2)}</td><td>$${(gb * 2.76).toFixed(2)}</td></tr>`;
        });
    
    html += `</tbody></table>`;
    
    // Recommendations
    if (analysis.recommendations.length > 0) {
        html += `<h3>💡 Recommendations</h3>`;
        
        analysis.recommendations.forEach(rec => {
            html += `
                <div class="rec-card rec-card-${rec.type}">
                    <div class="rec-card-header">
                        <span class="rec-card-icon">${rec.type === 'savings' ? '💰' : '⚠️'}</span>
                        <span class="rec-card-title">${rec.title}</span>
                        ${rec.impact ? `<span class="rec-card-impact">${rec.impact}</span>` : ''}
                    </div>
                    <div class="rec-card-body">
                        ${rec.tables ? `
                            <table class="data-table">
                                <thead><tr><th>Table</th><th>Size (GB)</th><th>Potential Savings</th></tr></thead>
                                <tbody>
                                    ${rec.tables.map(([table, gb]) => 
                                        `<tr><td>${table}</td><td>${gb.toFixed(2)}</td><td>$${(gb * 2.26).toFixed(2)}</td></tr>`
                                    ).join('')}
                                </tbody>
                            </table>
                        ` : ''}
                        ${rec.computers ? `
                            <p>${rec.computers.length} computer(s) sending excessive heartbeats:</p>
                            <ul>${rec.computers.slice(0, 5).map(c => 
                                `<li>${c.computer}: ${c.heartbeatsPerHour}/hour</li>`
                            ).join('')}</ul>
                        ` : ''}
                    </div>
                    <div class="rec-card-action">
                        <strong>📋 Action:</strong> ${rec.action}
                    </div>
                </div>
            `;
        });
    }
    
    // AI Recommendations
    if (aiRecommendations) {
        html += `<h3>🤖 AI Analysis</h3>`;
        html += `<div class="rec-card rec-card-info">
            <div class="rec-card-body">
                <pre style="white-space: pre-wrap; font-family: inherit;">${aiRecommendations}</pre>
            </div>
        </div>`;
    }
    
    content.innerHTML = html;
    
    // Store for export
    window.lastAnalysis = { analysis, aiRecommendations };
}

// Show error
function showError(title, message) {
    document.getElementById('errorSection').hidden = false;
    document.getElementById('errorMessage').textContent = message;
    document.getElementById('errorHelp').innerHTML = '';
}

// Show admin consent error
function showAdminConsentError() {
    document.getElementById('errorSection').hidden = false;
    document.getElementById('errorMessage').textContent = 
        'Admin consent is required to access Azure resources.';
    document.getElementById('errorHelp').innerHTML = `
        <h4>What does this mean?</h4>
        <p>Your organization requires an administrator to approve this app before you can use it.</p>
        <h4>Options:</h4>
        <ul>
            <li>Contact your IT administrator and request they approve this app</li>
            <li>If you have Azure CLI access, use the <a href="https://github.com/osalzberg/azure-monitor-cost-optimizer">server version</a> which uses CLI authentication</li>
            <li>Ask your admin to grant consent at: <code>https://login.microsoftonline.com/common/adminconsent?client_id=${msalConfig.auth.clientId}</code></li>
        </ul>
    `;
}

// Dismiss error
function dismissError() {
    document.getElementById('errorSection').hidden = true;
}

// New analysis
function newAnalysis() {
    document.getElementById('resultsSection').hidden = true;
    document.getElementById('mainApp').hidden = false;
}

// Copy results
function copyResults() {
    const content = document.getElementById('resultsContent').innerText;
    navigator.clipboard.writeText(content);
    alert('Results copied to clipboard!');
}

// Export results
function exportResults() {
    if (!window.lastAnalysis) return;
    
    const blob = new Blob([JSON.stringify(window.lastAnalysis, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `azure-monitor-analysis-${new Date().toISOString().split('T')[0]}.json`;
    a.click();
    URL.revokeObjectURL(url);
}
