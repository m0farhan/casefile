import { describe, expect, it } from 'vitest'
import { caseFilePath, isCasesLayout, taskFolderForProjectPath } from './layout'

describe('Cases/Tasks layout', () => {
  it('derives the Tasks folder for a case in Cases/', () => {
    expect(taskFolderForProjectPath('Projects/Cases/Argus.md')).toBe('Projects/Tasks/Argus')
    expect(isCasesLayout('Projects/Cases/Argus.md')).toBe(true)
  })

  it('keeps the legacy sibling _tasks derivation for old-layout vaults', () => {
    expect(taskFolderForProjectPath('Projects/Argus.md')).toBe('Projects/Argus_tasks')
    expect(isCasesLayout('Projects/Argus.md')).toBe(false)
  })

  it('nested roots and names with dots survive', () => {
    expect(taskFolderForProjectPath('Work/PM/Cases/v2.0 plan.md')).toBe('Work/PM/Tasks/v2.0 plan')
  })

  it('caseFilePath places new cases under Cases/ with sanitized names', () => {
    expect(caseFilePath('Projects', 'My Case')).toBe('Projects/Cases/My Case.md')
    expect(caseFilePath('Projects', 'a/b:c')).toBe('Projects/Cases/a-b-c.md')
  })
})
