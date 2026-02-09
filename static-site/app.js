// Azure Monitor Cost Optimizer - Static Site Version
// Uses token-based authentication (user provides Azure CLI token)

// App state
let accessToken = null;
let allSubscriptions = [];
let currentWorkspaces = [];
let selectedWorkspaces = [];

// KQL Queries for cost analysis
const analysisQueries = {
    dataVolumeByTable: `
        Usage
        | where TimeGenerated > ago(30d)
        | where IsBillable == true
        | summarize BillableGB = sum(Quantity) / 1000 by DataType
        | order by BillableGB desc
        | take 20
    `,
    dailyIngestionTrend: `
        Usage
        | where TimeGenerated > ago(30d)
        | where IsBillable == true
        | summarize DailyGB = sum(Quantity) / 1000 by bin(TimeGenerated, 1d)
        | order by TimeGenerated asc
    `,
    dataByComputer: `
        Heartbeat
        | where TimeGenerated > ago(7d)
        | summarize LastHeartbeat = max(TimeGenerated) by Computer, OSType
        | order by LastHeartbeat desc
        | take 20
    `,
    topTables: `
        Usage
        | where TimeGenerated > ago(7d)
        | where IsBillable == true
        | summarize TotalGB = sum(Quantity) / 1000 by DataType
        | top 10 by TotalGB desc
    `
};

// DOM Elements
const authRequiredSection = document.getElementById('authRequiredSection');
const inputSection = document.getElementById('inputSection');
const progressSection = document.getElementById('progressSection');
const recommendationsSection = document.getElementById('recommendationsSection');
const subscriptionSelect = document.getElementById('subscriptionSelect');

// Initialize on page load
document.addEventListener('DOMContentLoaded', () => {
    // Check for saved token
    const saved = localStorage.getItem('azureToken');
    if (saved) {
        try {
            const data = JSON.parse(saved);
            if (data.expiresAt > Date.now()) {
                accessToken = data.token;
                onSignedIn(data.username || 'User');
            } else {
                localStorage.removeItem('azureToken');
            }
        } catch (e) {
            localStorage.removeItem('azureToken');
        }
    }
});

// Copy the az command
function copyCommand() {
    const cmd = "az account get-access-token --resource https://management.azure.com --query accessToken -o tsv";
    navigator.clipboard.writeText(cmd);
    const btn = document.querySelector('.copy-cli-btn');
    btn.textContent = '✓ Copied!';
    setTimeout(() => btn.textContent = '📋 Copy', 2000);
}

