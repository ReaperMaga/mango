import { useCallback, useEffect, useState } from 'react'
import { AppState } from 'react-native'
import { useFocusEffect } from 'expo-router'

/**
 * Whether a screen is being looked at: focused in its stack and the app in front. Screens read
 * GitHub again on a timer only while this is true, so nothing is read for a hidden screen.
 */
export function useWatching(): boolean {
  const [focused, setFocused] = useState(true)
  const [inFront, setInFront] = useState(AppState.currentState === 'active')
  useFocusEffect(useCallback(() => {
    setFocused(true)
    return () => setFocused(false)
  }, []))
  useEffect(() => {
    const sub = AppState.addEventListener('change', next => setInFront(next === 'active'))
    return () => sub.remove()
  }, [])
  return focused && inFront
}
