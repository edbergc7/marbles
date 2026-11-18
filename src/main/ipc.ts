import { BrowserWindow, dialog, ipcMain } from 'electron'
import type { IpcMainInvokeEvent } from 'electron'
import type { LibraryService } from './services/library'
import type { SettingsService } from './services/settings'
import type { BridgeService } from './services/bridge'
import type { SecretsService } from './services/secrets'
import type { LLMService } from './services/llm'
import type { GeneratorService } from './services/generator'
import type { AttachmentStore } from './services/attachments'
import type { ChatGPTClient } from './services/chatgpt/client'
import { chatgptRoleDefaults } from './services/chatgpt/roles'
import { isChatGPTModel } from './services/chatgpt/protocol'
import type { ExporterService } from './services/exporter'
import type { NoticesService } from './services/notices'
import { LibraryLocationService } from './services/libraryLocation'
import { cleanSettingsPatch, isTrustedSender } from './services/guard'
import type { BridgeMethod, GenRequest, Settings } from '../shared/types'

export function registerIpc(deps: {
  library: LibraryService
  settings: SettingsService
  bridge: BridgeService
  secrets: SecretsService
  llm: LLMService
  generator: GeneratorService
  attachments: AttachmentStore
  exporter: ExporterService
  chatgpt: ChatGPTClient
  notices: NoticesService
  /** True for the app's own renderer page; IPC from anything else is rejected. */
  isAppUrl: (url: string) => boolean
  /** Asks the person, then opens an app's http(s) link in their browser. */
  openFromApp: (win: BrowserWindow, url: string) => void
  /** The app the window shows (null: none); see NotifierDeps.isWatched. */
  setShownApp: (appId: string | null) => void
  onSettingsChanged?: (next: Settings, prev: Settings) => void
}): void {
  const { library, settings } = deps

  /**
   * Every handler goes through this: only the main frame of a window showing the app's own
   * page may call in. The app iframe has no preload, so this is defence in depth.
   */
  function handle<A extends unknown[]>(
    channel: string,
    fn: (event: IpcMainInvokeEvent, ...args: A) => unknown
  ): void {
    ipcMain.handle(channel, (event, ...args) => {
      let trusted = false
      try {
        trusted = isTrustedSender(event.senderFrame, event.sender.mainFrame, deps.isAppUrl)
      } catch {
        // destroyed webContents or frame
      }
      if (!trusted) {
        throw new Error(`Blocked IPC call from an untrusted frame: ${channel}`)
      }
      return fn(event, ...(args as A))
    })
  }

  const applySettings = async (patch: Partial<Settings>): Promise<Settings> => {
    const prev = await settings.get()
    const next = await settings.set(patch)
    deps.onSettingsChanged?.(next, prev)
    return next
  }
  const location = new LibraryLocationService({
    settings,
    applySettings,
    isBusy: () => deps.generator.isBusy(),
    settle: async (): Promise<void> => {
      await Promise.all([library.settle(), deps.bridge.settle()])
    }
  })

  const RELOCATING_MSG = 'Your library is being moved. Try again in a moment'

  /** Rejects a library-writing handler while the library is relocating. */
  function gateWrite<A extends unknown[], R>(
    fn: (event: IpcMainInvokeEvent, ...args: A) => R
  ): (event: IpcMainInvokeEvent, ...args: A) => Promise<R> {
    return (event, ...args): Promise<R> => {
      if (location.isRelocating()) return Promise.reject(new Error(RELOCATING_MSG))
      return Promise.resolve(fn(event, ...args))
    }
  }

  handle('library:list', () => library.list())
  handle(
    'library:rename',
    gateWrite((_e, id: string, name: string) => library.rename(id, name))
  )
  handle(
    'library:setIcon',
    gateWrite((_e, id: string, icon: string) => library.setIcon(id, icon))
  )
  handle(
    'library:duplicate',
    gateWrite((_e, id: string) => library.duplicate(id))
  )
  handle(
    'library:trash',
    gateWrite((_e, id: string) => library.trash(id))
  )
  handle('library:listTrash', () => library.listTrash())
  handle(
    'library:restore',
    gateWrite((_e, id: string) => library.restore(id))
  )

  // Asks for confirmation here in the main process, so nothing in the renderer can skip it.
  // Resolves with the number of apps deleted, or null when the user cancels.
  handle(
    'library:emptyTrash',
    gateWrite(async (e) => {
      const items = await library.listTrash()
      if (!items.length) return 0
      const win = BrowserWindow.fromWebContents(e.sender)
      const opts = {
        type: 'warning' as const,
        buttons: ['Cancel', 'Delete forever'],
        defaultId: 0,
        cancelId: 0,
        message:
          items.length === 1 ? 'Delete 1 app forever?' : `Delete ${items.length} apps forever?`,
        detail:
          "They will be removed from this computer with all their versions. This can't be undone."
      }
      const res = win ? await dialog.showMessageBox(win, opts) : await dialog.showMessageBox(opts)
      if (res.response !== 1) return null
      return library.emptyTrash()
    })
  )
  // Confirmed here in main, like emptyTrash. Resolves true when deleted, false when cancelled.
  handle(
    'library:deleteTrashed',
    gateWrite(async (e, id: string) => {
      const item = (await library.listTrash()).find((t) => t.id === id)
      if (!item) throw new Error(`Not in trash: ${id}`)
      const win = BrowserWindow.fromWebContents(e.sender)
      const opts = {
        type: 'warning' as const,
        buttons: ['Cancel', 'Delete forever'],
        defaultId: 0,
        cancelId: 0,
        message: `Delete "${item.name}" forever?`,
        detail: "It will be removed from this computer with all its versions. This can't be undone."
      }
      const res = win ? await dialog.showMessageBox(win, opts) : await dialog.showMessageBox(opts)
      if (res.response !== 1) return false
      await library.deleteTrashed(id)
      return true
    })
  )
  handle('library:layout', () => library.layout())
  handle(
    'library:createFolder',
    gateWrite((_e, name: string) => library.createFolder(name))
  )
  handle(
    'library:updateFolder',
    gateWrite((_e, id: string, patch: { name?: string }) => library.updateFolder(id, patch ?? {}))
  )
  handle(
    'library:deleteFolder',
    gateWrite((_e, id: string) => library.deleteFolder(id))
  )
  handle(
    'library:reorderFolders',
    gateWrite((_e, ids: string[]) => library.reorderFolders(ids))
  )
  handle(
    'library:setPinned',
    gateWrite((_e, ids: string[]) => library.setPinned(ids))
  )
  handle('library:assets', async (_e, id: string) => {
    const files = await deps.bridge.listAssets(id)
    const meta = await library.get(id)
    const html = meta?.currentVersion
      ? await library.readVersion(id, meta.currentVersion).catch(() => '')
      : ''
    return files.map((f) => ({ ...f, used: html.includes(f.name) }))
  })
  handle(
    'library:removeAsset',
    gateWrite((_e, id: string, name: string) => library.removeAsset(id, name))
  )
  handle(
    'library:setFolder',
    gateWrite((_e, appId: string, folderId: string | null) => library.setFolder(appId, folderId))
  )

  handle(
    'versions:setCurrent',
    gateWrite((_e, id: string, n: number) => library.setCurrent(id, n))
  )

  handle('chat:read', (_e, id: string) => library.readChat(id))

  handle(
    'bridge:call',
    gateWrite((_e, appId: string, method: BridgeMethod, args: unknown[]) =>
      deps.bridge.call(appId, method, args)
    )
  )

  // A link in a generated app: main shows a prompt, so the app can only ask.
  handle('bridge:openLink', (e, url: string) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    if (win && typeof url === 'string') deps.openFromApp(win, url)
  })

  handle('bridge:setShown', (_e, appId: unknown) => {
    deps.setShownApp(typeof appId === 'string' ? appId : null)
  })

  handle('secrets:status', () => deps.secrets.status())
  handle('secrets:setKey', (_e, key: string) => deps.secrets.setKey(key))
  handle('secrets:clearKey', () => deps.secrets.clearKey())
  handle('secrets:testKey', () => deps.secrets.testKey())

  handle('models:list', () => deps.llm.listModels())

  handle('chatgpt:status', () => deps.chatgpt.auth.status())
  handle('chatgpt:cancelSignIn', () => deps.chatgpt.auth.cancelSignIn())
  handle('chatgpt:signIn', async () => {
    let status
    try {
      status = await deps.chatgpt.auth.signIn()
    } catch (err) {
      // Cancelling is not an error: just report where things stand.
      if (err instanceof Error && err.message === 'Sign-in was cancelled.') {
        return deps.chatgpt.auth.status()
      }
      throw err
    }
    deps.chatgpt.clearModels()
    // With no OpenRouter key, ChatGPT is the only way to build: point every role at it so
    // naming and host.ai() work too. With a key, leave the person's choices alone.
    if (status.state === 'signed_in' && status.planOk && !(await deps.secrets.getKey())) {
      try {
        const s = await settings.get()
        const roles = [s.builderModel, s.utilityModel, s.namingModel]
        if (!roles.every(isChatGPTModel)) {
          const picked = chatgptRoleDefaults(await deps.chatgpt.listModels())
          if (picked) await applySettings(picked)
        }
      } catch (err) {
        console.warn('[chatgpt] could not set role defaults:', err)
      }
    }
    return status
  })
  handle('chatgpt:signOut', async () => {
    const r = await deps.chatgpt.auth.signOut()
    deps.chatgpt.clearModels()
    return r
  })

  handle(
    'gen:start',
    gateWrite((_e, jobId: string, req: GenRequest) => {
      deps.generator.start(jobId, req)
    })
  )
  handle('gen:stop', (_e, jobId: string) => deps.generator.stop(jobId))
  handle(
    'attachments:stage',
    async (_e, name: unknown, mime: unknown, data: unknown, model?: unknown) => {
      return deps.attachments.stage(name, mime, data, model)
    }
  )
  handle('attachments:discard', (_e, id: unknown) => deps.attachments.discard(id))

  handle('notices:get', () => deps.notices.state())
  handle('notices:check', () => deps.notices.check())
  handle('notices:dismiss', (_e, id: string) => deps.notices.dismiss(String(id)))
  handle('notices:open', (_e, id: string) => deps.notices.open(String(id)))

  handle('settings:get', () => settings.get())
  // The window's patch is filtered; libraryPath changes only through libraryLocation below.
  handle('settings:set', (_e, patch: unknown) => applySettings(cleanSettingsPatch(patch)))

  handle('exporter:saveHtml', (e, appId: string, version?: number) =>
    deps.exporter.saveHtml(appId, version, BrowserWindow.fromWebContents(e.sender))
  )
  handle('exporter:reveal', (_e, path: string) => deps.exporter.reveal(path))

  handle('libraryLocation:pick', (e) => location.pick(BrowserWindow.fromWebContents(e.sender)))
  handle('libraryLocation:moveTo', (_e, path: string) => location.moveTo(path))
  handle('libraryLocation:useExisting', (_e, path: string) => location.useExisting(path))
  handle('libraryLocation:reset', () => location.reset())
}
