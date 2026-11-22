/**
 * The paths of models' URIs, `/~<n>/<file>`, `n` new for every model ever made: Monaco's workers and
 * services cache by URI and version, and a file opened again starts at version 1 with other text.
 */
export class ModelUris {
  private projects: string[] = []

  next(project: string, file: string): string {
    this.projects.push(project)
    return `/~${this.projects.length - 1}/${file}`
  }

  /** The project and file a path stands for; a model's top folder is the project's (`file` empty). */
  locate(path: string): { project: string; file: string } | null {
    const m = /^\/~(\d+)(?:\/(.*))?$/s.exec(path)
    const project = m ? this.projects[Number(m[1])] : undefined
    if (project === undefined) return null
    const file = m![2] ?? ''
    // Links in a file can spell such a path too: never out of the folder.
    if (file && file.split(/[\\/]/).some(part => part === '' || part === '.' || part === '..')) return null
    return { project, file }
  }
}
