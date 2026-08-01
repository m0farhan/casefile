import { describe, expect, it } from 'vitest'
import {
  caseFilePath,
  isCasesLayout,
  isProjectFolderLayout,
  projectFolderForProjectPath,
  taskFolderForProjectPath
} from './layout'

describe('v3 self-contained project folders', () => {
  it('recognizes a project file inside its own same-named folder', () => {
    expect(isProjectFolderLayout('Cases/Cases.md')).toBe(true)
    expect(isProjectFolderLayout('Work/PM/Cases/Cases.md')).toBe(true)
    expect(isProjectFolderLayout('Projects/Cases/Argus.md')).toBe(false)
    expect(isProjectFolderLayout('Projects/Argus.md')).toBe(false)
    expect(isProjectFolderLayout('Argus.md')).toBe(false)
  })

  it('derives the Tasks folder inside the project folder', () => {
    expect(taskFolderForProjectPath('Cases/Cases.md')).toBe('Cases/Tasks')
    expect(taskFolderForProjectPath('Work/PM/Cases/Cases.md')).toBe('Work/PM/Cases/Tasks')
  })

  it('exposes the project folder for v3 paths only', () => {
    expect(projectFolderForProjectPath('Cases/Cases.md')).toBe('Cases')
    expect(projectFolderForProjectPath('Base/Cases/Cases.md')).toBe('Base/Cases')
    expect(projectFolderForProjectPath('Projects/Cases/Argus.md')).toBeNull()
    expect(projectFolderForProjectPath('Projects/Argus.md')).toBeNull()
  })

  it('caseFilePath places new projects in their own folder, empty base = vault root', () => {
    expect(caseFilePath('', 'Cases')).toBe('Cases/Cases.md')
    expect(caseFilePath('Projects', 'My Case')).toBe('Projects/My Case/My Case.md')
    expect(caseFilePath('', 'a/b:c')).toBe('a-b-c/a-b-c.md')
  })

  it('a v2 case literally named Cases resolves as v3 (deterministic rule: parent name wins)', () => {
    expect(taskFolderForProjectPath('Projects/Cases/Cases.md')).toBe('Projects/Cases/Tasks')
  })
})

describe('older recognized layouts', () => {
  it('derives the Tasks folder for a case in Cases/ (v2)', () => {
    expect(taskFolderForProjectPath('Projects/Cases/Argus.md')).toBe('Projects/Tasks/Argus')
    expect(isCasesLayout('Projects/Cases/Argus.md')).toBe(true)
  })

  it('keeps the legacy sibling _tasks derivation for old-layout vaults', () => {
    expect(taskFolderForProjectPath('Projects/Argus.md')).toBe('Projects/Argus_tasks')
    expect(isCasesLayout('Projects/Argus.md')).toBe(false)
  })

  it('nested roots and names with dots survive (v2)', () => {
    expect(taskFolderForProjectPath('Work/PM/Cases/v2.0 plan.md')).toBe('Work/PM/Tasks/v2.0 plan')
  })
})
