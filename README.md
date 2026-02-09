# Azure Monitor Cost Optimizer

A web application that analyzes your Azure Monitor Log Analytics workspaces and provides AI-powered cost optimization recommendations.

![Azure Monitor Cost Optimizer](https://img.shields.io/badge/Azure-Monitor-0078D4?style=for-the-badge&logo=microsoft-azure)

## Features

- 🔍 **Real Azure Data** - Queries your actual Log Analytics workspaces
- 💰 **Cost Analysis** - Identifies savings opportunities (Basic Logs, commitment tiers, etc.)
- 🤖 **AI-Powered** - Uses Azure OpenAI to provide specific, actionable recommendations
- 📊 **Visual Cards** - Clean card-based UI for recommendations
- 🔐 **Secure** - Uses Azure CLI credentials, API keys stay on server

## Prerequisites

- Node.js 18+
- Azure CLI installed and logged in (`az login`)
- Azure OpenAI resource with GPT-4 deployment
- Reader access to Azure subscriptions you want to analyze

## Setup

1. **Clone the repository**
   ```bash
   git clone https://github.com/yourusername/azure-monitor-cost.git
   cd azure-monitor-cost
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Configure environment**
   ```bash
   cp .env.example .env
   ```
   Edit `.env` with your Azure OpenAI credentials:
   ```
   AZURE_OPENAI_ENDPOINT=https://your-resource.openai.azure.com
   AZURE_OPENAI_KEY=your-api-key
   ```

4. **Login to Azure CLI**
   ```bash
   az login
   ```

5. **Start the server**
   ```bash
   npm start
   ```

6. **Open the app**
   Navigate to http://localhost:3000

## Usage

1. Select a subscription from the dropdown
2. Choose one or more Log Analytics workspaces
3. Click "Analyze Selected Workspaces"
4. Review the AI-generated cost optimization recommendations

## Cost Optimization Areas

The tool analyzes:

- **Basic Logs Migration** - Tables that can move from Analytics ($2.76/GB) to Basic Logs ($0.50/GB)
- **Commitment Tiers** - Whether a commitment tier would save money based on ingestion volume
- **Excessive Heartbeat** - Agents sending heartbeats too frequently
- **Duplicate Data** - Redundant data being ingested
- **Retention Settings** - Opportunities to reduce retention periods

## Architecture

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│   Browser UI    │────▶│  Node.js Server │────▶│  Azure OpenAI   │
│   (HTML/JS/CSS) │     │  (Express)      │     │  (GPT-4)        │
└─────────────────┘     └────────┬────────┘     └─────────────────┘
                                 │
                                 ▼
                        ┌─────────────────┐
                        │  Azure APIs     │
                        │  - Subscriptions│
                        │  - Log Analytics│
                        │  - Monitor Query│
                        └─────────────────┘
```

## Security

- API keys are stored in `.env` (not committed to git)
- Azure authentication uses Azure CLI credentials
- All Azure API calls are made server-side
- No credentials are exposed to the browser

## License

MIT
