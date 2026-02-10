// Azure Monitor Cost Optimizer - Frontend App
// Supports Device Code Flow and Azure CLI authentication

// Store current workspace data
let currentWorkspaces = [];
let allSubscriptions = [];
let selectedWorkspaces = []; // Changed to array for multi-select
let sessionId = localStorage.getItem('azureSessionId') || null;
let authCheckInterval = null;

// DOM elements
const authRequiredSection = document.getElementById('authRequiredSection');
const inputSection = document.getElementById('inputSection');
const progressSection = document.getElementById('progressSection');
const recommendationsSection = document.getElementById('recommendationsSection');
const subscriptionSelect = document.getElementById('subscriptionSelect');
const subscriptionFilter = document.getElementById('subscriptionFilter');
const workspaceList = document.getElementById('workspaceList');
const azureForm = document.getElementById('azureForm');
const submitBtn = document.getElementById('submitBtn');
const statusIndicator = document.getElementById('statusIndicator');
const statusText = document.getElementById('statusText');
const retryBtn = document.getElementById('retryBtn');

// Initialize on page load
document.addEventListener('DOMContentLoaded', async () => {
    initializeDarkMode();
    await checkAzureConnection();
    setupEventListeners();
    loadRecentAnalyses();
});

// Add session header to all API requests
function apiHeaders() {
    const headers = { 'Content-Type': 'application/json' };
    if (sessionId) {
        headers['X-Session-Id'] = sessionId;
    }
    return headers;
}

// Check if Azure is authenticated (CLI or Device Code session)
async function checkAzureConnection() {
    try {
        statusIndicator.className = 'status-indicator checking';
        statusText.textContent = 'Checking authentication...';
        
        // First check if we have a valid session
        if (sessionId) {
            const statusRes = await fetch(`/api/auth/status/${sessionId}`);
            const status = await statusRes.json();
            if (status.status === 'authenticated') {
                onAuthenticated();
                return;
            } else if (status.status !== 'pending') {
                // Session invalid, clear it
                sessionId = null;
                localStorage.removeItem('azureSessionId');
            }
        }
        
        // Check CLI/health
        const response = await fetch('/api/health');
        const health = await response.json();
        
        if (health.azureAuthenticated) {
            onAuthenticated();
        } else {
            statusIndicator.className = 'status-indicator disconnected';
            statusText.textContent = 'Not authenticated';
            authRequiredSection.hidden = false;
            inputSection.hidden = true;
            showDeviceCodeButton();
        }
    } catch (error) {
        console.error('Error checking Azure connection:', error);
        statusIndicator.className = 'status-indicator disconnected';
        statusText.textContent = 'Connection error';
        authRequiredSection.hidden = false;
        inputSection.hidden = true;
        showDeviceCodeButton();
    }
}

// Show Device Code authentication button
function showDeviceCodeButton() {
    const authContent = authRequiredSection.querySelector('.auth-content');
    if (authContent && !document.getElementById('deviceCodeBtn')) {
        const existingMsg = authContent.querySelector('p');
        if (existingMsg) {
            existingMsg.innerHTML = `
                <strong>Sign in to access your Azure resources</strong><br>
                <span style="font-size: 0.9em; opacity: 0.9;">You'll be redirected to Microsoft's sign-in page to authenticate.</span>
            `;
        }
        
        const btn = document.createElement('button');
        btn.id = 'deviceCodeBtn';
        btn.className = 'auth-btn primary';
        btn.innerHTML = `
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"></path>
                <polyline points="10 17 15 12 10 7"></polyline>
                <line x1="15" y1="12" x2="3" y2="12"></line>
            </svg>
            Sign In with Microsoft
        `;
        btn.onclick = startDeviceCodeFlow;
        authContent.appendChild(btn);
    }
}

// Start Device Code Flow
async function startDeviceCodeFlow() {
    const btn = document.getElementById('deviceCodeBtn');
    btn.disabled = true;
    btn.innerHTML = `<span class="loading-spinner-small"></span> Initiating sign in...`;
    
    try {
        const response = await fetch('/api/auth/device-code', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({})
        });
        
        const data = await response.json();
        
        if (data.error) {
            throw new Error(data.error);
        }
        
        sessionId = data.sessionId;
        localStorage.setItem('azureSessionId', sessionId);
        
        // Show the device code UI
        showDeviceCodeUI(data);
        
    } catch (error) {
        console.error('Device code error:', error);
        btn.disabled = false;
        btn.innerHTML = `
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"></path>
                <polyline points="10 17 15 12 10 7"></polyline>
                <line x1="15" y1="12" x2="3" y2="12"></line>
            </svg>
            Sign In with Microsoft
        `;
        showError('Failed to start authentication: ' + error.message);
    }
}

// Show Device Code UI
function showDeviceCodeUI(data) {
    const authContent = authRequiredSection.querySelector('.auth-content');
    authContent.innerHTML = `
        <div class="device-code-ui">
            <h3>🔐 Sign In Required</h3>
            <p>To authenticate, follow these steps:</p>
            
            <div class="device-code-steps">
                <div class="step">
                    <span class="step-number">1</span>
                    <span>Go to <a href="${data.verificationUri}" target="_blank" class="device-link">${data.verificationUri}</a></span>
                </div>
                <div class="step">
                    <span class="step-number">2</span>
                    <span>Enter this code:</span>
                </div>
            </div>
            
            <div class="device-code-display">
                <code id="deviceCode">${data.userCode}</code>
                <button class="copy-code-btn" onclick="copyDeviceCode()">📋 Copy</button>
            </div>
            
            <p class="device-code-hint">
                <span class="spinner-small"></span>
                Waiting for you to complete sign in...
            </p>
            
            <button class="cancel-auth-btn" onclick="cancelDeviceCodeFlow()">Cancel</button>
        </div>
    `;
    
    // Start polling for authentication status
    authCheckInterval = setInterval(checkAuthStatus, 2000);
}

// Copy device code to clipboard
window.copyDeviceCode = function() {
    const code = document.getElementById('deviceCode').textContent;
    navigator.clipboard.writeText(code);
    const btn = document.querySelector('.copy-code-btn');
    btn.textContent = '✓ Copied!';
    setTimeout(() => btn.textContent = '📋 Copy', 2000);
};

// Cancel device code flow
window.cancelDeviceCodeFlow = function() {
    if (authCheckInterval) {
        clearInterval(authCheckInterval);
        authCheckInterval = null;
    }
    sessionId = null;
    localStorage.removeItem('azureSessionId');
    
    // Reset auth UI
    const authContent = authRequiredSection.querySelector('.auth-content');
    authContent.innerHTML = `<p></p>`;
    showDeviceCodeButton();
};

