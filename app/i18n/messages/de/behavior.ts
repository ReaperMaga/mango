import type { Messages } from '../en/index.ts'

export const behavior: Messages['behavior'] = {
  description: 'Wie Nachrichten gesendet werden und was ein Chat zeigt, während der Agent arbeitet.',
  composer: 'Eingabefeld',
  sendKey: {
    label: 'Tastenkürzel zum Senden',
    hint: 'Lege fest, wann Enter sendet oder eine neue Zeile einfügt.',
  },
  followUps: 'Folgenachrichten',
  followUp: {
    label: 'Verhalten bei Folgenachrichten',
    hint: 'Nachrichten während der Arbeit des Agenten einreihen oder den laufenden Durchgang lenken. {shortcut} macht für eine Nachricht das Gegenteil.',
    queue: 'Einreihen',
    steer: 'Lenken',
  },
  activity: 'Aktivität',
  toolCalls: {
    label: 'Werkzeugaufrufe im Chat',
    hint: 'Blendet Befehle, Änderungen und Suchen der Agenten aus. „Erfolgreiche ausblenden“ behält Fehlschläge. Zen zeigt nur Endantworten. Freigaben, Fragen und Fehler sind immer sichtbar.',
    all: 'Alle zeigen',
    'hide-ok': 'Erfolgreiche ausblenden',
    hide: 'Alle ausblenden',
    zen: 'Zen',
  },
}
