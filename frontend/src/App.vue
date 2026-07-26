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
const hasConfigMessage = computed(() => configMessage.text.length > 0)
const hasUserMgmtMessage = computed(() => userMgmtMessage.text.length > 0)
const hasTelemetry = computed(() => telemetry.value !== null)
const configStatusText = computed(() =>
  !canEditConfig.value
    ? 'Read-only access for user role'
    : hasPendingConfigChanges.value
      ? 'Unsaved configuration changes'
      : 'Configuration synced with device',
)

function authHeaders() {
  return { Authorization: `Bearer ${token.value}` }
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
  }, 2000)
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
                  <span>{{ item.role }}</span>
                </li>
              </ul>
            </div>
          </section>
        </template>
      </section>
    </section>
  </main>
</template>
