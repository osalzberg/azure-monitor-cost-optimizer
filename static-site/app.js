// Azure Monitor Cost Optimizer - Static Site Version
// Uses token-based authentication (user provides Azure CLI token)

// ============ GLOBAL ONCLICK HANDLERS (must be at top for immediate availability) ============
// Copy the az command
function copyCommand() {
    const cmd = "az account get-access-token --resource https://management.azure.com --query accessToken -o tsv | pbcopy";
    
    if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(cmd).then(() => {
            const btn = document.querySelector('.copy-cli-btn');
            if (btn) { btn.textContent = '✓ Copied!'; setTimeout(() => btn.textContent = '📋 Copy', 2000); }
        }).catch(() => {
            fallbackCopyCommand(cmd);
        });
    } else {
        fallbackCopyCommand(cmd);
    }
}

function fallbackCopyCommand(text) {
    const textArea = document.createElement('textarea');
    textArea.value = text;
    textArea.style.position = 'fixed';
    textArea.style.left = '-9999px';
    document.body.appendChild(textArea);
    textArea.select();
    try {
        document.execCommand('copy');
        const btn = document.querySelector('.copy-cli-btn');
        if (btn) { btn.textContent = '✓ Copied!'; setTimeout(() => btn.textContent = '📋 Copy', 2000); }
    } catch (e) {
        console.error('Copy failed:', e);
    }
    document.body.removeChild(textArea);
}

// App state
let accessToken = null;
let allSubscriptions = [];
let currentWorkspaces = [];
let selectedWorkspaces = [];

// KQL Queries for cost analysis - following aka.ms/costopt best practices
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
    // Check heartbeat frequency - should be ~60/hour (1/min), flag if higher
    heartbeatFrequency: `
        Heartbeat
        | where TimeGenerated > ago(1h)
        | summarize HeartbeatsPerHour = count() by Computer
        | summarize AvgHeartbeatsPerHour = avg(HeartbeatsPerHour), 
                    MaxHeartbeatsPerHour = max(HeartbeatsPerHour),
                    ComputerCount = count()
    `,
    // Check for computers with excessive heartbeats
    excessiveHeartbeats: `
        Heartbeat
        | where TimeGenerated > ago(1h)
        | summarize HeartbeatsPerHour = count() by Computer
        | where HeartbeatsPerHour > 70
        | order by HeartbeatsPerHour desc
        | take 10
    `,
    // Check Perf counter frequency
    perfCounterFrequency: `
        Perf
        | where TimeGenerated > ago(1h)
        | summarize SamplesPerHour = count() by Computer, CounterName
        | summarize AvgSamplesPerHour = avg(SamplesPerHour) by CounterName
        | where AvgSamplesPerHour > 100
        | order by AvgSamplesPerHour desc
        | take 10
    `,
    // Check for Basic Logs candidates - comprehensive list from https://learn.microsoft.com/azure/azure-monitor/logs/basic-logs-azure-tables
    basicLogsCandidates: `
        let BasicLogsTables = dynamic([
            // Application Insights
            'AppTraces',
            // Container & Kubernetes
            'ContainerLog', 'ContainerLogV2', 'ContainerAppConsoleLogs', 'AppEnvSpringAppConsoleLogs',
            'ArcK8sAudit', 'ArcK8sAuditAdmin', 'ArcK8sControlPlane', 'AKSAudit', 'AKSAuditAdmin', 'AKSControlPlane',
            'RetinaNetworkFlowLogs', 'ContainerNetworkLogs',
            // Syslog & Security
            'Syslog', 'SecurityEvent', 'CommonSecurityLog',
            // Azure Diagnostics
            'AzureDiagnostics', 'AzureMetrics', 'AzureMetricsV2',
            // Storage
            'StorageTableLogs', 'StorageQueueLogs', 'StorageFileLogs', 'StorageBlobLogs',
            // Firewall
            'AZFWNetworkRule', 'AZFWFatFlow', 'AZFWFlowTrace', 'AZFWApplicationRule', 'AZFWThreatIntel',
            'AZFWNatRule', 'AZFWIdpsSignature', 'AZFWDnsQuery', 'AZFWInternalFqdnResolutionFailure',
            'AZFWNetworkRuleAggregation', 'AZFWApplicationRuleAggregation', 'AZFWNatRuleAggregation', 'AZFWDnsFlowTrace',
            // Cosmos DB
            'CDBDataPlaneRequests', 'CDBDataPlaneRequests5M', 'CDBDataPlaneRequests15M', 'CDBPartitionKeyStatistics',
            'CDBPartitionKeyRUConsumption', 'CDBQueryRuntimeStatistics', 'CDBMongoRequests', 'CDBCassandraRequests',
            'CDBGremlinRequests', 'CDBTableApiRequests', 'CDBControlPlaneRequests', 'VCoreMongoRequests',
            // Event Hubs & Service Bus
            'AZMSApplicationMetricLogs', 'AZMSOperationalLogs', 'AZMSRunTimeAuditLogs', 'AZMSDiagnosticErrorLogs',
            'AZMSVnetConnectionEvents', 'AZMSArchiveLogs', 'AZMSAutoscaleLogs', 'AZMSKafkaCoordinatorLogs',
            'AZMSKafkaUserErrorLogs', 'AZMSCustomerManagedKeyUserLogs', 'AZMSHybridConnectionsEvents',
            // Key Vault
            'AZKVAuditLogs', 'AZKVPolicyEvaluationDetailsLogs',
            // AVS
            'AVSVcSyslog', 'AVSEsxiFirewallSyslog', 'AVSEsxiSyslog', 'AVSNsxManagerSyslog', 'AVSNsxEdgeSyslog', 'AVSSyslog',
            // Sentinel ASim
            'ASimWebSessionLogs', 'ASimAlertEventLogs', 'ASimDhcpEventLogs', 'ASimFileEventLogs',
            'ASimUserManagementActivityLogs', 'ASimRegistryEventLogs', 'ASimAuditEventLogs',
            'ASimAuthenticationEventLogs', 'ASimDnsActivityLogs', 'ASimNetworkSessionLogs', 'ASimProcessEventLogs',
            // AAD & Sign-in
            'AADGraphActivityLogs', 'SigninLogs', 'AADFirstPartyToFirstPartySignInLogs', 'AADManagedIdentitySignInLogs',
            'AADNonInteractiveUserSignInLogs', 'AADProvisioningLogs', 'AADServicePrincipalSignInLogs', 'ADFSSignInLogs',
            // Databricks
            'DatabricksBrickStoreHttpGateway', 'DatabricksDashboards', 'DatabricksCloudStorageMetadata',
            'DatabricksPredictiveOptimization', 'DatabricksDataMonitoring', 'DatabricksIngestion',
            'DatabricksMarketplaceConsumer', 'DatabricksLineageTracking', 'DatabricksFilesystem', 'DatabricksApps',
            'DatabricksClusterPolicies', 'DatabricksDataRooms', 'DatabricksGroups', 'DatabricksMarketplaceProvider',
            'DatabricksOnlineTables', 'DatabricksRBAC', 'DatabricksRFA', 'DatabricksVectorSearch',
            'DatabricksWebhookNotifications', 'DatabricksWorkspaceFiles', 'DatabricksLakeviewConfig', 'DatabricksFiles',
            'DatabricksBudgetPolicyCentral', 'DatabricksAccounts', 'DatabricksClusters', 'DatabricksDBFS',
            'DatabricksInstancePools', 'DatabricksJobs', 'DatabricksNotebook', 'DatabricksSQL',
            'DatabricksSQLPermissions', 'DatabricksSSH',
            // Synapse
            'SynapseSqlPoolExecRequests', 'SynapseSqlPoolRequestSteps', 'SynapseSqlPoolDmsWorkers',
            'SynapseSqlPoolWaits', 'SynapseSqlPoolSqlRequests',
            // PostgreSQL
            'PGSQLPgStatActivitySessions', 'PGSQLDbTransactionsStats', 'PGSQLQueryStoreRuntime',
            'PGSQLQueryStoreWaits', 'PGSQLAutovacuumStats', 'PGSQLServerLogs', 'PGSQLQueryStoreQueryText',
            // MySQL
            'MySqlAuditLogs', 'MySqlSlowLogs',
            // Log Analytics
            'LAQueryLogs', 'LASummaryLogs', 'LAJobLogs', 'OTelSpans', 'OTelEvents', 'OTelLogs', 'OTelTraces', 'OTelTracesAgent',
            // Communication Services
            'ACSSMSIncomingOperations', 'ACSOptOutManagementOperations', 'ACSCallDiagnostics',
            'ACSCallDiagnosticsUpdates', 'ACSCallingMetrics', 'ACSCallClientServiceRequestAndOutcome',
            'ACSCallClientOperations', 'ACSCallClientMediaStatsTimeSeries', 'ACSCallSummary', 'ACSCallSummaryUpdates',
            'ACSCallRecordingIncomingOperations', 'ACSCallRecordingSummary', 'ACSCallClosedCaptionsSummary',
            'ACSJobRouterIncomingOperations', 'ACSRoomsIncomingOperations', 'ACSCallAutomationIncomingOperations',
            'ACSCallAutomationMediaSummary', 'ACSCallAutomationStreamingUsage', 'ACSAdvancedMessagingOperations',
            // Dev Center
            'DevCenterDiagnosticLogs', 'DevCenterResourceOperationLogs', 'DevCenterBillingEventLogs',
            'DevCenterAgentHealthLogs', 'DevCenterConnectionLogs',
            // Other common tables
            'DNSQueryLogs', 'NatGatewayFlowlogsV1', 'NSPAccessLogs', 'AGWAccessLogs', 'AGWPerformanceLogs', 'AGWFirewallLogs',
            'AGCAccessLogs', 'AGCFirewallLogs', 'ALBHealthEvent', 'AMSKeyDeliveryRequests', 'AMSMediaAccountHealth',
            'AMSLiveEventOperations', 'AMSStreamingEndpointRequests', 'StorageMalwareScanningResults',
            'ThreatIntelObjects', 'ThreatIntelIndicators', 'SecurityAttackPathData'
        ]);
        Usage
        | where TimeGenerated > ago(30d)
        | where IsBillable == true
        | where DataType in (BasicLogsTables)
        | summarize BillableGB = sum(Quantity) / 1000 by DataType
        | where BillableGB > 0.01
        | order by BillableGB desc
    `,
    topTables: `
        Usage
        | where TimeGenerated > ago(7d)
        | where IsBillable == true
        | summarize TotalGB = sum(Quantity) / 1000 by DataType
        | top 10 by TotalGB desc
    `,
    // Check query frequency per table from LAQueryLogs to identify frequently queried tables
    // Tables queried frequently should NOT be converted to Basic Logs
    tableQueryFrequency: `
        LAQueryLogs
        | where TimeGenerated > ago(30d)
        | extend TablesQueried = todynamic(RequestTarget)
        | mv-expand TablesQueried
        | extend TableName = tostring(TablesQueried)
        | where isnotempty(TableName)
        | summarize QueryCount = count(), DistinctUsers = dcount(AADEmail), AvgQueriesPerDay = count() / 30.0 by TableName
        | where QueryCount > 10
        | order by QueryCount desc
        | take 50
    `,
    // Check if LAQueryLogs is enabled - returns row count if enabled, empty if not
    laQueryLogsStatus: `
        LAQueryLogs
        | where TimeGenerated > ago(7d)
        | summarize RecordCount = count(), IsEnabled = true
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

// Sign in with pasted token
function signInWithToken() {
    const tokenInput = document.getElementById('tokenInput');
    if (!tokenInput) {
        console.error('Token input element not found');
        showError('Error: Could not find token input');
        return;
    }
    
    let token = tokenInput.value;
    
    // Debug log
    console.log('Sign in attempt, token length:', token ? token.length : 0);
    
    if (!token) {
        showError('Please paste your access token');
        return;
    }
    
    // Clean up the token - remove whitespace, quotes, newlines
    token = token.trim();
    token = token.replace(/^["']|["']$/g, '');
    token = token.replace(/[\r\n\s]/g, '');
    
    console.log('Cleaned token length:', token.length);
    
    if (!token) {
        showError('Please paste your access token');
        return;
    }
    
    // Try to validate as JWT
    const parts = token.split('.');
    console.log('Token parts:', parts.length);
    
    if (parts.length === 3) {
        try {
            // Handle base64url encoding (replace - with + and _ with /)
            let base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
            // Pad with = if needed
            while (base64.length % 4) {
                base64 += '=';
            }
            const payload = JSON.parse(atob(base64));
            console.log('Token payload decoded, exp:', payload.exp);
            
            const exp = payload.exp * 1000;
            
            if (exp < Date.now()) {
                showError('Token expired. Please generate a fresh token using the az command.');
                return;
            }
            
            const username = payload.upn || payload.unique_name || payload.preferred_username || payload.name || 'User';
            console.log('Username from token:', username);
            
            accessToken = token;
            localStorage.setItem('azureToken', JSON.stringify({
                token: token,
                username: username,
                expiresAt: exp
            }));
            
            console.log('Token stored, calling onSignedIn');
            onSignedIn(username);
            return;
        } catch (e) {
            console.error('Token decode error:', e);
            // Continue to fallback
        }
    }
    
    // If we couldn't parse but it looks like a token, try anyway
    if (token.length > 100) {
        console.log('Using token without validation (length:', token.length, ')');
        accessToken = token;
        localStorage.setItem('azureToken', JSON.stringify({
            token: token,
            username: 'User',
            expiresAt: Date.now() + (60 * 60 * 1000)
        }));
        onSignedIn('User');
        return;
    }
    
    showError('Invalid token. Make sure you copied the entire output from the az command (it should be a long string of characters).');
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
    
    console.log('Using Azure OpenAI:', { endpoint, deployment, hasKey: !!key });
    
    // Format query data for AI
    const analysisData = formatQueryDataForAI(allQueryData, dataSummary);
    
    const systemPrompt = `You are an Azure Monitor cost optimization expert following Microsoft's official guidance at aka.ms/costopt.

