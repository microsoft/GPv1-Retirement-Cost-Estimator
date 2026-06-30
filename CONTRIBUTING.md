# Contributing

Thank you for your interest in contributing to the GPv1 to GPv2 Billing Impact Estimator!

This project welcomes contributions and suggestions. Most contributions require you to
agree to a Contributor License Agreement (CLA) declaring that you have the right to,
and actually do, grant us the rights to use your contribution. For details, visit
https://cla.microsoft.com.

When you submit a pull request, a CLA-bot will automatically determine whether you need
to provide a CLA and decorate the PR appropriately (e.g., label, comment). Simply follow the
instructions provided by the bot. You will only need to do this once across all repositories using our CLA.

This project has adopted the [Microsoft Open Source Code of Conduct](https://opensource.microsoft.com/codeofconduct/).
For more information see the [Code of Conduct FAQ](https://opensource.microsoft.com/codeofconduct/faq/)
or contact [opencode@microsoft.com](mailto:opencode@microsoft.com) with any additional questions or comments.

## Prerequisites

- [Node.js](https://nodejs.org/) 20 or later
- npm 10 or later (bundled with Node.js 20)

## Setting Up Locally

```powershell
git clone https://github.com/microsoft/GPv1-Retirement-Cost-Estimator.git
cd GPv1-Retirement-Cost-Estimator
npm install
```

## Common Commands

| Command | Description |
|---|---|
| `npm run dev` | Start the Vite dev server |
| `npm run test` | Run unit tests (vitest) |
| `npm run typecheck` | TypeScript type checking across all packages |
| `npm run lint` | ESLint for the web app |
| `npm run build` | Production build of all packages |
| `npm run audit:prod` | Audit production dependencies for vulnerabilities |

### Running the API Locally

To hit the live Azure Retail Prices API during development:

```powershell
# In one terminal
npm run build -w @gpv2-estimator/core
npm run build -w @gpv2-estimator/api
npm run start -w @gpv2-estimator/api

# In another terminal
npm run dev
```

Copy `apps/api/local.settings.example.json` to `apps/api/local.settings.json` before starting the API.

## Submitting a Pull Request

1. Fork the repository and create a feature branch from `main`.
2. Make your changes and ensure all checks pass locally:
   ```powershell
   npm run test
   npm run typecheck
   npm run lint
   npm run build
   npm run audit:prod
   ```
3. Open a pull request against `main`. The CI workflow will run the same checks automatically.
4. Address any reviewer feedback and keep your branch up to date with `main`.

## Reporting Issues

Open a [GitHub Issue](https://github.com/microsoft/GPv1-Retirement-Cost-Estimator/issues) and include:

- Steps to reproduce
- Expected behavior
- Actual behavior
- Browser and OS version (for UI bugs)
- Sanitised CSV or usage inputs if relevant (remove any customer-identifying data)

## Code Style

- TypeScript with strict mode enabled.
- React functional components and hooks only.
- Shared logic belongs in `packages/core` with unit tests.
- UI-specific logic belongs in `apps/web/src`.
- API functions belong in `apps/api/src/functions`.
- Do not add production dependencies without running `npm audit --omit=dev` and verifying no new high or critical vulnerabilities are introduced.

## Security

Please do **not** open public issues for security vulnerabilities. Follow the [SECURITY.md](./SECURITY.md) disclosure process.

## License

By contributing, you agree that your contributions will be licensed under the same [MIT License](./LICENSE.md) that covers this project.
