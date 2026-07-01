# GPv1 to GPv2 Billing Impact Estimator

[![CI](https://github.com/microsoft/GPv1-Retirement-Cost-Estimator/actions/workflows/ci.yml/badge.svg)](https://github.com/microsoft/GPv1-Retirement-Cost-Estimator/actions/workflows/ci.yml)
[![Deploy to Azure](https://aka.ms/deploytoazurebutton)](https://portal.azure.com/#create/Microsoft.Template/uri/https%3A%2F%2Fraw.githubusercontent.com%2Fmicrosoft%2FGPv1-Retirement-Cost-Estimator%2Fmain%2Finfra%2Fazuredeploy.json)

> **If the Deploy to Azure button shows a download error**, the repository may not yet be publicly accessible. Download [`infra/azuredeploy.json`](./infra/azuredeploy.json) manually, then open the [Azure custom deployment blade](https://portal.azure.com/#create/Microsoft.Template) and upload the file.

Azure-hostable web app for estimating the billing impact of upgrading Azure Storage GPv1 accounts to GPv2 using public Azure list pricing.

> [!IMPORTANT]
> This tool is an estimator only. It uses public list pricing and modeled assumptions to compare GPv1 and GPv2 costs, so results are directional and actual charges may vary. Actual costs can differ based on factors such as discounts, negotiated pricing, taxes, credits, reservations, support plans, marketplace charges, and other customer-specific billing conditions.

> [!TIP]
> 📖 **Ready to deploy?** See [docs/deployment.md](./docs/deployment.md) for all deployment options including one-click Azure deployment, manual ARM template deployment, and GitHub Actions setup.

## Deployment

Click the **Deploy to Azure** badge above (or use the ARM template at `infra/azuredeploy.json`) to provision an Azure Static Web App in your subscription.

To enable the automated deploy workflow after forking:

1. Click the **Deploy to Azure** badge above to provision an Azure Static Web App in your subscription.
2. In the Azure portal, open the Static Web App resource and copy its **deployment token** (Manage deployment token).
3. In your GitHub repository, go to **Settings → Secrets and variables → Actions** and add a secret named `AZURE_STATIC_WEB_APPS_API_TOKEN` with that token.
4. Push to `main` or trigger the Deploy workflow manually.

> [!TIP]
> See [docs/deployment.md](./docs/deployment.md) for full deployment options.

## What It Does

- Accepts manual GPv1 Blob Storage usage or structured CSV billing line items.
- Detects Blob Storage rows and excludes Azure Files, Disks, Tables, and Queues by default.
- Looks up public prices through the Azure Retail Prices API.
- Shows GPv1 vs GPv2 list-price and discount-adjusted cost comparisons.
- Flags matches as Exact match, Strong match, Needs review, or Unmatched.
- Exports a customer-ready CSV and PDF summary.

## Repository Layout

- `apps/web` - React + TypeScript + Vite frontend.
- `apps/api` - Azure Functions-compatible TypeScript API.
- `packages/core` - shared CSV parsing, pricing URL construction, matching, calculations, and exports.
- `docs` - deployment and calculation methodology.
- `apps/web/public/sample-usage.csv` - sample CSV template and test data.

## Local Development

```powershell
npm install
npm run build
npm run test
npm run dev
```

For live Retail Prices API lookups during local development, run the API in a separate terminal:

```powershell
npm run build -w @gpv2-estimator/core
npm run build -w @gpv2-estimator/api
npm run start -w @gpv2-estimator/api
```

Then open the Vite URL shown by `npm run dev`.

## Environment Variables

No secrets are required.

For Azure Functions local development, copy `apps/api/local.settings.example.json` to `apps/api/local.settings.json`.

## Pricing Source

The API uses the unauthenticated Azure Retail Prices API:

`https://prices.azure.com/api/retail/prices?api-version=2023-01-01-preview`

Prices are filtered by Storage service family, Consumption price type, region, currency, and available meter hints. The response keeps meter IDs and public meter details visible in the UI.

## CI/CD

The repository includes two GitHub Actions workflows:

- **CI** (`.github/workflows/ci.yml`) — runs on every push and pull request to `main`. Runs tests, typecheck, lint, build, and a production dependency audit. No secrets required.
- **Deploy** (`.github/workflows/deploy.yml`) — runs on every push to `main` and can be triggered manually. Deploys to Azure Static Web Apps.

> [!IMPORTANT]
> This app is an estimator. It does not model taxes, credits, reservations, support plans, marketplace charges, private negotiated pricing, or customer-specific billing APIs. Discounts are modeled only when provided by the user, and results should be validated against actual Azure billing data before being used for planning or customer commitments.
