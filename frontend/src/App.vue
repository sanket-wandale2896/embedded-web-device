<script setup lang="ts">
import { computed, onBeforeUnmount, reactive, ref } from 'vue'

type UserRole = 'service' | 'admin' | 'user'

interface DeviceMeta {
  tag: string
  firmware: string
}

interface AppUser {
  username: string
  role: UserRole
}

interface LoginResponse {
  token: string
  user: AppUser
  device: DeviceMeta
}

interface DeviceTelemetry {
  tag: string
  firmware: string
  massFlowKgHr: number
  densityKgM3: number
  temperatureC: number
  tubeFrequencyHz: number
  status: string
  updatedAt: string
}

interface DeviceConfig {
  tag: string
  setpointKgHr: number
  dampingSeconds: number
  alarmHighKgHr: number
}

interface ManagedUsersResponse {
  users: AppUser[]
}

interface ConfigAuditEntry {
  id: number
  eventType: string
  changedAt: string
  changedBy: {
    username: string
    role: string
  }
  targetUsername?: string | null
  targetRole?: string | null
  config?: {
    setpointKgHr: number
    dampingSeconds: number
    alarmHighKgHr: number
  } | null
}

interface ConfigAuditResponse {
  entries: ConfigAuditEntry[]
}

const token = ref('')
const poller = ref<number | null>(null)
const isEditingConfig = ref(false)
const hasPendingConfigChanges = ref(false)
const isLoggingIn = ref(false)
const isSaving = ref(false)
const loginError = ref('')
const telemetryError = ref('')
const deviceMeta = ref<DeviceMeta | null>(null)
const telemetry = ref<DeviceTelemetry | null>(null)
const currentUser = ref<AppUser | null>(null)
const managedUsers = ref<AppUser[]>([])
const isCreatingUser = ref(false)
const deletingUsername = ref('')
const auditEntries = ref<ConfigAuditEntry[]>([])
const auditError = ref('')
const isLoadingAudit = ref(false)
const auditFetchLimit = ref(25)
const auditPageSize = 5
const auditCurrentPage = ref(1)

const loginForm = reactive({
  username: 'user',
  password: 'user123',
})

const configDraft = reactive({
  setpointKgHr: 1250,
  dampingSeconds: 3,
  alarmHighKgHr: 1500,
})

const configMessage = reactive({
  text: '',
  kind: 'info' as 'info' | 'error',
})

const userForm = reactive({
  username: '',
  password: '',
  role: 'admin' as 'admin' | 'user',
})

const userMgmtMessage = reactive({
  text: '',
  kind: 'info' as 'info' | 'error',
})

const isAuthenticated = computed(() => token.value.length > 0)
const isServiceUser = computed(() => currentUser.value?.role === 'service')
const canEditConfig = computed(() => currentUser.value?.role === 'service' || currentUser.value?.role === 'admin')
const canViewAuditTrail = computed(
  () => currentUser.value?.role === 'service' || currentUser.value?.role === 'admin',
)
const hasConfigMessage = computed(() => configMessage.text.length > 0)
const hasUserMgmtMessage = computed(() => userMgmtMessage.text.length > 0)
const hasTelemetry = computed(() => telemetry.value !== null)
const totalAuditPages = computed(() => Math.max(1, Math.ceil(auditEntries.value.length / auditPageSize)))
const paginatedAuditEntries = computed(() => {
  const start = (auditCurrentPage.value - 1) * auditPageSize
  return auditEntries.value.slice(start, start + auditPageSize)
})
const auditPageSummary = computed(() => {
  if (auditEntries.value.length === 0) {
    return 'No records loaded'
  }

  const start = (auditCurrentPage.value - 1) * auditPageSize + 1
  const end = Math.min(auditCurrentPage.value * auditPageSize, auditEntries.value.length)
  return `Showing ${start}-${end} of ${auditEntries.value.length}`
})
const configStatusText = computed(() =>
  !canEditConfig.value
    ? 'Read-only access for user role'
    : hasPendingConfigChanges.value
      ? 'Unsaved configuration changes'
      : 'Configuration synced with device',
)

function formatLocalTimestamp(value: string | Date) {
  const date = value instanceof Date ? value : new Date(value)
  return date.toLocaleString(undefined, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    timeZoneName: 'short',
  })
}

