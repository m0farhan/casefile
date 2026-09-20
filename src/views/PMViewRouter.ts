import { TFile, type WorkspaceLeaf } from 'obsidian'
import type PMPlugin from '../main'
import { PM_DASHBOARD_VIEW_TYPE } from './DashboardView'
import { PM_PROJECT_VIEW_TYPE } from './ProjectView'

export class PMViewRouter {
  constructor(private plugin: PMPlugin) {}

  async openDashboard(): Promise<void> {
    const ws = this.plugin.app.workspace
    const leaf = ws.getLeaf('tab')
    await leaf.setViewState({ type: PM_DASHBOARD_VIEW_TYPE, state: {} })
    await ws.revealLeaf(leaf)
  }

  async openProject(file: TFile): Promise<void> {
    const ws = this.plugin.app.workspace
    const leaf = ws.getLeaf('tab')
    await leaf.setViewState({ type: PM_PROJECT_VIEW_TYPE, state: { filePath: file.path } })
    await ws.revealLeaf(leaf)
  }

  /**
   * Open a board in the leaf the analyst is already standing in, rather than a
   * new tab. This is the switcher's path: swapping boards is navigation, not
   * "open another thing", and a new tab per switch buries the workspace.
   * Every other route to a board still opens a tab.
   */
  async switchToBoard(leaf: WorkspaceLeaf, file: TFile): Promise<void> {
    await leaf.setViewState({ type: PM_PROJECT_VIEW_TYPE, state: { filePath: file.path } })
    await this.plugin.app.workspace.revealLeaf(leaf)
  }

  async openProjectByPath(path: string): Promise<void> {
    const file = this.plugin.app.vault.getAbstractFileByPath(path)
    if (file instanceof TFile) await this.openProject(file)
  }
}