// Check authentication status
async function checkAuthStatus() {
    if (!sessionId) return;
    
    try {
        const response = await fetch(`/api/auth/status/${sessionId}`);
        const data = await response.json();
        
        if (data.status === 'authenticated') {
            clearInterval(authCheckInterval);
            authCheckInterval = null;
            onAuthenticated();
        } else if (data.status === 'error') {
            clearInterval(authCheckInterval);
            authCheckInterval = null;
            showError('Authentication failed: ' + data.error);
            cancelDeviceCodeFlow();
        }
    } catch (error) {
        console.error('Auth status check error:', error);
    }
}

// Called when user is authenticated
function onAuthenticated() {
    statusIndicator.className = 'status-indicator connected';
    statusText.textContent = 'Connected to Azure';
    authRequiredSection.hidden = true;
    inputSection.hidden = false;
    
    // Show logout button
    showLogoutButton();
    
    loadSubscriptions();
}

// Show logout button
function showLogoutButton() {
    const authSection = document.querySelector('.auth-section');
    if (authSection && !document.getElementById('logoutBtn')) {
        const btn = document.createElement('button');
        btn.id = 'logoutBtn';
        btn.className = 'auth-btn';
        btn.innerHTML = `
            <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"></path>
                <polyline points="16 17 21 12 16 7"></polyline>
                <line x1="21" y1="12" x2="9" y2="12"></line>
            </svg>
            Sign Out
        `;
        btn.onclick = logout;
        authSection.appendChild(btn);
    }
}

// Logout
async function logout() {
    if (sessionId) {
        await fetch('/api/auth/logout', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sessionId })
        });
    }
    sessionId = null;
    localStorage.removeItem('azureSessionId');
    
    // Remove logout button
    const logoutBtn = document.getElementById('logoutBtn');
    if (logoutBtn) logoutBtn.remove();
    
    // Reset UI
    authRequiredSection.hidden = false;
    inputSection.hidden = true;
    const authContent = authRequiredSection.querySelector('.auth-content');
    authContent.innerHTML = `<p></p>`;
    showDeviceCodeButton();
    checkAzureConnection();
}

// Load subscriptions from the server
async function loadSubscriptions() {
    try {
        subscriptionSelect.innerHTML = '<option value="">Loading subscriptions...</option>';
        subscriptionSelect.disabled = true;
        subscriptionFilter.disabled = true;
        
        const response = await fetch('/api/subscriptions', {
            headers: apiHeaders()
        });
        
        if (!response.ok) {
            if (response.status === 401) {
                logout();
                return;
            }
            throw new Error('Failed to load subscriptions');
        }
        
        allSubscriptions = await response.json();
        renderSubscriptions(allSubscriptions);
        subscriptionSelect.disabled = false;
        subscriptionFilter.disabled = false;
        subscriptionFilter.focus();
        
    } catch (error) {
        console.error('Error loading subscriptions:', error);
        subscriptionSelect.innerHTML = '<option value="">Error loading subscriptions</option>';
        showError('Failed to load subscriptions. Please sign in again.');
    }
}

// Render subscriptions to the select element
function renderSubscriptions(subscriptions) {
    subscriptionSelect.innerHTML = '';
    
    // Add placeholder
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = subscriptions.length === 0 
        ? 'No matching subscriptions' 
        : `Select from ${subscriptions.length} subscription(s)...`;
    subscriptionSelect.appendChild(placeholder);
    
    subscriptions.forEach(sub => {
        const option = document.createElement('option');
        option.value = sub.id;
        option.textContent = `${sub.name}`;
        subscriptionSelect.appendChild(option);
    });
}

// Filter subscriptions based on search text
function filterSubscriptions(searchText) {
    const filtered = allSubscriptions.filter(sub => 
        sub.name.toLowerCase().includes(searchText.toLowerCase()) ||
        sub.id.toLowerCase().includes(searchText.toLowerCase())
    );
    renderSubscriptions(filtered);
}

// Load workspaces for a subscription
async function loadWorkspaces(subscriptionId) {
    try {
        workspaceList.innerHTML = '<div class="workspace-placeholder">Loading workspaces...</div>';
        
        const response = await fetch(`/api/subscriptions/${subscriptionId}/workspaces`, {
            headers: apiHeaders()
        });
        
        if (!response.ok) {
            if (response.status === 401) {
                logout();
                return;
            }
            throw new Error('Failed to load workspaces');
        }
        
        currentWorkspaces = await response.json();
        
        if (currentWorkspaces.length === 0) {
            workspaceList.innerHTML = '<div class="workspace-placeholder">No workspaces found</div>';
            return;
        }
        
        renderWorkspaceList();
        updateSelectedCount();
        
    } catch (error) {
        console.error('Error loading workspaces:', error);
        workspaceList.innerHTML = '<div class="workspace-placeholder">Error loading workspaces</div>';
        showError('Failed to load workspaces.');
    }
}

// Extract resource group from resourceId
function extractResourceGroup(resourceId) {
    if (!resourceId) return 'Unknown';
    const match = resourceId.match(/resourceGroups\/([^\/]+)/i);
    return match ? match[1] : 'Unknown';
}

// Group workspaces by resource group
function groupWorkspacesByRG(workspaces) {
    const groups = {};
    workspaces.forEach(ws => {
        const rg = extractResourceGroup(ws.resourceId);
        ws.resourceGroup = rg; // Store RG on workspace object
        if (!groups[rg]) {
            groups[rg] = [];
        }
        groups[rg].push(ws);
    });
    // Sort groups by name
    return Object.keys(groups).sort().reduce((sorted, key) => {
        sorted[key] = groups[key].sort((a, b) => a.name.localeCompare(b.name));
        return sorted;
    }, {});
}

