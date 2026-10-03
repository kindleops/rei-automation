import type { MouseEvent } from 'react'
import { handleObjectClick, openObject } from '../desktop/objects'
import { openPath } from '../../views/home/desktop/board/widget-runtime'
import type { BriefLine } from './brief-model'

/** Open what a line cites: its object through the registry (⌘ beside · ⇧ inspect), else the owning app's path. */
export function openCitation(line: BriefLine, e?: MouseEvent) {
  const { ref, path } = line.cite
  if (ref) {
    handleObjectClick(e, ref, () => { const r = openObject(ref); if (!r.ok && path) openPath(path) })
    return
  }
  if (path) openPath(path, Boolean(e && (e.metaKey || e.ctrlKey)))
}

