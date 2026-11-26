import type { Messages } from '../en/index.ts'

export const general: Messages['general'] = {
  description: 'Vorgaben für neue Chats und wobei Mango vorher nachfragt.',
  language: {
    title: 'Sprache',
    hint: 'Die Sprache der Oberfläche. Antworten der Agenten und Terminalausgaben werden nicht übersetzt.',
    label: 'Sprache der Oberfläche',
    system: 'System',
  },
  permissions: {
    title: 'Berechtigungen für neue Chats',
    hint: 'Wie viel ein Agent tun darf, bevor er nachfragt. Du kannst das in jedem Chat ändern.',
  },
  modes: {
    plan: {
      label: 'Planen',
      hint: 'Nur Lesen. Der Agent sieht sich um und schlägt einen Plan vor, ändert aber nichts.',
    },
    ask: {
      label: 'Erst fragen',
      hint: 'Der Agent fragt vor jeder Änderung und jedem Befehl.',
    },
    edits: {
      label: 'Änderungen erlauben',
      hint: 'Der Agent ändert Dateien ohne Nachfrage, fragt aber weiterhin vor Befehlen.',
    },
    auto: {
      label: 'Vollautomatisch',
      hint: 'Der Agent fragt nie. Er ändert Dateien und führt Befehle selbstständig aus.',
    },
  },
  confirm: {
    title: 'Bestätigungen',
    hint: 'Fragen, die Mango stellt, bevor es deine Chats ändert.',
    archive: 'Archivieren bestätigen',
    archiveHint: 'Nachfragen, bevor ein Chat ins Archiv wandert.',
    delete: 'Löschen bestätigen',
    deleteHint: 'Nachfragen, bevor ein Chat samt Nachrichten gelöscht wird.',
  },
  windows: {
    title: 'Fenster',
    hint: 'Ein Fenster kann mehrere Projekte enthalten, oder jedes bekommt sein eigenes.',
    openIn: 'Projekt öffnen in',
    openInHint: 'Wenn in diesem Fenster schon andere Projekte offen sind.',
    ask: 'Jedes Mal fragen',
    this: 'Diesem Fenster',
    new: 'Neuem Fenster',
  },
}