function describeAuditEvent(entry: ConfigAuditEntry) {
  switch (entry.eventType) {
    case 'CONFIG_UPDATED':
      return 'Configuration updated'
    case 'CONFIG_SEEDED':
      return 'Initial configuration seeded'
    case 'USER_LOGIN':
      return 'User logged in'
    case 'USER_CREATED':
      return entry.targetUsername ? `User created: ${entry.targetUsername}` : 'User created'
    case 'USER_DELETED':
      return entry.targetUsername ? `User deleted: ${entry.targetUsername}` : 'User deleted'
    default:
      return entry.eventType
  }
}

function authHeaders() {
  return { Authorization: `Bearer ${token.value}` }
}

async function extractApiError(response: Response, fallbackMessage: string) {
  const contentType = response.headers.get('content-type') || ''

  if (contentType.includes('application/json')) {
    try {
      const payload = (await response.json()) as { error?: string }
      if (payload.error) {
        return payload.error
      }
    } catch {
      // Fallback to text/status when a server sends invalid JSON.
    }
  }

  try {
    const rawBody = (await response.text()).trim()
    if (rawBody.length > 0) {
      return rawBody
    }
  } catch {
    // Ignore read errors and fall through to generic message.
  }

  return `${fallbackMessage} (HTTP ${response.status})`
}

