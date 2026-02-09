// KQL Queries for Azure Monitor Cost Analysis
// These queries are sent to the server which runs them via Azure SDK

const analysisQueries = {
    // Data volume by table (last 30 days)
    dataVolumeByTable: `
Usage
| where TimeGenerated > ago(30d)
| where IsBillable == true
| summarize 
    BillableGB = round(sum(Quantity) / 1000, 2),
    AvgDailyGB = round(sum(Quantity) / 1000 / 30, 2)
    by DataType
| sort by BillableGB desc
| take 20`,

    // Daily ingestion trend
    dailyIngestionTrend: `
Usage
| where TimeGenerated > ago(30d)
| where IsBillable == true
| summarize DailyGB = round(sum(Quantity) / 1000, 2) by bin(TimeGenerated, 1d)
| sort by TimeGenerated asc`,

    // Data by computer/source (top contributors)
    dataByComputer: `
Usage
| where TimeGenerated > ago(7d)
| where IsBillable == true
| summarize BillableGB = round(sum(Quantity) / 1000, 2) by Computer
| where Computer != ""
| sort by BillableGB desc
| take 15`,

    // Tables with low query frequency (candidates for Basic Logs)
    lowQueryTables: `
LAQueryLogs
| where TimeGenerated > ago(30d)
| extend Tables = todynamic(RequestTarget)
| mv-expand Tables
| summarize QueryCount = count() by tostring(Tables)
| join kind=leftouter (
    Usage
    | where TimeGenerated > ago(30d)
    | where IsBillable == true
    | summarize IngestionGB = round(sum(Quantity) / 1000, 2) by DataType
) on $left.Tables == $right.DataType
| where IngestionGB > 0.5
| project Table = Tables, QueryCount, IngestionGB
| sort by IngestionGB desc`,

    // Heartbeat analysis (potential duplicates or excessive heartbeats)
    heartbeatAnalysis: `
Heartbeat
| where TimeGenerated > ago(1d)
| summarize HeartbeatsPerHour = count() / 24.0 by Computer
| where HeartbeatsPerHour > 70
| sort by HeartbeatsPerHour desc
| take 10`,

    // Data breakdown by category
    dataByCategory: `
Usage
| where TimeGenerated > ago(30d)
| where IsBillable == true
| extend Category = case(
    DataType in ("SecurityEvent", "SecurityAlert", "SecurityBaseline", "SecurityBaselineSummary", "Syslog", "CommonSecurityLog", "WindowsFirewall"), "Security",
    DataType in ("Perf", "Heartbeat", "InsightsMetrics", "VMConnection", "VMBoundPort", "VMComputer", "VMProcess"), "VM Insights",
    DataType in ("ContainerLog", "ContainerLogV2", "ContainerInventory", "ContainerNodeInventory", "KubeEvents", "KubePodInventory"), "Container Insights",
    DataType in ("AppTraces", "AppRequests", "AppDependencies", "AppExceptions", "AppPageViews", "AppPerformanceCounters"), "Application Insights",
    "Other"
)
| summarize BillableGB = round(sum(Quantity) / 1000, 2) by Category
| sort by BillableGB desc`,

    // Check for duplicate agents on same computer
    duplicateDataCheck: `
Heartbeat
| where TimeGenerated > ago(1d)
| summarize AgentCount = dcount(SourceComputerId) by Computer
| where AgentCount > 1
| sort by AgentCount desc`,

    // Application Insights sampling check
    appInsightsSampling: `
AppRequests
| where TimeGenerated > ago(1d)
| summarize 
    TotalRequests = count(),
    SampledRequests = countif(ItemCount > 1),
    AvgItemCount = avg(ItemCount)
| extend SamplingInUse = SampledRequests > 0`
};