// Sign in with pasted token
function signInWithToken() {
    const tokenInput = document.getElementById('tokenInput');
    let token = tokenInput.value.trim();
    
    // Remove any quotes that might have been copied
    token = token.replace(/^["']|["']$/g, '');
    // Remove any newlines
    token = token.replace(/[\r\n]/g, '');
    
    if (!token) {
        showError('Please paste your access token');
        return;
    }
    
    // Try to validate as JWT
    const parts = token.split('.');
    
    if (parts.length === 3) {
        try {
            const payload = JSON.parse(atob(parts[1]));
            const exp = payload.exp * 1000;
            
            if (exp < Date.now()) {
                showError('Token expired. Please generate a fresh token using the az command.');
                return;
            }
            
            const username = payload.upn || payload.unique_name || payload.preferred_username || 'User';
            
            accessToken = token;
            localStorage.setItem('azureToken', JSON.stringify({
                token: token,
                username: username,
                expiresAt: exp
            }));
            
            onSignedIn(username);
            return;
        } catch (e) {
            console.error('Token decode error:', e);
        }
    }
    
    // If we couldn't parse but it looks like a token, try anyway
    if (token.length > 100) {
        accessToken = token;
        localStorage.setItem('azureToken', JSON.stringify({
            token: token,
            username: 'User',
            expiresAt: Date.now() + (60 * 60 * 1000)
        }));
        onSignedIn('User');
        return;
    }
    
    showError('Invalid token. Make sure you copied the entire output from the az command.');
}

// Sign Out
function signOut() {
    accessToken = null;
    localStorage.removeItem('azureToken');
    location.reload();
}

// AI Settings Management
function getAISettings() {
    const saved = localStorage.getItem('aiSettings');
    if (saved) {
        try {
            return JSON.parse(saved);
        } catch (e) {
            return {};
        }
    }
    return {};
}

function saveAISettings() {
    const endpoint = document.getElementById('openaiEndpoint').value.trim();
    const key = document.getElementById('openaiKey').value.trim();
    const deployment = document.getElementById('openaiDeployment').value.trim() || 'gpt-4';
    
    localStorage.setItem('aiSettings', JSON.stringify({ endpoint, key, deployment }));
    
    // Update UI
    const btn = document.querySelector('.save-settings-btn');
    btn.textContent = '✅ Saved!';
    setTimeout(() => btn.textContent = '💾 Save Settings', 2000);
    
    updateAIStatus();
}

function loadAISettings() {
    const settings = getAISettings();
    if (settings.endpoint) document.getElementById('openaiEndpoint').value = settings.endpoint;
    if (settings.key) document.getElementById('openaiKey').value = settings.key;
    if (settings.deployment) document.getElementById('openaiDeployment').value = settings.deployment;
    updateAIStatus();
}

function updateAIStatus() {
    const settings = getAISettings();
    const summary = document.querySelector('.ai-settings summary');
    
    // Remove existing status
    const existing = summary.querySelector('.ai-status');
    if (existing) existing.remove();
    
    // Add new status
    const status = document.createElement('span');
    if (settings.endpoint && settings.key) {
        status.className = 'ai-status configured';
        status.textContent = '✓ Configured';
    } else {
        status.className = 'ai-status not-configured';
        status.textContent = 'Not configured';
    }
    summary.appendChild(status);
}

// Azure OpenAI API call
async function getAIRecommendations(allQueryData, dataSummary, aiSettings, userContext) {
    const { endpoint, key, deployment } = aiSettings;
    
    // Format query data for AI
    const analysisData = formatQueryDataForAI(allQueryData, dataSummary);
    
    const systemPrompt = `You are an Azure Monitor cost optimization expert. Analyze the provided Log Analytics workspace data and provide specific, actionable cost optimization recommendations.

Format your response using these card markers for structured output:
[CARD:type] where type is: warning, savings, info, success
[TITLE]Card Title[/TITLE]
[IMPACT]Potential savings or impact[/IMPACT]
[ACTION]Specific action to take[/ACTION]
[DOCS]Link to relevant documentation[/DOCS]
[/CARD]

For KQL queries, use [KQL]query here[/KQL]

Focus on:
1. Commitment tier opportunities (if daily ingestion > 100GB)
2. Basic Logs for debug/verbose tables (ContainerLogV2, AppTraces, etc.)
3. Data retention optimization
4. DCR filtering to reduce ingestion
5. Identifying tables that could be sampled or filtered

Be specific with numbers and potential savings estimates.`;

    const userPrompt = `Analyze this Azure Monitor Log Analytics data and provide cost optimization recommendations:

## Data Summary
- Total 30-day ingestion: ${dataSummary.totalIngestionGB.toFixed(2)} GB
- Daily average: ${(dataSummary.totalIngestionGB / 30).toFixed(2)} GB/day
- Workspaces analyzed: ${dataSummary.workspacesWithData}/${dataSummary.totalWorkspaces}

## Detailed Analysis Data
${analysisData}

${userContext ? `## User Context\n${userContext}` : ''}

Provide specific, actionable recommendations with estimated cost savings where possible.`;

    try {
        const response = await fetch(`${endpoint}/openai/deployments/${deployment}/chat/completions?api-version=2024-02-01`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'api-key': key
            },
            body: JSON.stringify({
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: userPrompt }
                ],
                max_tokens: 4000,
                temperature: 0.7
            })
        });
        
        if (!response.ok) {
            const error = await response.json().catch(() => ({}));
            throw new Error(error.error?.message || `HTTP ${response.status}`);
        }
        
        const data = await response.json();
        return data.choices[0].message.content;
        
    } catch (error) {
        console.error('AI API error:', error);
        // Fallback to rule-based if AI fails
        return generateRecommendations(allQueryData, dataSummary) + 
            `\n\n[CARD:warning][TITLE]⚠️ AI Analysis Unavailable[/TITLE]AI-powered analysis failed: ${error.message}. Showing rule-based recommendations instead.[/CARD]`;
    }
}

// Format query data for AI consumption
function formatQueryDataForAI(allQueryData, dataSummary) {
    let formatted = '';
    
    // Top tables summary
    if (dataSummary.topTables.length > 0) {
        formatted += '### Top Data Tables (30-day volume)\n';
        formatted += '| Table | Volume (GB) | % of Total |\n|-------|-------------|------------|\n';
        dataSummary.topTables.forEach(t => {
            const pct = ((t.gb / dataSummary.totalIngestionGB) * 100).toFixed(1);
            formatted += `| ${t.name} | ${t.gb.toFixed(2)} | ${pct}% |\n`;
        });
        formatted += '\n';
    }
    
    // Per-workspace details
    for (const [wsName, queryResults] of Object.entries(allQueryData)) {
        const ws = currentWorkspaces.find(w => w.name === wsName);
        formatted += `### Workspace: ${wsName}\n`;
        formatted += `- Resource Group: ${ws?.resourceGroup || 'Unknown'}\n`;
        formatted += `- SKU: ${ws?.sku || 'Unknown'}\n`;
        formatted += `- Retention: ${ws?.retentionDays || 30} days\n\n`;
        
        // Data volume
        if (queryResults.dataVolumeByTable?.rows?.length > 0) {
            formatted += '**Top Tables:**\n';
            const gbIdx = queryResults.dataVolumeByTable.columns?.indexOf('BillableGB') ?? 1;
            const typeIdx = queryResults.dataVolumeByTable.columns?.indexOf('DataType') ?? 0;
            queryResults.dataVolumeByTable.rows.slice(0, 10).forEach(row => {
                formatted += `- ${row[typeIdx]}: ${parseFloat(row[gbIdx]).toFixed(2)} GB\n`;
            });
            formatted += '\n';
        }
    }
    
    return formatted;
}

// Called when user is signed in
function onSignedIn(username) {
    document.getElementById('statusIndicator').className = 'status-indicator connected';
    document.getElementById('statusText').textContent = username;
    document.getElementById('signOutBtn').hidden = false;
    
    authRequiredSection.hidden = true;
    inputSection.hidden = false;
    
    // Load AI settings
    loadAISettings();
    
    loadSubscriptions();
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
                showError('Token expired. Please sign in again.');
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
        showError('Failed to load subscriptions: ' + error.message);
    }
}

