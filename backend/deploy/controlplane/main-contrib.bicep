// AO control plane — Contributor-only Azure variant.
//
// Use this when the deploying account has **Contributor on a resource group**
// but cannot create role assignments or write to an RBAC-enabled Key Vault
// (i.e. no Owner / User Access Administrator). It drops the managed-identity +
// Key Vault + role-assignment machinery of main.bicep and instead:
//   - authenticates ACR pulls with the registry's admin username/password
//   - injects app secrets (Daytona key, Postgres DSN, GitHub token) as Container
//     App secrets (encrypted at rest by ACA; never in git or the image)
// Everything else — ACR, Log Analytics, Container Apps, Postgres — is identical.
//
// The ACR is created out-of-band (az acr create) so the image can be built
// (az acr build) BEFORE this deploys; pass its login server + admin creds in.

@description('Short prefix for resource names (lowercase, 3-10 chars).')
@minLength(3)
@maxLength(10)
param namePrefix string = 'aocphi'

@description('Azure region.')
param location string = resourceGroup().location

@description('Full container image ref already pushed to the ACR.')
param containerImage string

@description('ACR login server, e.g. aocphiacr.azurecr.io')
param registryServer string

@description('ACR admin username.')
param acrUsername string

@description('ACR admin password.')
@secure()
param acrPassword string

@description('Postgres admin password.')
@secure()
param postgresAdminPassword string

@description('The single Daytona provisioning API key (injected as a CA secret).')
@secure()
param daytonaApiKey string

@description('Claude Code credential JSON (read from Key Vault at deploy) injected into claude-code sandboxes so the harness can authenticate headlessly.')
@secure()
param claudeCredentials string = ''

@description('GitHub token for cloning private repos into sandboxes (optional).')
@secure()
param githubToken string = ''

@description('Clerk JWKS URL. Empty = DEV auth (X-AO-Tenant) — do NOT use in prod.')
param clerkJwksUrl string = ''

@description('Expected Clerk token issuer (optional).')
param clerkIssuer string = ''

@description('Federated-bus signing key (from Key Vault). Signs per-sandbox scoped bus tokens. Empty = sandbox outbound channel OFF. Do NOT use a placeholder: any non-empty value becomes a live HMAC key.')
@secure()
param busSigningKey string = ''

@description('This control plane\'s own public https URL, injected into sandboxes so their daemons can dial the bus. Stable across redeploys of the same app.')
param controlPlanePublicUrl string = ''

var pgAdmin = 'aoadmin'
var pgDbName = 'ao_controlplane'
var pgFqdn = '${namePrefix}-pg.postgres.database.azure.com'
var pgDsn = 'postgres://${pgAdmin}:${postgresAdminPassword}@${pgFqdn}:5432/${pgDbName}?sslmode=require'

// ── Log Analytics (required by the Container Apps environment) ──────────────
resource logs 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: '${namePrefix}-logs'
  location: location
  properties: { sku: { name: 'PerGB2018' }, retentionInDays: 30 }
}

// ── Postgres Flexible Server ────────────────────────────────────────────────
resource pg 'Microsoft.DBforPostgreSQL/flexibleServers@2024-08-01' = {
  name: '${namePrefix}-pg'
  location: location
  sku: { name: 'Standard_B1ms', tier: 'Burstable' } // cheapest; scale up later
  properties: {
    version: '16'
    administratorLogin: pgAdmin
    administratorLoginPassword: postgresAdminPassword
    storage: { storageSizeGB: 32 }
    backup: { backupRetentionDays: 7 }
    highAvailability: { mode: 'Disabled' }
  }
}

resource pgFirewall 'Microsoft.DBforPostgreSQL/flexibleServers/firewallRules@2024-08-01' = {
  parent: pg
  name: 'AllowAzureServices'
  properties: { startIpAddress: '0.0.0.0', endIpAddress: '0.0.0.0' }
}

resource pgDb 'Microsoft.DBforPostgreSQL/flexibleServers/databases@2024-08-01' = {
  parent: pg
  name: pgDbName
  properties: { charset: 'UTF8', collation: 'en_US.utf8' }
}

// ── Container Apps environment ──────────────────────────────────────────────
resource caEnv 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: '${namePrefix}-env'
  location: location
  properties: {
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: logs.properties.customerId
        sharedKey: logs.listKeys().primarySharedKey
      }
    }
  }
}

// ── Control-plane Container App ─────────────────────────────────────────────
resource app 'Microsoft.App/containerApps@2024-03-01' = {
  name: '${namePrefix}-controlplane'
  location: location
  properties: {
    managedEnvironmentId: caEnv.id
    configuration: {
      ingress: {
        external: true
        targetPort: 8080
        transport: 'auto' // supports the WebSocket terminal relay
        allowInsecure: false
      }
      registries: [
        { server: registryServer, username: acrUsername, passwordSecretRef: 'acr-password' }
      ]
      secrets: [
        { name: 'acr-password', value: acrPassword }
        { name: 'daytona-api-key', value: daytonaApiKey }
        { name: 'controlplane-db', value: pgDsn }
        { name: 'github-token', value: empty(githubToken) ? 'unset' : githubToken }
        { name: 'claude-credentials', value: empty(claudeCredentials) ? 'unset' : claudeCredentials }
        // Empty string, NOT an 'unset' sentinel: the app treats only "" as
        // bus-tokens-off; a placeholder would become a live weak signing key.
        { name: 'bus-signing-key', value: busSigningKey }
      ]
    }
    template: {
      containers: [
        {
          name: 'controlplane'
          image: containerImage
          resources: { cpu: json('0.5'), memory: '1Gi' }
          env: [
            { name: 'CONTROLPLANE_ADDR', value: ':8080' }
            { name: 'DAYTONA_API_KEY', secretRef: 'daytona-api-key' }
            { name: 'CONTROLPLANE_DB', secretRef: 'controlplane-db' }
            { name: 'GITHUB_TOKEN', secretRef: 'github-token' }
            { name: 'AO_CLAUDE_CREDENTIALS_JSON', secretRef: 'claude-credentials' }
            { name: 'CLERK_JWKS_URL', value: clerkJwksUrl }
            { name: 'CLERK_ISSUER', value: clerkIssuer }
            { name: 'AO_BUS_SIGNING_KEY', secretRef: 'bus-signing-key' }
            { name: 'CONTROL_PLANE_PUBLIC_URL', value: controlPlanePublicUrl }
          ]
        }
      ]
      // Single replica: the supervisor keeps session state in-memory, so a spawn
      // and a later terminate must hit the SAME replica. Scale-to-zero still
      // applies (0↔1). True multi-replica needs a store-backed ownership check.
      scale: { minReplicas: 0, maxReplicas: 1 }
    }
  }
}

output controlPlaneFqdn string = app.properties.configuration.ingress.fqdn
