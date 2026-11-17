import { useLocalSearchParams } from 'expo-router'
import { JoinScreen } from '@/screens/JoinScreen'

/** Join from Home: `?scan=1` starts with the camera, otherwise with the paste field. */
export default function Join() {
  const { scan } = useLocalSearchParams<{ scan?: string }>()
  return <JoinScreen scan={scan === '1'} />
}