// Render subscriptions dropdown
function renderSubscriptions(subscriptions) {
    const select = document.getElementById('subscriptionSelect');
    select.innerHTML = '<option value="">Select from ' + subscriptions.length + ' subscription(s)...</option>';
    
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
        sub.name.toLowerCase().includes(searchText.toLowerCase()) ||
        sub.id.toLowerCase().includes(searchText.toLowerCase())
    );
    renderSubscriptions(filtered);
}

// Load workspaces
async function loadWorkspaces(subscriptionId) {
    if (!subscriptionId) {
        document.getElementById('workspaceList').innerHTML = 
            '<div class="workspace-placeholder">Select a subscription first</div>';
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
            resourceGroup: extractResourceGroup(ws.id),
            sku: ws.properties.sku?.name || 'Unknown',
            retentionDays: ws.properties.retentionInDays || 30
        }));
        
        if (currentWorkspaces.length === 0) {
            document.getElementById('workspaceList').innerHTML = 
                '<div class="workspace-placeholder">No workspaces found in this subscription</div>';
            return;
        }
        
        renderWorkspaceList();
        updateSelectedCount();
        
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

// Group workspaces by resource group
function groupWorkspacesByRG(workspaces) {
    const groups = {};
    workspaces.forEach(ws => {
        const rg = ws.resourceGroup;
        if (!groups[rg]) {
            groups[rg] = [];
        }
        groups[rg].push(ws);
    });
    return Object.keys(groups).sort().reduce((sorted, key) => {
        sorted[key] = groups[key].sort((a, b) => a.name.localeCompare(b.name));
        return sorted;
    }, {});
}

// Render workspace list grouped by resource group
function renderWorkspaceList() {
    const container = document.getElementById('workspaceList');
    container.innerHTML = '';
    
    const groupedWorkspaces = groupWorkspacesByRG(currentWorkspaces);
    let wsIndex = 0;
    
    Object.entries(groupedWorkspaces).forEach(([rgName, workspaces]) => {
        const rgDiv = document.createElement('div');
        rgDiv.className = 'resource-group';
        rgDiv.dataset.rgName = rgName;
        
        const header = document.createElement('div');
        header.className = 'resource-group-header';
        header.innerHTML = `
            <span class="expand-icon">▼</span>
            <input type="checkbox" class="rg-checkbox" data-rg="${rgName}">
            <span class="rg-name">${rgName}</span>
            <span class="rg-count">(${workspaces.length})</span>
        `;
        
        const wsContainer = document.createElement('div');
        wsContainer.className = 'resource-group-workspaces';
        
        workspaces.forEach(ws => {
            const item = document.createElement('div');
            item.className = 'workspace-item';
            item.dataset.wsName = ws.name.toLowerCase();
            item.dataset.rgName = rgName.toLowerCase();
            item.innerHTML = `
                <input type="checkbox" class="ws-checkbox" id="ws_${wsIndex}" value="${ws.id}" data-rg="${rgName}">
                <label for="ws_${wsIndex}">${ws.name}</label>
                <span class="workspace-location">${ws.location}</span>
            `;
            
            const checkbox = item.querySelector('input');
            checkbox.addEventListener('change', () => {
                updateRGCheckbox(rgName);
                updateSelectedWorkspaces();
            });
            
            item.addEventListener('click', (e) => {
                if (e.target.tagName !== 'INPUT') {
                    checkbox.checked = !checkbox.checked;
                    updateRGCheckbox(rgName);
                    updateSelectedWorkspaces();
                }
            });
            
            wsContainer.appendChild(item);
            wsIndex++;
        });
        
        rgDiv.appendChild(header);
        rgDiv.appendChild(wsContainer);
        container.appendChild(rgDiv);
        
        // RG checkbox event
        const rgCheckbox = header.querySelector('.rg-checkbox');
        rgCheckbox.addEventListener('change', (e) => {
            const checked = e.target.checked;
            wsContainer.querySelectorAll('.ws-checkbox').forEach(cb => {
                cb.checked = checked;
            });
            updateSelectedWorkspaces();
        });
        
        // Expand/collapse
        header.addEventListener('click', (e) => {
            if (e.target.tagName === 'INPUT') return;
            const icon = header.querySelector('.expand-icon');
            icon.classList.toggle('collapsed');
            wsContainer.classList.toggle('collapsed');
        });
    });
    
    // Select first workspace by default if small number
    if (currentWorkspaces.length <= 5 && currentWorkspaces.length > 0) {
        const firstCheckbox = container.querySelector('.ws-checkbox');
        if (firstCheckbox) {
            firstCheckbox.checked = true;
            updateRGCheckbox(firstCheckbox.dataset.rg);
            updateSelectedWorkspaces();
        }
    }
}

