// Azure Monitor Cost Optimizer - Backend Server
// Uses Azure CLI credentials to query Log Analytics

const express = require('express');
const cors = require('cors');
const path = require('path');
require('dotenv').config();

const { AzureCliCredential } = require('@azure/identity');
const { SubscriptionClient } = require('@azure/arm-subscriptions');
const { OperationalInsightsManagementClient } = require('@azure/arm-operationalinsights');
const { LogsQueryClient } = require('@azure/monitor-query');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Azure OpenAI Configuration
const AZURE_OPENAI_CONFIG = {
    model1: {
        endpoint: process.env.AZURE_OPENAI_ENDPOINT,
        apiKey: process.env.AZURE_OPENAI_KEY,
        deployment: process.env.AZURE_OPENAI_DEPLOYMENT || 'gpt-4',
        apiVersion: process.env.AZURE_OPENAI_API_VERSION || '2024-12-01-preview'
    },
    model2: {
        endpoint: process.env.AZURE_OPENAI_ENDPOINT_2,
        apiKey: process.env.AZURE_OPENAI_KEY_2,
        deployment: process.env.AZURE_OPENAI_DEPLOYMENT_2 || 'gpt-4',
        apiVersion: process.env.AZURE_OPENAI_API_VERSION_2 || '2024-12-01-preview'
    }
};

// Azure credential - uses Azure CLI
let credential = null;
let logsQueryClient = null;

// Initialize Azure credentials
async function initializeAzure() {
    try {
        // Use Azure CLI credential (from 'az login')
        credential = new AzureCliCredential();
        logsQueryClient = new LogsQueryClient(credential);
        console.log('✅ Azure CLI credentials initialized');
        return true;
    } catch (error) {
        console.error('❌ Failed to initialize Azure credentials:', error.message);
        console.log('Please run "az login" to authenticate');
        return false;
    }
}

// Get list of subscriptions
app.get('/api/subscriptions', async (req, res) => {
    try {
        if (!credential) {
            return res.status(401).json({ error: 'Not authenticated. Please run "az login"' });
        }

        const subscriptionClient = new SubscriptionClient(credential);
        const subscriptions = [];
        
        for await (const sub of subscriptionClient.subscriptions.list()) {
            subscriptions.push({
                id: sub.subscriptionId,
                name: sub.displayName,
                state: sub.state
            });
        }

        res.json(subscriptions);
    } catch (error) {
        console.error('Error fetching subscriptions:', error);
        res.status(500).json({ error: error.message });
    }
});

// Get workspaces for a subscription
app.get('/api/subscriptions/:subscriptionId/workspaces', async (req, res) => {
    try {
        if (!credential) {
            return res.status(401).json({ error: 'Not authenticated. Please run "az login"' });
        }

        const { subscriptionId } = req.params;
        const opsClient = new OperationalInsightsManagementClient(credential, subscriptionId);
        const workspaces = [];

        for await (const ws of opsClient.workspaces.list()) {
            workspaces.push({
                id: ws.customerId, // This is the Workspace ID used for queries
                name: ws.name,
                resourceId: ws.id,
                location: ws.location,
                sku: ws.sku?.name,
                retentionDays: ws.retentionInDays
            });
        }

        res.json(workspaces);
    } catch (error) {
        console.error('Error fetching workspaces:', error);
        res.status(500).json({ error: error.message });
    }
});

// Run KQL queries against a workspace
app.post('/api/query', async (req, res) => {
    try {
        if (!logsQueryClient) {
            return res.status(401).json({ error: 'Not authenticated. Please run "az login"' });
        }

        const { workspaceId, queries } = req.body;
        
        if (!workspaceId || !queries) {
            return res.status(400).json({ error: 'workspaceId and queries are required' });
        }

        const results = {};
        const timespan = { duration: 'P30D' }; // Last 30 days

        for (const [name, query] of Object.entries(queries)) {
            try {
                console.log(`Running query: ${name}`);
                const result = await logsQueryClient.queryWorkspace(workspaceId, query, timespan);
                
                if (result.status === 'Success' || result.status === 'PartialFailure') {
                    const table = result.tables[0];
                    if (table) {
                        results[name] = {
                            columns: table.columnDescriptors.map(c => c.name),
                            rows: table.rows
                        };
                    } else {
                        results[name] = { columns: [], rows: [] };
                    }
                } else {
                    results[name] = { error: 'Query failed', status: result.status };
                }
            } catch (queryError) {
                console.error(`Query ${name} failed:`, queryError.message);
                results[name] = { error: queryError.message };
            }
        }

        res.json(results);
    } catch (error) {
        console.error('Error running queries:', error);
        res.status(500).json({ error: error.message });
    }
});

