import { contextBridge, ipcRenderer } from 'electron'
import type {
  ChatGPTStatus,
  GenEvent,
  IpcApi,
  LibraryChangedEvent,
  NotifiedEvent,
  NoticesState
} from '../shared/types'

/**
 * Electron reports a failed handler as "Error invoking remote method 'x': Error: <message>".
 * Only <message> is written for people, so every call goes through here and the window never
 * sees the prefix.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function invoke(channel: string, ...args: unknown[]): Promise<any> {
  return ipcRenderer.invoke(channel, ...args).catch((e: unknown) => {
    const raw = e instanceof Error ? e.message : String(e)
    throw new Error(raw.replace(/^Error invoking remote method '[^']*':\s*(?:\w*Error:\s*)?/, ''))
  })
}

const api: IpcApi = {
  library: {
    list: () => invoke('library:list'),
    rename: (id, name) => invoke('library:rename', id, name),
    setIcon: (id, icon) => invoke('library:setIcon', id, icon),
    duplicate: (id) => invoke('library:duplicate', id),
    trash: (id) => invoke('library:trash', id),
    listTrash: () => invoke('library:listTrash'),
    restore: (id) => invoke('library:restore', id),
    emptyTrash: () => invoke('library:emptyTrash'),
    deleteTrashed: (id) => invoke('library:deleteTrashed', id),
    layout: () => invoke('library:layout'),
    createFolder: (name) => invoke('library:createFolder', name),
    updateFolder: (id, patch) => invoke('library:updateFolder', id, patch),
    deleteFolder: (id) => invoke('library:deleteFolder', id),
    reorderFolders: (ids) => invoke('library:reorderFolders', ids),
    setPinned: (ids) => invoke('library:setPinned', ids),
    setFolder: (appId, folderId) => invoke('library:setFolder', appId, folderId),
    assets: (id) => invoke('library:assets', id),
    removeAsset: (id, name) => invoke('library:removeAsset', id, name),
    onChanged: (cb) => {
      const handler = (_e: Electron.IpcRendererEvent, payload: LibraryChangedEvent): void =>
        cb(payload)
      ipcRenderer.on('library:changed', handler)
      return () => {
        ipcRenderer.removeListener('library:changed', handler)
      }
    }
  },
  versions: {
    setCurrent: (id, n) => invoke('versions:setCurrent', id, n)
  },
  chat: {
    read: (id) => invoke('chat:read', id)
  },
  settings: {
    get: () => invoke('settings:get'),
    set: (patch) => invoke('settings:set', patch)
  },
  exporter: {
    saveHtml: (appId, version) => invoke('exporter:saveHtml', appId, version),
    reveal: (path) => invoke('exporter:reveal', path)
  },
  libraryLocation: {
    pick: () => invoke('libraryLocation:pick'),
    moveTo: (path) => invoke('libraryLocation:moveTo', path),
    useExisting: (path) => invoke('libraryLocation:useExisting', path),
    reset: () => invoke('libraryLocation:reset')
  },
  secrets: {
    status: () => invoke('secrets:status'),
    setKey: (key) => invoke('secrets:setKey', key),
    clearKey: () => invoke('secrets:clearKey'),
    testKey: () => invoke('secrets:testKey')
  },
  models: {
    list: () => invoke('models:list')
  },
  chatgpt: {
    status: () => invoke('chatgpt:status'),
    signIn: () => invoke('chatgpt:signIn'),
    cancelSignIn: () => invoke('chatgpt:cancelSignIn'),
    signOut: () => invoke('chatgpt:signOut'),
    onStatus: (cb) => {
      const handler = (_e: Electron.IpcRendererEvent, payload: ChatGPTStatus): void => cb(payload)
      ipcRenderer.on('chatgpt:status', handler)
      return () => {
        ipcRenderer.removeListener('chatgpt:status', handler)
      }
    }
  },
  attachments: {
    stage: (name, mime, data, model) => invoke('attachments:stage', name, mime, data, model),
    discard: (id) => invoke('attachments:discard', id)
  },
  gen: {
    start: (jobId, req) => invoke('gen:start', jobId, req),
    stop: (jobId) => invoke('gen:stop', jobId),
    onEvent: (cb) => {
      const handler = (_e: Electron.IpcRendererEvent, payload: GenEvent): void => cb(payload)
      ipcRenderer.on('gen:event', handler)
      return () => {
        ipcRenderer.removeListener('gen:event', handler)
      }
    }
  },
  notices: {
    get: () => invoke('notices:get'),
    check: () => invoke('notices:check'),
    dismiss: (id) => invoke('notices:dismiss', id),
    open: (id) => invoke('notices:open', id),
    onChanged: (cb) => {
      const handler = (_e: Electron.IpcRendererEvent, payload: NoticesState): void => cb(payload)
      ipcRenderer.on('notices:changed', handler)
      return () => {
        ipcRenderer.removeListener('notices:changed', handler)
      }
    }
  },
  bridge: {
    call: (appId, method, args) => invoke('bridge:call', appId, method, args),
    openLink: (url) => invoke('bridge:openLink', url),
    onOpenApp: (cb) => {
      const handler = (_e: Electron.IpcRendererEvent, appId: string): void => cb(appId)
      ipcRenderer.on('bridge:openApp', handler)
      return () => {
        ipcRenderer.removeListener('bridge:openApp', handler)
      }
    },
    onNotified: (cb) => {
      const handler = (_e: Electron.IpcRendererEvent, payload: NotifiedEvent): void => cb(payload)
      ipcRenderer.on('bridge:notified', handler)
      return () => {
        ipcRenderer.removeListener('bridge:notified', handler)
      }
    },
    setShown: (appId) => invoke('bridge:setShown', appId)
  }
}

contextBridge.exposeInMainWorld('api', api)
contextBridge.exposeInMainWorld('platform', process.platform)
