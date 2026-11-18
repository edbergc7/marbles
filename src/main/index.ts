import {
  app,
  BrowserWindow,
  dialog,
  Menu,
  nativeTheme,
  net,
  Notification,
  session,
  shell
} from 'electron'
import type { MenuItemConstructorOptions } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { registerIpc } from './ipc'
import { SettingsService } from './services/settings'
import { LibraryService } from './services/library'
import type { NoticeWithUrl } from './services/notices'
import { LibraryWatcher } from './services/watcher'
import { registerAppFrameProtocol, registerSchemes } from './services/appframe'
import { registerAppProtocol } from './services/appScheme'
import { guardAppFrameRequests } from './services/appFrameNet'
import { CdnCache } from './services/cdnCache'
import { BridgeService } from './services/bridge'
import { SecretsService } from './services/secrets'
import { LLMService } from './services/llm'
import { ChatGPTAuth } from './services/chatgpt/auth'
import { ChatGPTClient } from './services/chatgpt/client'
import { GeneratorService } from './services/generator'
import { AttachmentStore } from './services/attachments'
import { ExporterService } from './services/exporter'
import { createAiHandler } from './services/hostAi'
import { NotifierService } from './services/notifier'
import { NoticesService } from './services/notices'
import { ANNOUNCEMENTS_BRANCH, GITHUB_REPO } from './project'
import {
  APP_INDEX_URL,
  appPageFor,
  createPromptGate,
  isAllowedPermission,
  isAppPageUrl,
  linkPromptText,
  parseOpenableUrl
} from './services/guard'
import type { GenEvent, NoticesState, Settings, ThemeSetting } from '../shared/types'

app.setPath('userData', join(app.getPath('appData'), 'Marbles'))
// Dev only: a throwaway data folder, e.g. to see first-run setup without touching the real library.
if (!app.isPackaged && process.env['MARBLES_USER_DATA']) {
  app.setPath('userData', process.env['MARBLES_USER_DATA'])
}

// One Marbles per data folder: two would overwrite each other's settings and library files.
// Asked after userData is set, because the lock is kept per data folder.
const firstInstance = app.requestSingleInstanceLock()
if (!firstInstance) app.quit()
app.on('second-instance', () => {
  const win = BrowserWindow.getAllWindows()[0]
  if (!win) return
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
})

// Must run before app is ready.
registerSchemes()

const OVERLAY_DARK = { color: '#1d1d1d', symbolColor: '#a3a3a3' }
const OVERLAY_LIGHT = { color: '#fafaf9', symbolColor: '#5f5f5f' }

function isDark(theme: ThemeSetting): boolean {
  return theme === 'system' ? nativeTheme.shouldUseDarkColors : theme === 'dark'
}

function applyChrome(theme: ThemeSetting): void {
  nativeTheme.themeSource = theme
  if (process.platform === 'darwin') return
  const o = isDark(theme) ? OVERLAY_DARK : OVERLAY_LIGHT
  for (const win of BrowserWindow.getAllWindows()) {
    try {
      win.setTitleBarOverlay({ ...o, height: 44 })
    } catch {
      // overlay not supported on this window
    }
  }
}

function broadcastChanged(ids: string[]): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('library:changed', { ids })
  }
}

function broadcastGenEvent(e: GenEvent): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('gen:event', e)
  }
}

function broadcastNotices(s: NoticesState): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('notices:changed', s)
  }
}