// Update RG checkbox state
function updateRGCheckbox(rgName) {
    const wsCheckboxes = document.querySelectorAll(`.ws-checkbox[data-rg="${rgName}"]`);
    const rgCheckbox = document.querySelector(`.rg-checkbox[data-rg="${rgName}"]`);
    
    if (!rgCheckbox) return;
    
    const checkedCount = Array.from(wsCheckboxes).filter(cb => cb.checked).length;
    rgCheckbox.checked = checkedCount === wsCheckboxes.length;
    rgCheckbox.indeterminate = checkedCount > 0 && checkedCount < wsCheckboxes.length;
}

// Update selected workspaces array
function updateSelectedWorkspaces() {
    const checkboxes = document.querySelectorAll('.ws-checkbox:checked');
    selectedWorkspaces = Array.from(checkboxes).map(cb => {
        return currentWorkspaces.find(ws => ws.id === cb.value);
    }).filter(Boolean);
    updateSelectedCount();
    updateSubmitButton();
}

// Update selected count display
function updateSelectedCount() {
    const countEl = document.getElementById('selectedCount');
    const count = selectedWorkspaces.length;
    const rgCount = new Set(selectedWorkspaces.map(ws => ws.resourceGroup)).size;
    countEl.textContent = `${count} workspace${count !== 1 ? 's' : ''} in ${rgCount} RG${rgCount !== 1 ? 's' : ''}`;
    countEl.style.color = count > 0 ? 'var(--azure-blue)' : '#888';
}

// Update submit button state
function updateSubmitButton() {
    const btn = document.getElementById('submitBtn');
    btn.disabled = selectedWorkspaces.length === 0;
}

// Select all visible workspaces
function selectAllWorkspaces() {
    document.querySelectorAll('.ws-checkbox, .rg-checkbox').forEach(cb => {
        const item = cb.closest('.workspace-item');
        if (!item || !item.classList.contains('hidden')) {
            cb.checked = true;
            cb.indeterminate = false;
        }
    });
    document.querySelectorAll('.resource-group').forEach(rg => {
        updateRGCheckbox(rg.dataset.rgName);
    });
    updateSelectedWorkspaces();
}

// Clear all selections
function deselectAllWorkspaces() {
    document.querySelectorAll('.ws-checkbox, .rg-checkbox').forEach(cb => {
        cb.checked = false;
        cb.indeterminate = false;
    });
    updateSelectedWorkspaces();
}

// Expand all resource groups
function expandAllGroups() {
    document.querySelectorAll('.resource-group-workspaces').forEach(ws => {
        ws.classList.remove('collapsed');
    });
    document.querySelectorAll('.expand-icon').forEach(icon => {
        icon.classList.remove('collapsed');
    });
}

// Collapse all resource groups
function collapseAllGroups() {
    document.querySelectorAll('.resource-group-workspaces').forEach(ws => {
        ws.classList.add('collapsed');
    });
    document.querySelectorAll('.expand-icon').forEach(icon => {
        icon.classList.add('collapsed');
    });
}

// Filter workspaces
function filterWorkspaces(searchText) {
    const search = searchText.toLowerCase();
    
    document.querySelectorAll('.workspace-item').forEach(item => {
        const wsName = item.dataset.wsName || '';
        const rgName = item.dataset.rgName || '';
        const matches = wsName.includes(search) || rgName.includes(search);
        item.classList.toggle('hidden', !matches);
    });
    
    document.querySelectorAll('.resource-group').forEach(rg => {
        const visibleItems = rg.querySelectorAll('.workspace-item:not(.hidden)');
        rg.style.display = visibleItems.length > 0 ? '' : 'none';
    });
}

