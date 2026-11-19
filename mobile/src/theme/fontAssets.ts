import type { FontSource } from 'expo-font'
import { Inter_400Regular } from '@expo-google-fonts/inter/400Regular'
import { Inter_500Medium } from '@expo-google-fonts/inter/500Medium'
import { Inter_600SemiBold } from '@expo-google-fonts/inter/600SemiBold'
import { Inter_700Bold } from '@expo-google-fonts/inter/700Bold'
import { Inter_400Regular_Italic } from '@expo-google-fonts/inter/400Regular_Italic'
import { Geist_400Regular } from '@expo-google-fonts/geist/400Regular'
import { Geist_500Medium } from '@expo-google-fonts/geist/500Medium'
import { Geist_600SemiBold } from '@expo-google-fonts/geist/600SemiBold'
import { Geist_700Bold } from '@expo-google-fonts/geist/700Bold'
import { Geist_400Regular_Italic } from '@expo-google-fonts/geist/400Regular_Italic'
import { DMSans_400Regular } from '@expo-google-fonts/dm-sans/400Regular'
import { DMSans_500Medium } from '@expo-google-fonts/dm-sans/500Medium'
import { DMSans_600SemiBold } from '@expo-google-fonts/dm-sans/600SemiBold'
import { DMSans_700Bold } from '@expo-google-fonts/dm-sans/700Bold'
import { DMSans_400Regular_Italic } from '@expo-google-fonts/dm-sans/400Regular_Italic'
import { Manrope_400Regular } from '@expo-google-fonts/manrope/400Regular'
import { Manrope_500Medium } from '@expo-google-fonts/manrope/500Medium'
import { Manrope_600SemiBold } from '@expo-google-fonts/manrope/600SemiBold'
import { Manrope_700Bold } from '@expo-google-fonts/manrope/700Bold'
import { JetBrainsMono_400Regular } from '@expo-google-fonts/jetbrains-mono/400Regular'
import { JetBrainsMono_500Medium } from '@expo-google-fonts/jetbrains-mono/500Medium'
import { JetBrainsMono_600SemiBold } from '@expo-google-fonts/jetbrains-mono/600SemiBold'
import { FiraCode_400Regular } from '@expo-google-fonts/fira-code/400Regular'
import { FiraCode_500Medium } from '@expo-google-fonts/fira-code/500Medium'
import { FiraCode_600SemiBold } from '@expo-google-fonts/fira-code/600SemiBold'
import { SourceCodePro_400Regular } from '@expo-google-fonts/source-code-pro/400Regular'
import { SourceCodePro_500Medium } from '@expo-google-fonts/source-code-pro/500Medium'
import { SourceCodePro_600SemiBold } from '@expo-google-fonts/source-code-pro/600SemiBold'
import { GeistMono_400Regular } from '@expo-google-fonts/geist-mono/400Regular'
import { GeistMono_500Medium } from '@expo-google-fonts/geist-mono/500Medium'
import { GeistMono_600SemiBold } from '@expo-google-fonts/geist-mono/600SemiBold'

/** Every font file the app can use, by the family name `fonts.ts` gives it. Only the chosen ones are loaded. */
export const FONT_FILES: Record<string, FontSource> = {
  Inter_400Regular, Inter_500Medium, Inter_600SemiBold, Inter_700Bold, Inter_400Regular_Italic,
  Geist_400Regular, Geist_500Medium, Geist_600SemiBold, Geist_700Bold, Geist_400Regular_Italic,
  DMSans_400Regular, DMSans_500Medium, DMSans_600SemiBold, DMSans_700Bold, DMSans_400Regular_Italic,
  Manrope_400Regular, Manrope_500Medium, Manrope_600SemiBold, Manrope_700Bold,
  JetBrainsMono_400Regular, JetBrainsMono_500Medium, JetBrainsMono_600SemiBold,
  FiraCode_400Regular, FiraCode_500Medium, FiraCode_600SemiBold,
  SourceCodePro_400Regular, SourceCodePro_500Medium, SourceCodePro_600SemiBold,
  GeistMono_400Regular, GeistMono_500Medium, GeistMono_600SemiBold,
}
