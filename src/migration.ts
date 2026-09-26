import { Notice } from 'obsidian'
import type PMPlugin from './main'
import { parseFrontmatter, isOldFormat } from './store/YamlParser'

/**
 * Migrates old-format projects (tasks embedded in YAML frontmatter)
 * to new format (individual .md files per task).
 */
export async function migrateProjects(plugin: PMPlugin): Promise<void> {
  // Old-format projects only ever lived directly in the projects folder
  // ('' = vault root, so direct children of the root).
  const prefix = plugin.settings.projectsFolder ? plugin.settings.projectsFolder + '/' : ''
  const files = plugin.app.vault
    .getMarkdownFiles()
    .filter((f) => f.path.startsWith(prefix) && !f.path.slice(prefix.length).includes('/'))

  let migrated = 0

  for (const file of files) {
    // A warm cache already knows each note's frontmatter, or that it has none,
    // so only an old-format board, or a note Obsidian has not indexed yet, is
    // read. Null means "not indexed"; an entry without frontmatter means "not
    // a board". This runs on every launch over every root note by default.
    const cache = plugin.app.metadataCache.getFileCache(file)
    if (cache && (cache.frontmatter?.['pm-project'] !== true || !isOldFormat(cache.frontmatter))) continue
    try {
      const content = await plugin.app.vault.cachedRead(file)
      const { frontmatter } = parseFrontmatter(content)
      if (!frontmatter || frontmatter['pm-project'] !== true) continue
      if (!isOldFormat(frontmatter)) continue

      // This project needs migration
      const project = await plugin.store.loadProject(file)
      if (!project || project.tasks.length === 0) continue

      new Notice(`Migrating project: ${project.title}...`)

      // saveProject will create individual task files
      await plugin.store.saveProject(project)
      migrated++
    } catch (e) {
      console.error(`[PM] Migration failed for ${file.path}:`, e)
      new Notice(`Responder: Migration failed for "${file.basename}". Check console for details.`)
    }
  }

  if (migrated > 0) {
    new Notice(`Responder: Migrated ${migrated} project(s) to new format.`)
  }
}
