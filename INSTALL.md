# Installing GreySurface PM on another machine

GreySurface PM is a self-contained Obsidian plugin. No dev tooling, no network
access, and no specific vault name are required on the target machine.

## 1. Build the bundle (on the dev machine)

```bash
corepack pnpm package
```

This produces `dist/greysurface-pm-<version>.zip`.

## 2. Install (on any machine, any vault)

1. Copy the zip over (AirDrop / USB / drive — no internet needed).
2. Unzip it into the vault's plugin folder so you end up with:
   `<your vault>/.obsidian/plugins/greysurface-pm/` containing `main.js`,
   `styles.css`, `manifest.json`.
3. In Obsidian: **Settings → Community plugins → enable "GreySurface PM"**
   (turn on community plugins first if the vault never had any).

## 3. Optional: carry your settings

Settings (statuses, issue types, severities, SLA policies, templates) live in
`.obsidian/plugins/greysurface-pm/data.json`. Copy that file alongside the
three bundle files to reproduce your setup; omit it to start from defaults.

Project and task data is **not** in the plugin — it's plain markdown in the
vault (default folder: `Projects/`, configurable in settings), so syncing the
vault syncs the data.

## Never run two writers

If the original "Project Manager" community plugin is installed in the same
vault, keep it **disabled** while GreySurface PM is enabled. Both read and
write the same `pm-project`/`pm-task` files; running both invites double
writes.