/** GETs a small JSON file from GitHub. Uses Chromium's network stack, so system proxies apply. */
async function fetchJson(url: string): Promise<unknown> {
  const res = await net.fetch(url, {
    headers: { accept: 'application/vnd.github+json, application/json', 'user-agent': 'Marbles' },
    cache: 'no-store',
    credentials: 'omit',
    signal: AbortSignal.timeout(15_000)
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const text = await res.text()
  if (text.length > 256 * 1024) throw new Error('response too large')
  return JSON.parse(text)
}

/**
 * Where notices come from. Dev builds can point elsewhere to test:
 * MARBLES_UPDATE_REPO=owner/name, MARBLES_ANNOUNCEMENTS_URL=<url>, MARBLES_FAKE_VERSION=0.1.0.
 */
function noticeSources(): {
  repo: string | null
  releasesUrl: string | null
  announcementsUrl: string | null
  version: string
} {
  const dev = !app.isPackaged
  const env = (k: string): string | undefined => (dev ? process.env[k] || undefined : undefined)
  const repo = env('MARBLES_UPDATE_REPO') ?? GITHUB_REPO
  return {
    repo,
    releasesUrl: repo ? `https://api.github.com/repos/${repo}/releases/latest` : null,
    announcementsUrl:
      env('MARBLES_ANNOUNCEMENTS_URL') ??
      (repo
        ? `https://raw.githubusercontent.com/${repo}/${ANNOUNCEMENTS_BRANCH}/announcements.json`
        : null),
    version: env('MARBLES_FAKE_VERSION') ?? app.getVersion()
  }
}

const DEV_URL = is.dev ? process.env['ELECTRON_RENDERER_URL'] : undefined
const RENDERER_DIR = join(__dirname, '../renderer')
const APP_PAGE = appPageFor(DEV_URL)

/** The app's own renderer page: the dev server's origin, or app://marbles. */
function isAppUrl(url: string): boolean {
  return isAppPageUrl(url, APP_PAGE)
}

/** Same appframe page (scheme, host and path), ignoring query and hash. */
function samePage(a: string, b: string): boolean {
  try {
    const x = new URL(a)
    const y = new URL(b)
    return x.protocol === y.protocol && x.host === y.host && x.pathname === y.pathname
  } catch {
    return false
  }
}

/** Links from the trusted host UI open directly. */
function openFromHost(url: string): void {
  const u = parseOpenableUrl(url)
  if (u) void shell.openExternal(u.href)
}

const linkGate = createPromptGate()

/** Links from a generated app need a click in a native dialog first, one dialog at a time. */
async function openFromApp(win: BrowserWindow, url: string): Promise<void> {
  const u = parseOpenableUrl(url)
  if (!u || win.isDestroyed() || !linkGate.tryOpen()) return
  let open = false
  try {
    const { message, detail } = linkPromptText(u)
    const res = await dialog.showMessageBox(win, {
      type: 'question',
      buttons: ['Cancel', 'Open link'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
      message,
      detail
    })
    open = res.response === 1
  } finally {
    linkGate.close(!open)
  }
  if (open) void shell.openExternal(u.href)
}

/** Grants only clipboard writes; Electron would otherwise grant every permission. */
function setupPermissions(): void {
  const ses = session.defaultSession
  ses.setPermissionRequestHandler((_wc, permission, callback) =>
    callback(isAllowedPermission(permission))
  )
  ses.setPermissionCheckHandler((_wc, permission) => isAllowedPermission(permission))
  ses.setDevicePermissionHandler(() => false)
}

/**
 * Electron shows no context menu by default, so right-clicking a misspelled word did nothing.
 * Text fields get spelling suggestions plus the usual edit items; selected text gets Copy.
 */
function setupContextMenu(win: BrowserWindow): void {
  win.webContents.on('context-menu', (_event, params) => {
    const items: MenuItemConstructorOptions[] = []
    if (params.isEditable) {
      if (params.misspelledWord) {
        for (const s of params.dictionarySuggestions.slice(0, 5)) {
          items.push({ label: s, click: () => win.webContents.replaceMisspelling(s) })
        }
        if (!params.dictionarySuggestions.length)
          items.push({ label: 'No suggestions', enabled: false })
        items.push(
          {
            label: 'Add to dictionary',
            click: () =>
              win.webContents.session.addWordToSpellCheckerDictionary(params.misspelledWord)
          },
          { type: 'separator' }
        )
      }
      const f = params.editFlags
      items.push(
        { role: 'undo', enabled: f.canUndo },
        { role: 'redo', enabled: f.canRedo },
        { type: 'separator' },
        { role: 'cut', enabled: f.canCut },
        { role: 'copy', enabled: f.canCopy },
        { role: 'paste', enabled: f.canPaste },
        { type: 'separator' },
        { role: 'selectAll', enabled: f.canSelectAll }
      )
    } else if (params.selectionText.trim()) {
      items.push({ role: 'copy' })
    }
    if (items.length) Menu.buildFromTemplate(items).popup({ window: win })
  })
}

function createWindow(theme: ThemeSetting): void {
  const overlay = isDark(theme) ? OVERLAY_DARK : OVERLAY_LIGHT
  const mainWindow = new BrowserWindow({
    width: 1400,
    height: 880,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#141414',
    ...(process.platform === 'darwin'
      ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 16, y: 15 } }
      : { titleBarStyle: 'hidden' as const, titleBarOverlay: { ...overlay, height: 44 } }),
    show: false,
    autoHideMenuBar: true,
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true
    }
  })

  // ready-to-show can fail to fire for a hidden window (seen on Wayland without
  // a GPU), so finishing the page load also shows it.
  const showWindow = (): void => {
    if (!mainWindow.isDestroyed() && !mainWindow.isVisible()) mainWindow.show()
  }
  mainWindow.once('ready-to-show', showWindow)
  mainWindow.webContents.once('did-finish-load', showWindow)

  // WebRTC would let an app reach the network around its CSP; this stops its direct UDP.
  // The app frame's shim also removes the WebRTC API itself.
  mainWindow.webContents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp')

  // Never open new windows. Electron 44 doesn't say which frame called window.open, but the
  // app iframe has no allow-popups, so Chromium blocks it there and only the host UI gets
  // here: its http(s) links go to the system browser. A referrer from anywhere else is
  // treated as an app link, to fail closed.
  mainWindow.webContents.setWindowOpenHandler(({ url, referrer }) => {
    if (referrer.url && !isAppUrl(referrer.url)) void openFromApp(mainWindow, url)
    else openFromHost(url)
    return { action: 'deny' }
  })

  // The app iframe may not navigate away from appframe://. Its links normally arrive through
  // the shim (bridge:openLink); a navigation that gets here anyway is cancelled and prompted.
  mainWindow.webContents.on('will-frame-navigate', (event) => {
    if (!event.isMainFrame) {
      let proto = ''
      try {
        proto = new URL(event.url).protocol
      } catch {
        // unparsable: block
      }
      // Only the app iframe itself (a direct child of the host page) may load anything.
      // A frame nested inside an app gets no new documents: each would be a fresh realm
      // the shim hasn't locked down.
      let appFrame = false
      try {
        appFrame = !!event.frame?.parent && !event.frame.parent.parent
      } catch {
        // disposed frame: block
      }
      if (appFrame && event.url === 'about:blank') return
      // A new iframe (blank) may load any app page; after that a frame may only reload its own
      // page, so app A can't pull app B into its frame (B would then run against A's storage).
      if (appFrame && proto === 'appframe:') {
        let current = ''
        try {
          current = event.frame?.url ?? ''
        } catch {
          // disposed frame: block
        }
        if (!current || current === 'about:blank' || samePage(current, event.url)) return
      }
      event.preventDefault()
      void openFromApp(mainWindow, event.url)
    }
  })

  setupContextMenu(mainWindow)

  // Block navigation away from the app itself.
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!isAppUrl(url)) event.preventDefault()
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadURL(APP_INDEX_URL)
  }
}