// Render workspace list grouped by resource group
function renderWorkspaceList() {
    workspaceList.innerHTML = '';
    
    const groupedWorkspaces = groupWorkspacesByRG(currentWorkspaces);
    let wsIndex = 0;
    
    Object.entries(groupedWorkspaces).forEach(([rgName, workspaces]) => {
        const rgDiv = document.createElement('div');
        rgDiv.className = 'resource-group';
        rgDiv.dataset.rgName = rgName;
        
        // Resource Group Header
        const header = document.createElement('div');
        header.className = 'resource-group-header';
        header.innerHTML = `
            <span class="expand-icon">▼</span>
            <input type="checkbox" class="rg-checkbox" data-rg="${rgName}">
            <span class="rg-name">${rgName}</span>
            <span class="rg-count">(${workspaces.length})</span>
        `;
        
        // Workspaces container
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
        workspaceList.appendChild(rgDiv);
        
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
        const firstCheckbox = workspaceList.querySelector('.ws-checkbox');
        if (firstCheckbox) {
            firstCheckbox.checked = true;
            updateRGCheckbox(firstCheckbox.dataset.rg);
            updateSelectedWorkspaces();
        }
    }
}

// Update RG checkbox state based on workspace selections
function updateRGCheckbox(rgName) {
    const wsCheckboxes = workspaceList.querySelectorAll(`.ws-checkbox[data-rg="${rgName}"]`);
    const rgCheckbox = workspaceList.querySelector(`.rg-checkbox[data-rg="${rgName}"]`);
    
    if (!rgCheckbox) return;
    
    const checkedCount = Array.from(wsCheckboxes).filter(cb => cb.checked).length;
    rgCheckbox.checked = checkedCount === wsCheckboxes.length;
    rgCheckbox.indeterminate = checkedCount > 0 && checkedCount < wsCheckboxes.length;
}

// Update selected workspaces array
function updateSelectedWorkspaces() {
    const checkboxes = workspaceList.querySelectorAll('.ws-checkbox:checked');
    selectedWorkspaces = Array.from(checkboxes).map(cb => {
        return currentWorkspaces.find(ws => ws.id === cb.value);
    }).filter(Boolean);
    updateSelectedCount();
}

// Update selected count display
function updateSelectedCount() {
    const countEl = document.getElementById('selectedCount');
    const count = selectedWorkspaces.length;
    const rgCount = new Set(selectedWorkspaces.map(ws => ws.resourceGroup)).size;
    countEl.textContent = `${count} workspace${count !== 1 ? 's' : ''} in ${rgCount} RG${rgCount !== 1 ? 's' : ''}`;
    countEl.style.color = count > 0 ? 'var(--azure-blue)' : '#888';
}

// Select all visible workspaces
function selectAllWorkspaces() {
    workspaceList.querySelectorAll('.ws-checkbox, .rg-checkbox').forEach(cb => {
        const item = cb.closest('.workspace-item');
        if (!item || !item.classList.contains('hidden')) {
            cb.checked = true;
            cb.indeterminate = false;
        }
    });
    // Update all RG checkboxes
    workspaceList.querySelectorAll('.resource-group').forEach(rg => {
        updateRGCheckbox(rg.dataset.rgName);
    });
    updateSelectedWorkspaces();
}

// Clear all selections
function clearAllWorkspaces() {
    workspaceList.querySelectorAll('.ws-checkbox, .rg-checkbox').forEach(cb => {
        cb.checked = false;
        cb.indeterminate = false;
    });
    updateSelectedWorkspaces();
}

// Expand all resource groups
function expandAllRGs() {
    workspaceList.querySelectorAll('.resource-group-workspaces').forEach(ws => {
        ws.classList.remove('collapsed');
    });
    workspaceList.querySelectorAll('.expand-icon').forEach(icon => {
        icon.classList.remove('collapsed');
    });
}

// Collapse all resource groups
function collapseAllRGs() {
    workspaceList.querySelectorAll('.resource-group-workspaces').forEach(ws => {
        ws.classList.add('collapsed');
    });
    workspaceList.querySelectorAll('.expand-icon').forEach(icon => {
        icon.classList.add('collapsed');
    });
}

// Filter workspaces by name
function filterWorkspaces(searchText) {
    const search = searchText.toLowerCase();
    
    workspaceList.querySelectorAll('.workspace-item').forEach(item => {
        const wsName = item.dataset.wsName || '';
        const rgName = item.dataset.rgName || '';
        const matches = wsName.includes(search) || rgName.includes(search);
        item.classList.toggle('hidden', !matches);
    });
    
    // Show/hide RG headers based on whether they have visible items
    workspaceList.querySelectorAll('.resource-group').forEach(rg => {
        const visibleItems = rg.querySelectorAll('.workspace-item:not(.hidden)');
        rg.style.display = visibleItems.length > 0 ? '' : 'none';
    });
}

// Setup event listeners
function setupEventListeners() {
    // Retry button
    retryBtn.addEventListener('click', async () => {
        await checkAzureConnection();
    });
    
    // Select All / Clear All / Expand / Collapse buttons
    document.getElementById('selectAllBtn').addEventListener('click', selectAllWorkspaces);
    document.getElementById('selectNoneBtn').addEventListener('click', clearAllWorkspaces);
    document.getElementById('expandAllBtn').addEventListener('click', expandAllRGs);
    document.getElementById('collapseAllBtn').addEventListener('click', collapseAllRGs);
    
    // Workspace filter
    document.getElementById('workspaceFilter').addEventListener('input', (e) => {
        filterWorkspaces(e.target.value);
    });
    
    // Subscription filter
    subscriptionFilter.addEventListener('input', (e) => {
        filterSubscriptions(e.target.value);
    });
    
    // Clear filter on focus if empty selection
    subscriptionFilter.addEventListener('focus', () => {
        if (subscriptionSelect.value === '') {
            subscriptionFilter.select();
        }
    });
    
    // Subscription change
    subscriptionSelect.addEventListener('change', async (e) => {
        const subscriptionId = e.target.value;
        if (subscriptionId) {
            // Update filter to show selected subscription name
            const selectedSub = allSubscriptions.find(s => s.id === subscriptionId);
            if (selectedSub) {
                subscriptionFilter.value = selectedSub.name;
            }
            // Clear workspace filter
            document.getElementById('workspaceFilter').value = '';
            await loadWorkspaces(subscriptionId);
        } else {
            workspaceList.innerHTML = '<div class="workspace-placeholder">Select a subscription first</div>';
            selectedWorkspaces = [];
            updateSelectedCount();
        }
    });
    
    // Form submit
    azureForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        await runAnalysis();
    });
    
    // Copy button
    document.getElementById('copyBtn').addEventListener('click', copyRecommendations);
    
    // Copy as Markdown button
    document.getElementById('copyMarkdownBtn').addEventListener('click', copyRecommendationsAsMarkdown);
    
    // Reset checklist button
    document.getElementById('resetChecklistBtn').addEventListener('click', resetChecklist);
    
    // New analysis button
    document.getElementById('newAnalysisBtn').addEventListener('click', () => {
        recommendationsSection.hidden = true;
        inputSection.hidden = false;
    });
}

// Checklist management
let currentChecklistId = null;