async function login(username: string, password: string) {
  const response = await fetch('/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  })

  if (!response.ok) {
    const error = (await response.json()) as { error?: string }
    throw new Error(error.error || 'Login failed')
  }

  return (await response.json()) as LoginResponse
}

async function loadConfig() {
  const response = await fetch('/api/device/config', {
    headers: authHeaders(),
  })

  if (!response.ok) {
    throw new Error('Failed to load config')
  }

  return (await response.json()) as DeviceConfig
}

async function loadTelemetry() {
  const response = await fetch('/api/device/telemetry', {
    headers: authHeaders(),
  })

  if (!response.ok) {
    throw new Error('Failed to load telemetry')
  }

  return (await response.json()) as DeviceTelemetry
}

async function saveConfig(config: Omit<DeviceConfig, 'tag'>) {
  const response = await fetch('/api/device/config', {
    method: 'POST',
    headers: {
      ...authHeaders(),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(config),
  })

  if (!response.ok) {
    const error = (await response.json()) as { error?: string }
    throw new Error(error.error || 'Failed to save config')
  }

  return (await response.json()) as { ok: boolean; config: Omit<DeviceConfig, 'tag'> }
}

async function loadManagedUsers() {
  const response = await fetch('/api/users', {
    headers: authHeaders(),
  })

  if (!response.ok) {
    const error = (await response.json()) as { error?: string }
    throw new Error(error.error || 'Failed to load users')
  }

  return (await response.json()) as ManagedUsersResponse
}

async function createManagedUser(payload: { username: string; password: string; role: 'admin' | 'user' }) {
  const response = await fetch('/api/users', {
    method: 'POST',
    headers: {
      ...authHeaders(),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  })

  if (!response.ok) {
    const error = (await response.json()) as { error?: string }
    throw new Error(error.error || 'Failed to create user')
  }

  return (await response.json()) as { ok: boolean; user: AppUser }
}

async function deleteManagedUser(username: string) {
  const response = await fetch(`/api/users/${encodeURIComponent(username)}`, {
    method: 'DELETE',
    headers: authHeaders(),
  })

  if (!response.ok) {
    throw new Error(await extractApiError(response, 'Failed to delete user'))
  }

  return (await response.json()) as { ok: boolean; deletedUser: AppUser }
}

async function loadConfigAudit(limit = 15) {
  const response = await fetch(`/api/device/config/audit?limit=${limit}`, {
    headers: authHeaders(),
  })

  if (!response.ok) {
    const error = (await response.json()) as { error?: string }
    throw new Error(error.error || 'Failed to load config audit trail')
  }

  return (await response.json()) as ConfigAuditResponse
}

function applyConfig(config: DeviceConfig) {
  if (isEditingConfig.value || hasPendingConfigChanges.value) {
    return
  }

  configDraft.setpointKgHr = config.setpointKgHr
  configDraft.dampingSeconds = config.dampingSeconds
  configDraft.alarmHighKgHr = config.alarmHighKgHr
}

function handleConfigFocusIn() {
  isEditingConfig.value = true
}

function handleConfigFocusOut(event: FocusEvent) {
  const form = event.currentTarget as HTMLFormElement | null
  const nextTarget = event.relatedTarget as Node | null
  isEditingConfig.value = Boolean(form && nextTarget && form.contains(nextTarget))
}

function handleConfigInput() {
  if (!canEditConfig.value) {
    return
  }

  hasPendingConfigChanges.value = true
  configMessage.text = ''
}

async function refreshDashboard() {
  const [nextTelemetry, nextConfig] = await Promise.all([loadTelemetry(), loadConfig()])
  telemetry.value = nextTelemetry
  telemetryError.value = ''
  applyConfig(nextConfig)
}

async function refreshManagedUsers() {
  const result = await loadManagedUsers()
  managedUsers.value = result.users
}

function canDeleteManagedUser(user: AppUser) {
  return user.username !== 'service' && user.username !== currentUser.value?.username
}

function clampAuditPage(targetPage: number) {
  return Math.max(1, Math.min(totalAuditPages.value, targetPage))
}

function goToAuditPage(direction: -1 | 1) {
  auditCurrentPage.value = clampAuditPage(auditCurrentPage.value + direction)
}

function exportAuditTrailAsTxt() {
  if (auditEntries.value.length === 0) {
    return
  }

  const generatedAt = new Date()
  const generatedAtDisplay = formatLocalTimestamp(generatedAt)
  const generatedAtFilePart = generatedAt
    .toLocaleString('sv-SE', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    })
    .replace(/[: ]/g, '-')
  const lines = [
    'Embedded Web Device - Config Audit Trail',
    `Generated at (local): ${generatedAtDisplay}`,
    `Entries loaded: ${auditEntries.value.length}`,
    '',
    ...auditEntries.value.flatMap((entry, index) => {
      const header = describeAuditEvent(entry)
      const configLines = entry.config
        ? [
            `Setpoint kg/h: ${entry.config.setpointKgHr}`,
            `Damping sec: ${entry.config.dampingSeconds}`,
            `High alarm kg/h: ${entry.config.alarmHighKgHr}`,
          ]
        : []
      const targetUserLine = entry.targetUsername
        ? `Target user: ${entry.targetUsername}${entry.targetRole ? ` (${entry.targetRole})` : ''}`
        : null

      return [
        `Entry ${index + 1}`,
        `ID: ${entry.id}`,
        `Event: ${header}`,
        `Changed at (local): ${formatLocalTimestamp(entry.changedAt)}`,
        `Actor: ${entry.changedBy.username} (${entry.changedBy.role})`,
        ...(targetUserLine ? [targetUserLine] : []),
        ...configLines,
        '---',
      ]
    }),
  ]

  const blob = new Blob([`${lines.join('\n')}\n`], { type: 'text/plain;charset=utf-8' })
  const downloadUrl = window.URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = downloadUrl
  anchor.download = `config-audit-trail-${generatedAtFilePart}.txt`
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  window.URL.revokeObjectURL(downloadUrl)
}

async function refreshAuditTrail(targetPage = auditCurrentPage.value) {
  if (!canViewAuditTrail.value) {
    auditEntries.value = []
    auditError.value = ''
    auditCurrentPage.value = 1
    return
  }

  isLoadingAudit.value = true
  auditError.value = ''

  try {
    const result = await loadConfigAudit(auditFetchLimit.value)
    auditEntries.value = result.entries
    auditCurrentPage.value = clampAuditPage(targetPage)
  } catch (error) {
    auditError.value = error instanceof Error ? error.message : 'Failed to load config audit trail'
  } finally {
    isLoadingAudit.value = false
  }
}

async function handleAuditLimitChange() {
  await refreshAuditTrail(1)
}

function stopPolling() {
  if (poller.value !== null) {
    window.clearInterval(poller.value)
    poller.value = null
  }
}

function startPolling() {
  stopPolling()
  poller.value = window.setInterval(async () => {
    try {
      await refreshDashboard()
    } catch (error) {
      telemetryError.value = error instanceof Error ? error.message : 'Failed to refresh dashboard'
    }
  }, 1000)
}

async function handleLogin() {
  isLoggingIn.value = true
  loginError.value = ''
  telemetryError.value = ''

  try {
    const result = await login(loginForm.username.trim(), loginForm.password)
    token.value = result.token
    currentUser.value = result.user
    deviceMeta.value = result.device
    configMessage.text = ''
    userMgmtMessage.text = ''
    hasPendingConfigChanges.value = false
    await refreshDashboard()
    if (result.user.role === 'service') {
      await refreshManagedUsers()
    } else {
      managedUsers.value = []
    }
    if (result.user.role === 'service' || result.user.role === 'admin') {
      await refreshAuditTrail()
    } else {
      auditEntries.value = []
      auditError.value = ''
      auditCurrentPage.value = 1
    }
    startPolling()
  } catch (error) {
    loginError.value = error instanceof Error ? error.message : 'Login failed'
  } finally {
    isLoggingIn.value = false
  }
}

async function handleSaveConfig() {
  if (!canEditConfig.value) {
    configMessage.text = 'User role has read-only access. Configuration changes are not allowed.'
    configMessage.kind = 'error'
    return
  }

  isSaving.value = true
  telemetryError.value = ''
  configMessage.text = ''

  try {
    await saveConfig({
      setpointKgHr: Number(configDraft.setpointKgHr),
      dampingSeconds: Number(configDraft.dampingSeconds),
      alarmHighKgHr: Number(configDraft.alarmHighKgHr),
    })
    isEditingConfig.value = false
    hasPendingConfigChanges.value = false
    await refreshDashboard()
    await refreshAuditTrail()
    configMessage.text = 'Configuration saved to device.'
    configMessage.kind = 'info'
  } catch (error) {
    configMessage.text = error instanceof Error ? error.message : 'Failed to save config'
    configMessage.kind = 'error'
  } finally {
    isSaving.value = false
  }
}

async function handleCreateUser() {
  isCreatingUser.value = true
  userMgmtMessage.text = ''

  try {
    await createManagedUser({
      username: userForm.username.trim(),
      password: userForm.password,
      role: userForm.role,
    })
    userForm.username = ''
    userForm.password = ''
    userForm.role = 'admin'
    await refreshManagedUsers()
    userMgmtMessage.text = 'Login created successfully.'
    userMgmtMessage.kind = 'info'
  } catch (error) {
    userMgmtMessage.text = error instanceof Error ? error.message : 'Failed to create user'
    userMgmtMessage.kind = 'error'
  } finally {
    isCreatingUser.value = false
  }
}

async function handleDeleteUser(user: AppUser) {
  if (!canDeleteManagedUser(user) || deletingUsername.value.length > 0) {
    return
  }

  const confirmed = window.confirm(`Delete login \"${user.username}\"? This cannot be undone.`)
  if (!confirmed) {
    return
  }

  deletingUsername.value = user.username
  userMgmtMessage.text = ''

  try {
    await deleteManagedUser(user.username)
    await refreshManagedUsers()
    await refreshAuditTrail()
    userMgmtMessage.text = `Login deleted: ${user.username}`
    userMgmtMessage.kind = 'info'
  } catch (error) {
    userMgmtMessage.text = error instanceof Error ? error.message : 'Failed to delete user'
    userMgmtMessage.kind = 'error'
  } finally {
    deletingUsername.value = ''
  }
}

onBeforeUnmount(() => {
  stopPolling()
})
</script>

<template>
  <main class="shell">
    <section class="hero-card panel">
      <p class="eyebrow">V0.01</p>
      <h2>Embedded Web Device Demo</h2>
      <p class="intro">
        A browser client for an embedded-style flow transmitter, with live telemetry, login, and
        guarded configuration editing.
      </p>
    </section>

    <section class="workspace-grid">
      <section class="panel auth-panel">
        <div class="panel-header">
          <div>
            <p class="eyebrow">Access</p>
            <h2>Device login</h2>
          </div>
        </div>

        <form class="stack" @submit.prevent="handleLogin">
          <label>
            Username
            <input v-model="loginForm.username" type="text" autocomplete="username" required />
          </label>
          <label>
            Password
            <input
              v-model="loginForm.password"
              type="password"
              autocomplete="current-password"
              required
            />
          </label>
          <button type="submit" :disabled="isLoggingIn">
            {{ isLoggingIn ? 'Signing in...' : 'Login' }}
          </button>
        </form>

        <p class="muted">Also available: service and admin</p>

        <p v-if="loginError" class="message error">{{ loginError }}</p>
      </section>

      <section class="panel dashboard-panel" :class="{ disabled: !isAuthenticated }">
        <div class="panel-header">
          <div>
            <p class="eyebrow">Live dashboard</p>
            <h2>Device telemetry</h2>
          </div>
          <div v-if="deviceMeta" class="device-chip">
            <strong>{{ deviceMeta.tag }}</strong>
            <span>{{ deviceMeta.firmware }}</span>
            <span v-if="currentUser">Role: {{ currentUser.role }}</span>
          </div>
        </div>

        <p v-if="!isAuthenticated" class="muted">
          Log in to unlock telemetry polling and configuration write access.
        </p>

        <template v-else>
          <p v-if="telemetryError" class="message error">{{ telemetryError }}</p>

          <div v-if="hasTelemetry && telemetry" class="telemetry-grid">
            <article class="telemetry-card accent-card">
              <span>Mass Flow</span>
              <strong>{{ telemetry.massFlowKgHr.toFixed(1) }} kg/h</strong>
            </article>
            <article class="telemetry-card">
              <span>Density</span>
              <strong>{{ telemetry.densityKgM3.toFixed(2) }} kg/m3</strong>
            </article>
            <article class="telemetry-card">
              <span>Temperature</span>
              <strong>{{ telemetry.temperatureC.toFixed(1) }} C</strong>
            </article>
            <article class="telemetry-card">
              <span>Tube Frequency</span>
              <strong>{{ telemetry.tubeFrequencyHz.toFixed(2) }} Hz</strong>
            </article>
            <article class="telemetry-card">
              <span>Status</span>
              <strong :class="['status-value', telemetry.status === 'OK' ? 'status-ok' : 'status-alert']">
                {{ telemetry.status }}
              </strong>
            </article>
            <article class="telemetry-card">
              <span>Updated</span>
              <strong>{{ new Date(telemetry.updatedAt).toLocaleTimeString() }}</strong>
            </article>
          </div>

          <div class="config-header">
            <div>
              <p class="eyebrow">Configuration</p>
              <h2>Device settings</h2>
            </div>
            <span :class="['sync-pill', hasPendingConfigChanges ? 'dirty' : 'clean']">
              {{ configStatusText }}
            </span>
          </div>

          <form
            v-if="canEditConfig"
            class="stack"
            @submit.prevent="handleSaveConfig"
            @focusin="handleConfigFocusIn"
            @focusout="handleConfigFocusOut"
            @input="handleConfigInput"
          >
            <label>
              Setpoint (kg/h)
              <input v-model.number="configDraft.setpointKgHr" type="number" min="100" max="3000" required />
            </label>
            <label>
              Damping (sec)
              <input v-model.number="configDraft.dampingSeconds" type="number" min="1" max="20" required />
            </label>
            <label>
              High Alarm (kg/h)
              <input v-model.number="configDraft.alarmHighKgHr" type="number" min="200" max="3500" required />
            </label>
            <button type="submit" :disabled="isSaving">
              {{ isSaving ? 'Saving...' : 'Save Configuration' }}
            </button>
          </form>

          <div v-else class="stack">
            <label>
              Setpoint (kg/h)
              <input :value="configDraft.setpointKgHr" type="number" readonly disabled />
            </label>
            <label>
              Damping (sec)
              <input :value="configDraft.dampingSeconds" type="number" readonly disabled />
            </label>
            <label>
              High Alarm (kg/h)
              <input :value="configDraft.alarmHighKgHr" type="number" readonly disabled />
            </label>
          </div>

          <p v-if="hasConfigMessage" :class="['message', configMessage.kind]">{{ configMessage.text }}</p>

          <section v-if="canViewAuditTrail" class="audit-panel">
            <div class="config-header">
              <div>
                <p class="eyebrow">History</p>
                <h2>Config audit trail</h2>
              </div>
              <div class="audit-actions">
                <label class="audit-limit-control">
                  Load
                  <select v-model.number="auditFetchLimit" :disabled="isLoadingAudit" @change="handleAuditLimitChange">
                    <option :value="10">10</option>
                    <option :value="25">25</option>
                    <option :value="50">50</option>
                    <option :value="100">100</option>
                  </select>
                </label>
                <button
                  type="button"
                  class="secondary-button"
                  :disabled="isLoadingAudit"
                  @click="() => refreshAuditTrail()"
                >
                  {{ isLoadingAudit ? 'Refreshing...' : 'Refresh audit' }}
                </button>
                <button
                  type="button"
                  class="secondary-button"
                  :disabled="isLoadingAudit || auditEntries.length === 0"
                  @click="exportAuditTrailAsTxt"
                >
                  Export TXT
                </button>
              </div>
            </div>

            <p v-if="auditError" class="message error">{{ auditError }}</p>

            <div v-else-if="auditEntries.length > 0" class="audit-list">
              <article v-for="entry in paginatedAuditEntries" :key="entry.id" class="audit-item">
                <div class="audit-item-header">
                  <strong>#{{ entry.id }} {{ describeAuditEvent(entry) }}</strong>
                  <span>{{ formatLocalTimestamp(entry.changedAt) }}</span>
                </div>
                <p class="muted audit-role">Actor: {{ entry.changedBy.username }} ({{ entry.changedBy.role }})</p>
                <p v-if="entry.targetUsername" class="muted audit-target">
                  Target user: {{ entry.targetUsername }}<template v-if="entry.targetRole"> ({{ entry.targetRole }})</template>
                </p>
                <div v-if="entry.config" class="audit-values">
                  <span>Setpoint: {{ entry.config.setpointKgHr }}</span>
                  <span>Damping: {{ entry.config.dampingSeconds }}</span>
                  <span>High alarm: {{ entry.config.alarmHighKgHr }}</span>
                </div>
              </article>

              <div class="audit-pagination">
                <p class="muted">{{ auditPageSummary }}</p>
                <div class="audit-pagination-controls">
                  <button
                    type="button"
                    class="secondary-button"
                    :disabled="isLoadingAudit || auditCurrentPage <= 1"
                    @click="goToAuditPage(-1)"
                  >
                    Previous
                  </button>
                  <span class="muted">Page {{ auditCurrentPage }} / {{ totalAuditPages }}</span>
                  <button
                    type="button"
                    class="secondary-button"
                    :disabled="isLoadingAudit || auditCurrentPage >= totalAuditPages"
                    @click="goToAuditPage(1)"
                  >
                    Next
                  </button>
                </div>
              </div>
            </div>

            <p v-else class="muted">No audit entries available yet.</p>
          </section>

          <section v-if="isServiceUser" class="service-panel">
            <div class="config-header">
              <div>
                <p class="eyebrow">Service access</p>
                <h2>User management</h2>
              </div>
            </div>

            <form class="stack service-form" @submit.prevent="handleCreateUser">
              <label>
                New username
                <input v-model="userForm.username" type="text" minlength="3" required />
              </label>
              <label>
                New password
                <input v-model="userForm.password" type="password" minlength="6" required />
              </label>
              <label>
                Role
                <select v-model="userForm.role" required>
                  <option value="admin">Admin</option>
                  <option value="user">User</option>
                </select>
              </label>
              <button type="submit" :disabled="isCreatingUser">
                {{ isCreatingUser ? 'Creating...' : 'Create Login' }}
              </button>
            </form>

            <p v-if="hasUserMgmtMessage" :class="['message', userMgmtMessage.kind]">
              {{ userMgmtMessage.text }}
            </p>

            <div class="user-list" v-if="managedUsers.length > 0">
              <p class="eyebrow">Existing logins</p>
              <ul>
                <li v-for="item in managedUsers" :key="item.username">
                  <strong>{{ item.username }}</strong>
                  <div class="user-list-item-meta">
                    <span class="user-role">{{ item.role }}</span>
                    <span v-if="item.role === 'service'" class="protected-badge">Protected</span>
                    <button
                      type="button"
                      class="secondary-button danger-button"
                      :disabled="!canDeleteManagedUser(item) || deletingUsername.length > 0"
                      @click="handleDeleteUser(item)"
                    >
                      {{ deletingUsername === item.username ? 'Deleting...' : 'Delete' }}
                    </button>
                  </div>
                </li>
              </ul>
            </div>
          </section>
        </template>
      </section>
    </section>
  </main>
</template>
