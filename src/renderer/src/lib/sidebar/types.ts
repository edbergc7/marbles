/** Where a row is drawn. A pinned app shows under Pinned and in its folder. */
export type Ctx = 'pinned' | 'folder' | 'unfiled' | 'search'
export type Sort = 'name' | 'recent'

export type DragItem = { kind: 'app' | 'folder'; id: string; label: string; icon?: string }
