import { normalizePath } from 'obsidian'

/**
 * Vault layout: case files live in `<root>/Cases/`, task files in
 * `<root>/Tasks/<case name>/` — two tidy folders instead of a `X_tasks`
 * sibling folder sprawling next to every case file.
 *
 * Legacy layout (`<root>/X.md` + `<root>/X_tasks/`) is still recognized so
 * old vaults load unchanged and can convert via the migration command.
 */

/** True when the project file sits in a `Cases/` folder (new layout). */
export function isCasesLayout(projectPath: string): boolean {
  return /\/Cases\/[^/]+\.md$/.test(projectPath)
}

/** The task folder for a project file path, in either layout. */
export function taskFolderForProjectPath(projectPath: string): string {
  const m = /^(.*)\/Cases\/([^/]+)\.md$/.exec(projectPath)
  if (m) return `${m[1]}/Tasks/${m[2]}`
  return projectPath.replace(/\.md$/, '_tasks')
}

/** Where a new case file belongs under the configured projects folder. */
export function caseFilePath(projectsFolder: string, title: string): string {
  const safeName = title.replace(/[\\/:*?"<>|]/g, '-')
  return normalizePath(`${projectsFolder}/Cases/${safeName}.md`)
}