// Run analysis
async function runAnalysis() {
    if (selectedWorkspaces.length === 0) {
        showError('Please select at least one workspace');
        return;
    }
    
    // Warn if selecting too many
    if (selectedWorkspaces.length > 10) {
        if (!confirm(`You selected ${selectedWorkspaces.length} workspaces. This may take a while. Continue?`)) {
            return;
        }
    }
    
    // Show progress section
    inputSection.hidden = true;
    progressSection.hidden = false;
    recommendationsSection.hidden = true;
    
    try {
        updateProgress('progressAuth', 'complete', 'Authenticated');
        
        // Step 1: Run queries
        const totalWorkspaces = selectedWorkspaces.length;
        let allQueryData = {};
        
        for (let i = 0; i < selectedWorkspaces.length; i++) {
            const ws = selectedWorkspaces[i];
            updateProgress('progressQueries', 'running', `Querying workspace ${i + 1}/${totalWorkspaces}: ${ws.name}...`);
            
            const queryResults = await queryWorkspace(ws);
            allQueryData[ws.name] = queryResults;
        }
        
        updateProgress('progressQueries', 'complete', `Analyzed ${Object.keys(allQueryData).length} workspace(s)`);
        
        // Check if we got any actual data
        const dataSummary = summarizeQueryData(allQueryData);
        
        // If no data, show helpful message
        if (dataSummary.totalWorkspaces === 0 || dataSummary.workspacesWithData === 0) {
            progressSection.hidden = true;
            showNoDataResults(selectedWorkspaces, dataSummary);
            return;
        }
        
        // If minimal data
        if (dataSummary.totalIngestionGB < 1) {
            progressSection.hidden = true;
            showMinimalDataResults(selectedWorkspaces, dataSummary);
            return;
        }
        
        // Check if AI is configured
        const aiSettings = getAISettings();
        let recommendations;
        
        if (aiSettings.endpoint && aiSettings.key) {
            // Use Azure OpenAI
            updateProgress('progressAI', 'running', 'Generating AI recommendations...');
            const context = document.getElementById('context').value;
            recommendations = await getAIRecommendations(allQueryData, dataSummary, aiSettings, context);
        } else {
            // Fallback to rule-based recommendations
            updateProgress('progressAI', 'running', 'Generating recommendations...');
            recommendations = generateRecommendations(allQueryData, dataSummary);
        }
        
        updateProgress('progressAI', 'complete', 'Recommendations generated');
        
        // Show recommendations
        progressSection.hidden = true;
        showRecommendations(recommendations, selectedWorkspaces, dataSummary);
        
    } catch (error) {
        console.error('Analysis error:', error);
        progressSection.hidden = true;
        inputSection.hidden = false;
        showError(`Analysis failed: ${error.message}`);
    }
}