function generateChecklistFromRecommendations() {
    const cards = document.querySelectorAll('.rec-card-savings, .rec-card-warning');
    const checklistItems = [];
    
    cards.forEach((card, index) => {
        const icon = card.querySelector('.rec-card-icon')?.textContent || '';
        const title = card.querySelector('.rec-card-title')?.textContent || '';
        const impact = card.querySelector('.rec-card-impact')?.textContent || '';
        const action = card.querySelector('.rec-card-action')?.textContent?.replace('📋 Action:', '').trim() || '';
        
        // Only add savings and warning items to checklist
        if (title && action) {
            checklistItems.push({
                id: `item_${Date.now()}_${index}`,
                icon,
                title,
                impact,
                description: action,
                completed: false
            });
        }
    });
    
    return checklistItems;
}

function displayChecklist(items) {
    if (!items || items.length === 0) {
        document.getElementById('checklistTracker').hidden = true;
        return;
    }
    
    const checklistTracker = document.getElementById('checklistTracker');
    const checklistItems = document.getElementById('checklistItems');
    
    checklistItems.innerHTML = '';
    
    items.forEach(item => {
        const itemDiv = document.createElement('div');
        itemDiv.className = `checklist-item ${item.completed ? 'completed' : ''}`;
        itemDiv.dataset.itemId = item.id;
        
        itemDiv.innerHTML = `
            <input type="checkbox" class="checklist-checkbox" ${item.completed ? 'checked' : ''}>
            <div class="checklist-item-content">
                <div class="checklist-item-title">${item.icon} ${item.title}</div>
                <div class="checklist-item-description">${item.description}</div>
                ${item.impact ? `<span class="checklist-item-impact">${item.impact}</span>` : ''}
            </div>
        `;
        
        // Add click handler
        const checkbox = itemDiv.querySelector('.checklist-checkbox');
        checkbox.addEventListener('change', () => toggleChecklistItem(item.id));
        itemDiv.addEventListener('click', (e) => {
            if (e.target !== checkbox) {
                checkbox.checked = !checkbox.checked;
                toggleChecklistItem(item.id);
            }
        });
        
        checklistItems.appendChild(itemDiv);
    });
    
    updateChecklistProgress(items);
    checklistTracker.hidden = false;
}

function toggleChecklistItem(itemId) {
    const savedChecklist = getChecklistFromStorage();
    if (!savedChecklist) return;
    
    const item = savedChecklist.items.find(i => i.id === itemId);
    if (item) {
        item.completed = !item.completed;
        saveChecklistToStorage(savedChecklist);
        
        // Update UI
        const itemDiv = document.querySelector(`[data-item-id="${itemId}"]`);
        if (itemDiv) {
            itemDiv.classList.toggle('completed', item.completed);
        }
        
        updateChecklistProgress(savedChecklist.items);
    }
}

function updateChecklistProgress(items) {
    const total = items.length;
    const completed = items.filter(i => i.completed).length;
    const percentage = total > 0 ? Math.round((completed / total) * 100) : 0;
    
    document.getElementById('checklistProgressBar').style.width = `${percentage}%`;
    document.getElementById('checklistProgressText').textContent = 
        `${completed} of ${total} completed (${percentage}%)`;
}

function saveChecklistToStorage(checklist) {
    localStorage.setItem(`checklist_${currentChecklistId}`, JSON.stringify(checklist));
}

function getChecklistFromStorage() {
    if (!currentChecklistId) return null;
    const saved = localStorage.getItem(`checklist_${currentChecklistId}`);
    return saved ? JSON.parse(saved) : null;
}

function resetChecklist() {
    if (!currentChecklistId) return;
    
    if (confirm('Are you sure you want to reset the checklist? All progress will be lost.')) {
        localStorage.removeItem(`checklist_${currentChecklistId}`);
        
        // Regenerate checklist
        const items = generateChecklistFromRecommendations();
        const checklist = {
            id: currentChecklistId,
            items: items,
            createdAt: Date.now()
        };
        saveChecklistToStorage(checklist);
        displayChecklist(items);
    }
}

// Run the full analysis
async function runAnalysis() {
    console.log('Starting analysis...');
    
    const context = document.getElementById('context').value;
    
    // Use selected workspaces from checkboxes
    const workspacesToAnalyze = selectedWorkspaces;
    
    console.log('Workspaces to analyze:', workspacesToAnalyze.length);
    
    if (workspacesToAnalyze.length === 0) {
        showError('Please select at least one workspace');
        return;
    }
    
    // Warn if selecting too many
    if (workspacesToAnalyze.length > 10) {
        if (!confirm(`You selected ${workspacesToAnalyze.length} workspaces. This may take a while and could hit rate limits. Continue?`)) {
            return;
        }
    }
    
    // Show progress section
    inputSection.hidden = true;
    progressSection.hidden = false;
    
    console.log('Progress section visible');
    
    try {
        // Step 1: Run queries for all workspaces
        const totalWorkspaces = workspacesToAnalyze.length;
        let allQueryData = {};
        let allWorkspaceConfigs = [];
        
        for (let i = 0; i < workspacesToAnalyze.length; i++) {
            const ws = workspacesToAnalyze[i];
            updateProgress('progressQueries', 'running', `Querying workspace ${i + 1}/${totalWorkspaces}: ${ws.name}...`);
            
            const queryResults = await fetch('/api/query', {
                method: 'POST',
                headers: apiHeaders(),
                body: JSON.stringify({
                    workspaceId: ws.id,
                    queries: analysisQueries
                })
            });
            
            if (!queryResults.ok) {
                console.error(`Failed to query workspace ${ws.name}`);
                continue;
            }
            
            const queryData = await queryResults.json();
            allQueryData[ws.name] = queryData;
            allWorkspaceConfigs.push({
                name: ws.name,
                resourceGroup: ws.resourceGroup,
                sku: ws.sku,
                retentionDays: ws.retentionDays,
                location: ws.location
            });
        }
        
        // Group configs by RG for summary
        const rgSummary = {};
        allWorkspaceConfigs.forEach(cfg => {
            const rg = cfg.resourceGroup || 'Unknown';
            if (!rgSummary[rg]) rgSummary[rg] = [];
            rgSummary[rg].push(cfg.name);
        });
        
        updateProgress('progressQueries', 'complete', `Analyzed ${Object.keys(allQueryData).length} workspace(s) in ${Object.keys(rgSummary).length} RG(s)`);
        
        // Check if we got any actual data
        const dataSummary = summarizeQueryData(allQueryData);
        
        // Format results for AI
        const analysisData = formatMultiWorkspaceResults(allQueryData);
        
        // If no data at all, show a helpful message instead of calling AI
        if (dataSummary.totalWorkspaces === 0 || dataSummary.workspacesWithData === 0) {
            progressSection.hidden = true;
            showNoDataResults(workspacesToAnalyze, dataSummary);
            return;
        }
        
        // If very minimal data (under 1GB total), show minimal data message
        if (dataSummary.totalIngestionGB < 1) {
            progressSection.hidden = true;
            showMinimalDataResults(workspacesToAnalyze, dataSummary);
            return;
        }
        
        // Step 2: Get AI recommendations (only if we have meaningful data)
        updateProgress('progressAI', 'running', 'Generating AI recommendations...');
        
        const aiResponse = await fetch('/api/recommendations', {
            method: 'POST',
            headers: apiHeaders(),
            body: JSON.stringify({
                workspaceName: totalWorkspaces > 1 ? `Multiple (${totalWorkspaces})` : workspacesToAnalyze[0].name,
                workspaceConfig: totalWorkspaces > 1 
                    ? { summary: `${totalWorkspaces} workspaces analyzed`, workspaces: allWorkspaceConfigs }
                    : allWorkspaceConfigs[0],
                analysisData,
                context
            })
        });
        
        if (!aiResponse.ok) {
            const errorData = await aiResponse.json().catch(() => ({}));
            throw new Error(errorData.error || 'Failed to get recommendations');
        }
        
        const { recommendations } = await aiResponse.json();
        updateProgress('progressAI', 'complete', 'Recommendations generated');
        
        // Show recommendations
        progressSection.hidden = true;
        showRecommendations(recommendations, workspacesToAnalyze, dataSummary);
        
        // Save to history
        saveAnalysisToHistory(workspacesToAnalyze, dataSummary);
        
    } catch (error) {
        console.error('Analysis error:', error);
        progressSection.hidden = true;
        inputSection.hidden = false;
        showError(`Analysis failed: ${error.message}`);
    }
}

