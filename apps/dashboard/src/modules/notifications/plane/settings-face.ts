import { useState } from 'react'

export type SettingsFace = 'rules' | 'watching' | 'alerts'

/** The settings face's own local state (kept by the plane so Back returns to the same lens). */
export function useSettingsFace() {
  const [face, setFace] = useState<SettingsFace>('rules')
  const [focusRule, setFocusRule] = useState<string | null>(null)
  return { face, setFace, focusRule, setFocusRule }
}