IMPORTANT: When analyzing MULTIPLE workspaces, ALWAYS specify which workspace each finding applies to. Use the workspace name in your recommendations.

ALWAYS analyze and report on ALL of these areas in order:

## 1. COMMITMENT TIER ANALYSIS (REQUIRED) - Per workspace or combined
- If daily ingestion >= 100 GB/day: RECOMMEND commitment tier (saves ~17-30%)
- If 50-99 GB/day: Monitor and plan for commitment tier
- If < 50 GB/day: Pay-as-you-go is optimal
- Calculate exact savings: (daily_gb * 30 * $2.76) vs commitment tier price

## 2. BASIC LOGS CANDIDATES (REQUIRED) - CHECK ALERTS, DASHBOARDS, AND QUERY FREQUENCY FIRST!
⚠️ CRITICAL: Basic Logs have major limitations:
- Cannot be used in dashboards, workbooks, or alert rules
- Limited KQL operators supported
- Query cost of ~$0.006/GB scanned
- Only 8-day interactive retention

**FIRST, CHECK "Tables Used in Alert Rules":**
- If a table is listed in "Tables Used in Alert Rules" → NEVER recommend Basic Logs
- Converting these tables would BREAK existing alerts
- This is the #1 priority check - alert breakage is critical

**SECOND, CHECK "Tables Used in Dashboards":**
- If a table is listed in "Tables Used in Dashboards" → NEVER recommend Basic Logs
- Converting these tables would BREAK existing Azure Dashboards
- Dashboard tiles would fail to load data

**THEN, CHECK the "Table Query Frequency" data:**
- If a table is queried MORE than 5 times/day on average → DO NOT recommend Basic Logs
- If a table has multiple distinct users querying it → likely used in other dashboards/workbooks, DO NOT recommend
- Only recommend Basic Logs for tables that are RARELY queried (debugging/auditing purposes)

**If LAQueryLogs is NOT enabled:**
- We CANNOT determine query frequency - recommend enabling it first
- LAQueryLogs captures all queries to the workspace (audit log)
- To enable: Workspace → Diagnostic settings → Add "Query Audit" → Send to same workspace
- Without this data, be CONSERVATIVE - don't strongly recommend Basic Logs

Common high-volume candidates (if NOT in alerts and NOT frequently queried):
- Container/Kubernetes: ContainerLogV2, ContainerLog, AKSAudit, AKSAuditAdmin, AKSControlPlane
- Application: AppTraces, Syslog, AzureDiagnostics
- Storage: StorageBlobLogs, StorageFileLogs, StorageQueueLogs, StorageTableLogs  
- Firewall: AZFWNetworkRule, AZFWApplicationRule, AZFWFlowTrace, AZFWDnsQuery
- Security (non-alerting): SecurityEvent, CommonSecurityLog (for verbose logs)
- Database: CDBDataPlaneRequests, SynapseSqlPool*, MySQL/PostgreSQL logs
- Sign-in: SigninLogs, AADNonInteractiveUserSignInLogs
- Full list: https://aka.ms/basiclogs-tables

If a Basic Logs candidate is frequently queried, WARN the user instead of recommending conversion.

## 3. AUXILIARY LOGS CANDIDATES (REQUIRED) - FOR CUSTOM TABLES ONLY
⚠️ Auxiliary Logs are even CHEAPER than Basic Logs but with MORE limitations:
- **ONLY for custom tables** (tables ending in _CL created via Data Collection Rules)
- Azure built-in tables do NOT support Auxiliary plan
- No alerts at all (not even Simple Log Alerts)
- No Insights support
- Slower queries - NOT optimized for real-time analysis
- No restore capability
- No data export
- Good for: Auditing, compliance, verbose troubleshooting logs you rarely query

**When to recommend Auxiliary Logs:**
- Custom tables (_CL suffix) with high volume (>1 GB/month)
- Tables used purely for auditing/compliance/troubleshooting
- Tables NOT in alerts, NOT in dashboards, and RARELY queried (<1/day)
- Data you need to keep for long periods but rarely access

**Cost comparison:**
- Analytics: Standard ingestion cost + query cost included
- Basic: ~50% cheaper ingestion + $0.006/GB query cost
- Auxiliary: ~85% cheaper ingestion + $0.006/GB query cost (cheapest option)

Docs: https://learn.microsoft.com/azure/azure-monitor/logs/logs-table-plans

## 4. DATA COLLECTION OPTIMIZATION (REQUIRED) - Specify which workspace
- Heartbeat frequency: If Heartbeat table exists, check if computers send >60 heartbeats/hour (default is 1/min = 60/hour). Recommend reducing to 5-min intervals if appropriate.
- Performance counters: Check Perf table - recommend reducing collection frequency from 10s to 60s for non-critical counters
- Container Insights: If ContainerLog* tables exist, recommend filtering stdout/stderr, excluding namespaces
- Duplicate collection: Flag if same data appears from multiple sources

## 5. RETENTION OPTIMIZATION (REQUIRED)
- Recommend 30-day interactive retention for high-volume tables
- Recommend archive tier for data needed >90 days
- Security tables may need longer retention (compliance)

## 6. TABLE-SPECIFIC RECOMMENDATIONS (REQUIRED) - Specify which workspace
For EACH top table by volume, provide specific recommendations including which workspace it's in.

FORMAT YOUR RESPONSE EXACTLY LIKE THIS:

[CARD:info]
[TITLE]📊 Data Overview[/TITLE]
[IMPACT]Total: X GB/month, ~$Y/month[/IMPACT]
List each workspace with its ingestion: "WorkspaceName (ResourceGroup): X.XX GB"
[/CARD]

Then for each finding use:
[CARD:savings] for cost saving opportunities
[CARD:warning] for issues found
[CARD:success] for things already optimized
[CARD:info] for informational items

IMPORTANT - ORDER YOUR RECOMMENDATIONS BY PRIORITY:
1. FIRST: Show [CARD:savings] items - actionable cost savings (highest $ impact first)
2. SECOND: Show [CARD:warning] items - issues that need attention  
3. LAST: Show [CARD:success] items - things already optimized or no action needed

Do NOT lead with "everything is optimal" messages. Always show actionable recommendations first.
If something is already optimal, mention it briefly at the END, not the beginning.

Each card must have:
- [TITLE] that includes the workspace name if workspace-specific
- [IMPACT] (with $ amount or % savings)
- [ACTION] with specific steps mentioning the workspace name
- Include [DOCS] with relevant Microsoft docs link.

Example title format: "💡 Basic Logs Opportunity - my-workspace-name"

End with a [CARD:info] summary card with this EXACT format for the top actions:

[CARD:info]
[TITLE]🔍 Summary: Top Actions by Impact[/TITLE]
[IMPACT]Prioritized recommendations[/IMPACT]

**1. [Action Name]** - [Workspace Name]
   - Savings: ~$X/month
   - What: Brief description

**2. [Action Name]** - [Workspace Name]
   - Savings: ~$X/month  
   - What: Brief description

**3. [Action Name]** - [Workspace Name]
   - Savings: ~$X/month (or "minor")
   - What: Brief description
[/CARD]

