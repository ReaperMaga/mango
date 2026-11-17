import { useLocalSearchParams } from 'expo-router'
import { SCHEME_PREFIX } from '@/remote/shareLink'
import { JoinScreen } from '@/screens/JoinScreen'

/**
 * A share link opened from outside: `mango://join/<payload>` arrives here (see `+native-intent.tsx`)
 * and the Join modal opens with the link filled in, showing what it would join before anything is saved.
 */
export default function JoinLink() {
  const { payload } = useLocalSearchParams<{ payload: string }>()
  return <JoinScreen initialLink={payload ? `${SCHEME_PREFIX}${payload}` : undefined} />
}
