import { ProgressBar } from '../primitives/ProgressBar'

export interface ProjectCardProps {
  title: string
  icon: string
  color: string
  tasksDone: number
  tasksTotal: number
  /** Folder the board lives in; '' is the vault root. */
  location: string
  /** Full path of the board note, for the tooltip. */
  path: string
  onClick: () => void
  /** Open the board's menu at this point: the pointer, or the card's corner from the keyboard. */
  onContextMenu: (at: { x: number; y: number }) => void
}

export class ProjectCard {
  el: HTMLElement

  constructor(parentEl: HTMLElement, props: ProjectCardProps) {
    const card = parentEl.createDiv('pm-project-card')
    this.el = card

    const colorBar = card.createDiv('pm-project-card-bar')
    colorBar.setCssStyles({ background: props.color })

    const body = card.createDiv('pm-project-card-body')
    body.createDiv({ text: props.icon, cls: 'pm-project-card-icon' })
    body.createEl('h3', { text: props.title, cls: 'pm-project-card-title' })

    const meta = body.createDiv('pm-project-card-meta')
    meta.createSpan({
      text: `${props.tasksDone}/${props.tasksTotal} tasks`,
      cls: 'pm-project-card-tasks'
    })
    // Every board carries its own path, so the list says where each one is
    // rather than leaving the analyst to guess that they all share a root.
    const where = meta.createSpan({
      text: props.location || 'Vault root',
      cls: 'pm-project-card-path'
    })
    where.setAttr('title', props.path)

    const percent = props.tasksTotal ? (props.tasksDone / props.tasksTotal) * 100 : 0
    new ProgressBar(body).setSize('sm').setValue(percent).setColor(props.color)

    card.addEventListener('click', () => props.onClick())
    card.addEventListener('contextmenu', (e) => {
      e.preventDefault()
      props.onContextMenu({ x: e.clientX, y: e.clientY })
    })
    // Keyboard access, as on a kanban card. The menu is the only way to Move,
    // Edit or Delete a board, and a Mac keyboard has no key that sends a
    // contextmenu, so Shift+F10 and the Menu key open it here, at the card.
    // preventDefault keeps the browser's own contextmenu from opening a second.
    card.setAttribute('role', 'button')
    card.setAttribute('tabindex', '0')
    card.addEventListener('keydown', (e) => {
      if (e.target !== card) return
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        props.onClick()
      } else if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
        e.preventDefault()
        const r = card.getBoundingClientRect()
        props.onContextMenu({ x: r.left, y: r.bottom })
      }
    })
  }
}