Be CONSISTENT - always check the same things, always provide the same recommendations for the same data patterns.`;

    // Build workspace breakdown for prompt
    let workspaceBreakdown = '';
    for (const [rgName, rgData] of Object.entries(dataSummary.byResourceGroup)) {
        workspaceBreakdown += `\n### Resource Group: ${rgName}\n`;
        rgData.workspaces.forEach(ws => {
            workspaceBreakdown += `- **${ws.name}**: ${ws.gb.toFixed(2)} GB (~$${(ws.gb * 2.76).toFixed(2)}/month)\n`;
        });
    }

    const userPrompt = `Analyze this Azure Monitor Log Analytics workspace data following the checklist above.

## Data Summary
- Total 30-day ingestion: ${dataSummary.totalIngestionGB.toFixed(2)} GB
- Daily average: ${(dataSummary.totalIngestionGB / 30).toFixed(2)} GB/day  
- Estimated monthly cost: $${(dataSummary.totalIngestionGB * 2.76).toFixed(2)} (at Pay-As-You-Go $2.76/GB)
- Workspaces analyzed: ${dataSummary.workspacesWithData}/${dataSummary.totalWorkspaces}

## Workspaces Breakdown by Resource Group
${workspaceBreakdown}

## Top Tables by Volume (Combined)
${dataSummary.topTables.map(t => `- ${t.name}: ${t.gb.toFixed(2)} GB (${((t.gb/dataSummary.totalIngestionGB)*100).toFixed(1)}%)`).join('\n')}

## Detailed Analysis Data Per Workspace
${analysisData}

${dataSummary.advisorRecommendations?.length > 0 ? `## Azure Advisor Recommendations (Official)
The following recommendations come directly from Azure Advisor:
${dataSummary.advisorRecommendations.map((r, i) => `${i+1}. **${r.solution || r.problem}** (Impact: ${r.impact}) - Resource: ${r.impactedResource}`).join('\n')}

Please incorporate these Azure Advisor recommendations into your analysis and highlight them.` : ''}

${userContext ? `## User Context\n${userContext}` : ''}

IMPORTANT: When providing recommendations, ALWAYS specify which workspace the recommendation applies to. If there are Azure Advisor recommendations, include them prominently with [CARD:savings] or [CARD:warning] as appropriate. Follow the checklist exactly. Be specific with numbers. Be consistent.`;

    try {
        console.log('Calling Azure OpenAI API...');
        const apiUrl = `${endpoint}/openai/deployments/${deployment}/chat/completions?api-version=2024-02-01`;
        console.log('API URL:', apiUrl);
        
        const response = await fetch(apiUrl, {
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
                temperature: 0.2  // Low temperature for consistent results
            })
        });
        
        if (!response.ok) {
            const errorText = await response.text();
            console.error('AI API error response:', errorText);
            const error = JSON.parse(errorText).error || {};
            throw new Error(error.message || `HTTP ${response.status}`);
        }
        
        const data = await response.json();
        console.log('AI response received successfully');
        
        // Append Advisor recommendations card if AI didn't include them
        let aiResponse = data.choices[0].message.content;
        if (dataSummary.advisorRecommendations?.length > 0 && !aiResponse.includes('Azure Advisor')) {
            aiResponse += formatAdvisorRecommendations(dataSummary.advisorRecommendations);
        }
        
        return aiResponse;
        
    } catch (error) {
        console.error('AI API error:', error);
        // Fallback to rule-based if AI fails
        let fallback = generateRecommendations(allQueryData, dataSummary);
        if (dataSummary.advisorRecommendations?.length > 0) {
            fallback += formatAdvisorRecommendations(dataSummary.advisorRecommendations);
        }
        return fallback + 
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
        
        // Heartbeat frequency analysis
        if (queryResults.heartbeatFrequency?.rows?.length > 0) {
            const row = queryResults.heartbeatFrequency.rows[0];
            const avgIdx = queryResults.heartbeatFrequency.columns?.indexOf('AvgHeartbeatsPerHour') ?? 0;
            const maxIdx = queryResults.heartbeatFrequency.columns?.indexOf('MaxHeartbeatsPerHour') ?? 1;
            const countIdx = queryResults.heartbeatFrequency.columns?.indexOf('ComputerCount') ?? 2;
            formatted += `**Heartbeat Frequency:**\n`;
            formatted += `- Average: ${parseFloat(row[avgIdx]).toFixed(1)} heartbeats/hour/computer\n`;
            formatted += `- Max: ${parseFloat(row[maxIdx]).toFixed(0)} heartbeats/hour\n`;
            formatted += `- Computers monitored: ${row[countIdx]}\n`;
            formatted += `- Expected: 60/hour (1/min default)\n\n`;
        }
        
        // Excessive heartbeats
        if (queryResults.excessiveHeartbeats?.rows?.length > 0) {
            formatted += `**⚠️ Computers with Excessive Heartbeats (>70/hour):**\n`;
            const compIdx = queryResults.excessiveHeartbeats.columns?.indexOf('Computer') ?? 0;
            const hbIdx = queryResults.excessiveHeartbeats.columns?.indexOf('HeartbeatsPerHour') ?? 1;
            queryResults.excessiveHeartbeats.rows.forEach(row => {
                formatted += `- ${row[compIdx]}: ${row[hbIdx]} heartbeats/hour\n`;
            });
            formatted += '\n';
        }
        
        // High-frequency Perf counters
        if (queryResults.perfCounterFrequency?.rows?.length > 0) {
            formatted += `**High-Frequency Performance Counters (>100 samples/hour):**\n`;
            const counterIdx = queryResults.perfCounterFrequency.columns?.indexOf('CounterName') ?? 0;
            const samplesIdx = queryResults.perfCounterFrequency.columns?.indexOf('AvgSamplesPerHour') ?? 1;
            queryResults.perfCounterFrequency.rows.forEach(row => {
                formatted += `- ${row[counterIdx]}: ${parseFloat(row[samplesIdx]).toFixed(0)} samples/hour\n`;
            });
            formatted += '\n';
        }
        
        // Basic Logs candidates
        if (queryResults.basicLogsCandidates?.rows?.length > 0) {
            formatted += `**Basic Logs Candidates Found:**\n`;
            const typeIdx = queryResults.basicLogsCandidates.columns?.indexOf('DataType') ?? 0;
            const gbIdx = queryResults.basicLogsCandidates.columns?.indexOf('BillableGB') ?? 1;
            queryResults.basicLogsCandidates.rows.forEach(row => {
                formatted += `- ${row[typeIdx]}: ${parseFloat(row[gbIdx]).toFixed(2)} GB (could save ~50%)\n`;
            });
            formatted += '\n';
        }
        
        // Check LAQueryLogs status
        const laQueryLogsEnabled = queryResults.laQueryLogsStatus?.rows?.length > 0;
        
        // Table query frequency (for Basic Logs assessment)
        if (queryResults.tableQueryFrequency?.rows?.length > 0) {
            formatted += `**Table Query Frequency (last 30 days):**\n`;
            formatted += `✅ LAQueryLogs is enabled - using actual query data for analysis\n`;
            formatted += `⚠️ Tables queried frequently should NOT be converted to Basic Logs\n`;
            const tableNameIdx = queryResults.tableQueryFrequency.columns?.indexOf('TableName') ?? 0;
            const queryCountIdx = queryResults.tableQueryFrequency.columns?.indexOf('QueryCount') ?? 1;
            const avgPerDayIdx = queryResults.tableQueryFrequency.columns?.indexOf('AvgQueriesPerDay') ?? 3;
            queryResults.tableQueryFrequency.rows.slice(0, 15).forEach(row => {
                const avgPerDay = parseFloat(row[avgPerDayIdx]).toFixed(1);
                formatted += `- ${row[tableNameIdx]}: ${row[queryCountIdx]} queries (~${avgPerDay}/day)\n`;
            });
            formatted += '\n';
        } else if (!laQueryLogsEnabled) {
            formatted += `**⚠️ LAQueryLogs Not Enabled:**\n`;
            formatted += `Cannot determine table query frequency - LAQueryLogs diagnostic is not enabled.\n`;
            formatted += `Basic Logs recommendations will be conservative (assume tables may be queried).\n`;
            formatted += `To enable: Workspace > Diagnostic settings > Add "Query Audit"\n\n`;
        }
    }
    
    // Summary of frequently queried tables
    if (dataSummary.frequentlyQueriedTables?.length > 0) {
        formatted += '\n### Frequently Queried Tables Summary\n';
        formatted += '⚠️ These tables are actively queried and may not be suitable for Basic Logs:\n\n';
        dataSummary.frequentlyQueriedTables.slice(0, 10).forEach(t => {
            formatted += `- **${t.tableName}**: ${t.queryCount} queries (avg ${t.avgQueriesPerDay.toFixed(1)}/day)\n`;
        });
        formatted += '\n';
    }
    
    // Tables used in alert rules
    if (dataSummary.tablesInAlerts?.length > 0) {
        formatted += '\n### 🚨 Tables Used in Alert Rules (NEVER use Basic Logs)\n';
        formatted += 'These tables are used in scheduled query rules (alerts) and MUST remain on Analytics tier:\n\n';
        dataSummary.tablesInAlerts.forEach(table => {
            const alerts = (dataSummary.alertDetails || []).filter(a => 
                a.tables.some(t => t.toLowerCase() === table.toLowerCase())
            );
            const alertNames = alerts.map(a => a.displayName || a.name).slice(0, 3);
            formatted += `- **${table}**: Used in ${alerts.length} alert(s) - ${alertNames.join(', ')}${alerts.length > 3 ? '...' : ''}\n`;
        });
        formatted += '\n⚠️ Converting these to Basic Logs would BREAK existing alerts!\n\n';
    }
    
    // Tables used in dashboards
    if (dataSummary.tablesInDashboards?.length > 0) {
        formatted += '\n### 📊 Tables Used in Dashboards (NEVER use Basic Logs)\n';
        formatted += 'These tables are used in Azure Dashboards and MUST remain on Analytics tier:\n\n';
        dataSummary.tablesInDashboards.forEach(table => {
            const dashboards = (dataSummary.dashboardDetails || []).filter(d => 
                d.tables.some(t => t.toLowerCase() === table.toLowerCase())
            );
            const dashNames = dashboards.map(d => d.displayName || d.name).slice(0, 3);
            formatted += `- **${table}**: Used in ${dashboards.length} dashboard(s) - ${dashNames.join(', ')}${dashboards.length > 3 ? '...' : ''}\n`;
        });
        formatted += '\n⚠️ Converting these to Basic Logs would BREAK existing dashboards!\n\n';
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
        
        // Step 2: Fetch Azure Advisor recommendations
        updateProgress('progressAdvisor', 'running', 'Fetching Azure Advisor recommendations...');
        let advisorRecommendations = [];
        try {
            advisorRecommendations = await fetchAdvisorRecommendations(selectedWorkspaces);
            updateProgress('progressAdvisor', 'complete', `Found ${advisorRecommendations.length} Advisor recommendation(s)`);
        } catch (e) {
            console.warn('Could not fetch Advisor recommendations:', e);
            updateProgress('progressAdvisor', 'complete', 'Advisor recommendations unavailable');
        }
        
        // Step 2.5: Fetch scheduled query rules (alerts) and dashboards to detect table usage
        updateProgress('progressAdvisor', 'running', 'Detecting tables used in alerts & dashboards...');
        let alertTablesInfo = { tablesInAlerts: [], alertDetails: [] };
        let dashboardTablesInfo = { tablesInDashboards: [], dashboardDetails: [] };
        try {
            // Fetch alerts and dashboards in parallel
            const [alertResults, dashboardResults] = await Promise.all([
                fetchScheduledQueryRules(selectedWorkspaces),
                fetchDashboardTables(selectedWorkspaces)
            ]);
            alertTablesInfo = alertResults;
            dashboardTablesInfo = dashboardResults;
            
            const totalBlockedTables = new Set([
                ...alertTablesInfo.tablesInAlerts,
                ...dashboardTablesInfo.tablesInDashboards
            ]).size;
            
            if (totalBlockedTables > 0) {
                updateProgress('progressAdvisor', 'complete', 
                    `Found ${advisorRecommendations.length} Advisor rec(s), ${totalBlockedTables} tables in alerts/dashboards`);
            }
        } catch (e) {
            console.warn('Could not fetch alerts/dashboards:', e);
        }
        
        // Check if we got any actual data
        const dataSummary = summarizeQueryData(allQueryData);
        dataSummary.advisorRecommendations = advisorRecommendations;
        dataSummary.tablesInAlerts = alertTablesInfo.tablesInAlerts;
        dataSummary.alertDetails = alertTablesInfo.alertDetails;
        dataSummary.tablesInDashboards = dashboardTablesInfo.tablesInDashboards;
        dataSummary.dashboardDetails = dashboardTablesInfo.dashboardDetails;
        
        console.log('Data summary:', dataSummary);
        
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
        console.log('AI Settings:', { 
            hasEndpoint: !!aiSettings.endpoint, 
            hasKey: !!aiSettings.key, 
            deployment: aiSettings.deployment 
        });
        
        let recommendations;
        
        if (aiSettings.endpoint && aiSettings.key) {
            // Use Azure OpenAI
            console.log('Using Azure OpenAI for recommendations');
            updateProgress('progressAI', 'running', 'Generating AI recommendations (using Azure OpenAI)...');
            const context = document.getElementById('context').value;
            recommendations = await getAIRecommendations(allQueryData, dataSummary, aiSettings, context);
        } else {
            // Fallback to rule-based recommendations
            console.log('AI not configured, using rule-based recommendations');
            updateProgress('progressAI', 'running', 'Generating recommendations (rule-based)...');
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

// ============ AZURE ADVISOR INTEGRATION ============
async function fetchAdvisorRecommendations(workspaces) {
    const recommendations = [];
    const seenIds = new Set();
    
    // Get workspace names and resource IDs for matching
    const workspaceNames = workspaces.map(ws => ws.name.toLowerCase());
    const workspaceResourceIds = workspaces.map(ws => ws.resourceId.toLowerCase());
    
    console.log('Advisor: Looking for workspaces:', workspaceNames);
    
    // Get unique subscription IDs from workspaces
    const subscriptionIds = [...new Set(workspaces.map(ws => {
        const match = ws.resourceId.match(/\/subscriptions\/([^\/]+)/);
        return match ? match[1] : null;
    }).filter(Boolean))];
    
    for (const subscriptionId of subscriptionIds) {
        try {
            // Fetch ALL recommendations for the subscription
            console.log(`Advisor: Fetching all recommendations for subscription ${subscriptionId}...`);
            const response = await fetch(
                `https://management.azure.com/subscriptions/${subscriptionId}/providers/Microsoft.Advisor/recommendations?api-version=2020-01-01`,
                {
                    headers: { 'Authorization': `Bearer ${accessToken}` }
                }
            );
            
            if (!response.ok) {
                console.warn(`Advisor API returned ${response.status} for subscription ${subscriptionId}`);
                continue;
            }
            
            const data = await response.json();
            const allRecs = data.value || [];
            console.log(`Advisor: Found ${allRecs.length} total recommendations in subscription`);
            
            // Filter for Log Analytics workspace recommendations
            for (const rec of allRecs) {
                if (seenIds.has(rec.id)) continue;
                
                const props = rec.properties || {};
                const resourceId = (props.resourceMetadata?.resourceId || rec.id || '').toLowerCase();
                const impactedValue = (props.impactedValue || '').toLowerCase();
                
                // Check if this recommendation is for one of our workspaces
                const matchesByName = workspaceNames.includes(impactedValue);
                const matchesByResourceId = workspaceResourceIds.some(rid => resourceId.includes(rid) || rid.includes(resourceId));
                const containsWorkspaceName = workspaceNames.some(name => resourceId.includes(`/workspaces/${name}`));
                const isLogAnalytics = resourceId.includes('microsoft.operationalinsights/workspaces');
                
                // Include if it matches our workspace AND is a Cost recommendation
                const isCostCategory = (props.category || '').toLowerCase() === 'cost';
                
                if ((matchesByName || matchesByResourceId || containsWorkspaceName) && isCostCategory) {
                    seenIds.add(rec.id);
                    recommendations.push({
                        id: rec.id,
                        name: rec.name,
                        category: props.category || 'Cost',
                        impact: props.impact || 'Medium',
                        impactedResource: props.impactedValue || extractResourceName(resourceId),
                        resourceId: resourceId,
                        problem: props.shortDescription?.problem || '',
                        solution: props.shortDescription?.solution || '',
                        extendedProperties: props.extendedProperties || {},
                        lastUpdated: props.lastUpdated,
                        resourceGroup: extractResourceGroup(resourceId),
                        savingsAmount: props.extendedProperties?.savingsAmount,
                        savingsCurrency: props.extendedProperties?.savingsCurrency
                    });
                    console.log(`Advisor: ✅ ADDED COST REC - "${impactedValue}": ${props.shortDescription?.problem || rec.name}`);
                } else if (matchesByName || matchesByResourceId || containsWorkspaceName) {
                    console.log(`Advisor: ⏭️ SKIPPED (not Cost category: ${props.category}) - "${impactedValue}": ${props.shortDescription?.problem || rec.name}`);
                }
                // Only include recommendations for the selected workspaces - removed the fallback that was including ALL Log Analytics recommendations
            }
        } catch (error) {
            console.error(`Error fetching Advisor for subscription ${subscriptionId}:`, error);
        }
    }
    
    console.log(`Advisor: Total recommendations found: ${recommendations.length}`);
    return recommendations;
}