// Summarize query data to check if we have actual data
function summarizeQueryData(allQueryData) {
    const summary = {
        totalWorkspaces: Object.keys(allQueryData).length,
        workspacesWithData: 0,
        workspacesEmpty: 0,
        totalIngestionGB: 0,
        byResourceGroup: {}
    };
    
    for (const [wsName, queryResults] of Object.entries(allQueryData)) {
        const ws = currentWorkspaces.find(w => w.name === wsName);
        const rg = ws?.resourceGroup || 'Unknown';
        
        if (!summary.byResourceGroup[rg]) {
            summary.byResourceGroup[rg] = { workspaces: [], totalGB: 0, hasData: false };
        }
        
        // Check dataVolumeByTable for actual data
        const volumeData = queryResults.dataVolumeByTable;
        let wsGB = 0;
        
        if (volumeData && volumeData.rows && volumeData.rows.length > 0) {
            // Sum up all BillableGB values (usually column index 1)
            const gbIndex = volumeData.columns?.indexOf('BillableGB') ?? 1;
            wsGB = volumeData.rows.reduce((sum, row) => sum + (parseFloat(row[gbIndex]) || 0), 0);
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
    
    return summary;
}

// Show results when no data is found
function showNoDataResults(workspaces, dataSummary) {
    const resourceInfo = document.getElementById('resourceInfo');
    const content = document.getElementById('recommendationsContent');
    
    // Group by RG for display
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

// Show results when minimal data is found (under 1GB)
function showMinimalDataResults(workspaces, dataSummary) {
    const resourceInfo = document.getElementById('resourceInfo');
    const content = document.getElementById('recommendationsContent');
    
    const totalGB = dataSummary.totalIngestionGB.toFixed(2);
    const monthlyCost = (dataSummary.totalIngestionGB * 2.76).toFixed(2); // Approx cost
    
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
            
            <div class="data-breakdown">
                <h3>📊 Data by Resource Group</h3>
                <table class="summary-table">
                    <thead>
                        <tr>
                            <th>Resource Group</th>
                            <th>Workspace</th>
                            <th>30-Day Ingestion</th>
                            <th>Est. Monthly Cost</th>
                        </tr>
                    </thead>
                    <tbody>
    `;
    
    for (const [rgName, rgData] of Object.entries(dataSummary.byResourceGroup)) {
        const rgCost = (rgData.totalGB * 2.76).toFixed(2);
        const firstWs = rgData.workspaces[0];
        
        html += `<tr>
            <td rowspan="${rgData.workspaces.length}"><strong>${rgName}</strong></td>
            <td>${firstWs.name}</td>
            <td>${firstWs.gb.toFixed(3)} GB</td>
            <td>$${(firstWs.gb * 2.76).toFixed(2)}</td>
        </tr>`;
        
        rgData.workspaces.slice(1).forEach(ws => {
            html += `<tr>
                <td>${ws.name}</td>
                <td>${ws.gb.toFixed(3)} GB</td>
                <td>$${(ws.gb * 2.76).toFixed(2)}</td>
            </tr>`;
        });
    }
    
    html += `
                    </tbody>
                </table>
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
                    <li>Daily ingestion exceeds <strong>1 GB/day</strong> (consider 100 GB/day commitment tier)</li>
                    <li>Monthly costs exceed <strong>$100</strong></li>
                    <li>You enable new data collection (Container Insights, VM Insights, etc.)</li>
                </ul>
            </div>
        </div>
    `;
    
    content.innerHTML = html;
    recommendationsSection.hidden = false;
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
    
    // Build summary header
    let headerHtml = '';
    
    if (dataSummary) {
        const totalGB = dataSummary.totalIngestionGB.toFixed(2);
        headerHtml = `
            <strong>Workspaces:</strong> ${dataSummary.workspacesWithData}/${dataSummary.totalWorkspaces} with data | 
            <strong>Total Ingestion:</strong> ${totalGB} GB (30 days) |
            <strong>Resource Groups:</strong> ${Object.keys(dataSummary.byResourceGroup).length}
        `;
    } else {
        // Fallback
        const byRG = {};
        workspaces.forEach(ws => {
            const rg = ws.resourceGroup || 'Unknown';
            if (!byRG[rg]) byRG[rg] = [];
            byRG[rg].push(ws.name);
        });
        headerHtml = `
            <strong>Workspaces:</strong> ${workspaces.length} | 
            <strong>Resource Groups:</strong> ${Object.keys(byRG).length}
        `;
    }
    
    resourceInfo.innerHTML = headerHtml;
    
    // Build data summary section
    let summaryHtml = '';
    if (dataSummary && Object.keys(dataSummary.byResourceGroup).length > 0) {
        summaryHtml = '<div class="data-summary"><h3>📊 Data Summary by Resource Group</h3><table class="summary-table"><thead><tr><th>Resource Group</th><th>Workspaces</th><th>30-Day Ingestion</th></tr></thead><tbody>';
        
        for (const [rgName, rgData] of Object.entries(dataSummary.byResourceGroup)) {
            const statusIcon = rgData.hasData ? '✅' : '⚪';
            summaryHtml += `<tr>
                <td><strong>${rgName}</strong></td>
                <td>${rgData.workspaces.map(w => `${w.name} (${w.gb.toFixed(2)} GB)`).join('<br>')}</td>
                <td>${statusIcon} ${rgData.totalGB.toFixed(2)} GB</td>
            </tr>`;
        }
        
        summaryHtml += '</tbody></table></div><hr>';
    }
    
    const content = document.getElementById('recommendationsContent');
    content.innerHTML = summaryHtml + formatMarkdown(recommendations);
    
    recommendationsSection.hidden = false;
    
    // Generate and display checklist and savings counter
    setTimeout(() => {
        currentChecklistId = `analysis_${Date.now()}`;
        const items = generateChecklistFromRecommendations();
        
        // Check if there's a saved checklist for this analysis
        let savedChecklist = getChecklistFromStorage();
        if (!savedChecklist || savedChecklist.items.length !== items.length) {
            // Create new checklist
            savedChecklist = {
                id: currentChecklistId,
                items: items,
                createdAt: Date.now()
            };
            saveChecklistToStorage(savedChecklist);
        } else {
            // Use saved progress
            currentChecklistId = savedChecklist.id;
        }
        
        displayChecklist(savedChecklist.items);
        
        // Calculate and display savings
        displaySavingsCounter();
    }, 100);
}

// Calculate and display total savings counter
function displaySavingsCounter() {
    const cards = document.querySelectorAll('.rec-card-savings');
    if (cards.length === 0) {
        document.getElementById('savingsCounter').hidden = true;
        return;
    }
    
    let totalSavings = 0;
    const savingsItems = [];
    
    cards.forEach(card => {
        const title = card.querySelector('.rec-card-title')?.textContent || '';
        const impactText = card.querySelector('.rec-card-impact')?.textContent || '';
        
        // Extract dollar amount from impact text
        const dollarMatch = impactText.match(/\$[\d,]+\.?\d*/);
        if (dollarMatch) {
            const amount = parseFloat(dollarMatch[0].replace(/[$,]/g, ''));
            if (!isNaN(amount)) {
                totalSavings += amount;
                savingsItems.push({
                    title: title,
                    amount: amount,
                    description: impactText
                });
            }
        }
        
        // Also check for percentage savings
        const percentMatch = impactText.match(/(\d+)%/);
        if (percentMatch && !dollarMatch) {
            // Try to find dollar amount in card body
            const bodyText = card.querySelector('.rec-card-body')?.textContent || '';
            const bodyDollarMatch = bodyText.match(/\$[\d,]+\.?\d*/);
            if (bodyDollarMatch) {
                const amount = parseFloat(bodyDollarMatch[0].replace(/[$,]/g, ''));
                if (!isNaN(amount)) {
                    totalSavings += amount;
                    savingsItems.push({
                        title: title,
                        amount: amount,
                        description: impactText
                    });
                }
            }
        }
    });
    
    if (totalSavings > 0) {
        // Animate counter
        animateSavingsCounter(totalSavings);
        
        // Display breakdown if multiple items
        const breakdownContainer = document.getElementById('savingsBreakdown');
        if (savingsItems.length > 1) {
            breakdownContainer.innerHTML = savingsItems.map(item => `
                <div class="savings-item">
                    <div class="savings-item-title">${item.title}</div>
                    <div class="savings-item-amount">$${item.amount.toFixed(2)}</div>
                    <div class="savings-item-description">${item.description}</div>
                </div>
            `).join('');
        } else {
            breakdownContainer.innerHTML = '';
        }
        
        document.getElementById('savingsCounter').hidden = false;
    } else {
        document.getElementById('savingsCounter').hidden = true;
    }
}

// Animate the savings counter with count-up effect
function animateSavingsCounter(targetAmount) {
    const element = document.getElementById('savingsAmount');
    const duration = 1000; // 1 second
    const steps = 30;
    const increment = targetAmount / steps;
    let current = 0;
    let step = 0;
    
    const timer = setInterval(() => {
        step++;
        current += increment;
        
        if (step >= steps) {
            current = targetAmount;
            clearInterval(timer);
        }
        
        element.textContent = `$${current.toFixed(2)}`;
    }, duration / steps);
}

// Format multi-workspace query results for AI (grouped by RG)
function formatMultiWorkspaceResults(allQueryData) {
    let formatted = '';
    
    // Group results by resource group
    const byRG = {};
    for (const [workspaceName, queryResults] of Object.entries(allQueryData)) {
        const ws = currentWorkspaces.find(w => w.name === workspaceName);
        const rg = ws?.resourceGroup || 'Unknown';
        if (!byRG[rg]) byRG[rg] = {};
        byRG[rg][workspaceName] = queryResults;
    }
    
    // Format grouped by RG
    for (const [rgName, workspaces] of Object.entries(byRG)) {
        formatted += `\n# Resource Group: ${rgName}\n`;
        formatted += `*${Object.keys(workspaces).length} workspace(s)*\n\n`;
        
        for (const [workspaceName, queryResults] of Object.entries(workspaces)) {
            formatted += `## Workspace: ${workspaceName}\n\n`;
            formatted += formatQueryResultsForAI(queryResults);
            formatted += '\n---\n';
        }
    }
    
    return formatted;
}

// Format markdown to HTML - card-based version
function formatMarkdown(text) {
    // If no cards found, wrap entire response in an info card
    if (!text.includes('[CARD:')) {
        text = wrapInDefaultCards(text);
    }
    
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
        
        // Extract title
        body = body.replace(/\[TITLE\]([\s\S]*?)\[\/TITLE\]/g, (m, t) => { title = t.trim(); return ''; });
        // Extract impact
        body = body.replace(/\[IMPACT\]([\s\S]*?)\[\/IMPACT\]/g, (m, i) => { impact = i.trim(); return ''; });
        // Extract action
        body = body.replace(/\[ACTION\]([\s\S]*?)\[\/ACTION\]/g, (m, a) => { action = a.trim(); return ''; });
        // Extract docs link
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
    
    // Process KQL blocks
    text = text.replace(/\[KQL\]([\s\S]*?)\[\/KQL\]/g, (match, code) => {
        return `<div class="kql-block"><div class="kql-header">📊 KQL Query</div><pre><code>${code.trim()}</code></pre></div>`;
    });
    
    // Handle any remaining content with basic markdown
    text = formatCardBody(text);
    
    return text;
}

// Wrap unformatted AI response in cards
function wrapInDefaultCards(text) {
    let result = '';
    const sections = text.split(/(?=#{1,3}\s)/);
    
    for (const section of sections) {
        if (!section.trim()) continue;
        
        // Detect section type from content
        let cardType = 'info';
        let title = 'Analysis';
        
        const headerMatch = section.match(/^#{1,3}\s+(.+)$/m);
        if (headerMatch) {
            title = headerMatch[1].trim();
        }
        
        // Determine card type based on content
        if (/savings?|\$\d|cost reduc/i.test(section)) cardType = 'savings';
        else if (/warning|excessive|issue|problem/i.test(section)) cardType = 'warning';
        else if (/optimal|no issues|looks good/i.test(section)) cardType = 'success';
        
        const body = section.replace(/^#{1,3}\s+.+$/m, '').trim();
        
        // Extract action if present in text
        let action = '';
        const actionMatch = body.match(/\[ACTION\]([\s\S]*?)\[\/ACTION\]/);
        if (actionMatch) {
            action = actionMatch[1].trim();
        }
        const cleanBody = body.replace(/\[ACTION\]([\s\S]*?)\[\/ACTION\]/g, '').trim();
        
        result += `[CARD:${cardType}]\n[TITLE]${title}[/TITLE]\n${cleanBody}\n`;
        if (action) result += `[ACTION]${action}[/ACTION]\n`;
        result += `[/CARD]\n\n`;
    }
    
    return result || `[CARD:info]\n[TITLE]Analysis Results[/TITLE]\n${text}\n[/CARD]`;
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
    
    // Links
    text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" class="ai-link">$1</a>');
    
    // Line breaks to paragraphs for non-empty lines
    const lines = text.split('\n').filter(l => l.trim());
    text = lines.map(line => {
        line = line.trim();
        if (line.startsWith('<')) return line; // Already HTML
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

// Copy recommendations as Markdown
function copyRecommendationsAsMarkdown() {
    const content = document.getElementById('recommendationsContent');
    const markdown = htmlToMarkdown(content);
    
    navigator.clipboard.writeText(markdown).then(() => {
        const btn = document.getElementById('copyMarkdownBtn');
        const originalHTML = btn.innerHTML;
        btn.innerHTML = `
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <polyline points="20 6 9 17 4 12"></polyline>
            </svg>
            Copied!
        `;
        setTimeout(() => {
            btn.innerHTML = originalHTML;
        }, 2000);
    });
}

// Convert HTML content to Markdown
function htmlToMarkdown(element) {
    let markdown = '';
    
    // Get workspace info header
    const resourceInfo = document.getElementById('resourceInfo');
    if (resourceInfo) {
        markdown += '# Azure Monitor Cost Optimization Analysis\n\n';
        markdown += resourceInfo.innerText.replace(/\s+/g, ' ').trim() + '\n\n';
        markdown += '---\n\n';
    }
    
    // Process each recommendation card
    const cards = element.querySelectorAll('.rec-card');
    cards.forEach(card => {
        const type = card.className.match(/rec-card-(warning|savings|info|success)/)?.[1] || 'info';
        const icon = card.querySelector('.rec-card-icon')?.textContent || '';
        const title = card.querySelector('.rec-card-title')?.textContent || '';
        const impact = card.querySelector('.rec-card-impact')?.textContent || '';
        const body = card.querySelector('.rec-card-body');
        const action = card.querySelector('.rec-card-action');
        const docs = card.querySelector('.rec-card-docs a');
        
        // Title with icon
        markdown += `## ${icon} ${title}\n\n`;
        
        // Impact badge
        if (impact) {
            markdown += `**${impact}**\n\n`;
        }
        
        // Body content
        if (body) {
            markdown += convertBodyToMarkdown(body) + '\n\n';
        }
        
        // Action
        if (action) {
            const actionText = action.textContent.replace('📋 Action:', '').trim();
            markdown += `### 📋 Action\n\n${actionText}\n\n`;
        }
        
        // Documentation link
        if (docs) {
            markdown += `📖 [Documentation](${docs.href})\n\n`;
        }
        
        markdown += '---\n\n';
    });
    
    // Process data summary table if present
    const summaryTable = element.querySelector('.summary-table');
    if (summaryTable) {
        markdown += '## 📊 Data Summary\n\n';
        markdown += convertTableToMarkdown(summaryTable) + '\n\n';
    }
    
    return markdown;
}

// Convert body HTML to Markdown
function convertBodyToMarkdown(bodyElement) {
    let markdown = '';
    
    const children = Array.from(bodyElement.children);
    children.forEach(child => {
        const tagName = child.tagName.toLowerCase();
        
        switch (tagName) {
            case 'p':
                markdown += child.textContent.trim() + '\n\n';
                break;
                
            case 'ul':
            case 'ol':
                const items = child.querySelectorAll('li');
                items.forEach((item, index) => {
                    const bullet = tagName === 'ul' ? '-' : `${index + 1}.`;
                    markdown += `${bullet} ${item.textContent.trim()}\n`;
                });
                markdown += '\n';
                break;
                
            case 'table':
                markdown += convertTableToMarkdown(child) + '\n\n';
                break;
                
            case 'pre':
                const code = child.querySelector('code');
                if (code) {
                    markdown += '```\n' + code.textContent.trim() + '\n```\n\n';
                }
                break;
                
            case 'h1':
            case 'h2':
            case 'h3':
            case 'h4':
            case 'h5':
            case 'h6':
                const level = parseInt(tagName[1]);
                markdown += '#'.repeat(level) + ' ' + child.textContent.trim() + '\n\n';
                break;
                
            default:
                if (child.textContent.trim()) {
                    markdown += child.textContent.trim() + '\n\n';
                }
        }
    });
    
    return markdown.trim();
}

// Convert HTML table to Markdown table
function convertTableToMarkdown(table) {
    let markdown = '';
    
    // Headers
    const headers = table.querySelectorAll('thead th');
    if (headers.length > 0) {
        markdown += '| ' + Array.from(headers).map(th => th.textContent.trim()).join(' | ') + ' |\n';
        markdown += '| ' + Array.from(headers).map(() => '---').join(' | ') + ' |\n';
    }
    
    // Rows
    const rows = table.querySelectorAll('tbody tr');
    rows.forEach(row => {
        const cells = row.querySelectorAll('td');
        if (cells.length > 0) {
            markdown += '| ' + Array.from(cells).map(td => td.textContent.trim()).join(' | ') + ' |\n';
        }
    });
    
    return markdown;
}

// Show error message
function showError(message) {
    alert(message);
}

// Format query results for AI consumption
function formatQueryResultsForAI(results) {
    let formatted = '';
    
    for (const [queryName, result] of Object.entries(results)) {
        formatted += `### ${queryName.replace(/([A-Z])/g, ' $1').trim()}\n`;
        
        if (result.error) {
            formatted += `Error: ${result.error}\n\n`;
            continue;
        }
        
        if (!result.rows || result.rows.length === 0) {
            formatted += 'No data returned\n\n';
            continue;
        }
        
        // Create a simple table
        const headers = result.columns;
        formatted += '| ' + headers.join(' | ') + ' |\n';
        formatted += '| ' + headers.map(() => '---').join(' | ') + ' |\n';
        
        // Limit to first 50 rows
        const rows = result.rows.slice(0, 50);
        rows.forEach(row => {
            formatted += '| ' + row.map(cell => String(cell ?? '')).join(' | ') + ' |\n';
        });
        
        if (result.rows.length > 50) {
            formatted += `\n*... and ${result.rows.length - 50} more rows*\n`;
        }
        
        formatted += '\n';
    }
    
    return formatted;
}

// ============ DARK MODE ============

function initializeDarkMode() {
    const savedTheme = localStorage.getItem('theme');
    if (savedTheme === 'dark') {
        document.body.classList.add('dark-mode');
        updateThemeToggle(true);
    }
    
    // Theme toggle button
    const themeToggle = document.getElementById('themeToggle');
    if (themeToggle) {
        themeToggle.addEventListener('click', toggleDarkMode);
    }
}

function toggleDarkMode() {
    document.body.classList.toggle('dark-mode');
    const isDark = document.body.classList.contains('dark-mode');
    localStorage.setItem('theme', isDark ? 'dark' : 'light');
    updateThemeToggle(isDark);
}

function updateThemeToggle(isDark) {
    const toggleBtn = document.getElementById('themeToggle');
    if (toggleBtn) {
        if (isDark) {
            toggleBtn.classList.add('dark');
        } else {
            toggleBtn.classList.remove('dark');
        }
    }
}

// ============ RECENT ANALYSES ============

function saveAnalysisToHistory(workspaces, dataSummary) {
    const analysis = {
        id: Date.now(),
        timestamp: Date.now(),
        workspaceNames: workspaces.map(ws => ws.name),
        workspaceCount: workspaces.length,
        resourceGroups: [...new Set(workspaces.map(ws => ws.resourceGroup))],
        totalGB: dataSummary ? dataSummary.totalIngestionGB : 0,
        subscriptionId: subscriptionSelect.value
    };
    
    const history = getAnalysisHistory();
    history.unshift(analysis);
    
    // Keep only last 10
    const trimmed = history.slice(0, 10);
    localStorage.setItem('analysisHistory', JSON.stringify(trimmed));
    
    loadRecentAnalyses();
}

function getAnalysisHistory() {
    const saved = localStorage.getItem('analysisHistory');
    return saved ? JSON.parse(saved) : [];
}

function loadRecentAnalyses() {
    const history = getAnalysisHistory();
    const container = document.getElementById('recentAnalyses');
    const list = document.getElementById('recentAnalysesList');
    
    if (history.length === 0) {
        container.hidden = true;
        return;
    }
    
    list.innerHTML = history.map(analysis => {
        const date = new Date(analysis.timestamp);
        const timeAgo = formatTimeAgo(date);
        const wsCount = analysis.workspaceCount;
        const rgCount = analysis.resourceGroups.length;
        
        return `
            <div class="recent-analysis-item" data-analysis-id="${analysis.id}">
                <div class="recent-analysis-info">
                    <div class="recent-analysis-title">
                        ${wsCount} workspace${wsCount !== 1 ? 's' : ''} in ${rgCount} resource group${rgCount !== 1 ? 's' : ''}
                    </div>
                    <div class="recent-analysis-details">
                        ${analysis.workspaceNames.slice(0, 3).join(', ')}${analysis.workspaceCount > 3 ? ` +${analysis.workspaceCount - 3} more` : ''}
                        ${analysis.totalGB > 0 ? ` • ${analysis.totalGB.toFixed(2)} GB` : ''}
                    </div>
                </div>
                <div class="recent-analysis-date">${timeAgo}</div>
                <button class="recent-analysis-delete" onclick="deleteAnalysis(${analysis.id}, event)" title="Delete">🗑️</button>
            </div>
        `;
    }).join('');
    
    // Add click handlers to load analyses
    list.querySelectorAll('.recent-analysis-item').forEach(item => {
        item.addEventListener('click', (e) => {
            if (e.target.classList.contains('recent-analysis-delete')) return;
            const analysisId = parseInt(item.dataset.analysisId);
            loadAnalysisFromHistory(analysisId);
        });
    });
    
    container.hidden = false;
}

function formatTimeAgo(date) {
    const seconds = Math.floor((Date.now() - date) / 1000);
    
    if (seconds < 60) return 'Just now';
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
    if (seconds < 604800) return `${Math.floor(seconds / 86400)}d ago`;
    
    return date.toLocaleDateString();
}

async function loadAnalysisFromHistory(analysisId) {
    const history = getAnalysisHistory();
    const analysis = history.find(a => a.id === analysisId);
    
    if (!analysis) return;
    
    // Select the subscription
    if (analysis.subscriptionId) {
        subscriptionSelect.value = analysis.subscriptionId;
        const selectedSub = allSubscriptions.find(s => s.id === analysis.subscriptionId);
        if (selectedSub) {
            subscriptionFilter.value = selectedSub.name;
        }
        
        // Load workspaces
        await loadWorkspaces(analysis.subscriptionId);
        
        // Wait a bit for workspaces to render
        setTimeout(() => {
            // Select the workspaces
            analysis.workspaceNames.forEach(wsName => {
                const checkbox = Array.from(workspaceList.querySelectorAll('.ws-checkbox')).find(cb => {
                    const ws = currentWorkspaces.find(w => w.id === cb.value);
                    return ws && ws.name === wsName;
                });
                
                if (checkbox) {
                    checkbox.checked = true;
                    updateRGCheckbox(checkbox.dataset.rg);
                }
            });
            
            updateSelectedWorkspaces();
            
            // Scroll to form
            azureForm.scrollIntoView({ behavior: 'smooth' });
        }, 500);
    }
}

window.deleteAnalysis = function(analysisId, event) {
    event.stopPropagation();
    
    if (confirm('Delete this analysis from history?')) {
        const history = getAnalysisHistory();
        const filtered = history.filter(a => a.id !== analysisId);
        localStorage.setItem('analysisHistory', JSON.stringify(filtered));
        loadRecentAnalyses();
    }
};