// Query a workspace using Log Analytics API
async function queryWorkspace(workspace) {
    const results = {};
    
    for (const [queryName, query] of Object.entries(analysisQueries)) {
        try {
            const response = await fetch(
                `https://api.loganalytics.io/v1/workspaces/${workspace.id}/query`,
                {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${accessToken}`,
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({ query })
                }
            );
            
            if (!response.ok) {
                results[queryName] = { error: `HTTP ${response.status}`, rows: [], columns: [] };
                continue;
            }
            
            const data = await response.json();
            const table = data.tables?.[0];
            
            if (table) {
                results[queryName] = {
                    columns: table.columns.map(c => c.name),
                    rows: table.rows || []
                };
            } else {
                results[queryName] = { rows: [], columns: [] };
            }
        } catch (error) {
            results[queryName] = { error: error.message, rows: [], columns: [] };
        }
    }
    
    return results;
}

// Summarize query data
function summarizeQueryData(allQueryData) {
    const summary = {
        totalWorkspaces: Object.keys(allQueryData).length,
        workspacesWithData: 0,
        workspacesEmpty: 0,
        totalIngestionGB: 0,
        byResourceGroup: {},
        topTables: []
    };
    
    const tableData = {};
    
    for (const [wsName, queryResults] of Object.entries(allQueryData)) {
        const ws = currentWorkspaces.find(w => w.name === wsName);
        const rg = ws?.resourceGroup || 'Unknown';
        
        if (!summary.byResourceGroup[rg]) {
            summary.byResourceGroup[rg] = { workspaces: [], totalGB: 0, hasData: false };
        }
        
        const volumeData = queryResults.dataVolumeByTable;
        let wsGB = 0;
        
        if (volumeData && volumeData.rows && volumeData.rows.length > 0) {
            const gbIndex = volumeData.columns?.indexOf('BillableGB') ?? 1;
            const typeIndex = volumeData.columns?.indexOf('DataType') ?? 0;
            
            volumeData.rows.forEach(row => {
                const gb = parseFloat(row[gbIndex]) || 0;
                const tableName = row[typeIndex] || 'Unknown';
                wsGB += gb;
                
                if (!tableData[tableName]) tableData[tableName] = 0;
                tableData[tableName] += gb;
            });
        }
        
        summary.byResourceGroup[rg].workspaces.push({ name: wsName, gb: wsGB });
        summary.byResourceGroup[rg].totalGB += wsGB;
        
        if (wsGB > 0) {
            summary.workspacesWithData++;
            summary.byResourceGroup[rg].hasData = true;
        } else {
            summary.workspacesEmpty++;
        }
        
        summary.totalIngestionGB += wsGB;
    }
    
    // Top tables
    summary.topTables = Object.entries(tableData)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([name, gb]) => ({ name, gb }));
    
    return summary;
}

// Generate recommendations based on data analysis
function generateRecommendations(allQueryData, dataSummary) {
    let recommendations = '';
    
    const totalGB = dataSummary.totalIngestionGB;
    const dailyGB = totalGB / 30;
    const monthlyCost = totalGB * 2.76;
    
    // Executive Summary
    recommendations += `[CARD:info]
[TITLE]📊 Executive Summary[/TITLE]
[IMPACT]${totalGB.toFixed(2)} GB/month[/IMPACT]

**Total 30-Day Ingestion:** ${totalGB.toFixed(2)} GB
**Average Daily Ingestion:** ${dailyGB.toFixed(2)} GB/day
**Estimated Monthly Cost:** $${monthlyCost.toFixed(2)} (at $2.76/GB Pay-As-You-Go)
**Workspaces Analyzed:** ${dataSummary.workspacesWithData}/${dataSummary.totalWorkspaces} with data
[/CARD]

`;
    
    // Top Tables Analysis
    if (dataSummary.topTables.length > 0) {
        let tableRows = '';
        dataSummary.topTables.forEach(t => {
            const pct = ((t.gb / totalGB) * 100).toFixed(1);
            tableRows += `| ${t.name} | ${t.gb.toFixed(2)} GB | ${pct}% | $${(t.gb * 2.76).toFixed(2)} |\n`;
        });
        
        recommendations += `[CARD:info]
[TITLE]📈 Top Data Sources[/TITLE]

| Table | 30-Day Volume | % of Total | Est. Cost |
|-------|---------------|------------|-----------|
${tableRows}
[/CARD]

`;
    }
    
    // Commitment Tier Recommendation
    if (dailyGB >= 100) {
        const tier100Savings = ((dailyGB * 30 * 2.76) - (dailyGB * 30 * 2.30)) / (dailyGB * 30 * 2.76) * 100;
        recommendations += `[CARD:savings]
[TITLE]💰 Commitment Tier Opportunity[/TITLE]
[IMPACT]Save ~${tier100Savings.toFixed(0)}%[/IMPACT]

Your daily ingestion of **${dailyGB.toFixed(2)} GB** qualifies for commitment tier pricing!

**Current Pay-As-You-Go:** $${(dailyGB * 30 * 2.76).toFixed(2)}/month
**100 GB/day Commitment:** $${(dailyGB * 30 * 2.30).toFixed(2)}/month
**Potential Savings:** $${((dailyGB * 30 * 2.76) - (dailyGB * 30 * 2.30)).toFixed(2)}/month

[ACTION]Navigate to Log Analytics workspace > Usage and estimated costs > Pricing Tier[/ACTION]
[DOCS]https://learn.microsoft.com/azure/azure-monitor/logs/cost-logs#commitment-tiers[/DOCS]
[/CARD]

`;
    } else if (dailyGB >= 50) {
        recommendations += `[CARD:info]
[TITLE]📈 Approaching Commitment Tier[/TITLE]

Your daily ingestion of **${dailyGB.toFixed(2)} GB** is approaching the 100 GB/day threshold for commitment tier savings.

At 100 GB/day, you could save ~17% with the commitment tier.

[ACTION]Monitor ingestion growth and consider commitment tier when reaching 100 GB/day[/ACTION]
[/CARD]

`;
    }
    
    // Basic Logs Recommendation
    const debugTables = ['ContainerLogV2', 'AppTraces', 'AzureDiagnostics', 'Syslog'];
    const debugTableData = dataSummary.topTables.filter(t => debugTables.includes(t.name));
    
    if (debugTableData.length > 0) {
        const debugGB = debugTableData.reduce((sum, t) => sum + t.gb, 0);
        const savings = debugGB * 2.76 * 0.5; // Basic logs are ~50% cheaper
        
        recommendations += `[CARD:savings]
[TITLE]💡 Basic Logs Opportunity[/TITLE]
[IMPACT]Save ~$${savings.toFixed(2)}/month[/IMPACT]

These tables are candidates for Basic Logs (lower cost, limited query):

${debugTableData.map(t => `- **${t.name}**: ${t.gb.toFixed(2)} GB`).join('\n')}

Basic Logs cost ~50% less but have limited query capabilities (8 days retention, simplified queries).

[ACTION]Configure Basic Logs for debug/verbose tables in Log Analytics workspace settings[/ACTION]
[DOCS]https://learn.microsoft.com/azure/azure-monitor/logs/basic-logs-configure[/DOCS]
[/CARD]

`;
    }
    
    // Retention Recommendation
    recommendations += `[CARD:info]
[TITLE]🗄️ Data Retention Settings[/TITLE]

**Current retention:** Check each workspace's retention settings

**Recommendations:**
- Set interactive retention to 30-90 days for most tables
- Use archive tier for data needed beyond 90 days (90% cheaper)
- Security data may need longer retention for compliance

[ACTION]Review retention settings in each workspace under Tables > Manage table[/ACTION]
[DOCS]https://learn.microsoft.com/azure/azure-monitor/logs/data-retention-archive[/DOCS]
[/CARD]

`;
    
    // DCR Filtering Recommendation
    recommendations += `[CARD:info]
[TITLE]🔧 Data Collection Optimization[/TITLE]

**Filter data at the source using Data Collection Rules (DCRs):**

- Filter out unwanted columns before ingestion
- Drop verbose log levels (Debug, Trace)
- Sample high-volume telemetry
- Exclude non-essential resources

Example transformation to drop debug logs:
\`\`\`kql
source | where SeverityLevel != "Debug"
\`\`\`

[ACTION]Review and optimize Data Collection Rules for each data source[/ACTION]
[DOCS]https://learn.microsoft.com/azure/azure-monitor/essentials/data-collection-transformations[/DOCS]
[/CARD]

`;
    
    return recommendations;
}

// Update progress indicator
function updateProgress(id, status, text) {
    const item = document.getElementById(id);
    const icon = item.querySelector('.progress-icon');
    const textEl = item.querySelector('.progress-text');
    
    switch (status) {
        case 'running':
            icon.textContent = '🔄';
            break;
        case 'complete':
            icon.textContent = '✅';
            break;
        case 'error':
            icon.textContent = '❌';
            break;
    }
    textEl.textContent = text;
}

// Show recommendations
function showRecommendations(recommendations, workspaces, dataSummary) {
    const resourceInfo = document.getElementById('resourceInfo');
    
    const totalGB = dataSummary.totalIngestionGB.toFixed(2);
    resourceInfo.innerHTML = `
        <strong>Workspaces:</strong> ${dataSummary.workspacesWithData}/${dataSummary.totalWorkspaces} with data | 
        <strong>Total Ingestion:</strong> ${totalGB} GB (30 days) |
        <strong>Resource Groups:</strong> ${Object.keys(dataSummary.byResourceGroup).length}
    `;
    
    const content = document.getElementById('recommendationsContent');
    content.innerHTML = formatMarkdown(recommendations);
    
    recommendationsSection.hidden = false;
}

// Show no data results
function showNoDataResults(workspaces, dataSummary) {
    const resourceInfo = document.getElementById('resourceInfo');
    const content = document.getElementById('recommendationsContent');
    
    const byRG = {};
    workspaces.forEach(ws => {
        const rg = ws.resourceGroup || 'Unknown';
        if (!byRG[rg]) byRG[rg] = [];
        byRG[rg].push(ws.name);
    });
    
    resourceInfo.innerHTML = `
        <strong>Workspaces Analyzed:</strong> ${workspaces.length} | 
        <strong>Resource Groups:</strong> ${Object.keys(byRG).length} |
        <span style="color: var(--warning-orange);">⚠️ No billable data found</span>
    `;
    
    let html = `
        <div class="no-data-message">
            <h2>📊 No Billable Data Found</h2>
            <p>The selected workspaces have no billable data ingestion in the last 30 days.</p>
            
            <h3>Workspaces Analyzed by Resource Group:</h3>
            <div class="rg-summary">
    `;
    
    for (const [rgName, wsNames] of Object.entries(byRG)) {
        html += `
            <div class="rg-summary-item">
                <strong>${rgName}</strong>
                <ul>
                    ${wsNames.map(name => `<li>${name} - <em>No data</em></li>`).join('')}
                </ul>
            </div>
        `;
    }
    
    html += `
            </div>
            
            <h3>What This Means</h3>
            <ul>
                <li>These workspaces have no recent log ingestion</li>
                <li>Current cost is likely minimal or zero</li>
                <li>No specific optimization recommendations can be made without data</li>
            </ul>
            
            <h3>Suggestions</h3>
            <ul>
                <li>Select workspaces that are actively receiving data</li>
                <li>Check if data collection is properly configured</li>
                <li>Verify DCRs (Data Collection Rules) are targeting these workspaces</li>
            </ul>
        </div>
    `;
    
    content.innerHTML = html;
    recommendationsSection.hidden = false;
}

// Show minimal data results
function showMinimalDataResults(workspaces, dataSummary) {
    const resourceInfo = document.getElementById('resourceInfo');
    const content = document.getElementById('recommendationsContent');
    
    const totalGB = dataSummary.totalIngestionGB.toFixed(2);
    const monthlyCost = (dataSummary.totalIngestionGB * 2.76).toFixed(2);
    
    resourceInfo.innerHTML = `
        <strong>Workspaces:</strong> ${dataSummary.workspacesWithData}/${dataSummary.totalWorkspaces} with data | 
        <strong>Total:</strong> ${totalGB} GB |
        <span style="color: var(--success-green);">✓ Minimal data - Low cost</span>
    `;
    
    let html = `
        <div class="minimal-data-message">
            <div class="minimal-header">
                <span class="minimal-icon">💰</span>
                <div>
                    <h2>Low Data Volume - Minimal Cost</h2>
                    <p class="subtitle">Total ingestion: <strong>${totalGB} GB</strong> over 30 days ≈ <strong>$${monthlyCost}/month</strong></p>
                </div>
            </div>
            
            <div class="recommendation-box success">
                <h3>✅ Assessment</h3>
                <p>Your data ingestion is <strong>very low</strong>. At this volume:</p>
                <ul>
                    <li>Pay-As-You-Go pricing is optimal (no commitment tier needed)</li>
                    <li>Basic Logs wouldn't provide meaningful savings</li>
                    <li>Default retention settings are fine</li>
                    <li>No immediate optimization actions required</li>
                </ul>
            </div>
            
            <div class="recommendation-box info">
                <h3>💡 When to Re-analyze</h3>
                <p>Run this analysis again when:</p>
                <ul>
                    <li>Daily ingestion exceeds <strong>1 GB/day</strong></li>
                    <li>Monthly costs exceed <strong>$100</strong></li>
                    <li>You enable new data collection (Container Insights, VM Insights, etc.)</li>
                </ul>
            </div>
        </div>
    `;
    
    content.innerHTML = html;
    recommendationsSection.hidden = false;
}

// Format markdown to HTML
function formatMarkdown(text) {
    // Process recommendation cards
    text = text.replace(/\[CARD:(warning|savings|info|success)\]([\s\S]*?)\[\/CARD\]/g, (match, type, content) => {
        const icons = {
            warning: '⚠️',
            savings: '💰',
            info: 'ℹ️',
            success: '✅'
        };
        
        let title = '';
        let impact = '';
        let action = '';
        let docs = '';
        let body = content;
        
        body = body.replace(/\[TITLE\]([\s\S]*?)\[\/TITLE\]/g, (m, t) => { title = t.trim(); return ''; });
        body = body.replace(/\[IMPACT\]([\s\S]*?)\[\/IMPACT\]/g, (m, i) => { impact = i.trim(); return ''; });
        body = body.replace(/\[ACTION\]([\s\S]*?)\[\/ACTION\]/g, (m, a) => { action = a.trim(); return ''; });
        body = body.replace(/\[DOCS\]([\s\S]*?)\[\/DOCS\]/g, (m, d) => { docs = d.trim(); return ''; });
        
        body = body.trim();
        
        let html = `<div class="rec-card rec-card-${type}">`;
        html += `<div class="rec-card-header">`;
        html += `<span class="rec-card-icon">${icons[type]}</span>`;
        html += `<span class="rec-card-title">${title || 'Recommendation'}</span>`;
        if (impact) html += `<span class="rec-card-impact">${impact}</span>`;
        html += `</div>`;
        if (body) html += `<div class="rec-card-body">${formatCardBody(body)}</div>`;
        if (action) html += `<div class="rec-card-action"><strong>📋 Action:</strong> ${action}</div>`;
        if (docs) html += `<div class="rec-card-docs"><a href="${docs}" target="_blank">📖 Documentation</a></div>`;
        html += `</div>`;
        
        return html;
    });
    
    return text;
}

// Format card body content
function formatCardBody(text) {
    // Tables
    text = text.replace(/\|(.+)\|\n\|[-:\s|]+\|\n((?:\|.+\|\n?)+)/g, (match, header, body) => {
        const headers = header.split('|').filter(h => h.trim()).map(h => `<th>${h.trim()}</th>`).join('');
        const rows = body.trim().split('\n').map(row => {
            const cells = row.split('|').filter(c => c.trim() !== '').map(c => `<td>${c.trim()}</td>`).join('');
            return `<tr>${cells}</tr>`;
        }).join('');
        return `<table class="ai-table"><thead><tr>${headers}</tr></thead><tbody>${rows}</tbody></table>`;
    });
    
    // Code blocks
    text = text.replace(/```(\w*)\n([\s\S]*?)```/g, '<pre><code class="language-$1">$2</code></pre>');
    
    // Inline code
    text = text.replace(/`([^`]+)`/g, '<code>$1</code>');
    
    // Bold and italic
    text = text.replace(/\*\*\*(.*?)\*\*\*/g, '<strong><em>$1</em></strong>');
    text = text.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
    text = text.replace(/\*(.*?)\*/g, '<em>$1</em>');
    
    // Lists
    text = text.replace(/^- (.+)$/gm, '<li>$1</li>');
    text = text.replace(/(<li>.*<\/li>\n?)+/g, '<ul>$&</ul>');
    
    // Line breaks
    text = text.split('\n').map(line => {
        line = line.trim();
        if (!line || line.startsWith('<')) return line;
        return `<p>${line}</p>`;
    }).join('');
    
    return text;
}

// Copy recommendations to clipboard
function copyRecommendations() {
    const content = document.getElementById('recommendationsContent');
    const text = content.innerText;
    navigator.clipboard.writeText(text).then(() => {
        const btn = document.getElementById('copyBtn');
        btn.innerHTML = `
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <polyline points="20 6 9 17 4 12"></polyline>
            </svg>
            Copied!
        `;
        setTimeout(() => {
            btn.innerHTML = `
                <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
                </svg>
                Copy
            `;
        }, 2000);
    });
}

// New analysis
function newAnalysis() {
    recommendationsSection.hidden = true;
    inputSection.hidden = false;
}

// Show error message
function showError(message) {
    alert(message);
}