function extractResourceName(resourceId) {
    if (!resourceId) return 'Unknown';
    const parts = resourceId.split('/');
    return parts[parts.length - 1] || 'Unknown';
}

function formatAdvisorRecommendations(advisorRecs) {
    if (!advisorRecs || advisorRecs.length === 0) return '';
    
    let output = '\n\n[CARD:info]\n[TITLE]🔮 Azure Advisor Recommendations[/TITLE]\n[IMPACT]Official Azure recommendations[/IMPACT]\n\n';
    output += 'The following recommendations come directly from Azure Advisor:\n\n';
    
    advisorRecs.forEach((rec, i) => {
        const impactIcon = rec.impact === 'High' ? '🔴' : rec.impact === 'Medium' ? '🟡' : '🟢';
        output += `**${i + 1}. ${rec.solution || rec.problem}**\n`;
        output += `   - Resource: ${rec.impactedResource}\n`;
        output += `   - Impact: ${impactIcon} ${rec.impact}\n`;
        output += `   - Category: ${rec.category || 'Cost'}\n`;
        if (rec.problem && rec.problem !== rec.solution) {
            output += `   - Issue: ${rec.problem}\n`;
        }
        output += '\n';
    });
    
    output += '[ACTION]Review these recommendations in the Azure Portal under Advisor → Cost recommendations[/ACTION]\n';
    output += '[DOCS]https://learn.microsoft.com/azure/advisor/advisor-cost-recommendations[/DOCS]\n';
    output += '[/CARD]\n';
    
    return output;
}

// ============ SCHEDULED QUERY RULES (ALERTS) DETECTION ============
// Fetches alert rules to identify tables that are used in alerts (cannot use Basic Logs)
async function fetchScheduledQueryRules(workspaces) {
    const tablesInAlerts = new Set();
    const alertDetails = [];
    
    // Get workspace resource IDs for matching
    const workspaceResourceIds = workspaces.map(ws => ws.resourceId.toLowerCase());
    
    // Get unique subscription IDs from workspaces
    const subscriptionIds = [...new Set(workspaces.map(ws => {
        const match = ws.resourceId.match(/\/subscriptions\/([^\/]+)/);
        return match ? match[1] : null;
    }).filter(Boolean))];
    
    for (const subscriptionId of subscriptionIds) {
        try {
            // Fetch scheduled query rules (log alerts)
            const response = await fetch(
                `https://management.azure.com/subscriptions/${subscriptionId}/providers/Microsoft.Insights/scheduledQueryRules?api-version=2023-03-15-preview`,
                {
                    headers: { 'Authorization': `Bearer ${accessToken}` }
                }
            );
            
            if (!response.ok) {
                console.warn(`ScheduledQueryRules API returned ${response.status}`);
                continue;
            }
            
            const data = await response.json();
            const rules = data.value || [];
            
            for (const rule of rules) {
                const props = rule.properties || {};
                
                // Check if this alert targets one of our workspaces
                const scopes = props.scopes || [];
                const targetWorkspace = scopes.some(scope => 
                    workspaceResourceIds.some(wsId => scope.toLowerCase().includes(wsId) || wsId.includes(scope.toLowerCase()))
                );
                
                if (!targetWorkspace) continue;
                
                // Extract the query and find table names
                const query = props.criteria?.allOf?.[0]?.query || '';
                const tables = extractTablesFromQuery(query);
                
                if (tables.length > 0) {
                    tables.forEach(t => tablesInAlerts.add(t));
                    alertDetails.push({
                        name: rule.name,
                        displayName: props.displayName || rule.name,
                        tables: tables,
                        enabled: props.enabled !== false,
                        severity: props.severity
                    });
                }
            }
        } catch (error) {
            console.error(`Error fetching scheduled query rules:`, error);
        }
    }
    
    console.log(`Alert Detection: Found ${tablesInAlerts.size} tables used in ${alertDetails.length} alert rules`);
    return { tablesInAlerts: Array.from(tablesInAlerts), alertDetails };
}