// Get AI recommendations
app.post('/api/recommendations', async (req, res) => {
    try {
        const { workspaceName, workspaceConfig, analysisData, context } = req.body;

        const config = AZURE_OPENAI_CONFIG.model1;

        if (!config.endpoint || !config.apiKey) {
            return res.status(500).json({ error: 'AI model is not configured' });
        }

        const url = `${config.endpoint}/openai/deployments/${config.deployment}/chat/completions?api-version=${config.apiVersion}`;
        
        // Truncate analysis data if too large (to avoid rate limits)
        let truncatedAnalysisData = analysisData;
        if (analysisData && analysisData.length > 50000) {
            console.log(`Analysis data too large (${analysisData.length} chars), truncating...`);
            truncatedAnalysisData = analysisData.substring(0, 50000) + '\n\n... [Data truncated due to size]';
        }
        
        const userPrompt = buildUserPrompt(workspaceName, workspaceConfig, truncatedAnalysisData, context);
        console.log(`Sending prompt with ${userPrompt.length} characters`);

        const requestBody = {
            messages: [
                { role: "system", content: getSystemPrompt() },
                { role: "user", content: userPrompt }
            ],
            max_tokens: 4000,
            temperature: 0.7,
            top_p: 0.95
        };

        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'api-key': config.apiKey
            },
            body: JSON.stringify(requestBody)
        });

        if (!response.ok) {
            const errorText = await response.text();
            console.error('Azure OpenAI API error:', response.status, errorText);
            
            // Parse error for better message
            let errorMessage = `API request failed: ${response.status}`;
            try {
                const errorJson = JSON.parse(errorText);
                if (errorJson.error?.message) {
                    if (response.status === 429) {
                        errorMessage = 'Rate limit exceeded. Please wait 60 seconds and try again, or select fewer workspaces.';
                    } else {
                        errorMessage = errorJson.error.message;
                    }
                }
            } catch (e) {}
            
            return res.status(response.status).json({ error: errorMessage });
        }

        const data = await response.json();
        res.json({ recommendations: data.choices[0].message.content });

    } catch (error) {
        console.error('Error getting recommendations:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Health check
app.get('/api/health', async (req, res) => {
    let azureAuthenticated = false;
    
    if (credential) {
        try {
            // Try to get a token to verify credentials are valid
            await credential.getToken('https://management.azure.com/.default');
            azureAuthenticated = true;
        } catch (e) {
            azureAuthenticated = false;
        }
    }
    
    res.json({
        status: 'healthy',
        azureAuthenticated,
        models: {
            model1: !!AZURE_OPENAI_CONFIG.model1.apiKey,
            model2: !!AZURE_OPENAI_CONFIG.model2.apiKey
        }
    });
});

// Serve frontend
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// System prompt for AI
function getSystemPrompt() {
    return `You are an Azure Monitor Cost Optimization expert. Analyze the data and provide actionable recommendations.

KEY COST OPTIMIZATION AREAS TO CHECK:
1. **Basic Logs Migration** - Tables like Perf, ContainerInventory, Syslog, ContainerLog can often move to Basic Logs (~$0.50/GB vs ~$2.76/GB for Analytics). ALWAYS calculate specific savings.
2. **Excessive Heartbeat** - If heartbeats > 60/hour, recommend reducing frequency
3. **Commitment Tiers** - Only mention if ingestion > 100 GB/month
4. **Duplicate Data** - Only if actually detected

OUTPUT FORMAT - You MUST use this exact card structure:

[CARD:savings]
[TITLE]Move High-Volume Tables to Basic Logs[/TITLE]
[IMPACT]$XX.XX/month savings[/IMPACT]
Explanation of the recommendation with specific data.

| Table | Size (GB) | Current Cost | Basic Logs Cost | Savings |
|-------|-----------|--------------|-----------------|----------|
| Perf | 14.82 | $40.90 | $7.41 | $33.49 |

[ACTION]Go to Log Analytics workspace > Tables > Select table > Change plan to Basic Logs[/ACTION]
[DOCS]https://learn.microsoft.com/azure/azure-monitor/logs/basic-logs-configure[/DOCS]
[/CARD]

Card types: savings (green, for cost savings), warning (orange, for issues), info (blue, for general info), success (green, optimal config)

RULES:
- Start with a summary card showing total ingestion and estimated cost
- ALWAYS include Basic Logs recommendation if Perf, ContainerInventory, Syslog, or ContainerLog have significant volume
- Calculate SPECIFIC dollar amounts using: Analytics = $2.76/GB, Basic = $0.50/GB
- If no issues found, use [CARD:success] to say configuration is optimal
- NEVER output raw text without card wrappers
- OMIT sections with no data or no actionable recommendation`;
}

// Build user prompt with analysis data
function buildUserPrompt(workspaceName, workspaceConfig, analysisData, context) {
    let prompt = `# Azure Monitor Cost Analysis Request

## Environment Summary
${typeof workspaceConfig === 'object' && workspaceConfig.workspaces 
    ? `Analyzing ${workspaceConfig.workspaces.length} workspaces across multiple resource groups`
    : `Single workspace: ${workspaceName}`}

## Analysis Data
${analysisData || 'No analysis data available'}
`;

    if (context) {
        prompt += `\n## Customer Notes\n${context}\n`;
    }

    prompt += `
## STRICT Instructions
1. ONLY output sections where there is an actionable recommendation
2. DO NOT mention sections with "no data detected" or "no issues found" - just omit them entirely
3. If commitment tier doesn't make sense (ingestion < 100GB/month), don't mention it at all
4. If duplicates weren't found, don't have a "Duplicate Data" section at all
5. If heartbeat is normal, don't mention heartbeat at all
6. Focus ONLY on what the user can actually do to save money
7. If everything looks optimal, just say so briefly - don't list all the things that are already fine`;

    return prompt;
}

// Start server
async function start() {
    await initializeAzure();
    
    app.listen(PORT, () => {
        console.log(`🚀 Server running on http://localhost:${PORT}`);
        console.log(`📊 Models: Model1=${!!AZURE_OPENAI_CONFIG.model1.apiKey}, Model2=${!!AZURE_OPENAI_CONFIG.model2.apiKey}`);
        console.log(`💡 Make sure you're logged in: az login`);
    });
}

start();
