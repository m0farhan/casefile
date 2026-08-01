import { normalizePath } from 'obsidian'

/**
 * Vault layout (v3, current): each project is self-contained in its own folder
 * named after it — `<base>/Cases/Cases.md` + `<base>/Cases/Tasks/…` — so
 * everything a project owns lives under one folder. `<base>` is the
 * projects-folder setting; empty means the vault root.
 *
 * Older layouts are still recognized so old vaults load unchanged and can
 * convert via the migration commands:
 *   v2     — `<root>/Cases/X.md` + `<root>/Tasks/X/`
 *   legacy — `<root>/X.md` + `<root>/X_tasks/`
 */

/** Matches `…/<Name>/<Name>.md` — the v3 self-contained project folder shape. */
const V3_RE = /^(.*\/)?([^/]+)\/\2\.md$/

/** True when the project file sits in its own folder named after it (v3). */
export function isProjectFolderLayout(projectPath: string): boolean {
  return V3_RE.test(projectPath)
}

/** True when the project file sits in a `Cases/` folder (v2). */
export function isCasesLayout(projectPath: string): boolean {
  return /\/Cases\/[^/]+\.md$/.test(projectPath)
}

/** The project's own folder for a v3 path, or null for the folderless older layouts. */
export function projectFolderForProjectPath(projectPath: string): string | null {
  return isProjectFolderLayout(projectPath) ? projectPath.slice(0, projectPath.lastIndexOf('/')) : null
}

/**
 * The task folder for a project file path, in any layout.
 * ponytail: a v2 case literally named "Cases" (`<root>/Cases/Cases.md`) is
 * indistinguishable from a v3 project — v3 wins by rule; the migration command
 * settles such vaults for good.
 */
export function taskFolderForProjectPath(projectPath: string): string {
  const v3 = V3_RE.exec(projectPath)
  if (v3) return `${v3[1] ?? ''}${v3[2]}/Tasks`
  const m = /^(.*)\/Cases\/([^/]+)\.md$/.exec(projectPath)
  if (m) return `${m[1]}/Tasks/${m[2]}`
  return projectPath.replace(/\.md$/, '_tasks')
}

/** Filesystem-safe name for a project title — also the v3 folder name. */
export function projectFileName(title: string): string {
  return title.replace(/[\\/:*?"<>|]/g, '-')
}

/** Where a new project's file belongs: its own folder under the configured base ('' = vault root). */
export function caseFilePath(projectsFolder: string, title: string): string {
  const safeName = projectFileName(title)
  return normalizePath(`${projectsFolder}/${safeName}/${safeName}.md`)
}