// ============ DASHBOARD DETECTION ============
// Fetches Azure Dashboards to identify tables used in dashboard tiles (cannot use Basic Logs)
async function fetchDashboardTables(workspaces) {
    const tablesInDashboards = new Set();
    const dashboardDetails = [];
    
    // Get workspace resource IDs for matching
    const workspaceResourceIds = workspaces.map(ws => ws.resourceId.toLowerCase());
    const workspaceIds = workspaces.map(ws => ws.id.toLowerCase()); // customerId
    
    // Get unique subscription IDs from workspaces
    const subscriptionIds = [...new Set(workspaces.map(ws => {
        const match = ws.resourceId.match(/\/subscriptions\/([^\/]+)/);
        return match ? match[1] : null;
    }).filter(Boolean))];
    
    for (const subscriptionId of subscriptionIds) {
        try {
            // Fetch Azure Dashboards
            const response = await fetch(
                `https://management.azure.com/subscriptions/${subscriptionId}/providers/Microsoft.Portal/dashboards?api-version=2020-09-01-preview`,
                {
                    headers: { 'Authorization': `Bearer ${accessToken}` }
                }
            );
            
            if (!response.ok) {
                console.warn(`Dashboards API returned ${response.status}`);
                continue;
            }
            
            const data = await response.json();
            const dashboards = data.value || [];
            
            for (const dashboard of dashboards) {
                const props = dashboard.properties || {};
                const lenses = props.lenses || [];
                const dashboardTables = new Set();
                
                // Parse each lens (dashboard section)
                for (const lens of Object.values(lenses)) {
                    const parts = lens.parts || {};
                    
                    for (const part of Object.values(parts)) {
                        const metadata = part.metadata || {};
                        
                        // Check for Log Analytics query tiles
                        if (metadata.type === 'Extension/Microsoft_OperationsManagementSuite_Workspace/PartType/LogsDashboardPart' ||
                            metadata.type === 'Extension/Microsoft_Azure_Monitoring_Logs/PartType/LogsDashboardPart' ||
                            metadata.type?.includes('LogsDashboardPart') ||
                            metadata.type?.includes('AnalyticsPart')) {
                            
                            // Check if this tile targets one of our workspaces
                            const inputs = metadata.inputs || [];
                            let targetsOurWorkspace = false;
                            let query = '';
                            
                            for (const input of inputs) {
                                if (input.name === 'resourceIds' || input.name === 'workspaceResourceId') {
                                    const resourceIds = Array.isArray(input.value) ? input.value : [input.value];
                                    targetsOurWorkspace = resourceIds.some(rid => 
                                        workspaceResourceIds.some(wsId => 
                                            (rid || '').toLowerCase().includes(wsId) || wsId.includes((rid || '').toLowerCase())
                                        )
                                    );
                                }
                                if (input.name === 'query') {
                                    query = input.value || '';
                                }
                            }
                            
                            // Also check settings object
                            const settings = metadata.settings || {};
                            if (settings.content?.query) {
                                query = settings.content.query;
                            }
                            if (settings.content?.resourceIds) {
                                const resourceIds = settings.content.resourceIds;
                                targetsOurWorkspace = targetsOurWorkspace || resourceIds.some(rid =>
                                    workspaceResourceIds.some(wsId =>
                                        (rid || '').toLowerCase().includes(wsId) || wsId.includes((rid || '').toLowerCase())
                                    )
                                );
                            }
                            
                            if (query && targetsOurWorkspace) {
                                const tables = extractTablesFromQuery(query);
                                tables.forEach(t => {
                                    tablesInDashboards.add(t);
                                    dashboardTables.add(t);
                                });
                            }
                        }
                        
                        // Check for Workbook tiles
                        if (metadata.type?.includes('WorkbookPart')) {
                            // Workbooks are more complex - we note there are workbooks but can't easily parse them
                            console.log('Dashboard contains workbook reference - may have additional table dependencies');
                        }
                    }
                }
                
                if (dashboardTables.size > 0) {
                    dashboardDetails.push({
                        name: dashboard.name,
                        displayName: props.metadata?.name || dashboard.name,
                        tables: Array.from(dashboardTables),
                        resourceGroup: extractResourceGroup(dashboard.id)
                    });
                }
            }
        } catch (error) {
            console.error(`Error fetching dashboards:`, error);
        }
    }
    
    console.log(`Dashboard Detection: Found ${tablesInDashboards.size} tables used in ${dashboardDetails.length} dashboard(s)`);
    return { tablesInDashboards: Array.from(tablesInDashboards), dashboardDetails };
}

