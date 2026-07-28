// AO cloud control plane — Azure infrastructure (Container Apps).
//
// This DESCRIBES the infra; it provisions nothing until you run:
//   az group create -n ao-controlplane-rg -l centralindia
//   az deployment group create -g ao-controlplane-rg -f main.bicep \
//      -p namePrefix=aocp postgresAdminPassword=<pw> daytonaApiKey=<key> \
//         containerImage=<acr>.azurecr.io/ao-controlplane:latest
//
// Layout: ACR (image) + Log Analytics + Container Apps env + Container App
// (the control plane) + Postgres Flexible Server + Key Vault (secrets).
// Sandboxes still run on Daytona — this is only our service's infra.

@description('Short prefix for resource names (lowercase, 3-10 chars).')
@minLength(3)
@maxLength(10)
param namePrefix string = 'aocp'

@description('Azure region.')
param location string = resourceGroup().location

@description('Full container image ref (push to the ACR created here first).')
param containerImage string

@description('Postgres admin password.')
@secure()
param postgresAdminPassword string

@description('The single Daytona provisioning API key (stored in Key Vault).')
@secure()
param daytonaApiKey string

@description('GitHub token for cloning private repos into sandboxes (optional).')
@secure()
param githubToken string = ''

@description('Clerk JWKS URL. Empty = DEV auth (X-AO-Tenant header) — do NOT use in prod.')
param clerkJwksUrl string = ''

@description('Expected Clerk token issuer (optional).')
param clerkIssuer string = ''

var pgAdmin = 'aoadmin'
var pgDbName = 'ao_controlplane'
var pgFqdn = '${namePrefix}-pg.postgres.database.azure.com'
var pgDsn = 'postgres://${pgAdmin}:${postgresAdminPassword}@${pgFqdn}:5432/${pgDbName}?sslmode=require'

// ── Container Registry ──────────────────────────────────────────────────────
resource acr 'Microsoft.ContainerRegistry/registries@2023-07-01' = {
  name: '${namePrefix}acr'
  location: location
  sku: { name: 'Basic' }
  properties: { adminUserEnabled: false }
}

// ── Log Analytics (required by the Container Apps environment) ──────────────
resource logs 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: '${namePrefix}-logs'
  location: location
  properties: { sku: { name: 'PerGB2018' }, retentionInDays: 30 }
}

// ── Key Vault (secrets: Daytona key, Postgres DSN, GitHub token) ────────────
resource kv 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: '${namePrefix}-kv'
  location: location
  properties: {
    tenantId: subscription().tenantId
    sku: { family: 'A', name: 'standard' }
    enableRbacAuthorization: true
  }
}

resource secDaytona 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = {
  parent: kv
  name: 'daytona-api-key'
  properties: { value: daytonaApiKey }
}
resource secPgDsn 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = {
  parent: kv
  name: 'controlplane-db'
  properties: { value: pgDsn }
}
resource secGithub 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = {
  parent: kv
  name: 'github-token'
  properties: { value: empty(githubToken) ? 'unset' : githubToken }
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

// Allow other Azure services (the Container App) to reach Postgres.
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
  identity: { type: 'SystemAssigned' } // used for ACR pull + Key Vault reads
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
        { server: acr.properties.loginServer, identity: 'system' }
      ]
      // Secrets sourced from Key Vault via the app's managed identity.
      secrets: [
        { name: 'daytona-api-key', keyVaultUrl: secDaytona.properties.secretUri, identity: 'system' }
        { name: 'controlplane-db', keyVaultUrl: secPgDsn.properties.secretUri, identity: 'system' }
        { name: 'github-token', keyVaultUrl: secGithub.properties.secretUri, identity: 'system' }
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
            { name: 'CLERK_JWKS_URL', value: clerkJwksUrl }
            { name: 'CLERK_ISSUER', value: clerkIssuer }
          ]
        }
      ]
      // Scale to zero when idle; up to 3 replicas under load. (Registry is in
      // Postgres, so multi-replica is safe — no sqlite single-writer limit.)
      scale: { minReplicas: 0, maxReplicas: 3 }
    }
  }
}

// ── RBAC: let the app's identity pull from ACR + read Key Vault secrets ─────
resource acrPull 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(acr.id, app.id, 'AcrPull')
  scope: acr
  properties: {
    // AcrPull
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '7f951dda-4ed3-4680-a7ca-43fe172d538d')
    principalId: app.identity.principalId
    principalType: 'ServicePrincipal'
  }
}

resource kvReader 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(kv.id, app.id, 'KeyVaultSecretsUser')
  scope: kv
  properties: {
    // Key Vault Secrets User
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '4633458b-17de-408a-b874-0445c86b69e6')
    principalId: app.identity.principalId
    principalType: 'ServicePrincipal'
  }
}

output controlPlaneFqdn string = app.properties.configuration.ingress.fqdn
output acrLoginServer string = acr.properties.loginServer
output keyVaultName string = kv.name
