// Azure Monitor Cost Optimization Knowledge Base
// Based on: https://learn.microsoft.com/en-us/azure/azure-monitor/fundamentals/best-practices-cost

const AZURE_MONITOR_KNOWLEDGE_BASE = {
    overview: `Cost optimization in Azure Monitor focuses on reducing unnecessary expenses and improving operational efficiencies. The primary cost drivers are data ingestion into Log Analytics workspaces, data retention, and alert rule evaluations.`,

    categories: {
        logAnalytics: {
            title: "Azure Monitor Logs / Log Analytics",
            designChecklist: [
                "Determine whether to combine your operational data and your security data in the same Log Analytics workspace",
                "Configure pricing tier for the amount of data that each Log Analytics workspace typically collects",
                "Configure data retention and archiving",
                "Configure tables used for debugging, troubleshooting, and auditing as Basic Logs",
                "Limit data collection from data sources for the workspace",
                "Regularly analyze collected data to identify trends and anomalies",
                "Create an alert when data collection is high",
                "Consider a daily cap as a preventative measure to ensure that you don't exceed a particular budget",
                "Set up alerts on Azure Advisor cost recommendations for Log Analytics workspaces"
            ],
            recommendations: [
                {
                    title: "Workspace Strategy",
                    description: "Since all data in a Log Analytics workspace is subject to Microsoft Sentinel pricing if Sentinel is enabled, there might be cost implications to combining operational and security data."
                },
                {
                    title: "Pricing Tiers",
                    description: "By default, Log Analytics workspaces use pay-as-you-go pricing. If you collect enough data, you can significantly decrease costs by using a commitment tier, which offers a lower rate in exchange for committing to a daily minimum of data collected."
                },
                {
                    title: "Data Retention",
                    description: "There's a charge for retaining data beyond the default of 31 days (90 days if Sentinel is enabled). Configure long-term retention (up to 12 years) for data you need to retain but only occasionally access."
                },
                {
                    title: "Basic Logs",
                    description: "Tables configured for Basic Logs have lower ingestion cost but limited features and a charge for queries. Use this for debugging, troubleshooting, and auditing tables that you query infrequently."
                },
                {
                    title: "Daily Cap",
                    description: "A daily cap disables data collection after your configured limit is reached. This shouldn't be used as a cost reduction method but as a preventative budget measure. Set alerts at 90% threshold."
                }
            ],
            kqlQueries: {
                analyzeUsage: `// Analyze data volume by table
Usage
| where TimeGenerated > ago(30d)
| summarize TotalGB = sum(Quantity) / 1000 by DataType
| sort by TotalGB desc`,
                findDuplicates: `// Find potential duplicate data
Heartbeat
| where TimeGenerated > ago(1d)
| summarize Count = count() by Computer, SourceComputerId
| where Count > 1440  // More than 1 per minute`,
                topTables: `// Top tables by ingestion volume
Usage
| where TimeGenerated > ago(7d)
| where IsBillable == true
| summarize BillableDataGB = sum(Quantity) / 1000 by DataType
| sort by BillableDataGB desc
| take 10`
            }
        },

        alerts: {
            title: "Alerts",
            designChecklist: [
                "Activity log alerts, service health alerts, and resource health alerts are free of charge",
                "When using log search alerts, minimize log search alert frequency",
                "When using metric alerts, minimize the number of resources being monitored"
            ],
            recommendations: [
                {
                    title: "Free Alert Types",
                    description: "Activity log alerts, service health alerts, and resource health alerts are free. Use these alert types when they can achieve your monitoring goals."
                },
                {
                    title: "Log Search Alert Frequency",
                    description: "The more frequent the rule evaluation, the higher the cost. Configure alert rules with appropriate frequency based on urgency requirements."
                },
                {
                    title: "Metric Alert Scope",
                    description: "Multi-resource metric alert rules can become expensive when monitoring many resources. Consider using log search alert rules for monitoring large numbers of resources."
                }
            ]
        },

        virtualMachines: {
            title: "Virtual Machines",
            designChecklist: [
                "Migrate from Log Analytics agent to Azure Monitor agent for granular data filtering",
                "Filter data that you don't require from agents",
                "Determine whether you'll use VM insights and what data to collect",
                "Reduce polling frequency of performance counters",
                "Ensure that VMs aren't sending duplicate data",
                "Use Log Analytics workspace insights to analyze billable costs and identify cost saving opportunities",
                "Migrate your SCOM environment to Azure Monitor SCOM Managed Instance"
            ],
            recommendations: [
                {
                    title: "Azure Monitor Agent Migration",
                    description: "Migrate from Log Analytics agent to Azure Monitor agent for better data filtering using Data Collection Rules (DCRs). DCRs allow unique configurations for different VM sets."
                },
                {
                    title: "VM Insights Configuration",
                    description: "If you don't use the Map feature or dependency data, disable collection of processes and dependency data to save on ingestion costs."
                },
                {
                    title: "Performance Counter Frequency",
                    description: "Reduce the polling frequency of performance counters in your data collection rules to decrease data volume while still capturing meaningful trends."
                },
                {
                    title: "Duplicate Data Prevention",
                    description: "If multi-homing agents or using similar DCRs, ensure you're sending unique data to each workspace to avoid paying for duplicate data."
                }
            ]
        },

        containers: {
            title: "Containers / AKS",
            designChecklist: [
                "Enable collection of metrics through the Azure Monitor managed service for Prometheus",
                "Configure agent collection to modify data collection in Container insights",
                "Modify settings for collection of metric data by Container insights",
                "Disable Container insights collection of metric data if you don't use the Container insights experience",
                "If you don't query the container logs table regularly or use it for alerts, configure it as basic logs",
                "Limit collection of resource logs you don't need",
                "Use resource-specific logging for AKS resource logs and configure tables as basic logs",
                "Use OpenCost to collect details about your Kubernetes costs"
            ],
            recommendations: [
                {
                    title: "Managed Prometheus",
                    description: "Use Azure Monitor managed service for Prometheus for scraping metrics. Don't also send Prometheus metrics to Log Analytics workspace as this creates redundant data and additional cost."
                },
                {
                    title: "Container Insights Optimization",
                    description: "Configure Container insights to only collect Logs and events if you don't need the Container insights portal experience. Use Grafana for Prometheus metrics visualization instead."
                },
                {
                    title: "ContainerLogV2 with Basic Logs",
                    description: "Convert to ContainerLogV2 schema and configure as Basic Logs for significant cost savings on container log data you don't query frequently."
                },
                {
                    title: "AKS Control Plane Logs",
                    description: "Selectively collect control plane logs based on your needs. Use resource-specific logging mode to enable Basic Logs configuration."
                },
                {
                    title: "OpenCost",
                    description: "Deploy OpenCost for detailed Kubernetes cost visibility and analysis capabilities."
                }
            ]
        },

        applicationInsights: {
            title: "Application Insights",
            designChecklist: [
                "Change to workspace-based Application Insights",
                "Use sampling to tune the amount of data collected",
                "Limit the number of Ajax calls",
                "Disable unneeded modules",
                "Preaggregate metrics from any calls to TrackMetric",
                "Limit the use of custom metrics where possible",
                "Ensure use of updated software development kits (SDKs)",
                "Limit unwanted host trace and general trace logging using log levels"
            ],
            recommendations: [
                {
                    title: "Workspace-based Resources",
                    description: "Migrate to workspace-based Application Insights to benefit from cost savings tools like Basic Logs, commitment tiers, and long-term retention."
                },
                {
                    title: "Sampling",
                    description: "Sampling is the primary tool for reducing Application Insights data volume. It reduces telemetry with minimal distortion of metrics."
                },
                {
                    title: "Ajax Call Limits",
                    description: "Limit or disable Ajax call reporting. Disabling Ajax calls also disables JavaScript correlation."
                },
                {
                    title: "Module Configuration",
                    description: "Edit ApplicationInsights.config to disable collection modules you don't need (e.g., performance counters, dependency data)."
                },
                {
                    title: "Log Levels",
                    description: "Configure appropriate log levels to reduce trace telemetry. Adjust both application and host logging levels."
                }
            ]
        },

        azureResources: {
            title: "Azure Resources",
            designChecklist: [
                "Collect only critical resource log data from Azure resources"
            ],
            recommendations: [
                {
                    title: "Diagnostic Settings",
                    description: "When creating diagnostic settings, only specify log categories you require. Use workspace transformations to filter unneeded data for resources using supported tables."
                }
            ]
        }
    },

    azureAdvisorAlerts: [
        "Consider configuring the cost effective Basic logs plan on selected tables",
        "Consider changing pricing tier based on usage volume",
        "Consider removing unused restored tables",
        "Data ingestion anomaly detected - investigate significant changes"
    ],

    usefulLinks: {
        costUsage: "https://learn.microsoft.com/en-us/azure/azure-monitor/fundamentals/cost-usage",
        workspaceInsights: "https://learn.microsoft.com/en-us/azure/azure-monitor/logs/log-analytics-workspace-insights",
        basicLogs: "https://learn.microsoft.com/en-us/azure/azure-monitor/logs/basic-logs-configure",
        commitmentTiers: "https://learn.microsoft.com/en-us/azure/azure-monitor/logs/cost-logs",
        dataCollectionRules: "https://learn.microsoft.com/en-us/azure/azure-monitor/essentials/data-collection-rule-overview",
        containerInsightsCost: "https://learn.microsoft.com/en-us/azure/azure-monitor/containers/container-insights-cost"
    }
};

// System prompt for AI model
const SYSTEM_PROMPT = `You are an Azure Monitor Cost Optimization expert assistant. Your role is to provide specific, actionable recommendations to help customers reduce their Azure Monitor costs while maintaining effective monitoring.

Use the following knowledge base for your recommendations:

${JSON.stringify(AZURE_MONITOR_KNOWLEDGE_BASE, null, 2)}

When providing recommendations:
1. Start with a brief assessment based on the information provided
2. Organize recommendations by category (Log Analytics, Alerts, VMs, Containers, Application Insights)
3. Prioritize recommendations by potential cost impact (High, Medium, Low)
4. Include specific KQL queries when relevant for analyzing current usage
5. Provide links to relevant Microsoft documentation
6. Warn about any tradeoffs (e.g., reduced data might impact troubleshooting)
7. Suggest Azure Advisor alerts to set up for ongoing optimization

Format your response in clear sections with headers. Use bullet points for actionable items.
Be specific and practical - avoid generic advice.`;

// Export for use in app.js
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { AZURE_MONITOR_KNOWLEDGE_BASE, SYSTEM_PROMPT };
}