// Extract table names from a KQL query
function extractTablesFromQuery(query) {
    if (!query) return [];
    
    const tables = new Set();
    
    // Common patterns to find table names in KQL:
    // 1. Table name at the start of a line or after | 
    // 2. Table name after "from" keyword
    // 3. Union statements
    
    // Known Log Analytics table name patterns
    const tablePatterns = [
        // Start of query or after pipe - table name followed by whitespace, pipe, or newline
        /(?:^|\|)\s*([A-Z][a-zA-Z0-9_]+)\s*(?:\||$|where|project|summarize|extend|join|take|top|limit|order|sort|distinct|count|mv-expand|parse|evaluate)/gim,
        // Union statements
        /union\s+(?:kind\s*=\s*\w+\s+)?([A-Z][a-zA-Z0-9_]+(?:\s*,\s*[A-Z][a-zA-Z0-9_]+)*)/gi,
        // Explicit table() function
        /table\s*\(\s*["']?([A-Z][a-zA-Z0-9_]+)["']?\s*\)/gi,
        // Join clauses
        /join\s+(?:kind\s*=\s*\w+\s+)?([A-Z][a-zA-Z0-9_]+)/gi
    ];
    
    // Known table prefixes
    const knownPrefixes = ['Container', 'App', 'Azure', 'Security', 'Syslog', 'Perf', 'Heartbeat', 'Event', 
                          'Usage', 'AKS', 'Storage', 'AZFW', 'CDB', 'AAD', 'Signin', 'AZM', 'AVS', 'Databricks',
                          'LA', 'Kusto', 'Arc', 'Windows', 'Linux', 'VM', 'SQL', 'Network', 'DNS', 'HTTP'];
    
    tablePatterns.forEach(pattern => {
        let match;
        while ((match = pattern.exec(query)) !== null) {
            const potentialTables = match[1].split(/\s*,\s*/);
            potentialTables.forEach(t => {
                const tableName = t.trim();
                // Filter out KQL keywords and operators
                const keywords = ['where', 'project', 'summarize', 'extend', 'join', 'take', 'top', 'limit', 
                                 'order', 'sort', 'distinct', 'count', 'let', 'set', 'print', 'render',
                                 'ago', 'now', 'datetime', 'timespan', 'true', 'false', 'null', 'and', 'or', 'not'];
                if (tableName && !keywords.includes(tableName.toLowerCase()) && 
                    /^[A-Z][a-zA-Z0-9_]+$/.test(tableName) && tableName.length > 2) {
                    tables.add(tableName);
                }
            });
        }
    });
    
    return Array.from(tables);
}

// Query a workspace using Azure Resource Manager API (works with management token)
async function queryWorkspace(workspace) {
    const results = {};
    
    for (const [queryName, query] of Object.entries(analysisQueries)) {
        try {
            // Use ARM endpoint which accepts management.azure.com token
            const response = await fetch(
                `https://management.azure.com${workspace.resourceId}/query?api-version=2017-10-01`,
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
                const errorText = await response.text();
                // Check if this is a Basic Logs API error (LAQueryLogs configured as Basic Logs)
                if (errorText.includes('UnsupportedApiQueryValidationError') || 
                    errorText.includes('Basic Logs table is not supported')) {
                    console.info(`Query ${queryName}: LAQueryLogs is configured as Basic Logs table, skipping...`);
                    results[queryName] = { basicLogsTable: true, rows: [], columns: [] };
                    continue;
                }
                console.error(`Query ${queryName} failed:`, response.status, errorText);
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
            console.error(`Query ${queryName} error:`, error);
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
        topTables: [],
        frequentlyQueriedTables: [], // Track frequently queried tables
        laQueryLogsEnabled: false // Track if LAQueryLogs is enabled
    };
    
    const tableData = {};
    const tableQueryData = {}; // Aggregate query frequency across workspaces
    
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
        
        // Check if LAQueryLogs is enabled for this workspace
        const laQueryLogsStatus = queryResults.laQueryLogsStatus;
        if (laQueryLogsStatus && laQueryLogsStatus.basicLogsTable) {
            // LAQueryLogs is configured as Basic Logs table - cannot query it
            summary.laQueryLogsBasicLogs = true;
        } else if (laQueryLogsStatus && laQueryLogsStatus.rows && laQueryLogsStatus.rows.length > 0) {
            summary.laQueryLogsEnabled = true;
        }
        
        // Extract table query frequency data from LAQueryLogs
        const queryFreqData = queryResults.tableQueryFrequency;
        if (queryFreqData && queryFreqData.basicLogsTable) {
            // LAQueryLogs is configured as Basic Logs table - cannot query it
            summary.laQueryLogsBasicLogs = true;
        } else if (queryFreqData && queryFreqData.rows && queryFreqData.rows.length > 0) {
            summary.laQueryLogsEnabled = true; // If we got frequency data, it's definitely enabled
            const tableNameIdx = queryFreqData.columns?.indexOf('TableName') ?? 0;
            const queryCountIdx = queryFreqData.columns?.indexOf('QueryCount') ?? 1;
            const usersIdx = queryFreqData.columns?.indexOf('DistinctUsers') ?? 2;
            const avgPerDayIdx = queryFreqData.columns?.indexOf('AvgQueriesPerDay') ?? 3;
            
            queryFreqData.rows.forEach(row => {
                const tableName = row[tableNameIdx];
                const queryCount = parseFloat(row[queryCountIdx]) || 0;
                const distinctUsers = parseFloat(row[usersIdx]) || 0;
                const avgQueriesPerDay = parseFloat(row[avgPerDayIdx]) || 0;
                
                if (!tableQueryData[tableName]) {
                    tableQueryData[tableName] = { queryCount: 0, distinctUsers: 0, avgQueriesPerDay: 0 };
                }
                tableQueryData[tableName].queryCount += queryCount;
                tableQueryData[tableName].distinctUsers = Math.max(tableQueryData[tableName].distinctUsers, distinctUsers);
                tableQueryData[tableName].avgQueriesPerDay += avgQueriesPerDay;
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
    
    // Frequently queried tables
    summary.frequentlyQueriedTables = Object.entries(tableQueryData)
        .map(([tableName, data]) => ({
            tableName,
            queryCount: data.queryCount,
            distinctUsers: data.distinctUsers,
            avgQueriesPerDay: data.avgQueriesPerDay
        }))
        .sort((a, b) => b.queryCount - a.queryCount);
    
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
    
    // Basic Logs Recommendation - only recommend for tables NOT frequently queried or used in alerts
    const debugTables = ['ContainerLogV2', 'AppTraces', 'AzureDiagnostics', 'Syslog'];
    const debugTableData = dataSummary.topTables.filter(t => debugTables.includes(t.name));
    const laQueryLogsEnabled = dataSummary.laQueryLogsEnabled;
    const tablesInAlerts = (dataSummary.tablesInAlerts || []).map(t => t.toLowerCase());
    const alertDetails = dataSummary.alertDetails || [];
    
    // Filter out tables that are frequently queried (not suitable for Basic Logs)
    const frequentlyQueriedTables = dataSummary.frequentlyQueriedTables || [];
    
    // Check if table is used in alerts
    const isTableInAlerts = (tableName) => {
        return tablesInAlerts.some(alertTable => 
            alertTable.toLowerCase() === tableName.toLowerCase() ||
            alertTable.toLowerCase().includes(tableName.toLowerCase()) ||
            tableName.toLowerCase().includes(alertTable.toLowerCase())
        );
    };
    
    // Check if table is used in dashboards
    const tablesInDashboards = (dataSummary.tablesInDashboards || []).map(t => t.toLowerCase());
    const dashboardDetails = dataSummary.dashboardDetails || [];
    
    const isTableInDashboards = (tableName) => {
        return tablesInDashboards.some(dashTable => 
            dashTable.toLowerCase() === tableName.toLowerCase() ||
            dashTable.toLowerCase().includes(tableName.toLowerCase()) ||
            tableName.toLowerCase().includes(dashTable.toLowerCase())
        );
    };
    
    // Tables safe for Basic Logs: not frequently queried AND not used in alerts AND not used in dashboards
    const safeForBasicLogs = debugTableData.filter(t => {
        const queryInfo = frequentlyQueriedTables.find(q => q.tableName.toLowerCase() === t.name.toLowerCase());
        const frequentlyQueried = queryInfo && queryInfo.avgQueriesPerDay >= 5;
        const usedInAlerts = isTableInAlerts(t.name);
        const usedInDashboards = isTableInDashboards(t.name);
        return !frequentlyQueried && !usedInAlerts && !usedInDashboards;
    });
    
    // Tables NOT safe due to frequent queries
    const notSafeForBasicLogs = debugTableData.filter(t => {
        const queryInfo = frequentlyQueriedTables.find(q => q.tableName.toLowerCase() === t.name.toLowerCase());
        return queryInfo && queryInfo.avgQueriesPerDay >= 5;
    });
    
    // Tables NOT safe due to alert usage
    const tablesUsedInAlerts = debugTableData.filter(t => isTableInAlerts(t.name));
    
    // Tables NOT safe due to dashboard usage
    const tablesUsedInDashboards = debugTableData.filter(t => isTableInDashboards(t.name) && !isTableInAlerts(t.name));
    
    // Show warning about tables used in alerts FIRST (highest priority)
    if (tablesUsedInAlerts.length > 0) {
        recommendations += `[CARD:warning]
[TITLE]🚨 Tables Used in Alert Rules - DO NOT Use Basic Logs[/TITLE]
[IMPACT]Would break ${alertDetails.filter(a => a.enabled).length} active alert(s)[/IMPACT]

These tables are used in **scheduled query rules (alerts)** and **cannot** use Basic Logs:

${tablesUsedInAlerts.map(t => {
    const alerts = alertDetails.filter(a => 
        a.tables.some(at => at.toLowerCase() === t.name.toLowerCase())
    );
    const alertNames = alerts.map(a => a.displayName || a.name).slice(0, 3);
    return `- **${t.name}**: ${t.gb.toFixed(2)} GB - Used in: ${alertNames.join(', ')}${alerts.length > 3 ? ` (+${alerts.length - 3} more)` : ''}`;
}).join('\n')}

**Why this matters:**
- Basic Logs cannot be used in alert rules
- Converting these tables would **break your existing alerts**
- Alerts would fail to execute and you'd lose monitoring coverage

[ACTION]Keep these tables on Analytics tier to maintain alert functionality[/ACTION]
[/CARD]

`;
    }
    
    // Show warning about tables used in dashboards
    if (tablesUsedInDashboards.length > 0) {
        recommendations += `[CARD:warning]
[TITLE]📊 Tables Used in Dashboards - DO NOT Use Basic Logs[/TITLE]
[IMPACT]Would break ${dashboardDetails.length} dashboard(s)[/IMPACT]

These tables are used in **Azure Dashboards** and **cannot** use Basic Logs:

${tablesUsedInDashboards.map(t => {
    const dashboards = dashboardDetails.filter(d => 
        d.tables.some(dt => dt.toLowerCase() === t.name.toLowerCase())
    );
    const dashNames = dashboards.map(d => d.displayName || d.name).slice(0, 3);
    return `- **${t.name}**: ${t.gb.toFixed(2)} GB - Used in: ${dashNames.join(', ')}${dashboards.length > 3 ? ` (+${dashboards.length - 3} more)` : ''}`;
}).join('\n')}

**Why this matters:**
- Basic Logs cannot be used in dashboard tiles
- Converting these tables would **break your dashboards**
- Dashboard queries would fail to return data

[ACTION]Keep these tables on Analytics tier to maintain dashboard functionality[/ACTION]
[/CARD]

`;
    }
    
    // Show warning if LAQueryLogs is configured as Basic Logs (can't query it)
    if (summary.laQueryLogsBasicLogs && debugTableData.length > 0) {
        const tablesNotBlocked = debugTableData.filter(t => !isTableInAlerts(t.name) && !isTableInDashboards(t.name));
        if (tablesNotBlocked.length > 0) {
            const totalDebugGB = tablesNotBlocked.reduce((sum, t) => sum + t.gb, 0);
            const potentialSavings = totalDebugGB * 2.76 * 0.5;
            
            recommendations += `[CARD:warning]
[TITLE]⚠️ LAQueryLogs is Configured as Basic Logs[/TITLE]
[IMPACT]Potential ~$${potentialSavings.toFixed(2)}/month savings[/IMPACT]

**LAQueryLogs is set to Basic Logs plan** - Cannot query it to determine table usage patterns.

Basic Logs candidates found (but need query frequency check):
${tablesNotBlocked.map(t => `- **${t.name}**: ${t.gb.toFixed(2)} GB`).join('\n')}

**Why this matters:**
- LAQueryLogs tracks which tables are being queried
- When LAQueryLogs itself is Basic Logs, we can't query it via standard API
- Cannot determine if these tables are actively queried

**Recommendation:**
Consider changing LAQueryLogs back to Analytics plan to enable query auditing,
or accept that these tables may be safe for Basic Logs based on dashboard/alert checks only.

[ACTION]Review LAQueryLogs table configuration in workspace[/ACTION]
[DOCS]https://learn.microsoft.com/azure/azure-monitor/logs/basic-logs-configure[/DOCS]
[/CARD]

`;
        }
    }
    // Show warning if LAQueryLogs is not enabled
    else if (!laQueryLogsEnabled && debugTableData.length > 0) {
        const tablesNotBlocked = debugTableData.filter(t => !isTableInAlerts(t.name) && !isTableInDashboards(t.name));
        if (tablesNotBlocked.length > 0) {
            const totalDebugGB = tablesNotBlocked.reduce((sum, t) => sum + t.gb, 0);
            const potentialSavings = totalDebugGB * 2.76 * 0.5;
            
            recommendations += `[CARD:warning]
[TITLE]⚠️ Enable LAQueryLogs for Accurate Basic Logs Analysis[/TITLE]
[IMPACT]Potential ~$${potentialSavings.toFixed(2)}/month savings[/IMPACT]

**LAQueryLogs is not enabled** - Cannot determine which tables are actively queried.

Basic Logs candidates found (but need query frequency check):
${tablesNotBlocked.map(t => `- **${t.name}**: ${t.gb.toFixed(2)} GB`).join('\n')}

**Why this matters:**
- Basic Logs tables cost ~50% less but have query limitations
- Tables used in dashboards, alerts, or frequently queried should NOT use Basic Logs
- Without LAQueryLogs, we can't tell if these tables are actively used

**To enable LAQueryLogs:**
1. Go to your Log Analytics workspace
2. Diagnostic settings → Add diagnostic setting
3. Enable "Query Audit" category → Send to same workspace

After enabling, re-run this analysis in 7+ days for accurate recommendations.

[ACTION]Enable LAQueryLogs diagnostic setting in each workspace[/ACTION]
[DOCS]https://learn.microsoft.com/azure/azure-monitor/logs/query-audit[/DOCS]
[/CARD]

`;
        }
    } else if (safeForBasicLogs.length > 0) {
        const debugGB = safeForBasicLogs.reduce((sum, t) => sum + t.gb, 0);
        const savings = debugGB * 2.76 * 0.5; // Basic logs are ~50% cheaper
        
        // Split into custom tables (eligible for Auxiliary) and Azure tables (Basic only)
        const customTables = safeForBasicLogs.filter(t => t.name.endsWith('_CL'));
        const azureTables = safeForBasicLogs.filter(t => !t.name.endsWith('_CL'));
        
        // Check for very rarely queried custom tables (candidates for Auxiliary)
        const auxiliaryCandidates = customTables.filter(t => {
            const queryInfo = frequentlyQueriedTables.find(q => q.tableName.toLowerCase() === t.name.toLowerCase());
            // Auxiliary is for tables queried less than 1 time per day on average
            return !queryInfo || queryInfo.avgQueriesPerDay < 1;
        });
        
        const basicOnlyCustomTables = customTables.filter(t => !auxiliaryCandidates.includes(t));
        
        // Recommend Auxiliary Logs for eligible custom tables
        if (auxiliaryCandidates.length > 0) {
            const auxGB = auxiliaryCandidates.reduce((sum, t) => sum + t.gb, 0);
            const auxSavings = auxGB * 2.76 * 0.85; // Auxiliary is ~85% cheaper
            
            recommendations += `[CARD:savings]
[TITLE]💰 Auxiliary Logs Opportunity - Maximum Savings[/TITLE]
[IMPACT]Save ~$${auxSavings.toFixed(2)}/month (85% reduction)[/IMPACT]

These **custom tables** are candidates for **Auxiliary Logs** (cheapest option):

${auxiliaryCandidates.map(t => `- **${t.name}**: ${t.gb.toFixed(2)} GB`).join('\n')}

**Why Auxiliary Logs?**
- Custom tables (_CL) support Auxiliary plan
- Rarely queried (< 1 query/day avg)
- Not used in alerts or dashboards
- Perfect for: auditing, compliance, verbose troubleshooting

**Auxiliary Logs limitations:**
- No alerts (not even Simple Log Alerts)
- Slower queries - not for real-time analysis
- No restore capability
- No data export
- Query cost of ~$0.006/GB when you do query

**Cost comparison for ${auxGB.toFixed(2)} GB:**
- Analytics: ~$${(auxGB * 2.76).toFixed(2)}/month
- Basic: ~$${(auxGB * 2.76 * 0.5).toFixed(2)}/month (50% savings)
- Auxiliary: ~$${(auxGB * 2.76 * 0.15).toFixed(2)}/month (85% savings) ✅

[ACTION]Configure Auxiliary Logs plan for these custom tables in Log Analytics workspace[/ACTION]
[DOCS]https://learn.microsoft.com/azure/azure-monitor/logs/logs-table-plans[/DOCS]
[/CARD]

`;
        }
        
        // Recommend Basic Logs for remaining tables (Azure tables + more frequently queried custom tables)
        const basicCandidates = [...azureTables, ...basicOnlyCustomTables];
        if (basicCandidates.length > 0) {
            const basicGB = basicCandidates.reduce((sum, t) => sum + t.gb, 0);
            const basicSavings = basicGB * 2.76 * 0.5;
            
            recommendations += `[CARD:savings]
[TITLE]💡 Basic Logs Opportunity[/TITLE]
[IMPACT]Save ~$${basicSavings.toFixed(2)}/month[/IMPACT]

These tables are candidates for Basic Logs (lower cost, limited query):

${basicCandidates.map(t => `- **${t.name}**: ${t.gb.toFixed(2)} GB`).join('\n')}

**Important:** Basic Logs have limitations:
- Cannot be used in dashboards, workbooks, or alert rules
- Limited KQL query operators
- Query cost of ~$0.006/GB scanned
- 8-day interactive retention only

✅ These tables are **safe to convert**:
- Not used in any detected alert rules
- Not used in any detected Azure Dashboards
- Infrequently queried (based on LAQueryLogs)

[ACTION]Configure Basic Logs for debug/verbose tables in Log Analytics workspace settings[/ACTION]
[DOCS]https://learn.microsoft.com/azure/azure-monitor/logs/basic-logs-configure[/DOCS]
[/CARD]

`;
        }
    }
    
    // Warn about tables that look like Basic Logs candidates but are frequently queried (and not already blocked by alerts/dashboards)
    const notSafeOnlyDueToQueries = notSafeForBasicLogs.filter(t => !isTableInAlerts(t.name) && !isTableInDashboards(t.name));
    if (notSafeOnlyDueToQueries.length > 0) {
        recommendations += `[CARD:warning]
[TITLE]⚠️ Frequently Queried Tables - Not Recommended for Basic Logs[/TITLE]

These tables are eligible for Basic Logs but are **frequently queried**:

${notSafeOnlyDueToQueries.map(t => {
    const queryInfo = frequentlyQueriedTables.find(q => q.tableName.toLowerCase() === t.name.toLowerCase());
    const avgQueries = queryInfo ? queryInfo.avgQueriesPerDay.toFixed(1) : 'N/A';
    return `- **${t.name}**: ${t.gb.toFixed(2)} GB (~${avgQueries} queries/day)`;
}).join('\n')}

Basic Logs are **not recommended** because:
- These tables are actively used (dashboards, alerts, or ad-hoc queries)
- Query costs would likely exceed ingestion savings
- Dashboards and alerts cannot use Basic Logs tables

[ACTION]Review who is querying these tables and why before considering Basic Logs[/ACTION]
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
    const monthlyCost = (dataSummary.totalIngestionGB * 2.76).toFixed(2);
    
    // Build detailed workspace summary by RG
    let wsDetails = '<div class="workspace-summary">';
    wsDetails += '<h4 style="margin: 12px 0 8px 0; color: #667;">Analyzed Workspaces:</h4>';
    for (const [rgName, rgData] of Object.entries(dataSummary.byResourceGroup)) {
        wsDetails += `<div class="rg-group" style="margin-bottom: 8px;">`;
        wsDetails += `<div style="font-weight: 600; color: #5e5e5e;">📁 ${rgName}</div>`;
        wsDetails += `<div style="margin-left: 20px;">`;
        rgData.workspaces.forEach(ws => {
            const wsCost = (ws.gb * 2.76).toFixed(2);
            wsDetails += `<div class="ws-detail" style="display: flex; justify-content: space-between; padding: 2px 0;">`;
            wsDetails += `<span>• ${ws.name}</span>`;
            wsDetails += `<span style="color: #666;">${ws.gb.toFixed(2)} GB (~$${wsCost})</span>`;
            wsDetails += `</div>`;
        });
        wsDetails += `</div></div>`;
    }
    wsDetails += '</div>';
    
    resourceInfo.innerHTML = `
        <div class="info-item"><span class="label">📊 Total Ingestion:</span> <span class="value" style="font-size: 1.1em; font-weight: 600;">${totalGB} GB/month (~$${monthlyCost})</span></div>
        <div class="info-item"><span class="label">🔍 Workspaces Analyzed:</span> <span class="value">${dataSummary.workspacesWithData} of ${dataSummary.totalWorkspaces}</span></div>
        ${wsDetails}
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
    // Remove --- separators
    text = text.replace(/^---$/gm, '');
    text = text.replace(/\n{3,}/g, '\n\n');
    
    // Fix inline numbered lists (e.g., "1. foo 2. bar 3. baz" -> separate lines)
    text = text.replace(/(\d+)\.\s+([^0-9]+?)(?=\s+\d+\.\s|$)/g, '\n$1. $2\n');
    
    // Process recommendation sections (using top border instead of left to prevent stacking)
    text = text.replace(/\[CARD:(warning|savings|info|success)\]([\s\S]*?)\[\/CARD\]/g, (match, type, content) => {
        const colors = {
            warning: '#ff9800',
            savings: '#4caf50',
            info: '#2196f3',
            success: '#00bcd4'
        };
        const bgColors = {
            warning: '#fff8e1',
            savings: '#e8f5e9',
            info: '#e3f2fd',
            success: '#e0f7fa'
        };
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
        
        body = body.replace(/\[TITLE\]([\s\S]*?)\[\/TITLE\]/g, (m, t) => { 
            title = t.trim().replace(/\n+/g, ' ').replace(/\s+/g, ' ');
            title = title.replace(/^[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1F600}-\u{1F64F}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2702}-\u{27B0}\u{24C2}-\u{1F251}✅⚠️💡💰🚨📊🔍🗄️ℹ️]+\s*/gu, '');
            return ''; 
        });
        body = body.replace(/\[IMPACT\]([\s\S]*?)\[\/IMPACT\]/g, (m, i) => { impact = i.trim(); return ''; });
        body = body.replace(/\[ACTION\]([\s\S]*?)\[\/ACTION\]/g, (m, a) => { action = a.trim(); return ''; });
        body = body.replace(/\[DOCS\]([\s\S]*?)\[\/DOCS\]/g, (m, d) => { docs = d.trim(); return ''; });
        
        body = body.trim();
        
        // Build section with TOP border and background color - no left border
        let html = `</p><div style="border-top: 4px solid ${colors[type]}; background: ${bgColors[type]}; padding: 20px; margin: 30px 0; border-radius: 8px;">`;
        html += `<h3 style="margin: 0 0 12px 0; font-size: 1.1rem; color: #333; display: flex; align-items: center; flex-wrap: wrap; gap: 10px;">${icons[type]} ${title || 'Recommendation'}`;
        if (impact) html += ` <span style="background: ${colors[type]}; color: white; padding: 3px 12px; border-radius: 12px; font-size: 0.8rem; font-weight: 600;">${impact}</span>`;
        html += `</h3>`;
        if (body) html += `<div style="color: #444; line-height: 1.7;">${formatCardBody(body)}</div>`;
        if (action) html += `<div style="background: rgba(255,255,255,0.7); padding: 12px 16px; border-radius: 6px; margin-top: 16px; font-size: 0.95rem;"><strong>📋 Action:</strong> ${action}</div>`;
        if (docs) html += `<div style="margin-top: 12px;"><a href="${docs}" target="_blank" style="color: #0078d4; text-decoration: none; font-weight: 500;">📖 Documentation →</a></div>`;
        html += `</div><p>`;
        
        return html;
    });
    
    // Handle any [ACTION] tags outside of cards
    text = text.replace(/\[ACTION\]([^\[]+)/g, '<div class="standalone-action"><strong>📋 Action:</strong> $1</div>');
    
    // Handle any [DOCS] tags outside of cards - convert to clickable link
    // Support both [DOCS]url[/DOCS] and markdown-style [DOCS](url) formats
    text = text.replace(/\[DOCS\]\((https?:\/\/[^)]+)\)/g, '<a href="$1" target="_blank" class="inline-docs-link">📖 Documentation</a>');
    text = text.replace(/\[DOCS\](https?:\/\/[^\s\[]+)\[\/DOCS\]/g, '<a href="$1" target="_blank" class="inline-docs-link">📖 Documentation</a>');
    text = text.replace(/\[DOCS\](https?:\/\/[^\s\[]+)/g, '<a href="$1" target="_blank" class="inline-docs-link">📖 Documentation</a>');
    
    // Clean up any remaining empty lines
    text = text.replace(/\n\s*\n\s*\n/g, '\n\n');
    
    // Clean up any unmatched card tags
    text = text.replace(/\[CARD:[^\]]*\]/g, '');
    text = text.replace(/\[\/CARD\]/g, '');
    text = text.replace(/\[TITLE\][^\[]*\[\/TITLE\]/g, '');
    text = text.replace(/\[IMPACT\][^\[]*\[\/IMPACT\]/g, '');
    
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
    
    // Numbered lists (1. 2. 3.)
    text = text.replace(/^(\d+)\.\s+(.+)$/gm, '<li value="$1">$2</li>');
    text = text.replace(/(<li value="\d+">[^<]*<\/li>\s*)+/g, '<ol>$&</ol>');
    
    // Bullet lists
    text = text.replace(/^- (.+)$/gm, '<li>$1</li>');
    text = text.replace(/(<li>(?!value)[^<]*<\/li>\s*)+/g, match => {
        // Only wrap in <ul> if not already in <ol>
        if (!match.includes('value=')) return `<ul>${match}</ul>`;
        return match;
    });
    
    // Line breaks - convert remaining plain text lines to paragraphs
    text = text.split('\n').map(line => {
        line = line.trim();
        if (!line || line.startsWith('<') || line.match(/^<\/(ol|ul|li|p|table)/)) return line;
        return `<p>${line}</p>`;
    }).join('');
    
    // Clean up empty paragraphs
    text = text.replace(/<p>\s*<\/p>/g, '');
    
    return text;
}

// Copy recommendations to clipboard
function copyRecommendations() {
    const content = document.getElementById('recommendationsContent');
    if (!content) {
        console.error('recommendationsContent element not found');
        return;
    }
    const text = content.innerText;
    
    // Try modern clipboard API first, fall back to legacy method
    if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(() => {
            showCopySuccess('copyBtn');
        }).catch(err => {
            console.error('Clipboard API failed:', err);
            fallbackCopy(text, 'copyBtn');
        });
    } else {
        fallbackCopy(text, 'copyBtn');
    }
}

// Fallback copy method for older browsers or non-HTTPS
function fallbackCopy(text, btnId) {
    const textArea = document.createElement('textarea');
    textArea.value = text;
    textArea.style.position = 'fixed';
    textArea.style.left = '-9999px';
    textArea.style.top = '-9999px';
    document.body.appendChild(textArea);
    textArea.focus();
    textArea.select();
    
    try {
        const successful = document.execCommand('copy');
        if (successful) {
            showCopySuccess(btnId);
        } else {
            alert('Copy failed. Please select the text manually and copy.');
        }
    } catch (err) {
        console.error('Fallback copy failed:', err);
        alert('Copy failed. Please select the text manually and copy.');
    }
    
    document.body.removeChild(textArea);
}

// Show copy success feedback
function showCopySuccess(btnId) {
    const btn = document.getElementById(btnId);
    if (!btn) return;
    
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
}

// New analysis
function newAnalysis() {
    recommendationsSection.hidden = true;
    inputSection.hidden = false;
}

// Show error message - displays inline error instead of alert
function showError(message) {
    console.error('Error:', message);
    
    // Try to show error near the token input if on auth page
    const tokenInput = document.getElementById('tokenInput');
    if (tokenInput) {
        // Remove any existing error
        const existingError = document.querySelector('.auth-error');
        if (existingError) existingError.remove();
        
        // Create error element
        const errorDiv = document.createElement('div');
        errorDiv.className = 'auth-error';
        errorDiv.innerHTML = `⚠️ ${message}`;
        errorDiv.style.cssText = 'background: #fee; color: #c00; padding: 12px 16px; border-radius: 8px; margin: 10px 0; border: 1px solid #fcc; font-weight: 500;';
        
        // Insert after token input
        tokenInput.parentNode.insertBefore(errorDiv, tokenInput.nextSibling);
        
        // Auto-remove after 10 seconds
        setTimeout(() => errorDiv.remove(), 10000);
        
        // Shake the input
        tokenInput.style.animation = 'shake 0.5s';
        setTimeout(() => tokenInput.style.animation = '', 500);
        
        return;
    }
    
    // Fallback to alert
    alert(message);
}
// ============ DARK MODE ============
(function initializeDarkMode() {
    const savedTheme = localStorage.getItem('theme');
    if (savedTheme === 'dark') {
        document.body.classList.add('dark-mode');
        updateThemeToggle(true);
    }
    const themeToggle = document.getElementById('themeToggle');
    if (themeToggle) {
        themeToggle.addEventListener('click', toggleDarkMode);
    }
})();

function toggleDarkMode() {
    document.body.classList.toggle('dark-mode');
    const isDark = document.body.classList.contains('dark-mode');
    localStorage.setItem('theme', isDark ? 'dark' : 'light');
    updateThemeToggle(isDark);
}

function updateThemeToggle(isDark) {
    const toggleBtn = document.getElementById('themeToggle');
    if (toggleBtn) toggleBtn.classList.toggle('dark', isDark);
}

// ============ MARKDOWN EXPORT ============
function copyRecommendationsAsMarkdown() {
    const content = document.getElementById('recommendationsContent');
    let markdown = '# Azure Monitor Cost Optimization Analysis\n\n';
    
    const resourceInfo = document.getElementById('resourceInfo');
    if (resourceInfo) {
        markdown += resourceInfo.innerText + '\n\n---\n\n';
    }
    
    const cards = content.querySelectorAll('.rec-card');
    cards.forEach(card => {
        const icon = card.querySelector('.rec-card-icon')?.textContent || '';
        const title = card.querySelector('.rec-card-title')?.textContent || '';
        const impact = card.querySelector('.rec-card-impact')?.textContent || '';
        const body = card.querySelector('.rec-card-body');
        const action = card.querySelector('.rec-card-action');
        
        markdown += `## ${icon} ${title}\n\n`;
        if (impact) markdown += `**${impact}**\n\n`;
        if (body) markdown += body.innerText + '\n\n';
        if (action) markdown += `### 📋 Action\n\n${action.textContent.replace('📋 Action:', '').trim()}\n\n`;
        markdown += '---\n\n';
    });
    
    // Use the same robust copy method
    if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(markdown).then(() => {
            showMarkdownCopySuccess();
        }).catch(err => {
            console.error('Clipboard API failed:', err);
            fallbackCopyMarkdown(markdown);
        });
    } else {
        fallbackCopyMarkdown(markdown);
    }
}

function fallbackCopyMarkdown(text) {
    const textArea = document.createElement('textarea');
    textArea.value = text;
    textArea.style.position = 'fixed';
    textArea.style.left = '-9999px';
    textArea.style.top = '-9999px';
    document.body.appendChild(textArea);
    textArea.focus();
    textArea.select();
    
    try {
        const successful = document.execCommand('copy');
        if (successful) {
            showMarkdownCopySuccess();
        } else {
            alert('Copy failed. Please select the text manually and copy.');
        }
    } catch (err) {
        console.error('Fallback copy failed:', err);
        alert('Copy failed. Please select the text manually and copy.');
    }
    
    document.body.removeChild(textArea);
}

function showMarkdownCopySuccess() {
    const btn = document.getElementById('copyMarkdownBtn');
    if (btn) {
        const orig = btn.innerHTML;
        btn.innerHTML = `
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <polyline points="20 6 9 17 4 12"></polyline>
            </svg>
            Copied!
        `;
        setTimeout(() => btn.innerHTML = orig, 2000);
    }
}

// ============ CHECKLIST TRACKER ============
let currentChecklistId = null;

function generateChecklistFromRecommendations() {
    const cards = document.querySelectorAll('.rec-card-savings, .rec-card-warning');
    return Array.from(cards).map((card, i) => ({
        id: `item_${Date.now()}_${i}`,
        icon: card.querySelector('.rec-card-icon')?.textContent || '',
        title: card.querySelector('.rec-card-title')?.textContent || '',
        impact: card.querySelector('.rec-card-impact')?.textContent || '',
        description: card.querySelector('.rec-card-action')?.textContent?.replace('📋 Action:', '').trim() || '',
        completed: false
    })).filter(item => item.title && item.description);
}

function displayChecklist(items) {
    const tracker = document.getElementById('checklistTracker');
    if (!items?.length || !tracker) return tracker && (tracker.hidden = true);
    
    const container = document.getElementById('checklistItems');
    if (!container) return;
    
    container.innerHTML = items.map(item => `
        <div class="checklist-item ${item.completed ? 'completed' : ''}" data-item-id="${item.id}">
            <input type="checkbox" class="checklist-checkbox" ${item.completed ? 'checked' : ''}>
            <div class="checklist-item-content">
                <div class="checklist-item-title">${item.icon} ${item.title}</div>
                <div class="checklist-item-description">${item.description}</div>
                ${item.impact ? `<span class="checklist-item-impact">${item.impact}</span>` : ''}
            </div>
        </div>
    `).join('');
    
    container.querySelectorAll('.checklist-item').forEach(div => {
        const cb = div.querySelector('.checklist-checkbox');
        cb.addEventListener('change', () => toggleChecklistItem(div.dataset.itemId));
        div.addEventListener('click', e => { if (e.target !== cb) { cb.checked = !cb.checked; toggleChecklistItem(div.dataset.itemId); }});
    });
    
    updateChecklistProgress(items);
    tracker.hidden = false;
}

function toggleChecklistItem(id) {
    const cl = getChecklistFromStorage();
    if (!cl) return;
    const item = cl.items.find(i => i.id === id);
    if (item) {
        item.completed = !item.completed;
        saveChecklistToStorage(cl);
        document.querySelector(`[data-item-id="${id}"]`)?.classList.toggle('completed', item.completed);
        updateChecklistProgress(cl.items);
    }
}

function updateChecklistProgress(items) {
    const total = items.length;
    const done = items.filter(i => i.completed).length;
    const pct = total > 0 ? Math.round((done / total) * 100) : 0;
    const bar = document.getElementById('checklistProgressBar');
    const text = document.getElementById('checklistProgressText');
    if (bar) bar.style.width = `${pct}%`;
    if (text) text.textContent = `${done} of ${total} completed (${pct}%)`;
}

function saveChecklistToStorage(cl) {
    localStorage.setItem(`checklist_${currentChecklistId}`, JSON.stringify(cl));
}

function getChecklistFromStorage() {
    if (!currentChecklistId) return null;
    const s = localStorage.getItem(`checklist_${currentChecklistId}`);
    return s ? JSON.parse(s) : null;
}

function resetChecklist() {
    if (!currentChecklistId || !confirm('Reset checklist?')) return;
    localStorage.removeItem(`checklist_${currentChecklistId}`);
    const items = generateChecklistFromRecommendations();
    saveChecklistToStorage({ id: currentChecklistId, items, createdAt: Date.now() });
    displayChecklist(items);
}

// ============ SAVINGS COUNTER ============
function displaySavingsCounter() {
    const cards = document.querySelectorAll('.rec-card-savings');
    const counter = document.getElementById('savingsCounter');
    if (!cards.length || !counter) return counter && (counter.hidden = true);
    
    let total = 0;
    cards.forEach(card => {
        const m = card.querySelector('.rec-card-impact')?.textContent?.match(/\$[\d,]+\.?\d*/);
        if (m) total += parseFloat(m[0].replace(/[$,]/g, '')) || 0;
    });
    
    if (total > 0) {
        animateSavingsCounter(total);
        counter.hidden = false;
    }
}

function animateSavingsCounter(target) {
    const el = document.getElementById('savingsAmount');
    if (!el) return;
    let curr = 0;
    const steps = 30, inc = target / steps;
    const timer = setInterval(() => {
        curr += inc;
        if (curr >= target) { curr = target; clearInterval(timer); }
        el.textContent = `$${curr.toFixed(2)}`;
    }, 33);
}

// ============ ENHANCE showRecommendations ============
const _origShowRecs = showRecommendations;
showRecommendations = function(recs, ws, data) {
    _origShowRecs(recs, ws, data);
    setTimeout(() => {
        currentChecklistId = `analysis_${Date.now()}`;
        const items = generateChecklistFromRecommendations();
        saveChecklistToStorage({ id: currentChecklistId, items, createdAt: Date.now() });
        displayChecklist(items);
        displaySavingsCounter();
    }, 100);
};

// ============ EXPOSE FUNCTIONS TO WINDOW FOR ONCLICK HANDLERS ============
// These functions need to be globally accessible for inline onclick handlers
window.signOut = signOut;
window.filterSubscriptions = filterSubscriptions;
window.loadWorkspaces = loadWorkspaces;
window.selectAllWorkspaces = selectAllWorkspaces;
window.deselectAllWorkspaces = deselectAllWorkspaces;
window.expandAllGroups = expandAllGroups;
window.collapseAllGroups = collapseAllGroups;
window.saveAISettings = saveAISettings;
window.copyRecommendations = copyRecommendations;
window.copyRecommendationsAsMarkdown = copyRecommendationsAsMarkdown;
window.resetChecklist = resetChecklist;
window.newAnalysis = newAnalysis;
window.runAnalysis = runAnalysis;
window.filterWorkspaces = filterWorkspaces;