function setupMenu(): void {
  if (process.platform === 'darwin') {
    Menu.setApplicationMenu(
      Menu.buildFromTemplate([
        { role: 'appMenu' },
        { role: 'editMenu' },
        { role: 'viewMenu' },
        { role: 'windowMenu' }
      ])
    )
  } else {
    Menu.setApplicationMenu(null)
  }
}

app.whenReady().then(async () => {
  if (!firstInstance) return
  electronApp.setAppUserModelId('com.marbles.app')

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  setupMenu()
  setupPermissions()

  const settings = new SettingsService()
  const library = new LibraryService(async () => (await settings.get()).libraryPath)
  // The "library is from a newer Marbles" banner follows library.json, which changes under us
  // when the folder is synced or switched. An empty id list means the layout file changed.
  let libraryTooNew = false
  const onLibraryChanged = (ids: string[]): void => {
    broadcastChanged(ids)
    if (ids.length) return
    void library.tooNew().then((now) => {
      if (now !== libraryTooNew) void notices.refresh()
    })
  }
  library.setNotifier(onLibraryChanged)
  const watcher = new LibraryWatcher(
    async () => (await settings.get()).libraryPath,
    onLibraryChanged
  )
  void watcher.start()
  registerAppFrameProtocol({ library, settings, isHostUrl: isAppUrl })
  if (!DEV_URL) registerAppProtocol(RENDERER_DIR)
  guardAppFrameRequests(
    session.defaultSession,
    async () => (await settings.get()).allowLocalNetwork
  )
  new CdnCache(join(app.getPath('userData'), 'cdn-cache')).register()
  const secrets = new SecretsService()
  const chatgpt = new ChatGPTClient(new ChatGPTAuth())
  chatgpt.auth.onStatus((st) => {
    if (st.state !== 'signed_in') chatgpt.clearModels()
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send('chatgpt:status', st)
    }
  })
  const llm = new LLMService(secrets, chatgpt)
  /** The app on screen in the window, as the renderer last reported it. */
  let shownApp: string | null = null
  const mainWin = (): BrowserWindow | undefined =>
    BrowserWindow.getAllWindows().find((w) => !w.isDestroyed())
  const notifier = new NotifierService({
    appName: async (id) => (await library.get(id))?.name ?? null,
    isWatched: (id) => {
      const win = mainWin()
      return shownApp === id && !!win && win.isFocused() && !win.isMinimized()
    },
    onFired: (appId, alarm) => mainWin()?.webContents.send('bridge:notified', { appId, alarm }),
    show: (title, body, onClick) => {
      if (!Notification.isSupported()) return
      // Silent: the window plays Marbles' own chime or alarm, the same on every system.
      const n = new Notification({ title, body, silent: true })
      n.on('click', onClick)
      n.show()
    },
    onClick: (appId) => {
      const win = mainWin()
      if (!win) return
      if (win.isMinimized()) win.restore()
      win.show()
      win.focus()
      win.webContents.send('bridge:openApp', appId)
    }
  })
  const bridge = new BridgeService(
    library,
    async () => (await settings.get()).allowLocalNetwork,
    createAiHandler(llm, settings),
    notifier
  )
  const attachments = new AttachmentStore(join(app.getPath('userData'), 'staging'))
  void attachments.clear()
  const generator = new GeneratorService({
    library,
    settings,
    llm,
    attachments,
    emit: broadcastGenEvent
  })
  const exporter = new ExporterService({ library, settings })
  const notices = new NoticesService({
    ...noticeSources(),
    platform: process.platform,
    fetchJson,
    isEnabled: async () => (await settings.get()).checkForUpdates,
    getDismissed: async () => (await settings.get()).dismissedNotices ?? [],
    setDismissed: async (ids) => {
      await settings.set({ dismissedNotices: ids })
    },
    openUrl: openFromHost,
    emit: broadcastNotices,
    local: async (): Promise<NoticeWithUrl[]> => {
      libraryTooNew = await library.tooNew()
      if (!libraryTooNew) return []
      return [
        {
          id: 'local:library-too-new',
          kind: 'announcement',
          level: 'warning',
          title: 'This library was saved by a newer version of Marbles',
          body: 'You can open and export your apps, but not change them until you update Marbles.',
          dismissible: false,
          ...(GITHUB_REPO
            ? {
                linkLabel: 'Get the update',
                url: `https://github.com/${GITHUB_REPO}/releases/latest`
              }
            : {})
        }
      ]
    }
  })

  registerIpc({
    chatgpt,
    exporter,
    notices,
    library,
    settings,
    bridge,
    secrets,
    llm,
    generator,
    attachments,
    isAppUrl,
    openFromApp: (win, url) => void openFromApp(win, url),
    setShownApp: (id) => {
      shownApp = id
    },
    onSettingsChanged: (next: Settings, prev: Settings) => {
      if (next.theme !== prev.theme) applyChrome(next.theme)
      if (next.checkForUpdates !== prev.checkForUpdates) {
        void (next.checkForUpdates ? notices.check() : notices.reset())
      }
      if (next.libraryPath !== prev.libraryPath) {
        void watcher.start()
        onLibraryChanged([])
      }
    }
  })

  const initial = (await settings.get()).theme
  nativeTheme.themeSource = initial
  nativeTheme.on('updated', () => {
    void settings.get().then((s) => {
      if (s.theme === 'system') applyChrome('system')
    })
  })
  createWindow(initial)
  // A few seconds after startup so it never slows the first paint, then twice a day.
  notices.start(8_000, 12 * 60 * 60 * 1000)

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) {
      void settings.get().then((s) => createWindow(s.theme))
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
